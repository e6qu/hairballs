// Score one helpdesk session with built-in evaluators (the imperative shell).
// Usage: npm run evaluate -- <session-id>
import { setTimeout as sleep } from "node:timers/promises";
import { BedrockAgentCoreClient, EvaluateCommand } from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  GetHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { renderEvaluation, spanQuery } from "./core.ts";
import {
  type HarnessId,
  type RuntimeId,
  type SessionId,
  type SessionSpans,
  parseEvaluation,
  parseEvaluatorId,
  parseHarnessId,
  parseRuntimeId,
  parseSessionId,
  parseSpanRows,
} from "./domain.ts";

const REGION = "eu-west-1";
const control = new BedrockAgentCoreControlClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
const agentcore = new BedrockAgentCoreClient({ region: REGION });

// A harness runs on a Runtime agent; its traces are stored under that runtime's id.
async function runtimeOf(harness: HarnessId): Promise<RuntimeId> {
  return parseRuntimeId(await control.send(new GetHarnessCommand({ harnessId: harness })));
}

// The session's spans, from aws/spans and the runtime's log group (the last 7 days).
async function spansOf(runtime: RuntimeId, session: SessionId): Promise<SessionSpans> {
  const now = Math.floor(Date.now() / 1000);
  const { queryId } = await logs.send(
    new StartQueryCommand({
      logGroupNames: ["aws/spans", `/aws/bedrock-agentcore/runtimes/${runtime}-DEFAULT`],
      startTime: now - 7 * 24 * 3600,
      endTime: now,
      queryString: spanQuery(session),
    }),
  );
  for (;;) {
    await sleep(1000);
    const result = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (result.status === "Failed" || result.status === "Cancelled")
      throw new Error("query failed");
    if (result.status === "Complete") return parseSpanRows(result.results ?? []);
  }
}

const session = parseSessionId(process.argv[2] ?? "");
const evaluators = ["Builtin.GoalSuccessRate", "Builtin.Helpfulness"].map(parseEvaluatorId);
const spans = await spansOf(await runtimeOf(parseHarnessId("helpdesk-AbCdEf1234")), session);
for (const evaluatorId of evaluators) {
  const { evaluationResults } = await agentcore.send(
    new EvaluateCommand({ evaluatorId, evaluationInput: { sessionSpans: [...spans] } }),
  );
  for (const raw of evaluationResults ?? []) console.log(renderEvaluation(parseEvaluation(raw)));
}
