// Prompt caching with the raw Converse API: a cachePoint ends the part Bedrock may cache.
import { readFileSync } from "node:fs";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const HANDBOOK = readFileSync(process.argv[2]!, "utf8"); // a long, fixed document (> 4,096 tokens)

const bedrock = new BedrockRuntimeClient({ region: "eu-west-1" });

async function ask(question: string): Promise<void> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [
        { text: "Answer from this expenses handbook:\n\n" + HANDBOOK },
        { cachePoint: { type: "default" } }, // cache everything above; ttl: "1h" for longer
      ],
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  const usage = response.usage!;
  console.log(
    `input=${usage.inputTokens} ` +
      `cache_write=${usage.cacheWriteInputTokens ?? 0} ` +
      `cache_read=${usage.cacheReadInputTokens ?? 0}`,
  );
}

await ask("What is the hotel limit per night?"); // first call writes the cache
await ask("How long do I have to submit a claim?"); // second call reads it: about 10% of the price
