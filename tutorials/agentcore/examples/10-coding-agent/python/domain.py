"""Domain types for the coding agent and the workflow that drives it.

Outside data (tool arguments from the model, environment, command output streamed back from the
agent's VM, the Gateway's reply) is parsed into these types at the boundary. After that, a value
that exists is valid: no code downstream re-checks it.
"""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath

WORKSPACE = PurePosixPath("/mnt/workspace")  # session storage: kept across stop/resume
_REPO = re.compile(r"([A-Za-z0-9-]+)/([A-Za-z0-9_-][A-Za-z0-9._-]*)")
_BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*")
_RUNTIME_ARN = re.compile(r"arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime/[\w-]+")
_USER_ID = re.compile(r"usr_[a-z0-9]+")


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


# --- The agent's tools ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Repo:
    owner: str
    name: str

    @classmethod
    def parse(cls, raw: str) -> Repo:
        match = _REPO.fullmatch(raw)
        if match is None or match.group(2) in {".", ".."}:
            raise ParseError(f"not a GitHub repository (owner/name): {raw!r}")
        return cls(match.group(1), match.group(2))

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.name}"


@dataclass(frozen=True, slots=True)
class RepoPath:
    """A checkout inside the workspace. Only `of` makes one, so it can't point elsewhere."""

    path: PurePosixPath

    @classmethod
    def of(cls, repo: Repo) -> RepoPath:
        return cls(WORKSPACE / repo.name)  # repo.name has no "/" and is not "." or ".."


@dataclass(frozen=True, slots=True)
class BranchName:
    value: str

    @classmethod
    def parse(cls, raw: str) -> BranchName:
        bad = ".." in raw or raw.endswith(("/", ".lock")) or "//" in raw
        if bad or not _BRANCH.fullmatch(raw):
            raise ParseError(f"not a branch name: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class CommitMessage:
    text: str

    @classmethod
    def parse(cls, raw: str) -> CommitMessage:
        text = raw.strip()
        if not text:
            raise ParseError("the commit message is empty")
        return cls(text)


class Program(enum.Enum):
    """The programs the model may run. Anything else is refused at the boundary."""

    GIT = "git"
    LS = "ls"
    CAT = "cat"
    GREP = "grep"
    NPM = "npm"
    NPX = "npx"
    NODE = "node"
    PYTHON = "python"
    PYTEST = "pytest"
    UV = "uv"


@dataclass(frozen=True, slots=True)
class AllowedCommand:
    """An argv list whose program is allowed. Never a shell string."""

    program: Program
    args: tuple[str, ...]

    @classmethod
    def parse(cls, raw: object) -> AllowedCommand:
        if not isinstance(raw, list) or not raw or not all(isinstance(a, str) for a in raw):
            raise ParseError("argv must be a non-empty list of strings")
        try:
            program = Program(raw[0])
        except ValueError as exc:
            allowed = ", ".join(p.value for p in Program)
            raise ParseError(f"{raw[0]!r} is not allowed; use one of {allowed}") from exc
        return cls(program, tuple(raw[1:]))

    @property
    def argv(self) -> list[str]:
        return [self.program.value, *self.args]


@dataclass(frozen=True, slots=True)
class GitHubToken:
    """The user's GitHub token from the token vault. Never printed."""

    value: str

    @classmethod
    def parse(cls, raw: object) -> GitHubToken:
        if not isinstance(raw, str) or not raw:
            raise ParseError("the token vault returned no GitHub token")
        return cls(raw)

    def __repr__(self) -> str:
        return "GitHubToken(***)"


@dataclass(frozen=True, slots=True)
class Finished:
    exit_code: int
    output: str


@dataclass(frozen=True, slots=True)
class TimedOut:
    output: str


Outcome = Finished | TimedOut
"""How a command in the agent's VM ended."""


# --- The workflow -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AgentArn:
    value: str

    @classmethod
    def parse(cls, raw: str) -> AgentArn:
        if not _RUNTIME_ARN.fullmatch(raw):
            raise ParseError(f"not an AgentCore runtime ARN: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class SessionId:
    """One session (and workspace) per task. AgentCore requires 33 to 256 characters."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> SessionId:
        if not 33 <= len(raw) <= 256:
            raise ParseError("a session id must be 33 to 256 characters")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class UserId:
    """Who asked, from their verified Auth0 token. Selects whose GitHub token the agent gets."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> UserId:
        if not _USER_ID.fullmatch(raw):
            raise ParseError(f"not a user id: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class UserToken:
    """The developer's Auth0 access token, for the Gateway. Never printed."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> UserToken:
        if raw.count(".") != 2:
            raise ParseError("the user token is not a JWT")
        return cls(raw)

    def __repr__(self) -> str:
        return "UserToken(***)"


@dataclass(frozen=True, slots=True)
class Output:
    text: str


CommandEvent = Output | Outcome


def _fields(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"{path}: expected an object")
    return raw


def parse_command_event(raw: Mapping[str, object]) -> CommandEvent | None:
    """One InvokeAgentRuntimeCommand stream event, or None for events the workflow ignores."""
    chunk = _fields(raw.get("chunk", {}), "$.chunk")
    if "contentDelta" in chunk:
        delta = _fields(chunk["contentDelta"], "$.chunk.contentDelta")
        parts = [delta.get("stdout"), delta.get("stderr")]
        return Output("".join(p for p in parts if isinstance(p, str)))
    if "contentStop" in chunk:
        stop = _fields(chunk["contentStop"], "$.chunk.contentStop")
        code = stop.get("exitCode")
        if stop.get("status") == "TIMED_OUT":
            return TimedOut("")
        if not isinstance(code, int):
            raise ParseError("$.chunk.contentStop.exitCode: expected an integer")
        return Finished(code, "")
    return None


@dataclass(frozen=True, slots=True)
class PullRequest:
    repo: Repo
    head: BranchName
    base: BranchName
    title: str


@dataclass(frozen=True, slots=True)
class Opened:
    text: str


@dataclass(frozen=True, slots=True)
class Refused:
    """The Gateway or its Cedar policy said no."""

    reason: str


def parse_pull_request_reply(raw: object) -> Opened | Refused:
    """The Gateway's JSON-RPC reply to github___create_pull_request."""
    reply = _fields(raw, "$")
    if "error" in reply:
        return Refused(str(_fields(reply["error"], "$.error").get("message", "JSON-RPC error")))
    result = _fields(reply.get("result"), "$.result")
    content = result.get("content", [])
    blocks = content if isinstance(content, list) else []
    text = "\n".join(
        b["text"] for b in blocks if isinstance(b, Mapping) and isinstance(b.get("text"), str)
    )
    return Refused(text) if result.get("isError") is True else Opened(text)
