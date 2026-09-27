"""Call the gateway's MCP endpoint directly: list its tools, then check a claim (the shell).

The gateway uses AWS_IAM inbound auth, so every request is signed with your
AWS credentials (SigV4, service "bedrock-agentcore").

Usage: GATEWAY_URL=https://<id>.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp \
       uv run python call_gateway.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Generator

import boto3
import httpx2
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import TextContent

from core import render
from domain import Claim, GatewayToolName, GatewayUrl, ParseError, parse_claim, parse_verdict

CHECK_CLAIM = GatewayToolName("expenses", "check_claim")


class SigV4(httpx2.Auth):
    """Sign each HTTP request with the default AWS credentials."""

    requires_request_body = True

    def __init__(self, region: str) -> None:
        credentials = boto3.Session().get_credentials()
        if credentials is None:
            raise RuntimeError("no AWS credentials found")
        self.signer = SigV4Auth(credentials, "bedrock-agentcore", region)

    def auth_flow(
        self, request: httpx2.Request
    ) -> Generator[httpx2.Request, httpx2.Response, None]:
        signed = AWSRequest(method=request.method, url=str(request.url), data=request.content)
        self.signer.add_auth(signed)  # adds Authorization and X-Amz-Date headers
        request.headers.update(dict(signed.headers.items()))
        yield request


async def check(gateway: GatewayUrl, claim: Claim) -> None:
    timeout = httpx2.Timeout(30, read=300)  # the server may hold a stream open
    async with httpx2.AsyncClient(auth=SigV4("eu-west-1"), timeout=timeout) as http:
        async with Client(streamable_http_client(gateway.value, http_client=http)) as client:
            listed = await client.list_tools()
            print("tools:", ", ".join(tool.name for tool in listed.tools))

            result = await client.call_tool(str(CHECK_CLAIM), to_arguments(claim))
            texts = [block.text for block in result.content if isinstance(block, TextContent)]
            if result.is_error or not texts:
                raise RuntimeError(f"{CHECK_CLAIM} failed: {texts}")
            print(render(claim, parse_verdict(texts[0])))  # outside data -> domain type


def to_arguments(claim: Claim) -> dict[str, object]:
    """The tool arguments, as the tool schema in tools/expenses-tools.json defines them."""
    return {
        "category": claim.category.value,
        "amount_eur": claim.amount.to_json(),
        "city_class": claim.city.value,
    }


def main() -> int:
    try:
        gateway = GatewayUrl.parse(os.environ.get("GATEWAY_URL", ""))
        claim = parse_claim({"category": "hotel", "amount_eur": 210, "city_class": "major"})
    except ParseError as exc:
        print(f"error: {exc}\nusage: GATEWAY_URL=https://... call_gateway.py", file=sys.stderr)
        return 2
    asyncio.run(check(gateway, claim))
    return 0


if __name__ == "__main__":
    sys.exit(main())
