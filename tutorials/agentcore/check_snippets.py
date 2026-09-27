"""Check that every code line shown in a tutorial exists in that tutorial's example files.

Tutorial NN-slug.md is compared with examples/NN-slug/. Lines that are elisions ("...", "…") or blank are skipped.
In shell snippets only AWS CLI lines (`aws ...`) are checked against cli.sh; `agentcore` CLI and other one-off
commands may stand alone in the tutorial.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LANGS = {"python": {".py"}, "typescript": {".ts"}, "hcl": {".tf"}, "terraform": {".tf"}, "bash": {".sh"}, "sh": {".sh"}}
FENCE = re.compile(r"^```(\w+)\s*$(.*?)^```\s*$", re.MULTILINE | re.DOTALL)


def normalized(line: str) -> str:
    return " ".join(line.split())


def main() -> int:
    problems: list[str] = []
    only = set(sys.argv[1:])
    for tutorial in sorted(ROOT.glob("[0-9][0-9]-*.md")):
        if only and tutorial.stem not in only:
            continue
        examples = ROOT / "examples" / tutorial.stem
        for lang, body in FENCE.findall(tutorial.read_text(encoding="utf-8")):
            suffixes = LANGS.get(lang.lower())
            lines = [ln for ln in body.splitlines() if ln.strip()]
            if not suffixes or not lines:
                continue
            corpus = {
                normalized(ln)
                for f in examples.rglob("*")
                if f.suffix in suffixes and "node_modules" not in f.parts and ".venv" not in f.parts
                for ln in f.read_text(encoding="utf-8").splitlines()
            }
            for ln in lines:
                n = normalized(ln)
                if suffixes == {".sh"} and not n.startswith("aws "):
                    continue
                if n in {"...", "…", "# ...", "// ..."} or n.endswith(("# ...", "// ...")):
                    continue
                if n not in corpus:
                    problems.append(f"{tutorial.name} [{lang}]: not in {examples.relative_to(ROOT)}: {ln.strip()[:100]}")
    for p in problems:
        print(p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
