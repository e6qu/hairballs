// Machine clients (Auth0 client credentials) may read tickets but never open one.
forbid (
  principal,
  action == AgentCore::Action::"tickets___create_ticket",
  resource == AgentCore::Gateway::"${gateway_arn}"
)
when { principal.hasTag("gty") && principal.getTag("gty") == "client-credentials" };
