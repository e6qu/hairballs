// Pure logic: no AWS, no I/O, no clock, no randomness. Easy to test and to read.
import { type AnswerEvent, type TicketId, type TicketRequest, parseTicketId } from "./domain.ts";

// A ticket id from 8 random hex digits, which the shell supplies.
export function newTicketId(randomHex: string): TicketId {
  return parseTicketId(`TCK-${randomHex.slice(0, 8)}`);
}

export function ticketLogLine(ticket: TicketId, request: TicketRequest): string {
  return `ticket ${ticket}: ${request.title} (${request.description.length} chars)`;
}

// What to print for one event.
export function render(event: AnswerEvent): string {
  switch (event.kind) {
    case "text":
      return event.text;
    case "failed":
      return `\n[error: ${event.message}]\n`;
  }
}

// 0 if the agent answered without an error, 1 otherwise.
export function exitCode(events: readonly AnswerEvent[]): number {
  return events.length === 0 || events.some((e) => e.kind === "failed") ? 1 : 0;
}
