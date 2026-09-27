/**
 * The MCP client against the real Python MCP server of the generic tools (streamable HTTP),
 * plus transport edge cases against a scripted in-process server. Skipped when `uv` is missing.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { McpClient, ToolName, unwrap } from "../src/index.ts";

const TOOLS_DIR = fileURLToPath(new URL("../../../../generic-agents/tools", import.meta.url));
const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

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

describe("McpClient against the Python generic-tools MCP server", { skip: hasUv ? false : "uv is not installed" }, () => {
  let child: ChildProcess;
  let url = "";
  let stderr = "";

  before(async () => {
    const port = await freePort();
    child = spawn(
      "uv",
      ["run", "--directory", TOOLS_DIR, "--extra", "mcp", "python", "-m", "generic_tools.shell.mcp_server"],
      { env: { ...process.env, MCP_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await waitForPort(port, child, 90_000);
    } catch (error) {
      throw new Error(`${String(error)}\n${stderr.slice(-2000)}`);
    }
    url = `http://127.0.0.1:${port}/mcp`;
  });

  after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  });

  test("lists the tools with schemas (handshake)", async () => {
    const client = new McpClient({ url });
    const info = unwrap(await client.initialize());
    assert.equal(info.serverName, "generic-tools");
    const tools = unwrap(await client.listTools());
    assert.deepEqual(new Set(tools.map((t) => t.name)), new Set(["calculate", "search_knowledge", "create_ticket", "get_ticket"]));
    const calculate = tools.find((t) => t.name === "calculate");
    assert.ok(calculate !== undefined && calculate.description.length > 0);
    assert.equal((calculate.inputSchema as { type?: unknown }).type, "object");
  });

  test("calls a tool and surfaces tool errors with their reason (stateless, no handshake)", async () => {
    const client = new McpClient({ url, handshake: "none" });
    const ok = unwrap(await client.callTool(ToolName.of("calculate"), { expression: "0.1+0.2" }));
    assert.equal(ok.kind, "ok");
    assert.match(ok.text, /= 0\.3/);
    const bad = unwrap(await client.callTool(ToolName.of("calculate"), { expression: "1/0" }));
    assert.equal(bad.kind, "error");
    assert.match(bad.text, /division by zero/);
  });
});

describe("McpClient transport handling (scripted server)", () => {
  let server: Server;
  let url = "";
  const seen: { auth: string | undefined; session: string | undefined; method: string }[] = [];

  before(async () => {
    server = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method: string; params?: { cursor?: string; name?: string } };
        seen.push({
          auth: request.headers.authorization,
          session: request.headers["mcp-session-id"] as string | undefined,
          method: message.method,
        });
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const reply = (result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        switch (message.method) {
          case "initialize":
            response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
            response.end(reply({ protocolVersion: "2025-06-18", serverInfo: { name: "scripted" }, capabilities: {} }));
            return;
          case "tools/list": {
            // SSE with a notification first and the response split over two data lines.
            const page =
              message.params?.cursor === "p2"
                ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
                : { tools: [{ name: "first", description: "d", inputSchema: { type: "object" } }], nextCursor: "p2" };
            const [head, tail] = [reply(page).slice(0, 10), reply(page).slice(10)];
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
            response.write(`event: message\ndata: ${head}\n`);
            setTimeout(() => response.end(`data: ${tail}\n\n`), 10);
            return;
          }
          case "tools/call":
            if (message.params?.name === "boom") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } }));
              return;
            }
            response.writeHead(500, { "content-type": "text/plain" }).end("kaput");
            return;
          default:
            response.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("handshake, session id, bearer token, SSE and pagination", async () => {
    const client = new McpClient({ url, bearerToken: "tok" });
    const tools = unwrap(await client.listTools());
    assert.deepEqual(tools.map((t) => t.name), ["first", "second"]);
    assert.equal(tools[1]?.description, "");
    assert.deepEqual(seen.map((s) => s.method), ["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    assert.ok(seen.every((s) => s.auth === "Bearer tok"));
    assert.equal(seen[0]?.session, undefined);
    assert.equal(seen[2]?.session, "sess-1");
  });

  test("JSON-RPC and HTTP errors are values", async () => {
    const client = new McpClient({ url, handshake: "none" });
    const rpc = await client.callTool(ToolName.of("boom"), {});
    assert.deepEqual(rpc, { kind: "err", error: { kind: "rpc", code: -32602, message: "Unknown tool" } });
    const http = await client.callTool(ToolName.of("other"), {});
    assert.deepEqual(http, { kind: "err", error: { kind: "http", status: 500, body: "kaput" } });
    const down = await new McpClient({ url: "http://127.0.0.1:1/mcp", handshake: "none" }).listTools();
    assert.ok(down.kind === "err" && down.error.kind === "transport");
  });
});
