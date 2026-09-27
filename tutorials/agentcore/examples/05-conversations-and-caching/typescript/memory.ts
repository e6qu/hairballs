// A conversation thread in AgentCore Memory: one event per message, read back per branch.
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  type CreateEventInput,
  type ListEventsInput,
} from "@aws-sdk/client-bedrock-agentcore";

const MEMORY_ID = process.env.MEMORY_HELPDESK_MEMORY_ID!;
const memory = new BedrockAgentCoreClient({ region: "eu-west-1" });

export type Role = "USER" | "ASSISTANT";

/** Store one message; return its event id. `branch` + `forkFrom` start a new branch. */
export async function addMessage(
  actorId: string,
  sessionId: string,
  role: Role,
  text: string,
  branch?: string,
  forkFrom?: string,
): Promise<string> {
  const input: CreateEventInput = {
    memoryId: MEMORY_ID,
    actorId,
    sessionId,
    eventTimestamp: new Date(),
    payload: [{ conversational: { role, content: { text } } }],
  };
  if (branch && forkFrom) {
    input.branch = { name: branch, rootEventId: forkFrom }; // first event of a branch
  } else if (branch) {
    input.branch = { name: branch }; // later events on the branch
  }
  const { event } = await memory.send(new CreateEventCommand(input));
  return event!.eventId!;
}

/** [role, text] pairs of the main thread, or of a branch, oldest first. */
export async function readThread(
  actorId: string,
  sessionId: string,
  branch?: string,
): Promise<[Role, string][]> {
  const input: ListEventsInput = {
    memoryId: MEMORY_ID,
    actorId,
    sessionId,
    includePayloads: true,
    maxResults: 100,
  };
  if (branch) {
    input.filter = { branch: { name: branch, includeParentBranches: true } };
  }
  const { events = [] } = await memory.send(new ListEventsCommand(input));
  return events
    .filter((e) => branch || !e.branch) // main-thread events carry no branch
    .sort((a, b) => a.eventTimestamp!.getTime() - b.eventTimestamp!.getTime()) // API: newest first
    .flatMap((e) => e.payload ?? [])
    .flatMap((p): [Role, string][] =>
      p.conversational
        ? [[p.conversational.role as Role, p.conversational.content?.text ?? ""]]
        : [],
    );
}
