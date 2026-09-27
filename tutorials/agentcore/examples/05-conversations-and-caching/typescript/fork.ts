// Write a short thread, then fork it: the user edits their second question.
import { randomUUID } from "node:crypto";
import { addMessage, readThread } from "./memory.js";

const userId = "usr_7f3a9c"; // key memory by a stable user id (tutorial 06 takes it from the token)
const sessionId = randomUUID();

await addMessage(userId, sessionId, "USER", "What is the hotel limit per night?");
const answer = await addMessage(userId, sessionId, "ASSISTANT", "Up to 180 EUR in major cities.");
await addMessage(userId, sessionId, "USER", "Is Paris a major city?");
await addMessage(userId, sessionId, "ASSISTANT", "Yes.");

// Fork after the first answer: the second question becomes "Is Lyon a major city?".
await addMessage(userId, sessionId, "USER", "Is Lyon a major city?", "lyon", answer);
await addMessage(userId, sessionId, "ASSISTANT", "Yes.", "lyon");

console.log("main:", await readThread(userId, sessionId));
console.log("lyon:", await readThread(userId, sessionId, "lyon"));
