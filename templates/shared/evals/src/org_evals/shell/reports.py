"""Report files (shell): ``report.json`` (rendered here, parsed back for ``compare``) and ``report.md``."""

from __future__ import annotations

import json
from pathlib import Path

from org_agents.domain import TokenCount, Usd
from org_agents.parsing import ParseError, expect_int, expect_mapping, expect_sequence, expect_str, field

from org_evals.core.report import Report, ScenarioSummary, markdown
from org_evals.domain import ScenarioId, Split, Tag


def render(report: Report) -> dict[str, object]:
    return {
        "suite": report.suite,
        "variant": report.variant,
        "model": report.model,
        "splits": [s.value for s in report.splits],
        "planned_runs": report.planned_runs,
        "score": str(report.score.value),
        "safety_failures": report.safety_failures,
        "complete": report.complete,
        "agent_cost_usd": str(report.agent_cost.amount),
        "judge_cost_usd": str(report.judge_cost.amount),
        "tokens": report.tokens.value,
        "latency_p50_ms": report.latency_p50_ms,
        "latency_p95_ms": report.latency_p95_ms,
        "scenarios": [
            {
                "id": s.scenario.value,
                "tags": sorted(t.value for t in s.tags),
                "runs": s.runs,
                "passes": s.passes,
                "sample_failures": list(s.sample_failures),
            }
            for s in report.scenarios
        ],
    }


def parse(raw: object, path: str) -> Report:
    doc = expect_mapping(raw, path)

    def text(name: str) -> str:
        return expect_str(field(doc, name, path), f"{path}.{name}")

    def count(name: str) -> int:
        return expect_int(field(doc, name, path), f"{path}.{name}", minimum=0)

    scenarios = []
    for i, item in enumerate(expect_sequence(field(doc, "scenarios", path), f"{path}.scenarios")):
        where = f"{path}.scenarios[{i}]"
        s = expect_mapping(item, where)
        scenarios.append(
            ScenarioSummary(
                scenario=ScenarioId.parse(field(s, "id", where), f"{where}.id"),
                tags=frozenset(
                    Tag.parse(t, f"{where}.tags[{j}]")
                    for j, t in enumerate(expect_sequence(s.get("tags", []), where))
                ),
                runs=expect_int(field(s, "runs", where), f"{where}.runs", minimum=0),
                passes=expect_int(field(s, "passes", where), f"{where}.passes", minimum=0),
                sample_failures=tuple(
                    expect_str(f, f"{where}.sample_failures[{j}]")
                    for j, f in enumerate(expect_sequence(s.get("sample_failures", []), where))
                ),
            )
        )
    try:
        splits = tuple(
            Split(expect_str(s, f"{path}.splits")) for s in expect_sequence(field(doc, "splits", path), path)
        )
    except ValueError as exc:
        raise ParseError(f"{path}.splits", "unknown split") from exc
    return Report(
        suite=text("suite"),
        variant=text("variant"),
        model=text("model"),
        splits=splits,
        planned_runs=count("planned_runs"),
        scenarios=tuple(scenarios),
        agent_cost=Usd.parse(field(doc, "agent_cost_usd", path), f"{path}.agent_cost_usd"),
        judge_cost=Usd.parse(field(doc, "judge_cost_usd", path), f"{path}.judge_cost_usd"),
        tokens=TokenCount(count("tokens")),
        latency_p50_ms=count("latency_p50_ms"),
        latency_p95_ms=count("latency_p95_ms"),
    )


def write(report: Report, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(render(report), indent=2) + "\n", encoding="utf-8")
    (out / "report.md").write_text(markdown(report), encoding="utf-8")


def read(path: Path) -> Report:
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ParseError(str(path), f"cannot be read: {exc}") from exc
    return parse(raw, str(path))
