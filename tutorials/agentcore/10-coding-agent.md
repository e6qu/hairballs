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

The agent's `clone` and `push` tools fetch the user's token from the vault on each use and pass it to the `git` process in environment variables only: not in the command line, not in a file, not in the model's context. Runtime logs every `InvokeAgentRuntimeCommand` command line, so a token must never be part of one.

The code has the same three parts as in [01](01-first-agent.md):

- **`domain`**: `Repo` (`owner/name`), `RepoPath` (made only from a `Repo`, so it is always inside `/mnt/workspace`), `BranchName`, `CommitMessage`, `AllowedCommand` (an argv list whose program is on the allowlist), `GitHubToken`, and `Outcome = Finished | TimedOut`. Every tool argument the model sends is parsed into these first; a bad one comes back to the model as `refused: …`.
- **`core`**: pure functions: `git_env` (the token as git configuration), `clone_argv`, `commit_steps`, `describe` (what the model sees of a command).
- **shell**: the Strands tools, the vault call and the child processes.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

The shell (`agent.py`):

```python
@requires_access_token(
    provider_name="github",
    scopes=["repo"],
    auth_flow="USER_FEDERATION",
    on_auth_url=ask_user_to_consent,
    into="token",
)
async def vault_token(*, token: str = "") -> str:
    return token


async def github_token() -> GitHubToken:
    """The user's GitHub token from the token vault, parsed at the boundary."""
    return GitHubToken.parse(await vault_token())


async def git_with_token(argv: list[str], cwd: str) -> str:
    env = {**os.environ, **git_env((await github_token()).value)}
    return describe(execute(argv, cwd, env))


@tool
def run(repo: str, argv: list[str]) -> str:
    """Run one allowed program in a cloned repository, for example ["npm", "test"]. No shell.

    Args:
        repo: owner/name of a cloned repository.
        argv: the program and its arguments.
    """
    try:
        path = RepoPath.of(Repo.parse(repo))
        command = AllowedCommand.parse(argv)
    except ParseError as exc:
        return f"refused: {exc}"
    return describe(execute(command.argv, str(path.path)))
```

</td><td>

The shell (`agent.ts`):

```typescript
// The user's GitHub token from the token vault, parsed at the boundary.
const githubToken: () => Promise<GitHubToken> = withAccessToken({
  providerName: "github",
  scopes: ["repo"],
  authFlow: "USER_FEDERATION",
  // First use only: the user must allow GitHub access once. Send them this link.
  onAuthUrl: (url) => console.log(`GitHub consent needed: ${url}`),
})(async (token: string) => parseGitHubToken(token));

async function gitWithToken(argv: readonly string[], cwd: string): Promise<string> {
  return describe(await execute(argv, cwd, { ...process.env, ...gitEnv(await githubToken()) }));
}

const run = tool({
  name: "run",
  description: 'Run one allowed program in a cloned repository, e.g. ["npm", "test"]. No shell.',
  inputSchema: z.object({ repo: z.string(), argv: z.array(z.string()) }),
  callback: ({ repo, argv }) =>
    refusing(async () => {
      const path = repoPath(parseRepo(repo));
      const command = parseAllowedCommand(argv);
      return describe(await execute([command.program, ...command.args], path));
    }),
});
```

</td></tr><tr><td>

The allowlist parser (`domain.py`) and the git environment (`core.py`):

```python
@dataclass(frozen=True, slots=True)
class AllowedCommand:
    """An argv list whose program is allowed. Never a shell string."""

    program: Program
    args: tuple[str, ...]

    @classmethod
    def parse(cls, raw: object) -> AllowedCommand:
        if not isinstance(raw, list) or not raw or not all(isinstance(a, str) for a in raw):
            raise ParseError("argv must be a non-empty list of strings")
        try:
            program = Program(raw[0])
        except ValueError as exc:
            allowed = ", ".join(p.value for p in Program)
            raise ParseError(f"{raw[0]!r} is not allowed; use one of {allowed}") from exc
        return cls(program, tuple(raw[1:]))

    @property
    def argv(self) -> list[str]:
        return [self.program.value, *self.args]


def git_env(token_value: str) -> dict[str, str]:
    """Environment for one git process: the token goes here, never into argv, files or logs."""
    basic = base64.b64encode(f"x-access-token:{token_value}".encode()).decode()
    return {
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
    }
```

</td><td>

The allowlist parser (`domain.ts`) and the git environment (`core.ts`):

