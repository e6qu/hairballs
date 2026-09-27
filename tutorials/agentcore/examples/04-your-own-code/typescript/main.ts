// The helpdesk agent as code: a Strands agent inside an AgentCore Runtime app (the shell).
import { randomUUID } from "node:crypto";
import { Agent, tool } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";
import { newTicketId, ticketLogLine } from "./core.ts";
import { type SessionId, parseInvocation, parseSessionId, parseTicketRequest } from "./domain.ts";

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Open a ticket only when the user asks for one.
Never reveal credentials or personal data.`;

const createTicket = tool({
  name: "create_ticket",
  description: "Open an IT helpdesk ticket and return its id.",
  inputSchema: z.object({
    title: z.string().describe("One-line summary of the problem."),
    description: z.string().describe("What the user needs, in their own words."),
  }),
  callback: ({ title, description }) => {
    const request = parseTicketRequest(title, description); // the model's arguments -> domain type
    const ticket = newTicketId(randomUUID().replaceAll("-", ""));
    console.log(ticketLogLine(ticket, request));
    return ticket;
  },
});

// One agent (and so one conversation) per session.
const agents = new Map<SessionId, Agent>();
function agentFor(session: SessionId): Agent {
  let agent = agents.get(session);
  if (!agent) {
    agent = new Agent({ model: MODEL_ID, systemPrompt: SYSTEM_PROMPT, tools: [createTicket] });
    agents.set(session, agent);
  }
  return agent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload, context) {
      const prompt = parseInvocation(payload); // outside data -> domain types, right here
      const session = parseSessionId(context.sessionId);
      for await (const event of agentFor(session).stream(prompt)) {
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

app.run(); // serves /invocations and /ping on 0.0.0.0:8080
