/**
 * The org extension for pi (shell): connects pi's loop to the shared RunGuard and registers the
 * generic tools. Loaded as an inline extension factory; pi's own extension discovery is off.
 *
 *   agent_start   no active run → abort (fail closed: pi never runs without a guard)
 *   turn_start    RunGuard.beforeModelCall (turns, tokens, USD, wall clock, kill switch) → ctx.abort()
 *   message_end   assistant usage {input, output, cacheRead, cacheWrite} → RunGuard.afterModelCall → ctx.abort()
 *   session_compact  usage of the summary model call → RunGuard.recordExternalUsage
 *   tool_result   redact tool output (cards, IBANs, e-mail, AWS keys, bearer tokens) before the
 *                 model sees it and before pi stores it in the session transcript
 *   tool_call     RunGuard.beforeToolCall (allowlist, approval, loop detection, tool-call limit)
 *                 → {block, reason, terminate}; approval → hold the call (see core/approval.ts)
 *
 * A throwing `tool_call` handler makes pi block the tool (agent-session.js `_installAgentToolHooks`
 * rethrows, agent-loop.js `prepareToolCall` turns it into an error result): the hook fails safe,
 * and it throws on purpose when there is no active run.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { assertNever, redact, ToolName } from "@org/agents";

import { approvalIdFor, pendingApprovalNotice } from "../core/approval.ts";
import { ToolCallId } from "../core/domain.ts";
import { gateTool } from "../core/gate.ts";
import { parseAssistantUsage, parseCompactionUsage } from "./piMessages.ts";
import type { ActiveRun, RunSlot } from "./runState.ts";
import { type GenericTool, invokeTool, type ToolCaller } from "./tools.ts";

export type OrgExtensionOptions = {
  readonly slot: RunSlot;
  readonly tools: readonly GenericTool[];
  readonly caller: ToolCaller;
  /** Non-fatal boundary problems (unparseable usage). Default: stderr. */
  readonly warn?: (message: string) => void;
};

function requireRun(slot: RunSlot): ActiveRun {
  const run = slot.current;
  if (run === null) throw new Error("no active guarded run");
  return run;
}

function registerTools(pi: ExtensionAPI, options: OrgExtensionOptions): void {
  for (const tool of options.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params) {
        const run = requireRun(options.slot);
        const outcome = await invokeTool(options.caller, tool, params, {
          session: run.session,
          requester: run.requester(),
          callerToken: run.callerToken(),
        });
        // pi marks a tool result as an error when execute throws; the text reaches the model.
        if (outcome.kind === "error") throw new Error(outcome.text);
        const result = { content: [{ type: "text" as const, text: outcome.text }], details: {} };
        // A call held for approval in this batch ends the turn only if every result terminates.
        return run.pendingApproval === null ? result : { ...result, terminate: true };
      },
    });
  }
}

export function orgExtension(options: OrgExtensionOptions): ExtensionFactory {
  const warn = options.warn ?? ((message: string) => console.error(message));
  const { slot } = options;

  return (pi) => {
    registerTools(pi, options);

    pi.on("agent_start", (_event, ctx) => {
      if (slot.current === null) {
        warn("pi started a run without an active guard; aborting");
        ctx.abort();
      }
    });

    pi.on("turn_start", (_event, ctx) => {
      const run = slot.current;
      if (run === null) {
        ctx.abort();
        return;
      }
      if (run.firstTurnChecked) {
        run.firstTurnChecked = false;
        return;
      }
      if (run.guard.beforeModelCall().kind === "stop") ctx.abort();
    });

    pi.on("message_end", (event, ctx) => {
      const run = slot.current;
      if (run === null) return;
      const usage = parseAssistantUsage(event.message);
      if (usage.kind === "err") {
        // Treated as "no usage": turn, tool-call and wall-clock limits still apply.
        warn(`ignoring unparseable model usage: ${usage.error.message}`);
        return;
      }
      if (usage.value === null) return;
      if (run.guard.afterModelCall(usage.value).kind === "stop") ctx.abort();
    });

    pi.on("session_compact", (event, ctx) => {
      const run = slot.current;
      if (run === null) return;
      const usage = parseCompactionUsage(event.compactionEntry);
      if (usage.kind === "err") {
        warn(`ignoring unparseable compaction usage: ${usage.error.message}`);
        return;
      }
      if (usage.value !== null && run.guard.recordExternalUsage(usage.value).kind === "stop") ctx.abort();
    });

    pi.on("tool_result", (event) => {
      let changed = false;
      const content = event.content.map((block) => {
        if (block.type !== "text") return block;
        const redacted = redact(block.text);
        changed ||= redacted.changed;
        return redacted.changed ? { ...block, text: redacted.text } : block;
      });
      return changed ? { content } : undefined;
    });

    pi.on("tool_call", (event, ctx) => {
      const run = requireRun(slot); // throws → pi blocks the call
      const tool = ToolName.parse(event.toolName, "$.tool_call.toolName");
      if (tool.kind === "err") return { block: true, reason: `blocked: ${tool.error.message}` };
      const gate = gateTool(run.guard.beforeToolCall(tool.value, event.input), run.pendingApproval !== null);
      switch (gate.kind) {
        case "run":
          return undefined;
        case "block":
          if (gate.abort) ctx.abort();
          return { block: true, reason: gate.reason, terminate: gate.terminate };
        case "hold_for_approval": {
          const toolCallId = ToolCallId.parse(event.toolCallId);
          if (toolCallId.kind === "err") return { block: true, reason: `blocked: ${toolCallId.error.message}` };
          const pending = {
            approvalId: approvalIdFor(run.session, toolCallId.value),
            tool: tool.value,
            toolCallId: toolCallId.value,
            arguments: structuredClone(event.input),
            reason: gate.reason,
          };
          run.pendingApproval = pending;
          return { block: true, reason: pendingApprovalNotice(pending), terminate: true };
        }
        default:
          return assertNever(gate);
      }
    });
  };
}