```typescript
export function parseAllowedCommand(raw: readonly string[]): AllowedCommand {
  const [first, ...args] = raw;
  const program = PROGRAMS.find((p) => p === first);
  if (program === undefined) {
    throw new ParseError(`${String(first)} is not allowed; use one of ${PROGRAMS.join(", ")}`);
  }
  return { program, args };
}

// Environment for one git process: the token goes here, never into argv, files or logs.
export function gitEnv(tokenValue: string): Readonly<Record<string, string>> {
  const basic = Buffer.from(`x-access-token:${tokenValue}`).toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
```

</td></tr></table>

- **Which user.** `USER_FEDERATION` needs to know the user. Your workflow passes it as `runtimeUserId` in Step 5, and AgentCore gives the agent a workload token for that user.
- **The first time,** there is no token yet: `on_auth_url` / `onAuthUrl` receives GitHub's consent link. Send it to the developer (here it is only logged). **[verify]** how long the call waits for consent, and how your app completes the session binding (`CompleteResourceTokenAuth`, see [06](06-auth0-identity.md)).
- **The other tools.** `run` executes one allowed program as an argv list, never a shell string, inside the repository; `push` commits locally, then pushes with the token. The editor tool changes files.

Terraform: [`aws_bedrockagentcore_oauth2_credential_provider.github`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/bedrockagentcore_oauth2_credential_provider), [`aws_iam_role_policy.coder_tools`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/iam_role_policy)

## Step 5: Drive the task from a workflow

Your workflow is a trusted backend, such as the Lambda from [08](08-events-and-schedules.md). It uses one session id per task, so every step lands in the same VM and workspace.

- `ask` prompts the agent (`InvokeAgentRuntime`) and names the user with `runtimeUserId`. That needs the IAM action `bedrock-agentcore:InvokeAgentRuntimeForUser`. AgentCore does not check the value, so only the workflow may send it, and it takes it from the user's verified Auth0 token.
- `sh` runs a command in the same VM (`InvokeAgentRuntimeCommand`): no model, no tokens. Each streamed event is parsed into `Output` or an `Outcome`.
- `after_tests` in `core` decides what happens next, as a value: `Done | AskToFix | GiveUp`. The test run decides, not the model. The session id's random part is passed into `task_session`; the core has no randomness.

<table><tr><th>Python</th><th>TypeScript</th></tr><tr><td>

The shell (`workflow.py`):

```python
def sh(agent: AgentArn, session: SessionId, command: str, timeout: int = 900) -> Outcome:
    """Run a command in the agent's VM: no model, no tokens."""
    response = client.invoke_agent_runtime_command(
        agentRuntimeArn=agent.value,
        runtimeSessionId=session.value,
        body={"command": f'/bin/bash -c "{command}"', "timeout": timeout},
    )
    for raw in response["stream"]:
        event = parse_command_event(raw)  # outside data -> domain type, right here
        if isinstance(event, Output):
            print(event.text, end="")
        elif event is not None:
            return event
    raise ParseError("the command stream ended without an exit code")


def main() -> int:
    try:
        agent = AgentArn.parse(os.environ.get("AGENT_ARN", ""))
        user = UserId.parse(os.environ.get("USER_ID", ""))  # from their verified Auth0 token
        token = UserToken.parse(os.environ.get("USER_TOKEN", ""))
        repo, branch = Repo.parse("fintech/helpdesk-api"), BranchName.parse("fix/issue-42")
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    session = task_session("issue-42", str(uuid.uuid4()))  # one session (and workspace) per task
    print(ask(agent, session, user, f"Fix issue 42 in {repo.slug}. Clone it first."))

    tests = f"cd /mnt/workspace/{repo.name} && npm ci && npm test"
    attempt = 0
    while True:
        match after_tests(sh(agent, session, tests), attempt, MAX_ATTEMPTS):
            case Done():
                break
            case AskToFix(attempt=attempt):
                print(
                    ask(agent, session, user, "The tests fail. Run them, read the output, fix it.")
                )
            case GiveUp():
                print("tests still fail: a human takes over", file=sys.stderr)
                return 1

    print(ask(agent, session, user, f"Push the change to a new branch {branch.value}."))
    pr = PullRequest(repo, branch, BranchName.parse("main"), "Fix issue 42")
    print(open_pull_request(pr, token))
    return 0
```

</td><td>

The shell (`workflow.ts`):

