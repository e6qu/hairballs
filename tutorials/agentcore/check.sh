#!/usr/bin/env bash
# Check every tutorial example: typecheck, lint, format; and that tutorial snippets match the checked files.
# Usage: tutorials/agentcore/check.sh [NN-slug ...]   (no AWS calls are made)
# Needs: uv, node/npm, terraform (>= 1.16), shellcheck.
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$PWD
fail=0
run() { # run <label> <dir> <command...>
  local label=$1 dir=$2; shift 2
  if (cd "$dir" && "$@" >/tmp/tutorial-check.log 2>&1); then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s\n' "$label"; sed 's/^/        /' /tmp/tutorial-check.log | tail -20; fail=1
  fi
}

examples=("$@")
if [ ${#examples[@]} -eq 0 ]; then
  mapfile -t examples < <(find examples -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
fi

for ex in "${examples[@]}"; do
  dir=$ROOT/examples/$ex
  echo "== $ex"
  if [ -f "$dir/python/pyproject.toml" ]; then
    run "python: uv sync" "$dir/python" uv sync --quiet
    run "python: ruff format" "$dir/python" uvx --quiet ruff format --check .
    run "python: ruff check" "$dir/python" uvx --quiet ruff check .
    run "python: mypy --strict" "$dir/python" uv run --quiet mypy --strict .
  fi
  if [ -f "$dir/typescript/package.json" ]; then
    run "typescript: npm install" "$dir/typescript" npm install --ignore-scripts --no-audit --no-fund --silent
    run "typescript: tsc --noEmit" "$dir/typescript" npx --no-install tsc --noEmit
    run "typescript: prettier" "$dir/typescript" npx --yes prettier@3 --check .
  fi
  if [ -d "$dir/terraform" ]; then
    run "terraform: fmt" "$dir/terraform" terraform fmt -check -recursive
    run "terraform: validate" "$dir/terraform" sh -c 'terraform init -backend=false -input=false >/dev/null && terraform validate'
  fi
  if [ -f "$dir/cli.sh" ]; then
    run "cli.sh: shellcheck" "$dir" shellcheck cli.sh
  fi
done

echo "== markdown"
run "markdownlint" "$ROOT" npx --yes markdownlint-cli2@0.18 "*.md"
run "snippets match example files" "$ROOT" python3 check_snippets.py

exit $fail
