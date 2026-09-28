// Pure logic: no AWS, no HTTP, no clock. Easy to test and to read.
import type {
  AgentRuntimeArn,
  AnswerEvent,
  Caller,
  Prompt,
  Subject,
  TicketRequest,
} from "./domain.ts";

// Runtime doesn't tie sessions to users, so the agent does: only the starter may continue.
export const owns = (owner: Subject, caller: Caller): boolean => caller.subject === owner;

// Per-user details go in the first message, never in the system prompt (keeps the cache).
export function firstMessage(caller: Caller, prompt: Prompt): string {
  return caller.kind === "human" && caller.firstName
    ? `[Context: you are assisting ${caller.firstName}.]\n\n${prompt}`
    : prompt;
}

// Who a ticket is for: our user id for people, the client for services.
export function requester(caller: Caller): string {
  switch (caller.kind) {
    case "human":
      return caller.userId;
    case "service":
      return caller.subject;
  }
}

// The tickets API request. The requester comes from the token, never from the model.
export function ticketBody(request: TicketRequest, caller: Caller): Record<string, string> {
  return {
    title: request.title,
    description: request.description,
    requester_id: requester(caller),
  };
}

export function invocationUrl(agent: AgentRuntimeArn, region: string): string {
  return (
    `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/` +
    `${encodeURIComponent(agent)}/invocations?qualifier=DEFAULT`
  );
}

export function render(event: AnswerEvent): string {
  switch (event.kind) {
    case "text":
      return event.text;
    case "failed":
      return `\n[error: ${event.message}]\n`;
  }
}
