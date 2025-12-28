import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is required. Set it in your environment before starting the server.");
}

export const openai = new OpenAI({ apiKey });

export async function createConversation() {
  if (typeof openai.conversations?.create === "function") {
    return openai.conversations.create();
  }

  return openai.post("/conversations", { body: {} });
}

export async function createResponse(payload) {
  const options = { headers: { "OpenAI-Beta": "assistants=v2" } };

  if (typeof openai.responses?.create === "function") {
    return openai.responses.create(payload, options);
  }

  return openai.post("/responses", { body: payload, ...options });
}
