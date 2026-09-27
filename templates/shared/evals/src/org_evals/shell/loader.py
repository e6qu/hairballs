"""Reading a suite directory (shell)::

<suite>/suite.toml              variants, services, models + prices, defaults
<suite>/actors.toml             synthetic test users
<suite>/scenarios/dev/*.toml    scenarios that may be read and optimised against
<suite>/scenarios/holdout/*.toml  scenarios kept back for final checks (autoresearch never reads them)
"""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from org_agents.parsing import ParseError

from org_evals.domain import Actor, ActorName, Scenario, Split, parse_actors
from org_evals.suite import Suite


@dataclass(frozen=True, slots=True)
class LoadedSuite:
    root: Path
    suite: Suite
    actors: Mapping[ActorName, Actor]
    scenarios: tuple[Scenario, ...]

    def select(
        self, splits: tuple[Split, ...], tags: frozenset[str], ids: frozenset[str]
    ) -> tuple[Scenario, ...]:
        return tuple(
            s
            for s in self.scenarios
            if s.split in splits
            and (not tags or any(t.value in tags for t in s.tags))
            and (not ids or s.id.value in ids)
        )


def _toml(path: Path) -> object:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except tomllib.TOMLDecodeError as exc:
        raise ParseError(str(path), f"is not valid TOML: {exc}") from exc
    except OSError as exc:
        raise ParseError(str(path), f"cannot be read: {exc}") from exc


def load_suite(root: Path) -> LoadedSuite:
    suite = Suite.parse(_toml(root / "suite.toml"), "suite.toml")
    actors = parse_actors(_toml(root / "actors.toml"), "actors.toml")
    scenarios: list[Scenario] = []
    for split in Split:
        for file in sorted((root / "scenarios" / split.value).glob("*.toml")):
            where = f"scenarios/{split.value}/{file.name}"
            scenarios.append(Scenario.parse(_toml(file), split, actors, where))
    seen: set[str] = set()
    for scenario in scenarios:
        if scenario.id.value in seen:
            raise ParseError(f"scenarios/**/{scenario.id.value}", "duplicate scenario id")
        seen.add(scenario.id.value)
    return LoadedSuite(root, suite, actors, tuple(scenarios))
