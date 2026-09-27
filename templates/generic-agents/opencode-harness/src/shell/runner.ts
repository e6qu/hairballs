/**
 * SessionRunner (shell): one conversation thread = one AgentCore session = one opencode session.
 *
 * It keeps the thread state, applies the pure thread state machine (`@org/agents` core/thread) to
 * each incoming message, drives opencode over HTTP, and turns what opencode does back into a
 * domain `RunOutcome`. It is also the `GuardTarget` the org guard plugin talks to (through the
 * guard bridge), so ONE `RunGuard` per run sees every model call, tool call and usage report:
 *
 *   plugin chat.params          → beforeModelCall()    (turns, tokens, USD, wall clock, kill switch)
 *   plugin tool.execute.before  → beforeToolCall()     (allowlist, tool-call cap, loop detection,
 *                                                       requested_by + idempotency key injection)
 *   event message.updated       → afterModelCall()     (tokens → org pricing; opencode's own cost
 *                                                       estimate is ignored)
 *   event permission.asked      → approval routing (four-eyes) / reject / doom loop → stop
 *   adapter timer               → wall clock stop
 *   any stop                    → POST /session/:id/abort
 */

import {
  acknowledged,
  ApprovalId,
  approvalNeeded,
  type ApprovalDecision,
  type AuditSink,
  type Clock,
  completed,
  failed,
  finish,
  fingerprintArguments,
  type Incoming,
  mergeAnswers,
  nextFollowUp,
  type PrincipalId,
  type Prompt,
  receive,
  redact,
  refused,
  type Reply,
  type RunOutcome,
  RunGuard,
  type SessionId,
  type Settings,
  stopped,
  ThreadState,
  type ToolName,
  type Usage,
  assertNever,
} from "@org/agents";

import { OcSessionId, type OcMessageId, type PermissionRequestId } from "../domain.ts";
import { decideAsk, type McpServerName, orgToolName, permissionRules, sideEffectArguments } from "../core/permissions.ts";
import type { GuardTarget, ModelVerdict, ToolVerdictForPlugin } from "./guardBridge.ts";
import type { OpencodeHost } from "./opencodeHost.ts";
import { isAbortError, type OcEvent, parseAssistantMessages } from "./opencodeEvents.ts";

export const STEER_PREFIX = "[Message from the user while you were working]";

export type RunnerOptions = {
  readonly session: SessionId;
  readonly settings: Settings;
  readonly host: OpencodeHost;
  /** opencode agent name (see opencodeConfig.ts). */
  readonly agent: string;
  readonly server: McpServerName;
  readonly clock: Clock;
  readonly audit: AuditSink;
  readonly killSwitch: () => boolean;
};

type Signal =
  | { readonly kind: "idle" }
  | { readonly kind: "approval"; readonly request: PermissionRequestId; readonly tool: ToolName }
  | { readonly kind: "lost"; readonly error: string };

type PendingApproval = { readonly request: PermissionRequestId; readonly approvalId: ApprovalId; readonly tool: ToolName };

/** Mutable state of the run in flight (shell only). */
class ActiveRun {
  guard: RunGuard;
  readonly owner: PrincipalId;
  readonly messages: OcMessageId[] = [];
  error: string | null = null;
  pending: PendingApproval | null = null;
  readonly queuedAsks: Array<{ readonly request: PermissionRequestId; readonly tool: ToolName }> = [];
  closing = false;
  wallTimer: NodeJS.Timeout | null = null;
  readonly #signals: Signal[] = [];
  #waiter: ((signal: Signal) => void) | null = null;

  constructor(guard: RunGuard, owner: PrincipalId) {
    this.guard = guard;
    this.owner = owner;
  }

  signal(signal: Signal): void {
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter(signal);
    } else {
      this.#signals.push(signal);
    }
  }

  next(): Promise<Signal> {
    const queued = this.#signals.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => (this.#waiter = resolve));
  }
}

export class SessionRunner implements GuardTarget {
  readonly #o: RunnerOptions;
  #state: ThreadState = ThreadState.initial();
  #oc: OcSessionId | null = null;
  #run: ActiveRun | null = null;
  /** Assistant messages whose usage has been reported to a guard (opencode may repeat updates). */
  readonly #accounted = new Set<OcMessageId>();

