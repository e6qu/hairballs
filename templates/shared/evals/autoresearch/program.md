# autoresearch: improve an agent's system prompt against a fixed eval suite

This is a program for an autonomous coding agent: Claude Code, or the org's opencode or pi harness running headless.

The idea comes from Karpathy's [autoresearch](https://github.com/karpathy/autoresearch):
- edit one file;
- run a fixed evaluation with a fixed budget;
- keep the change if the metric improves, otherwise revert it;
- log everything and repeat.

Here, the file is an agent's **system prompt**, and the evaluation is the category's **scenario eval suite** (`org-evals`).

Humans edit this `program.md`. The agent edits only the prompt.

## Setup

Work with the human to agree on:

1. **The target**: a category suite and a variant. For example, suite `templates/generic-agents/evals` and variant `strands-sdk`. The editable file is `templates/generic-agents/<variant>/prompts/system.md`.
2. **The budget**:
   - `MAX_EXPERIMENTS` (default 20);
   - `MAX_TOTAL_USD` (default 10.00), for all runs together, including the final holdout check;
   - `RUN_USD` (default 1.00), the `--max-usd` for each experiment.

   An experiment on the generic suite with Haiku costs roughly $0.30–0.60. That is an estimate: the first run tells you the real figure.
3. **A run tag**, based on the date and variant, e.g. `sep27-strands-sdk`. The branch `autoresearch/<tag>` must not exist yet.

Then:

1. Create the branch from the current `main`: `git checkout -b autoresearch/<tag>`.
2. Read, for context:
   - the variant's `README.md`, `prompts/system.md` and `config/agent.toml`;
   - the category tools' descriptions (`TOOL_DESCRIPTIONS` in the tools package);
   - `suite.toml`, `actors.toml` and the **dev** scenarios in `scenarios/dev/`.
3. **Do not open `scenarios/holdout/`.** Those scenarios measure whether your changes generalise. Reading them spoils that.
4. Check that the eval tooling works, without spending anything:

   ```bash
   cd templates/shared/evals && uv sync --extra bedrock
   uv run org-evals check --suite ../../generic-agents/evals
   ```

5. Create `results.tsv` in the repository root with this header row. Leave it untracked, and never commit it.

   ```
   commit	score	safety_failures	cost_usd	prompt_chars	status	description
   ```

Confirm the setup with the human, then start.

## What you may and may not do

**You may:**
- edit the variant's `prompts/system.md`: wording, structure, examples, ordering, and removing text.

**You may not:**
- edit anything else. In particular, leave alone:
  - the scenarios, `suite.toml`, `actors.toml`;
  - the `org-evals` code;
  - the tools and their descriptions;
  - `config/agent.toml` (limits, tool allow-list, approvals);
  - the harness code.
- weaken a safety rule in the prompt:
  - approvals and four-eyes;
  - never revealing credentials or personal data;
  - not retrying blocked tools.
- teach to the test. Don't paste scenario prompts, expected strings (`TCK-`, `180`...) or answers into the prompt. Improvements must be general instructions that would help real users.
- put personal data, secrets, or user-specific content in the prompt. The prompt is shared by every user, and must stay identical across users so that Bedrock prompt caching works.
- install packages, change models, or run the holdout split before the final step.

**The goal: the highest dev `score` with `safety_failures: 0`.**

**Simplicity criterion:** all else being equal, a shorter and clearer prompt is better. Keep a change that removes text and keeps the score. Don't keep a tiny gain that adds a paragraph of special cases.

## Running one experiment

```bash
cd templates/shared/evals
uv run org-evals run --suite ../../generic-agents/evals --variant <variant> --split dev \
  --max-usd <RUN_USD> > run.log 2>&1
grep "^score:\|^safety_failures:\|^complete:\|^cost_usd:" run.log
```

- Redirect the output; don't let it flood your context.
- `run.log` holds only summary lines. For the failing checks, re-run with `--out <dir>` and read `<dir>/report.md`.
- The run starts the variant locally and uses the suite's default model (Haiku) for both the agent and the judge.

## The loop

Stop when either limit is reached: `MAX_EXPERIMENTS` experiments, or `MAX_TOTAL_USD` spent (the sum of the `cost_usd` column). **This loop does not run forever**: every experiment costs money.

1. **Baseline:** run the eval on the unchanged prompt. Record it as `baseline` with status `keep`.
2. **Each experiment:**
   1. Look at the latest failing checks in `report.md`, and form one hypothesis. For example: "the model computes in its head: make the calculator rule more prominent".
   2. Edit `prompts/system.md` to test that hypothesis, then `git commit` it.
   3. Run the eval, and read `score`, `safety_failures`, `complete` and `cost_usd`.
   4. Decide:
      - **keep** if `complete: yes`, `safety_failures: 0`, and one of:
        - the score is higher than the best kept score by at least one run's worth (`1 / (scenarios × repeats)`). If the gain is exactly one run's worth, re-run once and keep it only if the gain holds.
        - the score is equal and the prompt is shorter.
      - **discard** (`git reset --hard HEAD~1`) otherwise.
      - **crash** if the run failed or was incomplete. Fix an obvious mistake in your edit once; otherwise discard.
   5. Append a row to `results.tsv` with the short commit, score, safety failures, cost, prompt length in characters, status and a one-line description.
3. **Don't stop to ask whether to continue** until the budget is reached. The human may be away. If you run out of ideas:
   - re-read the failing checks;
   - try combining earlier near-misses;
   - try removing instructions.

## Finishing

1. Run the **holdout** split once for the baseline prompt and once for the best prompt:

   ```bash
   git show <baseline-commit>:templates/generic-agents/<variant>/prompts/system.md > /tmp/baseline-prompt.md
   uv run org-evals run --suite ../../generic-agents/evals --variant <variant> --split holdout \
     --prompt /tmp/baseline-prompt.md --out /tmp/autoresearch/holdout-baseline > holdout-baseline.log 2>&1
   uv run org-evals run --suite ../../generic-agents/evals --variant <variant> --split holdout \
     --out /tmp/autoresearch/holdout-best > holdout-best.log 2>&1
   uv run org-evals compare /tmp/autoresearch/holdout-baseline/report.json /tmp/autoresearch/holdout-best/report.json
   ```

2. Write `autoresearch-report.md` in the repository root. Commit it on the branch. It covers:
   - the dev score from baseline to best;
   - the holdout comparison;
   - the total cost;
   - the kept changes, with one line each;
   - the discarded ideas worth knowing about.

   If the holdout score dropped, or any holdout safety scenario failed, say so at the top. That means the prompt overfitted the dev scenarios, and the change should not ship.
3. Push the branch and open a pull request for human review. **Never merge it yourself, and never deploy.** A human reviews the prompt diff.
4. Before promoting a merged prompt to production, re-run the suite with the production model (`--model sonnet`). Then roll it out with an AgentCore A/B test (`agentcore run ab-test`, `agentcore promote ab-test`).

## Running it

- **The researcher's environment:**
  - the repository, `git`, `uv` and `node`;
  - Bedrock access for the eval model only (Haiku);
  - no production credentials;
  - no network access beyond Bedrock and the package mirrors.
- **The researcher's permissions:** edit one file (the variant's `prompts/system.md`); run `git`, `uv run org-evals` and `grep`. The same deny-by-default model applies as for the templates' own agents.
- **Managed counterparts in production:**
  - `agentcore run recommendation` optimises a system prompt or tool descriptions from real traces;
  - `agentcore add online-eval` and `agentcore run batch-evaluation` score production sessions.

  Use them after deployment. This loop is for pre-merge work.
