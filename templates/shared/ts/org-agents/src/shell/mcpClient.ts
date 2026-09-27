/**
 * A minimal MCP client over Streamable HTTP (JSON-RPC 2.0 over POST), using the global `fetch`.
 *
 * Supports `initialize` (+ `notifications/initialized`), `tools/list` (with pagination) and
 * `tools/call`. Responses may be `application/json` or `text/event-stream`. Results are parsed
 * into domain values at this boundary; the raw JSON never leaves this module (except each
 * tool's `inputSchema`, which is opaque by design and handed to the framework adapter).
 */

import { ToolName } from "../domain.ts";
import {
  attempt,
  expectArray,
  expectBool,
  expectInt,
  expectObject,
  expectString,
  field,
  fieldOr,
  hasField,
  must,
  ParseError,
  type Parsed,
  type UnknownRecord,
} from "../parsing.ts";
import { assertNever, err, ok, type Result } from "../result.ts";
import { dumps } from "./json.ts";

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export type McpTool = {
  readonly name: ToolName;
  readonly description: string;
  /** JSON Schema of the tool's arguments: opaque here, converted by the framework adapter. */
  readonly inputSchema: unknown;
};

export type McpCallResult = { readonly kind: "ok"; readonly text: string } | { readonly kind: "error"; readonly text: string };

export type McpServerInfo = { readonly protocolVersion: string; readonly serverName: string };

export type McpError =
  | { readonly kind: "transport"; readonly detail: string }
  | { readonly kind: "http"; readonly status: number; readonly body: string }
  | { readonly kind: "rpc"; readonly code: number; readonly message: string }
  | { readonly kind: "protocol"; readonly error: ParseError };

export function describeMcpError(error: McpError): string {
  switch (error.kind) {
    case "transport":
      return `MCP transport error: ${error.detail}`;
    case "http":
      return `MCP HTTP ${error.status}: ${error.body}`;
    case "rpc":
      return `MCP error ${error.code}: ${error.message}`;
    case "protocol":
      return `MCP protocol error: ${error.error.message}`;
    default:
      return assertNever(error);
  }
}

export type McpClientOptions = {
  readonly url: string | URL;
  /** Sent as `Authorization: Bearer <token>` (e.g. an AgentCore Gateway / Auth0 access token). */
  readonly bearerToken?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** `auto` (default): run the initialize handshake before the first request. `none`: stateless servers only. */
  readonly handshake?: "auto" | "none";
  readonly protocolVersion?: string;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
};

type McpResult<T> = Promise<Result<T, McpError>>;

const protocolError = (error: ParseError): McpError => ({ kind: "protocol", error });

// ---------------------------------------------------------------- response parsing (boundary)

/** Parse one JSON-RPC response message: the `result` object, or the JSON-RPC error. */
function parseRpcResponse(message: UnknownRecord): Result<UnknownRecord, McpError> {
  if (hasField(message, "error")) {
    const parsed = attempt(() => {
      const error = must(expectObject(message["error"], "$.error"));
      return {
        code: must(expectInt(must(field(error, "code", "$.error")), "$.error.code")),
        message: must(expectString(fieldOr(error, "message", ""), "$.error.message")),
      };
    });
    return parsed.kind === "err" ? err(protocolError(parsed.error)) : err({ kind: "rpc", ...parsed.value });
  }
  const result = attempt(() => must(expectObject(must(field(message, "result", "$")), "$.result")));
  return result.kind === "err" ? err(protocolError(result.error)) : ok(result.value);
}

function parseServerInfo(result: UnknownRecord): Parsed<McpServerInfo> {
  return attempt(() => {
    const info = must(expectObject(fieldOr(result, "serverInfo", {}), "$.result.serverInfo"));
    return {
      protocolVersion: must(expectString(must(field(result, "protocolVersion", "$.result")), "$.result.protocolVersion")),
      serverName: must(expectString(fieldOr(info, "name", ""), "$.result.serverInfo.name")),
    };
  });
}

function parseToolsPage(result: UnknownRecord): Parsed<{ tools: McpTool[]; nextCursor: string | null }> {
  return attempt(() => {
    const items = must(expectArray(must(field(result, "tools", "$.result")), "$.result.tools"));
    const tools = items.map((item, i): McpTool => {
      const path = `$.result.tools[${i}]`;
      const tool = must(expectObject(item, path));
      return {
        name: must(ToolName.parse(must(field(tool, "name", path)), `${path}.name`)),
        description: must(expectString(fieldOr(tool, "description", ""), `${path}.description`)),
        inputSchema: fieldOr(tool, "inputSchema", { type: "object" }),
      };
    });
    const cursor = fieldOr(result, "nextCursor", null);
    return {
      tools,
      nextCursor: cursor === null ? null : must(expectString(cursor, "$.result.nextCursor")),
    };
  });
}

function parseCallResult(result: UnknownRecord): Parsed<McpCallResult> {
  return attempt((): McpCallResult => {
    const isError = must(expectBool(fieldOr(result, "isError", false), "$.result.isError"));
    const content = must(expectArray(fieldOr(result, "content", []), "$.result.content"));
    const texts: string[] = [];
    for (const [i, item] of content.entries()) {
      const path = `$.result.content[${i}]`;
      const block = must(expectObject(item, path));
      const type = must(expectString(must(field(block, "type", path)), `${path}.type`));
      if (type === "text") texts.push(must(expectString(must(field(block, "text", path)), `${path}.text`)));
      else texts.push(`[${type} content omitted]`);
    }
    if (texts.length === 0 && hasField(result, "structuredContent")) texts.push(dumps(result["structuredContent"]));
    const text = texts.join("\n");
    return isError ? { kind: "error", text } : { kind: "ok", text };
  });
}

