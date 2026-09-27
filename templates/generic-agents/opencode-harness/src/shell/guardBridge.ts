/**
 * The guard bridge: a loopback HTTP endpoint the org guard plugin (running inside the opencode
 * process) calls from its hooks, so every decision is taken by the adapter's `RunGuard` — one
 * guard state per run, whether the event came from opencode's hooks or its event stream.
 *
 *   POST /model   {sessionID}                       → {action: "continue"} | {action: "stop", reason}
 *   POST /tool    {sessionID, tool, callID, args}   → {action: "proceed", set: {...}} | {action: "block", reason}
 *   POST /result  {sessionID, tool, texts: [...]}   → {texts: [...]}  (redacted)
 *
 * Requests must carry the per-process random token (`x-org-guard-token`); the listener is bound
 * to 127.0.0.1. Unknown sessions (no active run) are refused, so the plugin fails closed.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { attempt, dumps, expectArray, expectObject, expectString, field, fieldOr, must, type Parsed } from "@org/agents";

import { OcSessionId } from "../domain.ts";

export type ModelVerdict = { readonly kind: "continue" } | { readonly kind: "stop"; readonly reason: string };
export type ToolVerdictForPlugin =
  | { readonly kind: "proceed"; readonly set: Readonly<Record<string, string>> }
  | { readonly kind: "block"; readonly reason: string };

/** Implemented by the session runner for the opencode session it owns. */
export interface GuardTarget {
  beforeModelCall(): Promise<ModelVerdict>;
  /** `key` is opencode's tool key (e.g. `gw_create_ticket`); `args` are the model's raw arguments. */
  beforeToolCall(key: string, args: unknown): Promise<ToolVerdictForPlugin>;
  toolResult(key: string, texts: readonly string[]): readonly string[];
}

export const GUARD_TOKEN_HEADER = "x-org-guard-token";
const MAX_BODY = 4 * 1024 * 1024;

type BridgeRequest =
  | { readonly kind: "model"; readonly session: OcSessionId }
  | { readonly kind: "tool"; readonly session: OcSessionId; readonly tool: string; readonly args: unknown }
  | { readonly kind: "result"; readonly session: OcSessionId; readonly tool: string; readonly texts: readonly string[] };

function parseRequest(path: string, raw: unknown): Parsed<BridgeRequest> {
  return attempt((): BridgeRequest => {
    const body = must(expectObject(raw, "$"));
    const session = must(OcSessionId.parse(must(field(body, "sessionID", "$")), "$.sessionID"));
    switch (path) {
      case "/model":
        return { kind: "model", session };
      case "/tool":
        return {
          kind: "tool",
          session,
          tool: must(expectString(must(field(body, "tool", "$")), "$.tool")),
          args: fieldOr(body, "args", {}),
        };
      case "/result": {
        const items = must(expectArray(must(field(body, "texts", "$")), "$.texts"));
        return {
          kind: "result",
          session,
          tool: must(expectString(must(field(body, "tool", "$")), "$.tool")),
          texts: items.map((item, i) => must(expectString(item, `$.texts[${i}]`))),
        };
      }
      default:
        throw new Error(`unknown bridge path ${path}`);
    }
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = dumps(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

export class GuardBridge {
  readonly token: string = randomBytes(32).toString("hex");
  readonly #targets = new Map<OcSessionId, GuardTarget>();
  readonly #server: Server;
  #url = "";

  constructor(onError: (error: unknown) => void = (error) => console.error("guard bridge:", error)) {
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        onError(error);
        if (!response.headersSent) send(response, 500, { action: "block", reason: "guard error" });
      });
    });
  }

  get url(): string {
    return this.#url;
  }

  register(session: OcSessionId, target: GuardTarget): void {
    this.#targets.set(session, target);
  }

  unregister(session: OcSessionId): void {
    this.#targets.delete(session);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #authorized(request: IncomingMessage): boolean {
    const given = request.headers[GUARD_TOKEN_HEADER];
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || !this.#authorized(request)) {
      send(response, 403, { action: "block", reason: "forbidden" });
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(response, 413, { action: "block", reason: "body too large" });
        return;
      }
      chunks.push(chunk);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      send(response, 400, { action: "block", reason: "invalid JSON" });
      return;
    }
    const parsed = parseRequest((request.url ?? "").split("?")[0] ?? "", raw);
    if (parsed.kind === "err") {
      send(response, 400, { action: "block", reason: parsed.error.message });
      return;
    }
    const req = parsed.value;
    const target = this.#targets.get(req.session);
    if (target === undefined) {
      send(response, 200, { action: req.kind === "model" ? "stop" : "block", reason: "no active org run for this session" });
      return;
    }
    switch (req.kind) {
      case "model": {
        const verdict = await target.beforeModelCall();
        send(response, 200, verdict.kind === "continue" ? { action: "continue" } : { action: "stop", reason: verdict.reason });
        return;
      }
      case "tool": {
        const verdict = await target.beforeToolCall(req.tool, req.args);
        send(
          response,
          200,
          verdict.kind === "proceed" ? { action: "proceed", set: verdict.set } : { action: "block", reason: verdict.reason },
        );
        return;
      }
      case "result":
        send(response, 200, { texts: target.toolResult(req.tool, req.texts) });
        return;
    }
  }
}
