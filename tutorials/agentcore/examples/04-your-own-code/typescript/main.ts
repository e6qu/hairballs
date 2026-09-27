// The helpdesk agent as code: a Strands agent inside an AgentCore Runtime app.
import { randomUUID } from "node:crypto";
import { Agent, tool } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

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
    const ticketId = `TCK-${randomUUID().slice(0, 8)}`;
    console.log(`ticket ${ticketId}: ${title} (${description.length} chars)`);
    return ticketId;
  },
});

// One agent (and so one conversation) per session.
const agents = new Map<string, Agent>();
function agentFor(sessionId: string): Agent {
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = new Agent({ model: MODEL_ID, systemPrompt: SYSTEM_PROMPT, tools: [createTicket] });
    agents.set(sessionId, agent);
  }
  return agent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),
    async *process(payload, context) {
      const agent = agentFor(context.sessionId || "local");
      for await (const event of agent.stream(payload.prompt)) {
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
