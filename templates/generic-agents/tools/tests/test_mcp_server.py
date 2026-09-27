"""End-to-end: the MCP server over streamable HTTP (what pi/opencode/Gateway talk to)."""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator

import pytest


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(scope="module")
def server() -> Iterator[str]:
    port = _free_port()
    env = {**os.environ, "MCP_PORT": str(port)}
    proc = subprocess.Popen([sys.executable, "-m", "generic_tools.shell.mcp_server"], env=env)
    url = f"http://127.0.0.1:{port}/mcp"
    deadline = time.monotonic() + 90  # generous: CI machines can be slow to import the MCP SDK
    while True:
        if proc.poll() is not None:
            raise RuntimeError(f"MCP server exited early with code {proc.returncode}")
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            if time.monotonic() > deadline:
                proc.kill()
                raise TimeoutError("MCP server did not start within 90s") from None
            time.sleep(0.2)
    yield url
    proc.terminate()
    proc.wait(timeout=10)


def rpc(url: str, method: str, params: dict[str, object] | None = None) -> dict[str, object]:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        text = response.read().decode()
    data_lines = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    parsed: object = json.loads(data_lines[-1] if data_lines else text)
    assert isinstance(parsed, dict)
    return parsed


def test_tools_listed(server: str) -> None:
    result = rpc(server, "tools/list")["result"]
    assert isinstance(result, dict)
    names = {tool["name"] for tool in result["tools"]}
    assert names == {"calculate", "search_knowledge", "create_ticket", "get_ticket"}


def test_call_and_error_reason(server: str) -> None:
    ok = rpc(server, "tools/call", {"name": "calculate", "arguments": {"expression": "0.1+0.2"}})["result"]
    assert isinstance(ok, dict) and ok["isError"] is False and "= 0.3" in ok["content"][0]["text"]
    bad = rpc(server, "tools/call", {"name": "calculate", "arguments": {"expression": "1/0"}})["result"]
    assert (
        isinstance(bad, dict) and bad["isError"] is True and "division by zero" in bad["content"][0]["text"]
    )
