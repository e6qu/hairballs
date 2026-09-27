# 10. A coding agent

You will: run an agent that fixes an issue in a repository, with a workspace that survives the session, GitHub tokens from the token vault, tests run without the model, and a pull request for a human to merge. You need: tutorials [03](03-tools-and-gateway.md), [04](04-your-own-code.md), [06](06-auth0-identity.md) and [07](07-policy.md); a GitHub App you can configure. Cost: Runtime bills CPU only while the VM computes: a 30-minute task with 2 GB and 20% CPU is about 2 cents. Session storage is free during its preview. Model tokens are most of the bill.

The full, checked files are in [`examples/10-coding-agent/`](examples/10-coding-agent/).

## Step 1: Decide who does what

A coding task has steps that need judgment and steps that must not. Give each to the right place:

| Step | Who | Where |
|---|---|---|
| Read the code, decide the change, edit files | the model | the agent's tools in its session VM |
| `git clone`, `git push` | the agent's own code, with a token from the vault | the session VM |
| Install, test, build | your workflow, no model | `InvokeAgentRuntimeCommand` in the same VM |
| Run code nobody reviewed | the agent | Code Interpreter, with no network |
| Open the pull request | your workflow, as the user | a Gateway tool, under Cedar policy |
| Merge | a human | GitHub |

The agent here is code on Runtime (a Strands agent, as in [04](04-your-own-code.md)) rather than a harness. Its `git` tool fetches the GitHub token itself, so the token never appears in a prompt, a command or a log.

Terraform: [`aws_bedrockagentcore_agent_runtime.coder`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime), [`aws_bedrockagentcore_oauth2_credential_provider.github`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_oauth2_credential_provider), [`aws_bedrockagentcore_gateway_target.github`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway_target), [`aws_bedrockagentcore_code_interpreter.sandbox`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_code_interpreter)

## Step 2: Create the agent with a persistent workspace

Everything in a session VM is lost when the session ends. Mount **session storage** at `/mnt/workspace`: files there survive when the session stops and resumes with the same session id (up to 1 GB, kept 14 days, preview). The agent needs `git` in its image, so build a container.

With the `agentcore` CLI, create the project (first column of the table below), then:

