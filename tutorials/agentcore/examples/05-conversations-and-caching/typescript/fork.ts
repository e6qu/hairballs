// Write a short thread, then fork it: the user edits their second question (the shell).
// Usage: MEMORY_HELPDESK_MEMORY_ID=... node dist/fork.js
import { randomUUID } from "node:crypto";
import { thread } from "./core.ts";
import {
  type EventId,
  type Placement,
  type Role,
  message,
  parseActorId,
  parseBranchName,
  parseMemoryId,
  parseSessionId,
} from "./domain.ts";
import { addMessage, readEvents } from "./memory.ts";

const memory = parseMemoryId(process.env.MEMORY_HELPDESK_MEMORY_ID);
const user = parseActorId("usr_7f3a9c"); // a stable user id (tutorial 06 takes it from the token)
const session = parseSessionId(randomUUID());
const lyon = parseBranchName("lyon");

const say = (role: Role, text: string, where: Placement = { kind: "main" }): Promise<EventId> =>
  addMessage(memory, user, session, message(role, text), where, new Date());

await say("USER", "What is the hotel limit per night?");
const answer = await say("ASSISTANT", "Up to 180 EUR in major cities.");
await say("USER", "Is Paris a major city?");
await say("ASSISTANT", "Yes.");

// Fork after the first answer: the second question becomes "Is Lyon a major city?".
await say("USER", "Is Lyon a major city?", {
  kind: "startBranch",
  branch: lyon,
  forkAfter: answer,
});
await say("ASSISTANT", "Yes.", { kind: "onBranch", branch: lyon });

console.log("main:", thread(await readEvents(memory, user, session, undefined), false));
console.log("lyon:", thread(await readEvents(memory, user, session, lyon), true));
