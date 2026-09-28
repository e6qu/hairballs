// Everyone signed in through Auth0 may use the ticket tools.
permit (
  principal is AgentCore::OAuthUser,
  action in AgentCore::Action::"tickets",
  resource == AgentCore::Gateway::"${gateway_arn}"
);
