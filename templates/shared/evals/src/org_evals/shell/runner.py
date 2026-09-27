"""Running a suite against one variant (shell): start processes, play scenarios, score, judge."""

from __future__ import annotations

import os
import threading
import uuid
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from org_agents.core.pricing import cost_of
from org_agents.domain import Usd
from org_agents.parsing import ParseError

from org_evals.core.report import Report, RunResult, summarize
from org_evals.core.scoring import Check, agent_cost, check_scenario, judge_transcript, total_usage
from org_evals.domain import (
    Actor,
    ActorName,
    AuditSeen,
    Cancel,
    Decide,
    ObservedReply,
    PricedModel,
    Say,
    Scenario,
    Split,
    Transcript,
    parse_audit,
)
from org_evals.shell.client import AgentClient, TransportError
from org_evals.shell.judge import Judge
from org_evals.shell.loader import LoadedSuite
from org_evals.shell.processes import ManagedProcess
from org_evals.suite import VariantSpec

READY_TIMEOUT_SECONDS = 180.0  # first start may include `uv sync`


@dataclass(frozen=True, slots=True)
class RunPlan:
    loaded: LoadedSuite
    variant: VariantSpec
    agent_model: PricedModel
    scenarios: tuple[Scenario, ...]
    splits: tuple[Split, ...]
    repeats: int
    concurrency: int
    budget: Usd
    system_prompt: Path | None  # override of the variant's prompt (what autoresearch edits)
    judge: Judge | None


def play(
    client: AgentClient,
    agent: ManagedProcess,
    scenario: Scenario,
    actors: Mapping[ActorName, Actor],
    session: str,
) -> Transcript:
    replies: list[ObservedReply] = []
    error: str | None = None
    for i, step in enumerate(scenario.steps, start=1):
        payload: dict[str, object]
        match step:
            case Say(text=text):
                payload = {"prompt": text, "message_id": f"m{i}"}
            case Decide(decision=decision):
                pending = next((r.approval_id for r in reversed(replies) if r.approval_id), None)
                if pending is None:
                    error = f"step {i}: there is no approval request to answer"
                    break
                payload = {"approval": {"id": pending, "decision": decision.value}, "message_id": f"m{i}"}
            case Cancel():
                payload = {"cancel": True, "message_id": f"m{i}"}
        try:
            replies.append(client.send(session, actors[step.actor], payload))
        except (TransportError, ParseError) as exc:
            error = f"step {i}: {exc}"
            break

    audit: list[AuditSeen] = []
    lines: list[str] = []
    for line, record in agent.audit_for(session):
        lines.append(line)
        try:
            seen = parse_audit(record)
        except ParseError:
            continue  # an unexpected record shape is not the scenario's fault
        if seen is not None:
            audit.append(seen)
    return Transcript(tuple(replies), tuple(audit), tuple(lines), error)


def _score(plan: RunPlan, scenario: Scenario, repeat: int, transcript: Transcript) -> RunResult:
    checks = list(check_scenario(scenario, transcript, plan.agent_model.price))
    judge_cost = Usd(Decimal(0))
    if plan.judge is not None and scenario.rubric is not None and transcript.error is None:
        try:
            judgement = plan.judge.judge(scenario.rubric, judge_transcript(scenario, transcript))
        except Exception as exc:  # the judge failing must not look like the agent passing
            checks.append(Check("judge", False, f"judge error: {type(exc).__name__}: {exc}"[:300]))
        else:
            judge_cost = cost_of(judgement.usage, plan.judge.model.price)
            checks.append(Check("judge: rubric", judgement.verdict.passed, judgement.verdict.reason))
    return RunResult(
        scenario=scenario.id,
        split=scenario.split,
        tags=scenario.tags,
        repeat=repeat,
        checks=tuple(checks),
        agent_cost=agent_cost(transcript, plan.agent_model.price),
        judge_cost=judge_cost,
        tokens=total_usage(transcript).total,
        latency_ms=sum(r.latency_ms for r in transcript.replies),
    )


def _agent_env(plan: RunPlan) -> dict[str, str]:
    suite = plan.loaded.suite
    env = dict(os.environ)
    env.update(
        {
            "PYTHONUNBUFFERED": "1",
            "BEDROCK_MODEL_ID": plan.agent_model.id.value,
            "AWS_REGION": suite.region.value,
        }
    )
    if plan.system_prompt is not None:
        env["AGENT_SYSTEM_PROMPT"] = str(plan.system_prompt.resolve())
    env.update(plan.variant.env)
    return env


def run_plan(plan: RunPlan) -> Report:
    suite = plan.loaded.suite
    root = plan.loaded.root
    run_id = uuid.uuid4().hex[:8]
    jobs = [(scenario, repeat) for repeat in range(1, plan.repeats + 1) for scenario in plan.scenarios]
    results: list[RunResult] = []
    spent = Usd(Decimal(0))
    lock = threading.Lock()

    with ExitStack() as stack:
        for name in plan.variant.services:
            spec = suite.services[name]
            service = ManagedProcess(
                name,
                spec.command,
                (root / spec.directory).resolve(),
                {**os.environ, **spec.env},
                spec.port,
                None,
            )
            stack.callback(service.stop)
            service.start(READY_TIMEOUT_SECONDS)
        agent = ManagedProcess(
            plan.variant.name,
            plan.variant.command,
            (root / plan.variant.directory).resolve(),
            _agent_env(plan),
            plan.variant.port,
            "/ping",
        )
        stack.callback(agent.stop)
        agent.start(READY_TIMEOUT_SECONDS)
        client = AgentClient(agent.base_url, suite.claims, suite.defaults.request_timeout_seconds.value)

        def work(job: tuple[Scenario, int]) -> None:
            nonlocal spent
            scenario, repeat = job
            with lock:
                if spent.amount >= plan.budget.amount:
                    return  # budget reached: the report will say it is incomplete
            session = f"eval-{run_id}-{scenario.id.value}-r{repeat}-{uuid.uuid4().hex}"
            result = _score(
                plan, scenario, repeat, play(client, agent, scenario, plan.loaded.actors, session)
            )
            with lock:
                results.append(result)
                spent = spent + result.agent_cost + result.judge_cost

        with ThreadPoolExecutor(max_workers=plan.concurrency) as pool:
            list(pool.map(work, jobs))

    return summarize(
        suite.name, plan.variant.name, plan.agent_model.id.value, plan.splits, len(jobs), results
    )