- Replace `app/coder/main.py` with [`agent.py`](examples/10-coding-agent/python/agent.py) and add `strands-agents-tools` to its `pyproject.toml`. For TypeScript, create with `--language TypeScript` and use `agent.ts`.
- In `app/coder/Dockerfile`, before `USER bedrock_agentcore`, add:

  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends git nodejs npm \
      && rm -rf /var/lib/apt/lists/*
  ```

Need a workspace shared between sessions or agents, or kept longer? Put the agent in VPC mode and mount **EFS** or **S3 Files** instead (`--network-mode VPC --subnets … --security-groups … --efs-access-point-arn … --efs-mount-path /mnt/workspace`).

With the AWS CLI or Terraform, CI builds and pushes the image first.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

```bash
agentcore create --name coder --framework Strands --model-provider Bedrock --memory none \
  --build Container --session-storage-mount-path /mnt/workspace
```

The CLI builds the image in CodeBuild during `agentcore deploy`.

</td><td>

```bash
RUNTIME_ARN=$(aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
  --agent-runtime-name coder \
  --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$IMAGE\"}}" \
  --role-arn "$ROLE_ARN" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --filesystem-configurations '[{"sessionStorage":{"mountPath":"/mnt/workspace"}}]' \
  --lifecycle-configuration '{"idleRuntimeSessionTimeout":1800,"maxLifetime":28800}' \
  --environment-variables "CODE_INTERPRETER_ID=$SANDBOX_ID" \
  --query agentRuntimeArn --output text)
```

</td><td>

```hcl
resource "aws_bedrockagentcore_agent_runtime" "coder" {
  agent_runtime_name = "coder"
  role_arn           = data.aws_iam_role.coder.arn

  agent_runtime_artifact {
    container_configuration {
      container_uri = var.container_uri
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  filesystem_configuration {
    session_storage {
      mount_path = "/mnt/workspace"
    }
  }

  lifecycle_configuration = [{
    idle_runtime_session_timeout = 1800  # a task may pause between steps
    max_lifetime                 = 28800 # 8 hours, the maximum
  }]
  # ...
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_agent_runtime.coder`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime)

The image runs as a non-root user. **[verify]** that it can write to the session storage mount; if not, create the directory with the right owner at startup.

## Step 3: Put GitHub in the token vault

The agent acts as the developer who asked for the change. Each developer allows GitHub access once; the **token vault** then keeps their token, refreshes it, and hands it only to this agent's workload identity.

- Create a **GitHub App** (not an OAuth App). Its user tokens expire after 8 hours, and its permissions (contents, pull requests) are set on the app, not by scopes.
- The vendor name is `GithubOauth2`. The response contains a `callbackUrl`: add it to the GitHub App's callback URLs.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

Not for GitHub in CLI 0.30.0: `agentcore add credential --type oauth` makes a custom OAuth provider from a `--discovery-url`, and GitHub has none. Use the AWS CLI or Terraform.

</td><td>

```bash
aws bedrock-agentcore-control create-oauth2-credential-provider --region "$REGION" \
  --name github --credential-provider-vendor GithubOauth2 \
  --oauth2-provider-config-input "{\"githubOauth2ProviderConfig\":{\"clientId\":\"$GITHUB_CLIENT_ID\",\"clientSecret\":\"$GITHUB_CLIENT_SECRET\"}}" \
  --query callbackUrl --output text
```

</td><td>

```hcl
resource "aws_bedrockagentcore_oauth2_credential_provider" "github" {
  name                       = "github"
  credential_provider_vendor = "GithubOauth2"

  oauth2_provider_config {
    github_oauth2_provider_config {
      client_id     = var.github_client_id
      client_secret = var.github_client_secret
    }
  }
}

output "github_callback_url" {
  description = "Register this as the callback URL of the GitHub App."
  value       = aws_bedrockagentcore_oauth2_credential_provider.github.callback_url
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_oauth2_credential_provider.github`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_oauth2_credential_provider)

The agent's execution role needs `bedrock-agentcore:GetResourceOauth2Token`. **[verify]** that the vault refreshes GitHub App user tokens when they expire.

Terraform: [`aws_iam_role_policy.coder_tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy) (the agent may fetch tokens and use the sandbox)

## Step 4: Give the token to git, not to the model

The agent's `clone` and `push` tools call `git()`. It fetches the user's token from the vault on each use and passes it to the `git` process in environment variables only: not in the command line, not in a file, not in the model's context. Runtime logs every `InvokeAgentRuntimeCommand` command line, so a token must never be part of one.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
@requires_access_token(
    provider_name="github",
    scopes=["repo"],
    auth_flow="USER_FEDERATION",
    on_auth_url=ask_user_to_consent,
    into="token",
)
async def github_token(*, token: str = "") -> str:
    """The user's GitHub token from the token vault. Never stored, never logged."""
    return token


async def git(args: list[str], cwd: Path) -> str:
    """Run git with the token in the child's environment only: not in argv, files or logs."""
    basic = base64.b64encode(f"x-access-token:{await github_token()}".encode()).decode()
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
    }
    done = subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=600
    )
    return f"exit {done.returncode}\n{(done.stdout + done.stderr)[-4000:]}"
```

</td><td>

```typescript
/** The user's GitHub token from the token vault. Never stored, never logged. */
const githubToken = withAccessToken({
  providerName: "github",
  scopes: ["repo"],
  authFlow: "USER_FEDERATION",
  // First use only: the user must allow GitHub access once. Send them this link.
  onAuthUrl: (url) => console.log(`GitHub consent needed: ${url}`),
})(async (token: string) => token);

