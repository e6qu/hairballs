/**
 * A minimal HTTP client for `opencode serve` (loopback, Basic auth), with plain `fetch`.
 *
 * Endpoints used (opencode 1.18.31, `server/routes/instance/httpapi/groups/{session,permission,event,global}.ts`):
 *
 *   GET  /global/health                      readiness probe
 *   POST /session                            {title, permission: Rule[]}   → {id}
 *   POST /session/:id/prompt_async           {agent, parts: [{type: "text", text}]}  (204; also while busy = steering)
 *   POST /session/:id/abort                  cancel the running loop (and child sessions)
 *   GET  /session/:id/message                messages with parts (answer text, usage reconciliation)
 *   GET  /session/status                     {sessionID: {type: busy|retry}} (idle sessions are absent)
 *   POST /permission/:requestID/reply        {reply: "once" | "reject", message?}
 *   GET  /event                              SSE stream of `{type, properties}` events
 *
 * The official `@opencode-ai/sdk` is deliberately not used: it would add a dependency (and
 * `cross-spawn`) for eight calls, and its generated types mirror the wire format, which the org
 * standards ask us not to type. Responses are parsed into domain values in `opencodeEvents.ts`.
 */

import { dumps } from "@org/agents";

import type { OcSessionId, PermissionRequestId } from "../domain.ts";
import type { PermissionRule } from "../core/permissions.ts";

export class OpencodeHttpError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`opencode ${method} ${path} → ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

export class OpencodeApi {
  readonly #base: string;
  readonly #authorization: string;

  constructor(baseUrl: string, username: string, password: string) {
    this.#base = baseUrl.replace(/\/$/, "");
    this.#authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  async #call(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: { authorization: this.#authorization, "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) init.body = dumps(body);
    const response = await fetch(`${this.#base}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new OpencodeHttpError(method, path, response.status, text);
    return text.length === 0 ? null : (JSON.parse(text) as unknown);
  }

  async healthy(): Promise<boolean> {
    try {
      await this.#call("GET", "/global/health", undefined, 2_000);
      return true;
    } catch {
      return false;
    }
  }

  createSession(title: string, permission: readonly PermissionRule[]): Promise<unknown> {
    return this.#call("POST", "/session", { title, permission });
  }

  async promptAsync(session: OcSessionId, agent: string, text: string): Promise<void> {
    await this.#call("POST", `/session/${session}/prompt_async`, { agent, parts: [{ type: "text", text }] });
  }

  async abort(session: OcSessionId): Promise<void> {
    await this.#call("POST", `/session/${session}/abort`, {});
  }

  messages(session: OcSessionId): Promise<unknown> {
    return this.#call("GET", `/session/${session}/message`);
  }

  status(): Promise<unknown> {
    return this.#call("GET", "/session/status");
  }

  async replyPermission(request: PermissionRequestId, reply: "once" | "reject", message?: string): Promise<void> {
    await this.#call("POST", `/permission/${request}/reply`, message === undefined ? { reply } : { reply, message });
  }

  /** Open the event stream; yields each SSE `data` payload as parsed JSON (`unknown`). */
  async *events(signal: AbortSignal): AsyncGenerator<unknown> {
    const response = await fetch(`${this.#base}/event`, {
      headers: { authorization: this.#authorization, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || response.body === null) {
      throw new OpencodeHttpError("GET", "/event", response.status, await response.text());
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) {
            const payload = data.join("\n");
            data = [];
            try {
              yield JSON.parse(payload) as unknown;
            } catch {
              // not JSON (comment / keep-alive): ignore
            }
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  }
}
