import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
const SIMULATE_OPENAI = process.env.OPENAI_SIMULATE === "1";
const SIMULATED_RESPONSE_DELAY_MS = Number(process.env.OPENAI_SIMULATED_RESPONSE_DELAY_MS || 1500);
const SIMULATED_MAX_PARALLEL = Number(process.env.OPENAI_SIMULATED_MAX_PARALLEL || 4);
const SIMULATED_RESPONSE_TEXT = process.env.OPENAI_SIMULATED_RESPONSE_TEXT
  || "[simulated] Feedback response generated successfully.";

let simulatedActiveResponses = 0;
let simulatedConversationCounter = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSimulatedRateLimitError() {
  const error = new Error("Simulated OpenAI rate limit exceeded.");
  error.status = 429;
  error.code = "rate_limit_exceeded";
  return error;
}

if (!apiKey && !SIMULATE_OPENAI) {
  throw new Error("OPENAI_API_KEY is required. Set it in your environment before starting the server.");
}

export const openai = SIMULATE_OPENAI ? null : new OpenAI({ apiKey });

export async function createConversation() {
  if (SIMULATE_OPENAI) {
    simulatedConversationCounter += 1;
    return { id: `sim-conv-${simulatedConversationCounter}` };
  }

  if (typeof openai.conversations?.create === "function") {
    return openai.conversations.create();
  }

  return openai.post("/conversations", { body: {} });
}

export async function createResponse(payload) {
  if (SIMULATE_OPENAI) {
    simulatedActiveResponses += 1;
    try {
      if (simulatedActiveResponses > SIMULATED_MAX_PARALLEL) {
        throw buildSimulatedRateLimitError();
      }
      await delay(SIMULATED_RESPONSE_DELAY_MS);
      let simulatedText = SIMULATED_RESPONSE_TEXT;
      const formatName = payload.text?.format?.name;
      if (formatName === "practice_selection") {
        const data = JSON.parse(payload.input);
        const source = data.transcript.find(message => data.eligibleSourceMessageIds.includes(message.id));
        simulatedText = JSON.stringify({
          sourceMessageId: source.id,
          originalStrategyId: "problem_solving", originalStrategyExplanation: "ניסיון להציע פתרון.",
          strategyId: data.requiredStrategyId || (data.excludedStrategyIds.includes("validate_emotion") ? "explore_rupture" : "validate_emotion"),
          title: "תרגול איחוי", explanation: "התייחסות לרגע של קושי בקשר.",
          principles: "הקשבה וסקרנות.", application: "התייחסות לחוויה של המטופל."
        });
      } else if (formatName === "practice_score") {
        const data = JSON.parse(payload.input);
        simulatedText = JSON.stringify({ score: data.therapistMessage.includes("excellent") ? 5 : data.therapistMessage.includes("retry") ? 1 : 3 });
      } else if (formatName === "practice_evaluation") {
        const data = JSON.parse(payload.input);
        simulatedText = JSON.stringify({
          feedback: "משוב מדומה על התגובה.", summary: "סיכום מדומה של הכיוון שנוסה."
        });
      }
      return {
        output: [
          ...(payload.tools?.some(tool => tool.type === "file_search") ? [{
            type: "file_search_call", status: "completed",
            results: [{ file_id: process.env.OPENAI_FILE_ID, text: "Simulated manual excerpt for integration tests." }]
          }] : []),
          {
            content: [{ text: simulatedText }]
          }
        ]
      };
    } finally {
      simulatedActiveResponses -= 1;
    }
  }

  const options = { headers: { "OpenAI-Beta": "assistants=v2" } };

  if (typeof openai.responses?.create === "function") {
    return openai.responses.create(payload, options);
  }

  return openai.post("/responses", { body: payload, ...options });
}
