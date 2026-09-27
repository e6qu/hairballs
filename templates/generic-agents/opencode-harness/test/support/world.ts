/**
 * Test world: the real opencode binary (pinned), the real Python tools MCP server (via `uv`), and
 * the scripted fake model — all on loopback. One opencode server per test file (as in production:
 * one per microVM); every test gets its own thread (= its own opencode session and runner).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Caller,
  EmailAddress,
  type Env,
  FakeClock,
  humanUser,
  type Incoming,
  loadSettings,
  MemoryAuditSink,
  ModelId,
  PersonName,
  PrincipalId,
  type Reply,
  SessionId,
  type Settings,
  unwrap,
  UserId,
} from "@org/agents";

import { ModelBackend } from "../../src/domain.ts";
import { TOOLS_SERVER } from "../../src/core/permissions.ts";
import { AGENT, PLUGIN_PATH } from "../../src/shell/app.ts";
import { opencodeBinary } from "../../src/shell/binary.ts";
import { OpencodeHost } from "../../src/shell/opencodeHost.ts";
import { SessionRunner } from "../../src/shell/runner.ts";
import { FakeModel } from "./fakeModel.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOOLS_DIR = fileURLToPath(new URL("../../../tools", import.meta.url));

export const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
export const ALICE = PrincipalId.of("auth0|alice");
export const LEAD = PrincipalId.of("auth0|service-desk-lead");
export const BOB = PrincipalId.of("auth0|bob");

function person(subject: PrincipalId, user: string, email: string, given: string | null): Caller {
  return humanUser({
    userId: UserId.of(user),
    subject,
    email: EmailAddress.of(email),
    givenName: given === null ? null : PersonName.of(given),
    familyName: null,
  });
}

/** The resolved callers of the test principals (what the IdentityResolver would give). */
export const CALLERS: ReadonlyMap<PrincipalId, Caller> = new Map([
  [ALICE, person(ALICE, "usr_alice", "alice@example.com", "Alice")],
  [BOB, person(BOB, "usr_bob", "bob@example.com", "Bob")],
  [LEAD, person(LEAD, "usr_lead", "lead@example.com", null)],
]);

export function callerOf(who: PrincipalId): Caller {
  const caller = CALLERS.get(who);
  if (caller === undefined) throw new Error(`no test caller for ${who}`);
  return caller;
}

/** Deliver a message to a runner as its sender (the way the Registry hands it over). */
export function send(runner: SessionRunner, message: Incoming): Promise<Reply> {
  return runner.handle(message, callerOf(message.sender));
}

export function settings(env: Env = {}): Settings {
  return unwrap(loadSettings(env, ROOT));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP server exited with ${child.exitCode}`);
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`MCP server did not listen on ${port} within ${timeoutMs} ms`);
}

export class World {
  readonly model = new FakeModel();
  host: OpencodeHost | null = null;
  mcpUrl = "";
  #mcp: ChildProcess | null = null;
  #threads = 0;
  readonly #runtimeDir = mkdtempSync(join(tmpdir(), "opencode-test-"));

  async start(): Promise<void> {
    await this.model.start();
    const port = await freePort();
    const mcp = spawn(
      "uv",
      ["run", "--directory", TOOLS_DIR, "--extra", "mcp", "python", "-m", "generic_tools.shell.mcp_server"],
      { env: { ...process.env, MCP_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] },
    );
    this.#mcp = mcp;
    let stderr = "";
    mcp.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      await waitForPort(port, mcp, 90_000);
    } catch (error) {
      throw new Error(`${String(error)}\n${stderr.slice(-2000)}`);
    }
    this.mcpUrl = `http://127.0.0.1:${port}/mcp`;
    this.host = new OpencodeHost({
      binary: opencodeBinary(process.env),
      settings: settings(),
      agent: AGENT,
      backend: ModelBackend.openaiCompatible(this.model.baseUrl, ModelId.of("claude-fake")),
      server: TOOLS_SERVER,
      toolsMcpUrl: this.mcpUrl,
      mcpToken: null,
      pluginPath: PLUGIN_PATH,
      modelsPath: join(ROOT, "config", "opencode-models.json"),
      // Deliberately NOT process.env: the child gets an allowlisted environment anyway, and tests
      // must never hand AWS credentials to opencode.
      env: { PATH: process.env["PATH"] },
      runtimeDir: this.#runtimeDir,
      logs: process.env["OPENCODE_LOGS"] === "1",
    });
    await this.host.start();
  }

  async stop(): Promise<void> {
    await this.host?.stop();
    const mcp = this.#mcp;
    if (mcp !== null && mcp.exitCode === null) {
      const exited = new Promise((resolve) => mcp.once("exit", resolve));
      mcp.kill("SIGTERM");
      await exited;
    }
    await this.model.stop();
    rmSync(this.#runtimeDir, { recursive: true, force: true });
  }

  /** A fresh thread (AgentCore session) with its own runner, audit sink and settings. */
  thread(env: Env = {}, kill = false): { runner: SessionRunner; audit: MemoryAuditSink } {
    if (this.host === null) throw new Error("world not started");
    this.#threads += 1;
    const audit = new MemoryAuditSink();
    const runner = new SessionRunner({
      session: SessionId.of(`thread-${String(this.#threads).padStart(4, "0")}-0000000000000000000000000000`),
      settings: settings(env),
      host: this.host,
      agent: AGENT,
      server: TOOLS_SERVER,
      clock: new FakeClock(),
      audit,
      killSwitch: () => kill,
    });
    return { runner, audit };
  }
}
