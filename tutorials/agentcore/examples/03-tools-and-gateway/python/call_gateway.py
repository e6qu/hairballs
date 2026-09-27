"""Call the gateway's MCP endpoint directly: list its tools, then call one.

The gateway uses AWS_IAM inbound auth, so every request is signed with your
AWS credentials (SigV4, service "bedrock-agentcore").

Usage: GATEWAY_URL=https://<id>.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp \
       uv run python call_gateway.py
"""

import asyncio
import os
from collections.abc import Generator

import boto3
import httpx2
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import TextContent


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


async def main(gateway_url: str) -> None:
    timeout = httpx2.Timeout(30, read=300)  # the server may hold a stream open
    async with httpx2.AsyncClient(auth=SigV4("eu-west-1"), timeout=timeout) as http:
        async with Client(streamable_http_client(gateway_url, http_client=http)) as client:
            listed = await client.list_tools()
            for tool in listed.tools:
                print(tool.name)  # "<target>___<tool>", e.g. expenses___check_claim

            result = await client.call_tool(
                "expenses___check_claim",
                {"category": "hotel", "amount_eur": 210, "city_class": "major"},
            )
            for block in result.content:
                if isinstance(block, TextContent):
                    print(block.text)


if __name__ == "__main__":
    asyncio.run(main(os.environ["GATEWAY_URL"]))
