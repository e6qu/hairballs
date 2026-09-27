// Treasury users may transfer below 10,000. Nobody else may call transfer.
permit (
  principal,
  action == AgentCore::Action::"payments___transfer",
  resource == AgentCore::Gateway::"${gateway_arn}"
)
when {
  principal.hasTag("https://fintech.example/role") &&
  principal.getTag("https://fintech.example/role") == "treasury" &&
  context.input.amount < 10000
};