/** Run git with the token in the child's environment only: not in argv, files or logs. */
async function git(args: string[], cwd: string): Promise<string> {
  const basic = Buffer.from(`x-access-token:${await githubToken()}`).toString("base64");
  return runProgram(["git", ...args], cwd, {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
}
```

</td></tr></table>

- **Which user.** `USER_FEDERATION` needs to know the user. Your workflow passes it as `runtimeUserId` in Step 5, and AgentCore gives the agent a workload token for that user.
- **The first time,** there is no token yet: `on_auth_url` / `onAuthUrl` receives GitHub's consent link. Send it to the developer (here it is only logged). **[verify]** how long the call waits for consent, and how your app completes the session binding (`CompleteResourceTokenAuth`, see [06](06-auth0-identity.md)).
- **The other tools.** `run` executes one program from an allowlist as an argv list, never a shell string, inside the repository. The editor tool changes files. Paths outside `/mnt/workspace` are refused.

Terraform: [`aws_bedrockagentcore_oauth2_credential_provider.github`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_oauth2_credential_provider), [`aws_iam_role_policy.coder_tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

## Step 5: Drive the task from a workflow

Your workflow is a trusted backend, such as the Lambda from [08](08-events-and-schedules.md). It uses one session id per task, so every step lands in the same VM and workspace.

- `ask` prompts the agent (`InvokeAgentRuntime`) and names the user with `runtimeUserId`. That needs the IAM action `bedrock-agentcore:InvokeAgentRuntimeForUser`. AgentCore does not check the value, so only the workflow may send it, and it takes it from the user's verified Auth0 token.
- `sh` runs a command in the same VM (`InvokeAgentRuntimeCommand`): no model, no tokens. The test run decides whether the change is done, not the model.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
def sh(command: str, session_id: str, timeout: int = 900) -> int:
    """Run a command in the agent's VM: no model, no tokens. Returns the exit code."""
    response = client.invoke_agent_runtime_command(
        agentRuntimeArn=AGENT_ARN,
        runtimeSessionId=session_id,
        body={"command": f'/bin/bash -c "{command}"', "timeout": timeout},
    )
    for event in response["stream"]:
        chunk = event.get("chunk", {})
        if "contentDelta" in chunk:
            delta = chunk["contentDelta"]
            print(delta.get("stdout", "") + delta.get("stderr", ""), end="")
        if "contentStop" in chunk:
            return chunk["contentStop"]["exitCode"]
    return -1


def main() -> None:
    session = f"coder-issue-42-{uuid.uuid4()}"  # one session (and workspace) per task
    user = os.environ["USER_ID"]  # who asked; taken from their verified Auth0 token
    print(ask("Fix issue 42 in fintech/helpdesk-api. Clone it first.", session, user))

    tests = "cd /mnt/workspace/helpdesk-api && npm ci && npm test"
    for _ in range(3):  # the test run decides, not the model
        if sh(tests, session) == 0:
            break
        print(ask("The tests fail. Run them, read the output, fix it.", session, user))
    else:
        raise SystemExit("tests still fail: a human takes over")

    print(ask("Push the change to a new branch fix/issue-42.", session, user))
```

</td><td>

```typescript
async function sh(command: string, sessionId: string, timeout = 900): Promise<number> {
  const response = await client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: AGENT_ARN,
      runtimeSessionId: sessionId,
      body: { command: `/bin/bash -c "${command}"`, timeout },
    }),
  );
  for await (const event of response.stream ?? []) {
    const chunk = event.chunk;
    if (chunk?.contentDelta) {
      process.stdout.write((chunk.contentDelta.stdout ?? "") + (chunk.contentDelta.stderr ?? ""));
    }
    if (chunk?.contentStop) return chunk.contentStop.exitCode ?? -1;
  }
  return -1;
}

const session = `coder-issue-42-${randomUUID()}`; // one session (and workspace) per task
const user = process.env.USER_ID!; // who asked; taken from their verified Auth0 token
console.log(await ask("Fix issue 42 in fintech/helpdesk-api. Clone it first.", session, user));

const tests = "cd /mnt/workspace/helpdesk-api && npm ci && npm test";
let passed = false;
for (let i = 0; i < 3 && !passed; i++) {
  // the test run decides, not the model
  passed = (await sh(tests, session)) === 0;
  if (!passed) {
    console.log(await ask("The tests fail. Run them, read the output, fix it.", session, user));
  }
}
if (!passed) throw new Error("tests still fail: a human takes over");

console.log(await ask("Push the change to a new branch fix/issue-42.", session, user));
```

</td></tr></table>

By hand, from the project folder: `agentcore invoke --exec --session-id "$SID" "cd /mnt/workspace/helpdesk-api && npm test"`. The AWS CLI has no command for this streamed operation; use an SDK or the `agentcore` CLI.

Terraform: [`aws_bedrockagentcore_agent_runtime.coder`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_agent_runtime), [`aws_iam_policy.coder_workflow`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_policy) (the workflow's `InvokeAgentRuntime`, `InvokeAgentRuntimeForUser` and `InvokeAgentRuntimeCommand`)

## Step 6: Open the pull request through the Gateway

The workflow opens the pull request with a Gateway tool, as the developer. The Gateway gets the developer's GitHub token from the same vault, and the Cedar policies from [07](07-policy.md) decide who may call `github___create_pull_request`. The branch goes to review; nobody merges automatically.

Put GitHub's MCP server behind the Gateway with an `AUTHORIZATION_CODE` (user) credential.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

Partly. This adds the target with an OAuth credential, but CLI 0.30.0 can't set the grant type to `AUTHORIZATION_CODE`:

```bash
agentcore add gateway-target --gateway helpdesk-tools \
  --name GitHub --type mcp-server \
  --endpoint https://api.githubcopilot.com/mcp/ \
  --outbound-auth oauth --credential-name github
