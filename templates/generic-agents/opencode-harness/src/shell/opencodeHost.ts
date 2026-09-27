/**
 * OpencodeHost: one `opencode serve` child process per microVM (= per AgentCore session), started
 * lazily by the adapter, bound to loopback with Basic auth, plus the guard bridge and a single
 * event-stream pump that dispatches events to the session runners.
 *
 * Environment (AGENTS_OPENCODE_BEDROCK.md §3.3), built from an ALLOWLIST — the adapter's own
 * environment (which may hold AWS keys) is never inherited wholesale:
 *   - OPENCODE_CONFIG_CONTENT (the generated config), OPENCODE_SERVER_PASSWORD (random);
 *   - OPENCODE_DISABLE_PROJECT_CONFIG / _MODELS_FETCH (+ OPENCODE_MODELS_PATH) / _AUTOUPDATE /
 *     _SHARE / _DEFAULT_PLUGINS / _CLAUDE_CODE / _EXTERNAL_SKILLS / _LSP_DOWNLOAD;
 *   - HOME, XDG_{CONFIG,DATA,CACHE,STATE}_HOME and OPENCODE_DB in a fresh temp dir;
 *   - Bedrock: AWS_PROFILE + AWS_CONFIG_FILE (credential_process profile) and AWS_REGION only.
 *
 * opencode starts a background `npm install @opencode-ai/plugin` in every config directory it
 * loads (`config/config.ts` → `Npm.install`). The global config dir is pre-seeded with a
 * package.json / package-lock.json / node_modules that already "contain" it, which makes that
 * install a no-op (`core/src/npm.ts`): nothing is downloaded at runtime.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { Env, Settings } from "@org/agents";

import type { ModelBackend, OcSessionId } from "../domain.ts";
import type { McpServerName } from "../core/permissions.ts";
import { GuardBridge } from "./guardBridge.ts";
import { OpencodeApi } from "./opencodeApi.ts";
import { renderConfig } from "./opencodeConfig.ts";
import { type OcEvent, parseEvent } from "./opencodeEvents.ts";

export const OPENCODE_VERSION = "1.18.31";

export type EventListener = {
  readonly onEvent: (event: OcEvent) => void;
  /** The event stream or the opencode process is gone; in-flight runs must fail. */
  readonly onLost: (error: string) => void;
};

export type HostOptions = {
  readonly binary: string;
  readonly settings: Settings;
  readonly agent: string;
  readonly backend: ModelBackend;
  readonly server: McpServerName;
  readonly toolsMcpUrl: string;
  readonly mcpAuthorization: string | null;
  readonly pluginPath: string;
  /** Pinned model catalog (OPENCODE_MODELS_PATH); models are defined in the generated config. */
  readonly modelsPath: string;
  /** The adapter's environment; only allowlisted variables are passed on. */
  readonly env: Env;
  /** Where HOME / XDG dirs / the session DB / the workspace go (default: a new temp dir). */
  readonly runtimeDir?: string;
  /** Forward opencode's stdout/stderr (logs) to the adapter's stderr. */
  readonly logs?: boolean;
  readonly startTimeoutMs?: number;
};

/** Passed through from the adapter environment when set (proxy, CA bundle, telemetry, time zone). */
const PASSTHROUGH = [
  "PATH",
  "LANG",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
];

function seedGlobalConfigDir(dir: string): void {
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  const dependency = { "@opencode-ai/plugin": OPENCODE_VERSION };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, dependencies: dependency }));
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, requires: true, packages: { "": { dependencies: dependency } } }),
  );
}

export class OpencodeHost {
  readonly #options: HostOptions;
  readonly #bridge = new GuardBridge();
  readonly #listeners = new Map<OcSessionId, EventListener>();
  readonly #password = randomBytes(24).toString("base64url");
  #child: ChildProcess | null = null;
  #api: OpencodeApi | null = null;
  #events: AbortController | null = null;
  #stopping = false;

  constructor(options: HostOptions) {
    this.#options = options;
  }

  get bridge(): GuardBridge {
    return this.#bridge;
  }

