"""Aggregating scenario runs into a report (pure): pass rates, safety, cost, latency."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from org_agents.domain import TokenCount, Usd

from org_evals.core.scoring import Check
from org_evals.domain import SAFETY, Ratio, ScenarioId, Split, Tag


@dataclass(frozen=True, slots=True)
class RunResult:
    scenario: ScenarioId
    split: Split
    tags: frozenset[Tag]
    repeat: int
    checks: tuple[Check, ...]
    agent_cost: Usd
    judge_cost: Usd
    tokens: TokenCount
    latency_ms: int

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    @property
    def failures(self) -> tuple[Check, ...]:
        return tuple(c for c in self.checks if not c.passed)


@dataclass(frozen=True, slots=True)
class ScenarioSummary:
    scenario: ScenarioId
    tags: frozenset[Tag]
    runs: int
    passes: int
    sample_failures: tuple[str, ...]  # a few failed checks, for the report

    @property
    def pass_rate(self) -> Ratio:
        return Ratio.of(self.passes, self.runs)


@dataclass(frozen=True, slots=True)
class Report:
    suite: str
    variant: str
    model: str
    splits: tuple[Split, ...]
    planned_runs: int
    scenarios: tuple[ScenarioSummary, ...]
    agent_cost: Usd
    judge_cost: Usd
    tokens: TokenCount
    latency_p50_ms: int
    latency_p95_ms: int

    @property
    def completed_runs(self) -> int:
        return sum(s.runs for s in self.scenarios)

    @property
    def complete(self) -> bool:
        """False when the budget ran out before every planned run was played."""
        return self.completed_runs == self.planned_runs

    @property
    def score(self) -> Ratio:
        """Mean scenario pass rate: every scenario weighs the same, whatever its repeat count."""
        if not self.scenarios:
            return Ratio(Decimal(0))
        total = sum((s.pass_rate.value for s in self.scenarios), Decimal(0))
        return Ratio((total / len(self.scenarios)).quantize(Decimal("0.000001")))

    @property
    def safety_failures(self) -> int:
        """Failed runs of scenarios tagged ``safety``: any failure here must block a change."""
        return sum(s.runs - s.passes for s in self.scenarios if SAFETY in s.tags)

    @property
    def total_cost(self) -> Usd:
        return self.agent_cost + self.judge_cost


def _percentile(values: list[int], pct: int) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct / 100 * (len(ordered) - 1))))
    return ordered[index]


def summarize(
    suite: str, variant: str, model: str, splits: tuple[Split, ...], planned_runs: int, runs: list[RunResult]
) -> Report:
    by_scenario: dict[ScenarioId, list[RunResult]] = {}
    for run in runs:
        by_scenario.setdefault(run.scenario, []).append(run)
    summaries = tuple(
        ScenarioSummary(
            scenario=sid,
            tags=results[0].tags,
            runs=len(results),
            passes=sum(1 for r in results if r.passed),
            sample_failures=tuple(
                dict.fromkeys(f"{c.name}: {c.detail}"[:240] for r in results for c in r.failures)
            )[:3],
        )
        for sid, results in sorted(by_scenario.items(), key=lambda kv: kv[0].value)
    )
    latencies = [r.latency_ms for r in runs]
    return Report(
        suite=suite,
        variant=variant,
        model=model,
        splits=splits,
        planned_runs=planned_runs,
        scenarios=summaries,
        agent_cost=sum((r.agent_cost for r in runs), Usd(Decimal(0))),
        judge_cost=sum((r.judge_cost for r in runs), Usd(Decimal(0))),
        tokens=sum((r.tokens for r in runs), TokenCount(0)),
        latency_p50_ms=_percentile(latencies, 50),
        latency_p95_ms=_percentile(latencies, 95),
    )


def summary_lines(report: Report) -> str:
    """Grep-able summary (one ``key: value`` per line), the metric the autoresearch loop reads."""
    return "\n".join(
        [
            "---",
            f"score:           {report.score.value}",
            f"safety_failures: {report.safety_failures}",
            f"complete:        {'yes' if report.complete else 'no'}",
            f"runs:            {report.completed_runs}/{report.planned_runs}",
            f"cost_usd:        {report.total_cost.amount}",
            f"agent_cost_usd:  {report.agent_cost.amount}",
            f"judge_cost_usd:  {report.judge_cost.amount}",
            f"tokens:          {report.tokens.value}",
            f"latency_p50_ms:  {report.latency_p50_ms}",
            f"latency_p95_ms:  {report.latency_p95_ms}",
        ]
    )


def markdown(report: Report) -> str:
    splits = ", ".join(s.value for s in report.splits)
    lines = [
        f"# Eval report: {report.suite} / {report.variant}",
        "",
        f"Model `{report.model}`, split {splits}. **Score {report.score.value}**, "
        f"safety failures {report.safety_failures}, runs {report.completed_runs}/{report.planned_runs}, "
        f"cost ${report.total_cost.amount} "
        f"(agent ${report.agent_cost.amount}, judge ${report.judge_cost.amount}), "
        f"latency p50 {report.latency_p50_ms} ms / p95 {report.latency_p95_ms} ms.",
        "",
        "| Scenario | Tags | Passed | Sample failures |",
        "|---|---|---|---|",
    ]
    for s in report.scenarios:
        tags = ", ".join(sorted(t.value for t in s.tags))
        failures = "<br>".join(f.replace("|", "\\|").replace("\n", " ") for f in s.sample_failures)
        lines.append(f"| `{s.scenario.value}` | {tags} | {s.passes}/{s.runs} | {failures} |")
    return "\n".join(lines) + "\n"


def comparison(reports: list[Report]) -> str:
    lines = [
        "| Variant | Model | Score | Safety failures | Runs | Cost (USD) | p50 ms | p95 ms |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in sorted(reports, key=lambda r: (-r.score.value, r.total_cost.amount)):
        lines.append(
            f"| {r.variant} | `{r.model}` | {r.score.value} | {r.safety_failures} | "
            f"{r.completed_runs}/{r.planned_runs} | {r.total_cost.amount} | "
            f"{r.latency_p50_ms} | {r.latency_p95_ms} |"
        )
    return "\n".join(lines) + "\n"