  constructor(options: RunnerOptions) {
    this.#o = options;
  }

  get state(): ThreadState {
    return this.#state;
  }

  get opencodeSession(): OcSessionId | null {
    return this.#oc;
  }

  // ------------------------------------------------------------------ messages from the caller

  async handle(message: Incoming): Promise<Reply> {
    const [state, action] = receive(this.#state, message, this.#o.settings.agent.busyPolicy);
    this.#state = state;
    switch (action.kind) {
      case "start_run":
        return this.#withFollowUps(() => this.#start(action.prompt, message.sender), message.sender);
      case "steer":
        return this.#steer(action.prompt, message.sender);
      case "queue_follow_up":
        return acknowledged("queued");
      case "cancel_run":
        await this.#cancel();
        return acknowledged("cancelling");
      case "deliver_approval": {
        const owner = this.#owner();
        return this.#withFollowUps(() => this.#resume(action.approvalId, action.decision), owner);
      }
      case "ignore_duplicate":
        return acknowledged("duplicate");
      case "reject":
        return refused(action.reason);
      default:
        return assertNever(action);
    }
  }

  #owner(): PrincipalId {
    const status = this.#state.status;
    if (status.kind === "idle") throw new Error("no active owner");
    return status.owner;
  }

  async #withFollowUps(first: () => Promise<RunOutcome>, owner: PrincipalId): Promise<Reply> {
    let reply = this.#finish(await this.#guarded(first), owner);
    for (;;) {
      const [state, queued] = nextFollowUp(this.#state);
      this.#state = state;
      if (queued === null) return reply;
      const next = this.#finish(await this.#guarded(() => this.#start(queued.prompt, queued.sender)), queued.sender);
      reply = mergeAnswers(reply, next);
    }
  }

