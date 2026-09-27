/**
 * SessionRunner (shell): one conversation thread = one AgentCore session = one pi AgentSession.
 *
 * It keeps the thread state, applies the pure thread state machine (`@org/agents` core/thread) to
 * each incoming message, runs pi when asked to, and turns the run back into a domain `RunOutcome`.
 *
 * Messages while busy:
 * - the run owner → `session.steer()` (busy_policy = steer): pi delivers it after the current tool
 *   batch, before the next model call;
 * - anyone else → queued in the thread state and run afterwards as a new run on behalf of the
 *   sender (not pi's `followUp()`, which would run inside the current run and budget, with the
 *   current owner as `requested_by`);
 * - cancel → guard records `cancelled`, `session.abort()`.
 */

import "./offline.ts"; // before pi runs: PI_OFFLINE & co.

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  acknowledged,
  type ApprovalDecision,
  type AuditSink,
  type Clock,
  failed,
  finish,
  type Incoming,
  mergeAnswers,
  nextFollowUp,
  type PrincipalId,
  receive,
  refused,
  type Reply,
  RunGuard,
  type RunOutcome,
  type SessionId,
  type Settings,
  stopped,
  ThreadState,
  assertNever,
  DurationMs,
  redact,
} from "@org/agents";

import {
  approvalGrantedPrompt,
  approvalRejectedPrompt,
  type PendingApproval,
} from "../core/approval.ts";
import type { Guardrail, ToolOutcome } from "../core/domain.ts";
import { decideOutcome } from "../core/outcome.ts";
import { steeringText } from "../core/steering.ts";
import { guardrailExtension } from "./guardrail.ts";
import type { PiModel } from "./model.ts";
import { orgExtension } from "./orgExtension.ts";
import { piAi } from "./piAi.ts";
import { parseFinalMessage } from "./piMessages.ts";
import { type ActiveRun, RunSlot } from "./runState.ts";
import { type GenericTool, genericTools, invokeTool, type ToolCaller } from "./tools.ts";

type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

/**
 * pi settings for a headless, non-coding agent (keys from pi docs/settings.md). Nothing is read
 * from `settings.json`: the SettingsManager is in-memory.
 */
export const BASE_PI_SETTINGS: PiSettings = {
  defaultProjectTrust: "never",
  enableInstallTelemetry: false,
  enableSkillCommands: false,
  quietStartup: true,
  cacheWarming: "off",
  steeringMode: "all",
  followUpMode: "all",
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
  compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 },
  httpIdleTimeoutMs: 300_000,
};

export type SessionRunnerOptions = {
  readonly session: SessionId;
  readonly settings: Settings;
  readonly modelRuntime: ModelRuntime;
  readonly model: PiModel;
  readonly caller: ToolCaller;
  readonly clock: Clock;
  readonly audit: AuditSink;
  readonly killSwitch: () => boolean;
  /** pi's cwd: an empty directory; no project resources are read from it. */
  readonly workDir: string;
  readonly guardrail: Guardrail | null;
  /** Overrides of BASE_PI_SETTINGS (tests switch retries off). */
  readonly piSettings?: PiSettings;
  readonly warn?: (message: string) => void;
};

/** What a run starts from: a user prompt, or an approver's answer to a held tool call. */
type RunInput =
  | { readonly kind: "prompt"; readonly text: string }
  | {
      readonly kind: "approval";
      readonly pending: PendingApproval;
      readonly decision: ApprovalDecision;
      readonly approver: PrincipalId;
    };

export class SessionRunner {
  readonly #options: SessionRunnerOptions;
  readonly #pi: AgentSession;
  readonly #slot: RunSlot;
  readonly #tools: ReadonlyMap<string, GenericTool>;
  #state: ThreadState = ThreadState.initial();
  /** The call held for approval while the thread is awaiting_approval. */
  #pending: PendingApproval | null = null;

