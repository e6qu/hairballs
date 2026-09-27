// Call the tickets API with a token from the AgentCore Identity token vault (shell).
import { withAccessToken } from "bedrock-agentcore/identity";
import { ticketBody } from "./core.ts";
import { type Caller, type TicketId, type TicketRequest, parseTicketCreated } from "./domain.ts";

const TICKETS_API = "https://tickets.fintech.example";

const ticketsToken = withAccessToken({
  providerName: "auth0-tickets", // the credential provider in the token vault
  authFlow: "M2M", // client credentials: the agent acts as itself
  scopes: ["tickets:write"],
  customParameters: { audience: TICKETS_API }, // Auth0 needs the API's audience
})(async (accessToken: string) => accessToken); // the agent never holds a client secret

export async function openTicket(request: TicketRequest, caller: Caller): Promise<TicketId> {
  const token = await ticketsToken();
  const response = await fetch(`${TICKETS_API}/tickets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(ticketBody(request, caller)),
  });
  if (!response.ok) throw new Error(`tickets API: ${response.status}`);
  return parseTicketCreated(await response.json()); // outside data -> domain type
}
