"""Thin org harness on Pydantic AI.

* ``core/``: pure decisions (context window, tool-output truncation, session recovery).
* ``shell/``: the Pydantic AI integration: guarded runner, sessions, context processor, steering,
  Bedrock prompt caching. Public API: :mod:`org_pydantic_harness.shell`.
"""
