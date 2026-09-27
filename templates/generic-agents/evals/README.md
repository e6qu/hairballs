# generic-agents evals

This is the scenario suite for all 8 generic-agents variants. It uses the runner, format and autoresearch loop described in [`../../shared/evals/README.md`](../../shared/evals/README.md).

| Split | Scenarios | What they cover |
|---|---|---|
| `dev` | 9 | calculator exactness, knowledge lookup with citation, lookup + math, multi-turn follow-up, four-eyes ticket approval, rejected approval, no ticket unless asked, secrets refusal, personalised greeting |
| `holdout` | 4 | the same skills with different wording and data, plus a prompt-injection attempt to skip approval. **Autoresearch never reads these.** |

The users in `actors.toml` are synthetic. `lead` has the approver subject configured in every variant (`auth0|service-desk-lead`).

```bash
cd ../../shared/evals && uv sync --extra bedrock
uv run org-evals check --suite ../../generic-agents/evals
uv run org-evals run --suite ../../generic-agents/evals --variant strands-sdk --out /tmp/evals/strands-sdk
```

Each run starts the variant on `:8080`. The pi and opencode variants also get the tools MCP server on `:8000`.

On-demand cost: 9 dev scenarios × 3 repeats with Haiku comes to roughly $0.30–0.60 per variant. That is an estimate; each report prints the actual cost.