  get api(): OpencodeApi {
    if (this.#api === null) throw new Error("opencode is not running");
    return this.#api;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  listen(session: OcSessionId, listener: EventListener): void {
    this.#listeners.set(session, listener);
  }

  unlisten(session: OcSessionId): void {
    this.#listeners.delete(session);
  }

  #childEnv(root: string, config: string): Record<string, string> {
    const source = this.#options.env;
    const env: Record<string, string> = {};
    for (const name of PASSTHROUGH) {
      const value = source[name];
      if (value !== undefined) env[name] = value;
    }
    Object.assign(env, {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_DB: join(root, "data", "opencode.db"),
      OPENCODE_CONFIG_CONTENT: config,
      OPENCODE_SERVER_PASSWORD: this.#password,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_MODELS_PATH: this.#options.modelsPath,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_SHARE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      ORG_GUARD_URL: this.#bridge.url,
      ORG_GUARD_TOKEN: this.#bridge.token,
    });
    const backend = this.#options.backend;
    if (backend.kind === "bedrock") {
      env["AWS_PROFILE"] = backend.profile;
      env["AWS_REGION"] = backend.region;
      const configFile = source["AWS_CONFIG_FILE"];
      if (configFile !== undefined) env["AWS_CONFIG_FILE"] = configFile;
    }
    return env;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const root = this.#options.runtimeDir ?? mkdtempSync(join(tmpdir(), "opencode-"));
    for (const dir of ["home", "config/opencode", "data", "cache", "state", "workspace"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    seedGlobalConfigDir(join(root, "config", "opencode"));
    if (this.#bridge.url === "") await this.#bridge.start();

    const config = JSON.stringify(
      renderConfig({
        settings: this.#options.settings,
        agent: this.#options.agent,
        backend: this.#options.backend,
        server: this.#options.server,
        toolsMcpUrl: this.#options.toolsMcpUrl,
        mcpAuthorization: this.#options.mcpAuthorization,
        pluginPath: this.#options.pluginPath,
      }),
    );
    const child = spawn(this.#options.binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: join(root, "workspace"),
      env: this.#childEnv(root, config),
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    const logs = this.#options.logs ?? false;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (logs) process.stderr.write(chunk);
    });
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error(`opencode did not start within ${this.#options.startTimeoutMs ?? 30_000} ms`)),
        this.#options.startTimeoutMs ?? 30_000,
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        if (logs) process.stderr.write(chunk);
        out += chunk.toString("utf8");
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode exited during start-up (code ${String(code)})`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    child.on("exit", (code, signal) => this.#lost(`opencode exited (code ${String(code)}, signal ${String(signal)})`));

    const api = new OpencodeApi(url, "opencode", this.#password);
    this.#api = api;
    const deadline = Date.now() + (this.#options.startTimeoutMs ?? 30_000);
    while (!(await api.healthy())) {
      if (Date.now() > deadline) throw new Error("opencode health check timed out");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.#pumpEvents(api);
  }

  /** Subscribe to `/event` and resolve once the stream is connected (no events are missed). */
  async #pumpEvents(api: OpencodeApi): Promise<void> {
    const controller = new AbortController();
    this.#events = controller;
    let connected: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (connected = resolve));
    const pump = async (): Promise<void> => {
      for await (const raw of api.events(controller.signal)) {
        connected();
        const parsed = parseEvent(raw);
        if (parsed.kind === "err") {
          console.error(`opencode event not understood: ${parsed.error.message}`);
          continue;
        }
        const event = parsed.value;
        if (event.kind === "other") continue;
        this.#listeners.get(event.session)?.onEvent(event);
      }
    };
    pump().then(
      () => this.#lost("opencode event stream ended"),
      (error: unknown) => this.#lost(`opencode event stream failed: ${String(error)}`),
    );
    await ready;
  }

  #lost(reason: string): void {
    if (this.#stopping) return;
    for (const listener of this.#listeners.values()) listener.onLost(reason);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#events?.abort();
    const child = this.#child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await this.#bridge.stop();
  }
}
