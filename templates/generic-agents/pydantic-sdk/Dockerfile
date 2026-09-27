# Build context: templates/ (see templates/agentcore/agentcore.json: buildContextPath ".")
# AgentCore Runtime requires linux/arm64; `agentcore deploy` builds for arm64 in CodeBuild.
FROM public.ecr.aws/docker/library/python:3.12-slim

# uv is installed from PyPI (via your CodeArtifact mirror in CI: set PIP_INDEX_URL / UV_INDEX_URL).
# Optional corporate CA (e.g. egress proxy / CodeArtifact TLS inspection), passed as a BuildKit secret:
#   docker build --secret id=extra_ca,src=/path/ca.pem ...   (never baked into the image)
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    pip install --no-cache-dir uv==0.8.17 && useradd --uid 1000 --create-home agent

WORKDIR /app
COPY shared/python /app/shared/python
COPY generic-agents/tools /app/generic-agents/tools
COPY generic-agents/pydantic-sdk /app/generic-agents/pydantic-sdk

WORKDIR /app/generic-agents/pydantic-sdk
# Locked, reproducible install; path dependencies are copied (not editable) into the venv.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    uv sync --locked --no-dev --no-editable && chown -R agent /app

USER agent
ENV PYTHONUNBUFFERED=1 AGENT_HOME=/app/generic-agents/pydantic-sdk
EXPOSE 8080
CMD ["/app/generic-agents/pydantic-sdk/.venv/bin/python", "-m", "generic_agent_pydantic.shell.app"]
