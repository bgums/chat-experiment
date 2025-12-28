import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { createConversation, createResponse } from "./openaiClient.js";
import { extractTextFromResponse } from "./utils/extractText.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const MODEL_ID = process.env.OPENAI_MODEL || "gpt-4.1";
const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;
const FILE_ID = process.env.OPENAI_FILE_ID;

if (!VECTOR_STORE_ID) {
  throw new Error("OPENAI_VECTOR_STORE_ID is required. Set it in your environment before starting the server.");
}

if (!FILE_ID) {
  throw new Error("OPENAI_FILE_ID is required. Set it in your environment before starting the server.");
}

const instructionsPath = path.join(__dirname, "instructions", "patient_persona.md");
const rawPersonaPointer = fs.readFileSync(instructionsPath, "utf-8");
// Allow the pointer file to specify an alternate persona by listing its filename.
const pointerLine = rawPersonaPointer
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.length > 0 && !line.startsWith("#"));

let personaInstructions = rawPersonaPointer;

if (pointerLine) {
  const referencedPersonaPath = path.join(__dirname, "instructions", pointerLine);
  if (fs.existsSync(referencedPersonaPath) && fs.statSync(referencedPersonaPath).isFile()) {
    personaInstructions = fs.readFileSync(referencedPersonaPath, "utf-8");
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "client")));

app.post("/api/message", async (req, res) => {
  try {
    const { message, conversationId: incomingConversationId } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    let conversationId = incomingConversationId;

    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
    }

    const response = await createResponse({
      model: MODEL_ID,
      conversation: conversationId,
      instructions: personaInstructions,
      tools: [
        {
          type: "file_search",
          vector_store_ids: [VECTOR_STORE_ID]
        }
      ],
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: message }
          ]
        }
      ]
    });

    const assistantText = extractTextFromResponse(response);

    return res.json({
      conversationId,
      response: assistantText
    });
  } catch (error) {
    console.error("OpenAI request failed", error);
    const message = error?.response?.data?.error?.message || error?.message || "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
