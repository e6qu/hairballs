// The helpdesk agent behind an Auth0 JWT authorizer: it knows who is calling.
import { Agent, tool } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";
import { callerOf, type Caller } from "./identity.js";
import { openTicket } from "./tickets.js";

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Open a ticket only when the user asks for one.
Never reveal credentials or personal data.`;

function newAgent(caller: Caller): Agent {
  const createTicket = tool({
    name: "create_ticket",
    description: "Open an IT helpdesk ticket for the current user and return its id.",
    inputSchema: z.object({
      title: z.string().describe("One-line summary of the problem."),
      description: z.string().describe("What the user needs, in their own words."),
    }),
    // The requester comes from the verified token, never from the model.
    callback: ({ title, description }) =>
      openTicket(title, description, caller.userId ?? caller.subject),
  });
  return new Agent({ model: MODEL_ID, systemPrompt: SYSTEM_PROMPT, tools: [createTicket] });
}

const agents = new Map<string, { owner: string; agent: Agent }>(); // session id -> owner, agent

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),
    async *process(payload, context) {
      const caller = callerOf(context.headers["authorization"] ?? ""); // on the allowlist
      const sessionId = context.sessionId || "local";
      let prompt = payload.prompt;
      if (!agents.has(sessionId)) {
        agents.set(sessionId, { owner: caller.subject, agent: newAgent(caller) });
        if (caller.firstName) {
          // per-user details go in the first message, not the system prompt
          prompt = `[Context: you are assisting ${caller.firstName}.]\n\n${prompt}`;
        }
      }
      const { owner, agent } = agents.get(sessionId)!;
      if (owner !== caller.subject) {
        // Runtime doesn't tie sessions to users; the agent does
        throw new Error("this session belongs to another user");
      }
      for await (const event of agent.stream(prompt)) {
        if (
          event.type === "modelStreamUpdateEvent" &&
          event.event.type === "modelContentBlockDeltaEvent" &&
          event.event.delta.type === "textDelta"
        ) {
          yield { data: event.event.delta.text };
        }
      }
    },
  },
});

app.run();
