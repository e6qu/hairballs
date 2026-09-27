// A conversation thread in AgentCore Memory: one event per message (the shell's Memory I/O).
import {
  BedrockAgentCoreClient,
  type Branch,
  CreateEventCommand,
  ListEventsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  type ActorId,
  type BranchName,
  type EventId,
  type MemoryId,
  type Message,
  type Placement,
  type SessionId,
  type ThreadEvent,
  parseEvent,
  parseEventId,
} from "./domain.ts";

const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

function branchOf(placement: Placement): Branch | undefined {
  switch (placement.kind) {
    case "main":
      return undefined;
    case "startBranch": // first event of a branch
      return { name: placement.branch, rootEventId: placement.forkAfter };
    case "onBranch": // later events on the branch
      return { name: placement.branch };
  }
}

// Store one message; return its event id.
export async function addMessage(
  memory: MemoryId,
  actor: ActorId,
  session: SessionId,
  message: Message,
  placement: Placement,
  at: Date,
): Promise<EventId> {
  const branch = branchOf(placement);
  const { event } = await client.send(
    new CreateEventCommand({
      memoryId: memory,
      actorId: actor,
      sessionId: session,
      eventTimestamp: at,
      payload: [{ conversational: { role: message.role, content: { text: message.text } } }],
      ...(branch ? { branch } : {}),
    }),
  );
  return parseEventId(event?.eventId);
}

// The session's events, or one branch's with the history it grew from.
export async function readEvents(
  memory: MemoryId,
  actor: ActorId,
  session: SessionId,
  branch: BranchName | undefined,
): Promise<ThreadEvent[]> {
  const { events = [] } = await client.send(
    new ListEventsCommand({
      memoryId: memory,
      actorId: actor,
      sessionId: session,
      includePayloads: true,
      maxResults: 100,
      ...(branch ? { filter: { branch: { name: branch, includeParentBranches: true } } } : {}),
    }),
  );
  return events.map(parseEvent); // outside data -> domain types
}
