import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GatewayClient, apiKeyFromEnv, loadDotEnvFile } from "./gateway_client.ts";

const REPO_DOT_ENV = fileURLToPath(new URL("../../.env", import.meta.url));

function resolveApiKey(): string {
  if (process.env.AI_GATEWAY_API_KEY !== undefined && process.env.AI_GATEWAY_API_KEY.trim().length > 0) {
    return apiKeyFromEnv(process.env as Record<string, string | undefined>);
  }
  return apiKeyFromEnv(loadDotEnvFile(readFileSync(REPO_DOT_ENV, "utf8")));
}

const client = new GatewayClient({ apiKey: resolveApiKey() });
client.ensureAuthenticated();

console.log("Smoke check 1: one Jev evaluate call through the gateway (confirms the typesafe-ai provider is enabled)...");
const jev = await client.systemOne({
  model: "typesafe-ai/jev",
  state: "Adviser: Priya, your basic salary is £68,500 with the April pay round.",
  questions: {
    salary_stated: { type: "noul", instructions: "Does the source explicitly state a basic salary figure for Priya?" },
  },
});
console.log("  Jev answers:", JSON.stringify(jev.answers));
console.log("  Jev model:", jev.modelVersion, "provider:", jev.provider, "usage:", JSON.stringify(jev.usage));
if (jev.generationId !== null) {
  const info = await client.lookupGenerationWithPolling(jev.generationId, { tries: 6, delayMs: 1_000 });
  console.log("  Generation lookup:", info === null ? "not yet available" : JSON.stringify(info));
}

console.log("Smoke check 2: one schema-constrained chat completion (confirms structured output on the chat endpoint)...");
const chat = await client.chatCompletion({
  model: "anthropic/claude-haiku-4.5",
  messages: [{ role: "user", content: 'Does the quoted text state a salary for Priya? Text: "Adviser: Priya, your basic salary is £68,500." Answer as JSON.' }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "smoke_verdict",
      strict: true,
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["supported", "unsupported", "uncertain"] },
          reason: { type: "string" },
        },
        required: ["verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
  max_tokens: 100,
});
console.log("  Chat content:", chat.content);
console.log("  Chat model:", chat.modelVersion, "usage:", JSON.stringify(chat.usage));
if (chat.generationId !== null) {
  const info = await client.lookupGenerationWithPolling(chat.generationId, { tries: 6, delayMs: 1_000 });
  console.log("  Generation lookup:", info === null ? "not yet available" : JSON.stringify(info));
}

console.log("Smoke check passed: both providers served calls through the gateway.");