```

Use the AWS CLI or Terraform for this target.

</td><td>

```bash
aws bedrock-agentcore-control create-gateway-target --region "$REGION" \
  --gateway-identifier "$GATEWAY_ID" --name github \
  --target-configuration '{"mcp":{"mcpServer":{"endpoint":"https://api.githubcopilot.com/mcp/"}}}' \
  --credential-provider-configurations "[{\"credentialProviderType\":\"OAUTH\",\"credentialProvider\":{\"oauthCredentialProvider\":{\"providerArn\":\"$PROVIDER_ARN\",\"scopes\":[\"repo\"],\"grantType\":\"AUTHORIZATION_CODE\"}}}]"
```

</td><td>

```hcl
resource "aws_bedrockagentcore_gateway_target" "github" {
  name               = "github"
  gateway_identifier = var.gateway_id

  target_configuration {
    mcp {
      mcp_server {
        endpoint = "https://api.githubcopilot.com/mcp/"
      }
    }
  }

  credential_provider_configuration {
    oauth {
      provider_arn = aws_bedrockagentcore_oauth2_credential_provider.github.credential_provider_arn
      scopes       = ["repo"]
      grant_type   = "AUTHORIZATION_CODE"
    }
  }
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_gateway_target.github`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway_target), [`aws_bedrockagentcore_gateway`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_gateway) (the helpdesk-tools gateway from 03)

The call itself is the same `tools/call` as in [07](07-policy.md), with the developer's Auth0 token (`open_pull_request` in `workflow.py`, `openPullRequest` in `workflow.ts`). **[verify]** the GitHub MCP server's tool name and arguments (`create_pull_request`: `owner`, `repo`, `title`, `head`, `base`), and how the Gateway asks for consent when a developer hasn't given it yet.

## Step 7: Run untrusted code in Code Interpreter

Code from an issue, a downloaded script, a snippet the model found: don't run it in the agent's VM, which holds the workspace and can reach GitHub. Create a Code Interpreter in `SANDBOX` mode, with no network at all, and give the agent that tool.

<table><tr><th>agentcore CLI</th><th>AWS CLI</th><th>Terraform</th></tr><tr><td>

Not in CLI 0.30.0: it has no Code Interpreter resource. Closest: `agentcore add tool --harness <name> --type agentcore_code_interpreter --code-interpreter-arn <arn>` gives a harness an existing interpreter.

</td><td>

```bash
SANDBOX_ID=$(aws bedrock-agentcore-control create-code-interpreter --region "$REGION" \
  --name coder_sandbox --network-configuration '{"networkMode":"SANDBOX"}' \
  --query codeInterpreterId --output text)
```

</td><td>

```hcl
resource "aws_bedrockagentcore_code_interpreter" "sandbox" {
  name = "coder_sandbox"

  network_configuration {
    network_mode = "SANDBOX"
  }
}
```

</td></tr></table>

Terraform: [`aws_bedrockagentcore_code_interpreter.sandbox`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_code_interpreter), [`aws_iam_role_policy.coder_tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

```python
sandbox = AgentCoreCodeInterpreter(region="eu-west-1", identifier=SANDBOX_ID)
```

```python
            tools=[clone, push, run, editor, sandbox.code_interpreter],
```

</td><td>

```typescript
const sandbox = new CodeInterpreterTools({ region: "eu-west-1", identifier: SANDBOX_ID });
```

```typescript
      tools: [clone, push, run, fileEditor, ...sandbox.tools],
```

</td></tr></table>

The system prompt tells the model when to use it. The agent's role needs `StartCodeInterpreterSession`, `InvokeCodeInterpreter` and `StopCodeInterpreterSession` on that interpreter. To keep the agent's own VM off the internet except GitHub, run it in VPC mode with egress rules.

## What just happened

- The agent worked on a repository in `/mnt/workspace`, which outlives a stopped session. Git got a GitHub token from the vault, and the model never saw it.
- Your workflow ran the tests in the same VM without the model, and opened the pull request as the developer, through the Gateway and its policies.
- Untrusted code ran in a Code Interpreter with no network.

## Clean up

```bash
agentcore remove agent --name coder --yes && agentcore deploy
# AWS CLI: the clean_up function in examples/10-coding-agent/cli.sh
# Terraform: terraform destroy
```

Next: back to the [tutorial index](README.md).
