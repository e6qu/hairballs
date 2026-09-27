// Pure logic: no AWS, no network, no clock, no randomness.
import { createHash } from "node:crypto";
import {
  type CachedToken,
  type EventRef,
  type SessionId,
  type Task,
  type TaskState,
  type Trigger,
  parseSessionId,
} from "./domain.ts";

const TOKEN_MARGIN_MS = 60_000;

// Same event -> same session id, so a retried delivery reaches the same agent session.
export function sessionIdFor(ref: EventRef): SessionId {
  return parseSessionId(createHash("sha256").update(`${ref.source}:${ref.id}`).digest("hex"));
}

export function taskFor(trigger: Trigger): Task {
  switch (trigger.kind) {
    case "dailyDigest":
      return {
        taskId: trigger.ref.id,
        prompt: "Write the daily digest of open high-priority tickets and post it as a note.",
      };
    case "ticketEscalated":
      return {
        taskId: trigger.ref.id,
        prompt: `Ticket ${trigger.ticketId} was escalated. Triage it and add a note.`,
      };
  }
}

// The cached token if it is valid for at least another minute, else undefined.
export function usable(token: CachedToken | undefined, now: number): CachedToken | undefined {
  return token !== undefined && now < token.expiresAt - TOKEN_MARGIN_MS ? token : undefined;
}

// A new task starts in the background; a retried delivery only reports the state.
export type OnTask =
  | { readonly kind: "start" }
  | { readonly kind: "known"; readonly state: TaskState };

export function onTask(known: ReadonlyMap<string, TaskState>, task: Task): OnTask {
  const state = known.get(task.taskId);
  return state === undefined ? { kind: "start" } : { kind: "known", state };
}

// The agent's reply body.
export function accepted(task: Task, state: TaskState) {
  return { status: "accepted", taskId: task.taskId, state } as const;
}
