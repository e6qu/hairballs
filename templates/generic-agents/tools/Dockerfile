# Build context: templates/. Deployed to AgentCore Runtime with protocol MCP (0.0.0.0:8000/mcp),
# then registered as an AgentCore Gateway target.
FROM public.ecr.aws/docker/library/python:3.12-slim
# Optional corporate CA (e.g. egress proxy / CodeArtifact TLS inspection), passed as a BuildKit secret:
#   docker build --secret id=extra_ca,src=/path/ca.pem ...   (never baked into the image)
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    pip install --no-cache-dir uv==0.8.17 && useradd --uid 1000 --create-home agent
WORKDIR /app
COPY shared/python /app/shared/python
COPY generic-agents/tools /app/generic-agents/tools
WORKDIR /app/generic-agents/tools
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export SSL_CERT_FILE=/run/secrets/extra_ca; fi; \
    uv sync --locked --no-dev --no-editable --extra mcp && chown -R agent /app
USER agent
ENV PYTHONUNBUFFERED=1 MCP_HOST=0.0.0.0 MCP_PORT=8000
EXPOSE 8000
CMD ["/app/generic-agents/tools/.venv/bin/python", "-m", "generic_tools.shell.mcp_server"]
