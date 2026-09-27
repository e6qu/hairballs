/**
 * The org guard plugin for opencode (AGENTS_OPENCODE_BEDROCK.md §8).
 *
 * A LOCAL file plugin (config `plugin: ["/abs/path/orgGuard.ts"]`), loaded by opencode's embedded
 * Bun runtime; no npm plugins are used. It has no imports, so nothing is resolved or installed at
 * runtime. It is deliberately thin: every decision is delegated to the adapter's RunGuard over the
 * loopback guard bridge (`src/shell/guardBridge.ts`), and it fails CLOSED when the bridge is
 * unreachable.
 *
 * Hooks (verified against opencode 1.18.31 `packages/plugin/src/index.ts` and the call sites in
 * `session/tools.ts`, `session/llm/request.ts`):
 *   - `chat.params`: runs before EVERY model call → RunGuard.beforeModelCall (turns, tokens, USD,
 *     wall clock, kill switch). Throwing aborts the model call.
 *   - `tool.execute.before`: runs before the permission check and the execution of every tool →
 *     RunGuard.beforeToolCall (allowlist, tool-call cap, loop detection). Throwing blocks the tool
 *     (the model sees the error). For side-effecting tools the adapter returns `requested_by` and
 *     `idempotency_key`, which are written INTO `output.args` (the same object opencode then passes
 *     to the MCP call, so the model cannot choose them).
 *   - `tool.execute.after`: redacts tool output before it reaches the model and the session DB.
 *   - `shell.env`: removes AWS credentials from any shell environment (bash is denied anyway).
 *
 * Only the plugin function is exported: opencode treats every export as a plugin.
 */

type ChatParamsInput = { readonly sessionID: string };
type ToolBeforeInput = { readonly tool: string; readonly sessionID: string; readonly callID: string };
type ToolBeforeOutput = { args: unknown };
type ToolAfterInput = { readonly tool: string; readonly sessionID: string; readonly callID: string };
/** Built-in tools return `{output: string}`; MCP tools return the MCP result `{content: [...]}`. */
type ToolAfterOutput = { output?: unknown; content?: unknown };
type ShellEnvOutput = { env: Record<string, string> };

type Hooks = {
  readonly "chat.params": (input: ChatParamsInput, output: unknown) => Promise<void>;
  readonly "tool.execute.before": (input: ToolBeforeInput, output: ToolBeforeOutput) => Promise<void>;
  readonly "tool.execute.after": (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>;
  readonly "shell.env": (input: unknown, output: ShellEnvOutput) => Promise<void>;
};

const BRIDGE_URL = process.env["ORG_GUARD_URL"] ?? "";
const BRIDGE_TOKEN = process.env["ORG_GUARD_TOKEN"] ?? "";
const TIMEOUT_MS = 30_000;

type Json = Readonly<Record<string, unknown>>;

async function bridge(path: string, body: Json): Promise<Json> {
  if (BRIDGE_URL === "" || BRIDGE_TOKEN === "") throw new Error("org guard: bridge is not configured");
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-org-guard-token": BRIDGE_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const parsed: unknown = await response.json();
  if (!response.ok || typeof parsed !== "object" || parsed === null) {
    throw new Error(`org guard: bridge answered ${response.status}`);
  }
  return parsed as Json;
}

function reasonOf(verdict: Json): string {
  return typeof verdict["reason"] === "string" ? verdict["reason"] : "blocked";
}

type TextBlock = { type: string; text?: unknown };

export const OrgGuard = async (): Promise<Hooks> => ({
  "chat.params": async (input) => {
    const verdict = await bridge("/model", { sessionID: input.sessionID });
    if (verdict["action"] !== "continue") throw new Error(`run stopped by org guard: ${reasonOf(verdict)}`);
  },

  "tool.execute.before": async (input, output) => {
    const verdict = await bridge("/tool", { sessionID: input.sessionID, tool: input.tool, callID: input.callID, args: output.args });
    if (verdict["action"] !== "proceed") throw new Error(`blocked: ${reasonOf(verdict)}`);
    const set = verdict["set"];
    if (typeof set === "object" && set !== null && Object.keys(set).length > 0) {
      if (typeof output.args !== "object" || output.args === null) throw new Error("blocked: arguments are not an object");
      // Mutate in place: opencode passes this very object to the tool (session/tools.ts).
      Object.assign(output.args, set);
    }
  },

  "tool.execute.after": async (input, output) => {
    const blocks: TextBlock[] = Array.isArray(output.content) ? (output.content as TextBlock[]) : [];
    const texts: string[] = [];
    if (typeof output.output === "string") texts.push(output.output);
    for (const block of blocks) if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (texts.length === 0) return;
    let redacted: unknown;
    try {
      redacted = (await bridge("/result", { sessionID: input.sessionID, tool: input.tool, texts }))["texts"];
    } catch {
      redacted = null;
    }
    const safe = Array.isArray(redacted) && redacted.length === texts.length ? (redacted as unknown[]) : null;
    let i = 0;
    const next = (): string => {
      const value = safe?.[i];
      i += 1;
      return typeof value === "string" ? value : "[output withheld: org guard unavailable]";
    };
    if (typeof output.output === "string") output.output = next();
    for (const block of blocks) if (block.type === "text" && typeof block.text === "string") block.text = next();
  },

  "shell.env": async (_input, output) => {
    for (const name of Object.keys(output.env)) {
      if (name.startsWith("AWS_") || name === "ORG_GUARD_TOKEN" || name === "OPENCODE_SERVER_PASSWORD") {
        delete output.env[name];
      }
    }
  },
});
