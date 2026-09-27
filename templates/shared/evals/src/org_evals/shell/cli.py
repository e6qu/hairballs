"""``org-evals``: check scenario files, run a suite against a variant, compare reports.

    org-evals check   --suite generic-agents/evals
    org-evals run     --suite generic-agents/evals --variant strands-sdk [--split dev] [--repeats 3]
    org-evals compare out/strands-sdk/report.json out/pi-harness/report.json

``run`` calls Bedrock (the agent's model, and the judge unless ``--no-judge``): it costs money, so it
only runs when someone asks for it. Its budget (``--max-usd``) stops new runs once reached.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from org_agents.domain import Usd
from org_agents.parsing import ParseError

from org_evals.core.report import comparison, summary_lines
from org_evals.domain import Split
from org_evals.shell import reports
from org_evals.shell.judge import BedrockJudge, Judge
from org_evals.shell.loader import load_suite
from org_evals.shell.processes import ProcessError
from org_evals.shell.runner import RunPlan, run_plan

EXIT_OK, EXIT_RUN_ERROR, EXIT_CONFIG_ERROR = 0, 1, 2


def _splits(value: str) -> tuple[Split, ...]:
    return (Split.DEV, Split.HOLDOUT) if value == "all" else (Split(value),)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="org-evals", description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check", help="parse the suite and scenario files (no model calls)")
    check.add_argument("--suite", type=Path, required=True)

    run = sub.add_parser("run", help="run scenarios against one variant (calls Bedrock)")
    run.add_argument("--suite", type=Path, required=True)
    run.add_argument("--variant", required=True)
    run.add_argument("--split", choices=["dev", "holdout", "all"], default="dev")
    run.add_argument("--tag", action="append", default=[], help="only scenarios with this tag (repeatable)")
    run.add_argument("--scenario", action="append", default=[], help="only this scenario id (repeatable)")
    run.add_argument("--repeats", type=int)
    run.add_argument("--concurrency", type=int)
    run.add_argument("--model", help="agent model id or alias from suite.toml (default: suite agent_model)")
    judge = run.add_mutually_exclusive_group()
    judge.add_argument("--judge-model", help="judge model id or alias (default: suite judge_model)")
    judge.add_argument("--no-judge", action="store_true", help="skip rubric checks (code checks only)")
    run.add_argument("--max-usd", help="budget for this run, agent + judge (default: suite defaults.max_usd)")
    run.add_argument("--prompt", type=Path, help="system prompt file to use instead of the variant's")
    run.add_argument("--out", type=Path, help="write report.json and report.md here")

    compare = sub.add_parser("compare", help="compare report.json files as a Markdown table")
    compare.add_argument("reports", type=Path, nargs="+")
    return parser


def _check(args: argparse.Namespace) -> int:
    loaded = load_suite(args.suite)
    for scenario in loaded.scenarios:
        tags = ", ".join(sorted(t.value for t in scenario.tags))
        judged = " (judge)" if scenario.rubric else ""
        print(
            f"{scenario.split.value:8} {scenario.id.value:32} {len(scenario.steps)} steps  [{tags}]{judged}"
        )
    print(
        f"ok: {len(loaded.scenarios)} scenarios, {len(loaded.suite.variants)} variants, "
        f"{len(loaded.actors)} actors"
    )
    return EXIT_OK


def _run(args: argparse.Namespace) -> int:
    loaded = load_suite(args.suite)
    suite = loaded.suite
    if args.variant not in suite.variants:
        raise ParseError("--variant", f"unknown variant; one of {sorted(suite.variants)}")
    splits = _splits(args.split)
    scenarios = loaded.select(splits, frozenset(args.tag), frozenset(args.scenario))
    if not scenarios:
        raise ParseError("--split/--tag/--scenario", "no scenario matches")
    agent_model = suite.model(args.model or suite.agent_model.value, "--model")
    judge: Judge | None = None
    if not args.no_judge and any(s.rubric for s in scenarios):
        judge_name = args.judge_model or (suite.judge_model.value if suite.judge_model else None)
        if judge_name is None:
            raise ParseError(
                "--judge-model", "the suite has no judge_model; pass --judge-model or --no-judge"
            )
        judge = BedrockJudge(suite.model(judge_name, "--judge-model"), suite.region.value)
    defaults = suite.defaults
    plan = RunPlan(
        loaded=loaded,
        variant=suite.variants[args.variant],
        agent_model=agent_model,
        scenarios=scenarios,
        splits=splits,
        repeats=args.repeats or defaults.repeats.value,
        concurrency=args.concurrency or defaults.concurrency.value,
        budget=Usd.parse(args.max_usd, "--max-usd") if args.max_usd else defaults.max_usd,
        system_prompt=args.prompt,
        judge=judge,
    )
    if plan.repeats < 1 or plan.concurrency < 1:
        raise ParseError("--repeats/--concurrency", "must be >= 1")
    print(
        f"running {len(scenarios)} scenarios x {plan.repeats} on {plan.variant.name}"
        f" with {agent_model.id.value}"
        f" (budget ${plan.budget.amount})",
        file=sys.stderr,
    )
    report = run_plan(plan)
    if args.out:
        reports.write(report, args.out)
    print(summary_lines(report))
    return EXIT_OK


def _compare(args: argparse.Namespace) -> int:
    print(comparison([reports.read(p) for p in args.reports]), end="")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        match args.command:
            case "check":
                return _check(args)
            case "run":
                return _run(args)
            case _:
                return _compare(args)
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG_ERROR
    except ProcessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_RUN_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