  private constructor(options: SessionRunnerOptions, pi: AgentSession, slot: RunSlot, tools: readonly GenericTool[]) {
    this.#options = options;
    this.#pi = pi;
    this.#slot = slot;
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  static async create(options: SessionRunnerOptions): Promise<SessionRunner> {
    const slot = new RunSlot();
    const tools = genericTools(piAi.Type);
    const warn = options.warn ?? ((message: string) => console.error(message));
    const settingsManager = SettingsManager.inMemory({ ...BASE_PI_SETTINGS, ...options.piSettings });
    const extensions = [
      { name: "org-guard", factory: orgExtension({ slot, tools, caller: options.caller, warn }) },
      ...(options.guardrail === null ? [] : [{ name: "org-guardrail", factory: guardrailExtension(options.guardrail) }]),
    ];
    const agentDir = `${options.workDir}/.pi-agent`; // never created: nothing is discovered or persisted
    const loader = new DefaultResourceLoader({
      cwd: options.workDir,
      agentDir,
      settingsManager,
      extensionFactories: extensions,
      noExtensions: true, // only our inline factories; no ~/.pi or .pi/extensions discovery
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true, // ignore AGENTS.md / CLAUDE.md
      systemPrompt: options.settings.systemPrompt,
      systemPromptOverride: () => options.settings.systemPrompt,
      appendSystemPrompt: [], // no APPEND_SYSTEM.md discovery
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors.length > 0) {
      throw new Error(`pi extensions failed to load: ${loaded.errors.map((e) => e.error).join("; ")}`);
    }
    const { session } = await createAgentSession({
      cwd: options.workDir,
      agentDir,
      modelRuntime: options.modelRuntime,
      model: options.model,
      thinkingLevel: "off",
      noTools: "builtin", // no read/bash/edit/write: only the org extension's tools
      excludeTools: ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(options.workDir),
      settingsManager,
    });
    return new SessionRunner(options, session, slot, tools);
  }

  get state(): ThreadState {
    return this.#state;
  }

  /** Names of the tools pi offers the model (for tests and diagnostics). */
  activeToolNames(): readonly string[] {
    return this.#pi.getActiveToolNames();
  }

  async handle(message: Incoming): Promise<Reply> {
    const [state, action] = receive(this.#state, message, this.#options.settings.agent.busyPolicy);
    this.#state = state;
    switch (action.kind) {
      case "start_run":
        return this.#runWithFollowUps({ kind: "prompt", text: action.prompt }, message.sender);
      case "steer":
        await this.#pi.steer(steeringText(action.prompt));
        return acknowledged("steered");
      case "queue_follow_up":
        return acknowledged("queued");
      case "cancel_run":
        this.#cancel(message.sender);
        return acknowledged("cancelling");
      case "deliver_approval": {
        const pending = this.#pending;
        const owner = this.#owner();
        this.#pending = null;
        if (pending === null || owner === null) return refused("no approval is pending");
        return this.#runWithFollowUps(
          { kind: "approval", pending, decision: action.decision, approver: action.approver },
          owner,
        );
      }
      case "ignore_duplicate":
        return acknowledged("duplicate");
      case "reject":
        return refused(action.reason);
      default:
        return assertNever(action);
    }
  }

  #owner(): PrincipalId | null {
    const status = this.#state.status;
    return status.kind === "idle" ? null : status.owner;
  }

  #cancel(sender: PrincipalId): void {
    if (this.#state.status.kind === "idle") this.#pending = null; // a pending approval was abandoned
    const run = this.#slot.current;
    if (run === null) return;
    run.guard.recordExternalStop("cancelled", `cancelled by ${sender}`);
    void this.#pi.abort();
  }

  async #runWithFollowUps(first: RunInput, owner: PrincipalId): Promise<Reply> {
    let reply = await this.#runOnce(first, owner);
    for (;;) {
      const [state, queued] = nextFollowUp(this.#state);
      this.#state = state;
      if (queued === null) return reply;
      reply = mergeAnswers(reply, await this.#runOnce({ kind: "prompt", text: queued.prompt }, queued.sender));
    }
  }

  async #runOnce(input: RunInput, owner: PrincipalId): Promise<Reply> {
    const { settings, session, clock, audit, killSwitch } = this.#options;
    const cfg = settings.agent;
    const guard = new RunGuard({ session, limits: cfg.limits, price: cfg.price, tools: cfg.tools, clock, audit, killSwitch });
    const run: ActiveRun = { guard, session, owner, pendingApproval: null, firstTurnChecked: false };
    this.#slot.current = run;
    // A hung provider call must not outlive the wall-clock limit (the guard also checks per event).
    const wallClock = setTimeout(() => {
      guard.recordExternalStop("wall_clock", `exceeded ${DurationMs.format(cfg.limits.maxWallTime)}`);
      void this.#pi.abort();
    }, cfg.limits.maxWallTime);
    wallClock.unref();

    let outcome: RunOutcome;
    try {
      outcome = await this.#execute(input, run);
    } catch (error) {
      // Provider/infrastructure messages can echo request data: redact and bound them.
      const detail = redact(error instanceof Error ? error.message : String(error)).text.slice(0, 500);
      guard.fail(detail);
      outcome = failed(detail);
    } finally {
      clearTimeout(wallClock);
      this.#slot.current = null;
    }
    guard.finish();

    const [state, reply] = finish(this.#state, outcome, owner, settings.approvals);
    this.#state = state;
    if (outcome.kind === "approval_needed") this.#pending = run.pendingApproval;
    return reply;
  }

  async #execute(input: RunInput, run: ActiveRun): Promise<RunOutcome> {
    const prompt = await this.#promptFor(input, run);
    if (prompt.kind === "stopped") return prompt.outcome;

    // Ask the guard before pi calls the model at all (kill switch, budget already spent).
    const decision = run.guard.beforeModelCall();
    if (decision.kind === "stop") return stopped(decision, "");
    run.firstTurnChecked = true;

    const before = this.#pi.messages.length;
    await this.#pi.prompt(prompt.text, { expandPromptTemplates: false });
    const final = parseFinalMessage(this.#pi.messages.slice(before));
    if (final.kind === "err") throw final.error;

    const outcome = decideOutcome({ stopped: run.guard.stopped, pendingApproval: run.pendingApproval, final: final.value });
    if (outcome.kind === "failed") {
      const detail = redact(outcome.error).text.slice(0, 500);
      run.guard.fail(detail);
      return failed(detail);
    }
    // Keep guard state and audit in line with stops the guard did not decide (guardrail).
    if (outcome.kind === "stopped" && run.guard.stopped === null) {
      run.guard.recordExternalStop(outcome.stop.reason, outcome.stop.detail);
    }
    return outcome;
  }

  /** The text pi receives; for an approval, the approved call is executed first (exactly once). */
  async #promptFor(
    input: RunInput,
    run: ActiveRun,
  ): Promise<{ readonly kind: "prompt"; readonly text: string } | { readonly kind: "stopped"; readonly outcome: RunOutcome }> {
    switch (input.kind) {
      case "prompt":
        return { kind: "prompt", text: input.text };
      case "approval": {
        const { pending, approver } = input;
        if (input.decision === "reject") return { kind: "prompt", text: approvalRejectedPrompt(pending, approver) };
        const executed = await this.#executeApproved(pending, run);
        if (executed.kind === "stopped") return executed;
        return { kind: "prompt", text: approvalGrantedPrompt(pending, approver, executed.outcome) };
      }
      default:
        return assertNever(input);
    }
  }

  async #executeApproved(
    pending: PendingApproval,
    run: ActiveRun,
  ): Promise<{ readonly kind: "executed"; readonly outcome: ToolOutcome } | { readonly kind: "stopped"; readonly outcome: RunOutcome }> {
    // The approved call still counts against this run's tool-call limit and loop detection.
    const verdict = run.guard.beforeToolCall(pending.tool, pending.arguments);
    switch (verdict.kind) {
      case "stop":
        return { kind: "stopped", outcome: stopped(verdict, "") };
      case "block_tool":
        return { kind: "executed", outcome: { kind: "error", text: `blocked: ${verdict.reason}` } };
      case "proceed":
      case "require_approval": {
        // require_approval is satisfied: an authorised approver (four-eyes) just granted it.
        const tool = this.#tools.get(pending.tool);
        if (tool === undefined) return { kind: "executed", outcome: { kind: "error", text: `unknown tool ${pending.tool}` } };
        const outcome = await invokeTool(this.#options.caller, tool, pending.arguments, {
          session: run.session,
          principal: run.owner,
        });
        return { kind: "executed", outcome };
      }
      default:
        return assertNever(verdict);
    }
  }
}
