/**
 * A scripted fake model: a tiny OpenAI-compatible server (`POST /v1/chat/completions`, streaming
 * SSE) that opencode drives through its BUNDLED `@ai-sdk/openai-compatible` provider.
 *
 * Tests push `Turn`s; each model request consumes the next turn. Every request body is recorded
 * so tests can assert what the model saw (tool results, steering text). No network, no AWS.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type ToolCall = { readonly name: string; readonly args: Readonly<Record<string, unknown>> };

export type Turn = {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** The response is held until this promise resolves (lets a test act while the model "thinks"). */
  readonly gate?: Promise<void>;
  /** Respond with an HTTP error instead of a completion (provider failure). */
  readonly httpError?: { readonly status: number; readonly message: string };
};

export type RecordedRequest = {
  readonly messages: readonly unknown[];
  readonly tools: readonly string[];
};

export class FakeModel {
  readonly #server: Server;
  #turns: Turn[] = [];
  #requests: RecordedRequest[] = [];
  #waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  #callId = 0;
  port = 0;

  constructor() {
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500).end(String(error));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  /** Replace the script (and forget recorded requests). */
  script(turns: readonly Turn[]): void {
    this.#turns = [...turns];
    this.#requests = [];
  }

  get requests(): readonly RecordedRequest[] {
    return this.#requests;
  }

  get calls(): number {
    return this.#requests.length;
  }

  /** Resolves once `count` requests have been received. */
  received(count: number): Promise<void> {
    if (this.#requests.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ count, resolve }));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(body) as { messages?: unknown[]; tools?: Array<{ function?: { name?: string } }> };
    this.#requests.push({
      messages: parsed.messages ?? [],
      tools: (parsed.tools ?? []).map((t) => t.function?.name ?? ""),
    });
    for (const waiter of this.#waiters.filter((w) => this.#requests.length >= w.count)) waiter.resolve();
    this.#waiters = this.#waiters.filter((w) => this.#requests.length < w.count);

    const turn = this.#turns.shift() ?? { text: "(fake model: script exhausted)" };
    if (turn.gate !== undefined) await turn.gate;
    if (turn.httpError !== undefined) {
      response.writeHead(turn.httpError.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: turn.httpError.message, type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (payload: unknown): void => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake" };
    const delta = (d: unknown, finish: string | null = null): void =>
      chunk({ ...base, choices: [{ index: 0, delta: d, finish_reason: finish }] });

    delta({ role: "assistant", content: "" });
    if (turn.text !== undefined) delta({ content: turn.text });
    const calls = turn.toolCalls ?? [];
    for (const [index, call] of calls.entries()) {
      this.#callId += 1;
      delta({
        tool_calls: [
          {
            index,
            id: `call_${this.#callId}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      });
    }
    delta({}, calls.length > 0 ? "tool_calls" : "stop");
    const input = turn.inputTokens ?? 10;
    const output = turn.outputTokens ?? 5;
    chunk({ ...base, choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
    response.end("data: [DONE]\n\n");
  }
}
