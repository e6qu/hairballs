# Build context: templates/ (see templates/agentcore/agentcore.json: buildContextPath ".")
# AgentCore Runtime requires linux/arm64; `agentcore deploy` builds for arm64 in CodeBuild.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY shared/ts/org-agents /app/shared/ts/org-agents
COPY generic-agents/pi-harness /app/generic-agents/pi-harness

# Locked installs, no install scripts (npm mirror / CodeArtifact with the cooldown in CI).
# Optional corporate CA (egress proxy / TLS inspection) as a BuildKit secret, never baked in:
#   docker build --secret id=extra_ca,src=/path/ca.pem ...
# The shared library first: npm does not install the dependencies of a `file:` link.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    cd /app/shared/ts/org-agents && npm ci --ignore-scripts --omit=dev \
    && cd /app/generic-agents/pi-harness && npm ci --ignore-scripts --omit=dev \
    && npm cache clean --force \
    && mkdir -p /tmp/pi-agent && chown -R 1000:1000 /tmp/pi-agent

# The base image's `node` user is uid 1000.
USER 1000
WORKDIR /app/generic-agents/pi-harness
# pi supply-chain switches (also forced in src/shell/offline.ts): no package auto-install,
# no version check, no catalog refresh, no telemetry. AGENT_WORKDIR is pi's (empty) cwd.
ENV NODE_ENV=production \
    AGENT_HOME=/app/generic-agents/pi-harness \
    AGENT_WORKDIR=/tmp/pi-agent \
    PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0
EXPOSE 8080
CMD ["node", "src/shell/app.ts"]
