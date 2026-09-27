// Score one helpdesk session with built-in evaluators (on-demand evaluation).
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
import type { DocumentType } from "@smithy/types";

const REGION = "eu-west-1";
const HARNESS_ID = "helpdesk-AbCdEf1234";
const EVALUATORS = ["Builtin.GoalSuccessRate", "Builtin.Helpfulness"];

const control = new BedrockAgentCoreControlClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
const agentcore = new BedrockAgentCoreClient({ region: REGION });

/** A harness runs on a Runtime agent; its traces are under that runtime's id. */
async function runtimeId(harnessId: string): Promise<string> {
  const { harness } = await control.send(new GetHarnessCommand({ harnessId }));
  return harness!.environment!.agentCoreRuntimeEnvironment!.agentRuntimeId!;
}

/** The session's spans, from aws/spans and the runtime's log group. */
async function sessionSpans(runtime: string, sessionId: string): Promise<DocumentType[]> {
  const now = Math.floor(Date.now() / 1000);
  const { queryId } = await logs.send(
    new StartQueryCommand({
      logGroupNames: ["aws/spans", `/aws/bedrock-agentcore/runtimes/${runtime}-DEFAULT`],
      startTime: now - 7 * 24 * 3600,
      endTime: now,
      queryString: `fields @timestamp, @message
        | filter ispresent(scope.name) and attributes.session.id = "${sessionId}"
        | sort @timestamp asc | limit 10000`,
    }),
  );
  for (;;) {
    await sleep(1000);
    const result = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (result.status === "Failed" || result.status === "Cancelled")
      throw new Error("query failed");
    if (result.status !== "Complete") continue;
    return (result.results ?? [])
      .flat()
      .filter((f) => f.field === "@message" && f.value?.startsWith("{"))
      .map((f) => JSON.parse(f.value!) as DocumentType);
  }
}

const sessionId = process.argv[2]!;
const spans = await sessionSpans(await runtimeId(HARNESS_ID), sessionId);
for (const evaluatorId of EVALUATORS) {
  const { evaluationResults } = await agentcore.send(
    new EvaluateCommand({ evaluatorId, evaluationInput: { sessionSpans: spans } }),
  );
  for (const result of evaluationResults ?? []) {
    console.log(result.evaluatorId, result.value, result.label);
    console.log("  ", (result.explanation ?? "").slice(0, 200));
  }
}
