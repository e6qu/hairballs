// The helpdesk agent behind an Auth0 JWT authorizer: it knows who is calling (the shell).
import { Agent, tool } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";
import { firstMessage, owns } from "./core.ts";
import {
  type Caller,
  type SessionId,
  type Subject,
  claimsOf,
  parseCaller,
  parseInvocation,
  parseSessionId,
  parseTicketRequest,
} from "./domain.ts";
import { openTicket } from "./tickets.ts";

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
    callback: ({ title, description }) =>
      openTicket(parseTicketRequest(title, description), caller),
  });
  return new Agent({ model: MODEL_ID, systemPrompt: SYSTEM_PROMPT, tools: [createTicket] });
}

const agents = new Map<SessionId, { owner: Subject; agent: Agent }>();

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload, context) {
      const caller = parseCaller(claimsOf(context.headers["authorization"])); // on the allowlist
      const session = parseSessionId(context.sessionId);
      const prompt = parseInvocation(payload);
      let text: string = prompt;
      if (!agents.has(session)) {
        agents.set(session, { owner: caller.subject, agent: newAgent(caller) });
        text = firstMessage(caller, prompt);
      }
      const { owner, agent } = agents.get(session)!;
      if (!owns(owner, caller)) throw new Error("this session belongs to another caller");
      for await (const event of agent.stream(text)) {
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
