"""Pure logic: no AWS, no subprocess, no clock, no randomness."""

from __future__ import annotations

import base64
from dataclasses import dataclass

from domain import (
    BranchName,
    CommitMessage,
    Finished,
    Outcome,
    PullRequest,
    Repo,
    RepoPath,
    SessionId,
    TimedOut,
)

OUTPUT_LIMIT = 4000  # characters of output the model sees


def git_env(token_value: str) -> dict[str, str]:
    """Environment for one git process: the token goes here, never into argv, files or logs."""
    basic = base64.b64encode(f"x-access-token:{token_value}".encode()).decode()
    return {
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
    }


def clone_argv(repo: Repo) -> list[str]:
    return ["git", "clone", f"https://github.com/{repo.slug}.git", str(RepoPath.of(repo).path)]


def commit_steps(branch: BranchName, message: CommitMessage) -> list[list[str]]:
    """Local git steps before a push. None of them needs the token."""
    return [
        ["git", "switch", "-c", branch.value],
        ["git", "add", "-A"],
        ["git", "commit", "-m", message.text],
    ]


def describe(outcome: Outcome) -> str:
    """What the model sees after a command: the exit code and the end of the output."""
    match outcome:
        case Finished(exit_code=code, output=output):
            return f"exit {code}\n{output[-OUTPUT_LIMIT:]}"
        case TimedOut(output=output):
            return f"timed out\n{output[-OUTPUT_LIMIT:]}"


def task_session(task: str, nonce: str) -> SessionId:
    """One session per task. The nonce (a UUID) is passed in: no randomness here."""
    return SessionId.parse(f"coder-{task}-{nonce}")


@dataclass(frozen=True, slots=True)
class Done:
    """The tests pass: push and open the pull request."""


@dataclass(frozen=True, slots=True)
class AskToFix:
    attempt: int


@dataclass(frozen=True, slots=True)
class GiveUp:
    """A human takes over."""


def after_tests(outcome: Outcome, attempt: int, max_attempts: int) -> Done | AskToFix | GiveUp:
    """The test run decides, not the model."""
    if isinstance(outcome, Finished) and outcome.exit_code == 0:
        return Done()
    return AskToFix(attempt + 1) if attempt + 1 < max_attempts else GiveUp()


def pull_request_arguments(pr: PullRequest) -> dict[str, str]:
    """Arguments of the GitHub MCP tool create_pull_request."""
    return {
        "owner": pr.repo.owner,
        "repo": pr.repo.name,
        "title": pr.title,
        "head": pr.head.value,
        "base": pr.base.value,
    }
