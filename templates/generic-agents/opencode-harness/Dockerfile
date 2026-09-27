# Build context: templates/ (see templates/agentcore/agentcore.json: buildContextPath ".")
# AgentCore Runtime requires linux/arm64; `agentcore deploy` builds for arm64 in CodeBuild.
# Debian (glibc) base: matches the pinned `opencode-linux-arm64` binary (not the -musl build).
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /app
COPY shared/ts/org-agents /app/shared/ts/org-agents
COPY generic-agents/opencode-harness /app/generic-agents/opencode-harness

# Locked installs, no install scripts (npm mirror / CodeArtifact with the cooldown in CI).
# opencode is NOT installed through `opencode-ai` (its postinstall picks the binary): the platform
# package `opencode-linux-arm64@1.18.31` is an exact-pinned optional dependency whose tarball is
# verified against the sha512 in package-lock.json; npm installs only the one matching os/cpu.
# (`opencode-linux-x64` is also pinned so the image can be built and smoke-tested on x86 hosts.)
# Optional corporate CA (egress proxy / TLS inspection) as a BuildKit secret, never baked in:
#   docker build --secret id=extra_ca,src=/path/ca.pem ...
# The shared library first: npm does not install the dependencies of a `file:` link.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    cd /app/shared/ts/org-agents && npm ci --ignore-scripts --omit=dev \
    && cd /app/generic-agents/opencode-harness && npm ci --ignore-scripts --omit=dev \
    && { test -x node_modules/opencode-linux-arm64/bin/opencode || test -x node_modules/opencode-linux-x64/bin/opencode; } \
    && npm cache clean --force

# The base image's `node` user is uid 1000. Code and config stay root-owned (read-only for the
# agent); opencode's HOME / XDG dirs / session DB / workspace are created per process under /tmp.
USER 1000
WORKDIR /app/generic-agents/opencode-harness
# AWS_PROFILE + AWS_CONFIG_FILE: credential_process profile for opencode's Bedrock provider.
# TOOLS_MCP_URL: the AgentCore Gateway MCP URL (set in agentcore.json envVars).
ENV NODE_ENV=production \
    AGENT_HOME=/app/generic-agents/opencode-harness \
    AWS_PROFILE=agentcore \
    AWS_CONFIG_FILE=/app/generic-agents/opencode-harness/config/aws-config
EXPOSE 8080
CMD ["node", "src/shell/app.ts"]