// ---------------------------------------------------------------- transport

/** Yield the `data` payload of each Server-Sent Event as it arrives. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let data: string[] = [];
  const flushLine = function* (line: string): Generator<string> {
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
        yield* flushLine(line);
      }
      if (done) {
        if (buffer !== "") yield* flushLine(buffer);
        yield* flushLine("");
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

export class McpClient {
  readonly #url: string;
  readonly #options: McpClientOptions;
  readonly #fetch: typeof fetch;
  #nextId = 1;
  #sessionId: string | null = null;
  #protocolVersion: string | null = null;
  #initialized: Promise<Result<McpServerInfo, McpError>> | null = null;

  constructor(options: McpClientOptions) {
    this.#url = String(options.url);
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Run the handshake (once). Safe to call explicitly; otherwise it runs lazily when `handshake` is `auto`. */
  initialize(): McpResult<McpServerInfo> {
    if (this.#initialized === null) {
      this.#initialized = this.#handshake();
      // A failed handshake may be retried by the next call.
      void this.#initialized.then((r) => {
        if (r.kind === "err") this.#initialized = null;
      });
    }
    return this.#initialized;
  }

  async listTools(): McpResult<readonly McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.#call("tools/list", cursor === null ? {} : { cursor });
      if (result.kind === "err") return result;
      const parsed = parseToolsPage(result.value);
      if (parsed.kind === "err") return err(protocolError(parsed.error));
      tools.push(...parsed.value.tools);
      cursor = parsed.value.nextCursor;
      if (cursor === null) return ok(tools);
    }
    return err({ kind: "transport", detail: "tools/list did not finish after 100 pages" });
  }

  /** Call a tool with the model's raw arguments (an object). Tool failures are `{kind: "error"}`, not `Err`. */
  async callTool(name: ToolName, args: unknown): McpResult<McpCallResult> {
    const result = await this.#call("tools/call", { name, arguments: args ?? {} });
    if (result.kind === "err") return result;
    const parsed = parseCallResult(result.value);
    return parsed.kind === "err" ? err(protocolError(parsed.error)) : ok(parsed.value);
  }

  async #handshake(): McpResult<McpServerInfo> {
    const result = await this.#request("initialize", {
      protocolVersion: this.#options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.#options.clientInfo ?? { name: "org-agents", version: "0.1.0" },
    });
    if (result.kind === "err") return result;
    const info = parseServerInfo(result.value);
    if (info.kind === "err") return err(protocolError(info.error));
    this.#protocolVersion = info.value.protocolVersion;
    const notified = await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, null);
    return notified.kind === "err" ? notified : ok(info.value);
  }

  async #call(method: string, params: UnknownRecord): McpResult<UnknownRecord> {
    if ((this.#options.handshake ?? "auto") === "auto") {
      const init = await this.initialize();
      if (init.kind === "err") return init;
    }
    return this.#request(method, params);
  }

  async #request(method: string, params: UnknownRecord): McpResult<UnknownRecord> {
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, id);
    if (response.kind === "err") return response;
    if (response.value === null) {
      return err(protocolError(new ParseError("$", `no response to ${method}`)));
    }
    return parseRpcResponse(response.value);
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.#options.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.#options.bearerToken !== undefined) headers["authorization"] = `Bearer ${this.#options.bearerToken}`;
    if (this.#sessionId !== null) headers["mcp-session-id"] = this.#sessionId;
    if (this.#protocolVersion !== null) headers["mcp-protocol-version"] = this.#protocolVersion;
    return headers;
  }

  /** POST one message; for requests (`id` set) return the matching response message. */
  async #post(message: UnknownRecord, id: number | null): McpResult<UnknownRecord | null> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      return err({ kind: "transport", detail: describeThrown(error) });
    }
    try {
      const session = response.headers.get("mcp-session-id");
      if (session !== null && session !== "") this.#sessionId = session;
      if (!response.ok) {
        const body = (await response.text()).slice(0, 2000);
        return err({ kind: "http", status: response.status, body });
      }
      if (id === null) {
        await response.body?.cancel();
        return ok(null);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && response.body !== null) {
        for await (const data of sseData(response.body)) {
          const found = this.#match(data, id);
          if (found.kind === "err") return found;
          if (found.value !== null) return ok(found.value);
        }
        return err(protocolError(new ParseError("$", "event stream ended without a response")));
      }
      const found = this.#match(await response.text(), id);
      if (found.kind === "err") return found;
      if (found.value === null) return err(protocolError(new ParseError("$.id", "no response matches the request id")));
      return ok(found.value);
    } catch (error) {
      return err({ kind: "transport", detail: describeThrown(error) });
    }
  }

  /** Parse a JSON text; return the message answering request `id` (batches allowed), else null. */
  #match(text: string, id: number): Result<UnknownRecord | null, McpError> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return ok(null); // not JSON (keep-alive or foreign event): ignore
    }
    const messages = Array.isArray(raw) ? raw : [raw];
    for (const [i, candidate] of messages.entries()) {
      const message = expectObject(candidate, Array.isArray(raw) ? `$[${i}]` : "$");
      if (message.kind === "err") return err(protocolError(message.error));
      if (message.value["id"] === id) return ok(message.value);
    }
    return ok(null);
  }
}