```typescript
// Run a command in the agent's VM: no model, no tokens.
async function sh(
  agent: AgentArn,
  session: SessionId,
  command: string,
  timeout = 900,
): Promise<Outcome> {
  const response = await client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: agent,
      runtimeSessionId: session,
      body: { command: `/bin/bash -c "${command}"`, timeout },
    }),
  );
  for await (const raw of response.stream ?? []) {
    const event = parseCommandEvent(raw); // outside data -> domain type, right here
    if (event?.kind === "output") process.stdout.write(event.text);
    else if (event) return event;
  }
  throw new ParseError("the command stream ended without an exit code");
}

async function main(): Promise<number> {
  const agent = parseAgentArn(process.env.AGENT_ARN ?? "");
  const user = parseUserId(process.env.USER_ID ?? ""); // from their verified Auth0 token
  const token = parseUserToken(process.env.USER_TOKEN ?? "");
  const repo = parseRepo("fintech/helpdesk-api");
  const branch = parseBranchName("fix/issue-42");
  const session = taskSession("issue-42", randomUUID()); // one session (and workspace) per task
  console.log(
    await ask(agent, session, user, `Fix issue 42 in ${repo.owner}/${repo.name}. Clone it first.`),
  );

  const tests = `cd /mnt/workspace/${repo.name} && npm ci && npm test`;
  for (let attempt = 0; ; ) {
    const next = afterTests(await sh(agent, session, tests), attempt, MAX_ATTEMPTS);
    if (next.kind === "done") break;
    if (next.kind === "giveUp") {
      console.error("tests still fail: a human takes over");
      return 1;
    }
    attempt = next.attempt;
    console.log(
      await ask(agent, session, user, "The tests fail. Run them, read the output, fix it."),
    );
  }

  console.log(await ask(agent, session, user, `Push the change to a new branch ${branch}.`));
  const pr = { repo, head: branch, base: parseBranchName("main"), title: "Fix issue 42" };
  console.log(await openPullRequest(pr, token));
  return 0;
}
```

</td></tr><tr><td>

The stream parser (`domain.py`) and the decision (`core.py`):

```python
def parse_command_event(raw: Mapping[str, object]) -> CommandEvent | None:
    """One InvokeAgentRuntimeCommand stream event, or None for events the workflow ignores."""
    chunk = _fields(raw.get("chunk", {}), "$.chunk")
    if "contentDelta" in chunk:
        delta = _fields(chunk["contentDelta"], "$.chunk.contentDelta")
        parts = [delta.get("stdout"), delta.get("stderr")]
        return Output("".join(p for p in parts if isinstance(p, str)))
    if "contentStop" in chunk:
        stop = _fields(chunk["contentStop"], "$.chunk.contentStop")
        code = stop.get("exitCode")
        if stop.get("status") == "TIMED_OUT":
            return TimedOut("")
        if not isinstance(code, int):
            raise ParseError("$.chunk.contentStop.exitCode: expected an integer")
        return Finished(code, "")
    return None


def after_tests(outcome: Outcome, attempt: int, max_attempts: int) -> Done | AskToFix | GiveUp:
    """The test run decides, not the model."""
    if isinstance(outcome, Finished) and outcome.exit_code == 0:
        return Done()
    return AskToFix(attempt + 1) if attempt + 1 < max_attempts else GiveUp()
```

</td><td>

The stream parser (`domain.ts`) and the decision (`core.ts`):

```typescript
// One InvokeAgentRuntimeCommand stream event, or undefined for events the workflow ignores.
export function parseCommandEvent(
  raw: InvokeAgentRuntimeCommandStreamOutput,
): CommandEvent | undefined {
  const chunk = raw.chunk;
  if (chunk?.contentDelta) {
    return {
      kind: "output",
      text: (chunk.contentDelta.stdout ?? "") + (chunk.contentDelta.stderr ?? ""),
    };
  }
  if (chunk?.contentStop) {
    if (chunk.contentStop.status === "TIMED_OUT") return { kind: "timedOut", output: "" };
    const exitCode = chunk.contentStop.exitCode;
    if (exitCode === undefined) throw new ParseError("$.chunk.contentStop.exitCode: missing");
    return { kind: "finished", exitCode, output: "" };
  }
  return undefined;
}

// The test run decides, not the model.
export function afterTests(outcome: Outcome, attempt: number, maxAttempts: number): Next {
  if (outcome.kind === "finished" && outcome.exitCode === 0) return { kind: "done" };
  return attempt + 1 < maxAttempts
    ? { kind: "askToFix", attempt: attempt + 1 }
    : { kind: "giveUp" };
}
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

The call itself is the same `tools/call` as in [07](07-policy.md), with the developer's Auth0 token (`open_pull_request` in `workflow.py`, `openPullRequest` in `workflow.ts`); the reply is parsed into `Opened | Refused`. **[verify]** the GitHub MCP server's tool name and arguments (`create_pull_request`: `owner`, `repo`, `title`, `head`, `base`), and how the Gateway asks for consent when a developer hasn't given it yet.

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