  /** Infrastructure failures (opencode down, HTTP errors) end the run as `failed`, never wedge the thread. */
  async #guarded(body: () => Promise<RunOutcome>): Promise<RunOutcome> {
    try {
      return await body();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const run = this.#run;
      if (run !== null) {
        run.guard.fail(text);
        this.#close(run);
      }
      return failed(text);
    }
  }

  #finish(outcome: RunOutcome, owner: PrincipalId): Reply {
    const [state, reply] = finish(this.#state, outcome, owner, this.#o.settings.approvals);
    this.#state = state;
    return reply;
  }

  // ------------------------------------------------------------------ opencode session

  async #session(): Promise<OcSessionId> {
    const host = this.#o.host;
    if (this.#oc !== null && host.running) return this.#oc;
    await host.start();
    const created = await host.api.createSession(
      this.#o.session,
      permissionRules(this.#o.settings.agent.tools, this.#o.server),
    );
    const id =
      typeof created === "object" && created !== null ? (created as Readonly<Record<string, unknown>>)["id"] : undefined;
    const parsed = OcSessionId.parse(id, "$.id");
    if (parsed.kind === "err") throw parsed.error;
    const oc = parsed.value;
    this.#oc = oc;
    host.listen(oc, { onEvent: (event) => this.#onEvent(event), onLost: (error) => this.#run?.signal({ kind: "lost", error }) });
    host.bridge.register(oc, this);
    return oc;
  }

  #newGuard(): RunGuard {
    const cfg = this.#o.settings.agent;
    return new RunGuard({
      session: this.#o.session,
      limits: cfg.limits,
      price: cfg.price,
      tools: cfg.tools,
      clock: this.#o.clock,
      audit: this.#o.audit,
      killSwitch: this.#o.killSwitch,
    });
  }

  #armWallClock(run: ActiveRun): void {
    if (run.wallTimer !== null) clearTimeout(run.wallTimer);
    const limit = this.#o.settings.agent.limits.maxWallTime;
    const guard = run.guard;
    run.wallTimer = setTimeout(() => {
      if (this.#run !== run || run.guard !== guard) return;
      guard.recordExternalStop("wall_clock", `exceeded ${Math.round(limit / 1000)}s`);
      this.#abort();
    }, limit);
    run.wallTimer.unref();
  }

  // ------------------------------------------------------------------ runs

  async #start(prompt: Prompt, owner: PrincipalId): Promise<RunOutcome> {
    const oc = await this.#session();
    const run = new ActiveRun(this.#newGuard(), owner);
    this.#run = run;
    this.#armWallClock(run);
    await this.#o.host.api.promptAsync(oc, this.#o.agent, prompt);
    return this.#await(run, oc);
  }

  async #resume(approvalId: ApprovalId, decision: ApprovalDecision): Promise<RunOutcome> {
    const run = this.#run;
    const oc = this.#oc;
    if (run === null || oc === null || run.pending === null || run.pending.approvalId !== approvalId) {
      throw new Error("no suspended run for this approval");
    }
    const pending = run.pending;
    run.pending = null;
    // Like the reference variants, the resumed run gets a fresh guard (the wait for a human
    // does not count against the wall clock); usage already reported stays accounted.
    run.guard.finish();
    run.guard = this.#newGuard();
    this.#armWallClock(run);
    if (decision === "approve") {
      await this.#o.host.api.replyPermission(pending.request, "once");
    } else {
      // opencode rejects every other pending request of the session together with this one.
      run.queuedAsks.length = 0;
      await this.#o.host.api.replyPermission(pending.request, "reject", "rejected by approver");
    }
    const next = run.queuedAsks.shift();
    if (next !== undefined) run.signal({ kind: "approval", ...next });
    return this.#await(run, oc);
  }

  async #await(run: ActiveRun, oc: OcSessionId): Promise<RunOutcome> {
    const signal = await run.next();
    switch (signal.kind) {
      case "approval": {
        const approvalId = ApprovalId.of(signal.request);
        run.pending = { request: signal.request, approvalId, tool: signal.tool };
        return approvalNeeded(approvalId, signal.tool, `tool '${signal.tool}' changes external state and needs approval`);
      }
      case "lost":
        throw new Error(signal.error);
      case "idle":
        return this.#conclude(run, oc);
      default:
        return assertNever(signal);
    }
  }

  async #conclude(run: ActiveRun, oc: OcSessionId): Promise<RunOutcome> {
    run.closing = true;
    const messages = await this.#reconcile(run, oc);
    const ours = new Set(run.messages);
    const answer = [...messages].reverse().find((m) => ours.has(m.id) && m.text.length > 0)?.text ?? "";
    const guard = run.guard;
    this.#close(run);
    const stop = guard.stopped;
    if (stop !== null) {
      guard.finish();
      return stopped(stop, answer);
    }
    if (run.error !== null) {
      guard.fail(run.error);
      return failed(run.error);
    }
    guard.finish();
    return completed(answer);
  }

  #close(run: ActiveRun): void {
    if (run.wallTimer !== null) clearTimeout(run.wallTimer);
    if (this.#run === run) this.#run = null;
  }

  /** Report the usage of completed assistant messages not yet seen (event races, end of run). */
  async #reconcile(run: ActiveRun, oc: OcSessionId) {
    const parsed = parseAssistantMessages(await this.#o.host.api.messages(oc));
    if (parsed.kind === "err") throw parsed.error;
    for (const message of parsed.value) {
      if (message.completed) this.#account(run, message.id, message.usage);
    }
    return parsed.value;
  }

  #account(run: ActiveRun | null, message: OcMessageId, usage: Usage): void {
    if (this.#accounted.has(message)) return;
    this.#accounted.add(message);
    if (run === null) return;
    if (run.guard.afterModelCall(usage).kind === "stop") this.#abort();
  }

  #abort(): void {
    const oc = this.#oc;
    if (oc === null) return;
    this.#o.host.api.abort(oc).catch((error: unknown) => console.error("opencode abort failed:", error));
  }

  async #steer(prompt: Prompt, sender: PrincipalId): Promise<Reply> {
    const run = this.#run;
    const oc = this.#oc;
    if (run === null || oc === null || run.closing) {
      // The run is finishing: deliver the message as a follow-up instead of restarting opencode's loop.
      this.#state = { ...this.#state, followUps: [...this.#state.followUps, { sender, prompt }] };
      return acknowledged("queued");
    }
    await this.#o.host.api.promptAsync(oc, this.#o.agent, `${STEER_PREFIX} ${prompt}`);
    return acknowledged("steered");
  }

  async #cancel(): Promise<void> {
    const run = this.#run;
    if (run === null) return;
    run.guard.recordExternalStop("cancelled", "cancelled by the run owner");
    if (run.pending !== null) {
      // Cancelled while waiting for approval: the thread is already idle (core); end the run here.
      const pending = run.pending;
      run.pending = null;
      run.guard.finish();
      this.#close(run);
      await this.#o.host.api.replyPermission(pending.request, "reject", "cancelled").catch(() => undefined);
    }
    this.#abort();
  }

  // ------------------------------------------------------------------ opencode events

  #onEvent(event: OcEvent): void {
    const run = this.#run;
    switch (event.kind) {
      case "assistant_message":
        if (run !== null && !run.messages.includes(event.message) && !this.#accounted.has(event.message)) {
          run.messages.push(event.message);
        }
        if (event.completed) this.#account(run, event.message, event.usage);
        return;
      case "permission_asked":
        this.#onAsk(run, event.request, event.permission);
        return;
      case "session_error":
        if (run !== null && !isAbortError(event.error)) run.error = event.error;
        return;
      case "session_idle":
        run?.signal({ kind: "idle" });
        return;
      case "other":
        return;
      default:
        assertNever(event);
    }
  }

  #onAsk(run: ActiveRun | null, request: PermissionRequestId, permission: string): void {
    const decision = decideAsk(permission, this.#o.settings.agent.tools, this.#o.server);
    const reject = (message: string): void => {
      this.#o.host.api
        .replyPermission(request, "reject", message)
        .catch((error: unknown) => console.error("permission reply failed:", error));
    };
    switch (decision.kind) {
      case "route_to_approvers":
        if (run === null) {
          reject("no active run");
        } else if (run.pending !== null) {
          run.queuedAsks.push({ request, tool: decision.tool });
        } else {
          run.signal({ kind: "approval", request, tool: decision.tool });
        }
        return;
      case "reject":
        reject(decision.reason);
        return;
      case "reject_loop":
        reject(decision.detail);
        run?.guard.recordExternalStop("loop_detected", decision.detail);
        this.#abort();
        return;
      default:
        assertNever(decision);
    }
  }

  // ------------------------------------------------------------------ GuardTarget (org guard plugin)

  async beforeModelCall(): Promise<ModelVerdict> {
    const run = this.#run;
    const oc = this.#oc;
    if (run === null || oc === null) return { kind: "stop", reason: "no active run" };
    await this.#reconcile(run, oc);
    const decision = run.guard.beforeModelCall();
    if (decision.kind === "stop") {
      this.#abort();
      return { kind: "stop", reason: `${decision.reason}: ${decision.detail}` };
    }
    return { kind: "continue" };
  }

  async beforeToolCall(key: string, args: unknown): Promise<ToolVerdictForPlugin> {
    const run = this.#run;
    if (run === null) return { kind: "block", reason: "no active run" };
    const tool = orgToolName(key, args, this.#o.server);
    if (tool === null) return { kind: "block", reason: `'${key}' is not a valid tool` };
    const verdict = run.guard.beforeToolCall(tool, args);
    switch (verdict.kind) {
      case "proceed":
        return { kind: "proceed", set: {} };
      case "require_approval":
        // The permission rule for this tool is "ask": opencode now asks, and the adapter routes
        // the request to the approvers. The guard, not the model, sets these arguments.
        return {
          kind: "proceed",
          set: sideEffectArguments(this.#o.session, tool, fingerprintArguments(args), run.owner),
        };
      case "block_tool":
        return { kind: "block", reason: verdict.reason };
      case "stop":
        this.#abort();
        return { kind: "block", reason: `run stopped (${verdict.reason}): ${verdict.detail}` };
      default:
        return assertNever(verdict);
    }
  }

  toolResult(_key: string, texts: readonly string[]): readonly string[] {
    return texts.map((text) => redact(text).text);
  }
}
