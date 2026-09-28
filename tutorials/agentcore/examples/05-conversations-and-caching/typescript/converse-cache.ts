// Prompt caching with the raw Converse API: a cachePoint ends the part Bedrock may cache.
// Usage: node dist/converse-cache.js HANDBOOK.md  (a long, fixed document: > 4,096 tokens)
import { readFileSync } from "node:fs";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe } from "./core.ts";
import { parseUsage } from "./domain.ts";

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const bedrock = new BedrockRuntimeClient({ region: "eu-west-1" });

async function ask(handbook: string, question: string): Promise<void> {
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [
        { text: "Answer from this expenses handbook:\n\n" + handbook },
        { cachePoint: { type: "default" } }, // cache everything above; ttl: "1h" for longer
      ],
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  console.log(describe(parseUsage(response.usage))); // outside data -> domain type -> text
}

const handbook = readFileSync(process.argv[2] ?? "", "utf8");
await ask(handbook, "What is the hotel limit per night?"); // first call writes the cache
await ask(handbook, "How long do I have to submit a claim?"); // second reads it: ~10% of the price
