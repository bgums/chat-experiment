import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { createConversation, createResponse } from "./openaiClient.js";
import { extractTextFromResponse } from "./utils/extractText.js";
import {
  createInvite,
  getSessionByToken,
  listParticipants,
  markSessionStarted,
  markSessionCompleted,
  saveConversationId,
  saveFormResponse,
  saveMessage,
  updateParticipantStatus
} from "./db.js";

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

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "12345";

function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", "Basic realm=admin");
    return res.status(401).send("Authentication required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  const [user, pass] = decoded.split(":");
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  res.set("WWW-Authenticate", "Basic realm=admin");
  return res.status(401).send("Invalid credentials");
}

const sessionFlowPath = path.join(__dirname, "config", "sessionFlow.json");
const formsDir = path.join(__dirname, "forms");

function loadSessionFlow() {
  try {
    const raw = fs.readFileSync(sessionFlowPath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    console.error("Failed to load session flow config", error);
    return { sessions: [], defaultTotalSessions: 2 };
  }
}

function getSessionSteps(sessionNumber) {
  const flow = loadSessionFlow();
  const match = (flow.sessions || []).find((session) => Number(session.session) === Number(sessionNumber));
  if (match && Array.isArray(match.steps)) {
    return match.steps;
  }
  return [{ type: "chat" }];
}

function loadFormDefinition(formKey) {
  const safeKey = `${formKey}`.replace(/[^a-zA-Z0-9_-]/g, "");
  const formPath = path.join(formsDir, `${safeKey}.json`);
  if (!fs.existsSync(formPath)) {
    return null;
  }
  const raw = fs.readFileSync(formPath, "utf-8");
  return JSON.parse(raw);
}

app.use("/api/admin", adminAuth);

app.post("/api/admin/invite", async (_req, res) => {
  try {
    const flow = loadSessionFlow();
    const totalSessions = flow.defaultTotalSessions || 2;
    const invite = await createInvite({ totalSessions });

    const origin = req.get("origin") || `${req.protocol}://${req.get("host")}`;
    const sessions = invite.sessionTokens.map(({ sessionNumber, token }) => ({
      sessionNumber,
      token,
      url: `${origin}/?token=${token}`
    }));

    res.json({ participantCode: invite.participantCode, sessions });
  } catch (error) {
    console.error("Failed to create invite", error);
    res.status(500).json({ error: error?.message || "Could not create invite." });
  }
});

app.get("/api/admin/participants", async (_req, res) => {
  try {
    const participants = await listParticipants();
    res.json({ participants });
  } catch (error) {
    console.error("Failed to list participants", error);
    res.status(500).json({ error: error?.message || "Could not load participants." });
  }
});

app.get("/api/forms/:formKey", (req, res) => {
  const form = loadFormDefinition(req.params.formKey);
  if (!form) {
    return res.status(404).json({ error: "Form not found." });
  }
  res.json(form);
});

app.get("/api/session/:token", async (req, res) => {
  try {
    const sessionToken = req.params.token;
    const session = await getSessionByToken(sessionToken);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const flow = loadSessionFlow();
    const match = (flow.sessions || []).find((s) => Number(s.session) === Number(session.sessionNumber));
    const steps = getSessionSteps(session.sessionNumber);

    await markSessionStarted(session.sessionId);

    res.json({
      participantCode: session.participantCode,
      sessionNumber: session.sessionNumber,
      status: session.sessionStatus,
      sessionLabel: match?.label || null,
      steps,
      conversationId: session.conversationId,
      totalSessions: session.totalSessions
    });
  } catch (error) {
    console.error("Failed to load session", error);
    res.status(500).json({ error: error?.message || "Could not load session." });
  }
});

app.post("/api/session/:token/forms/:formKey", async (req, res) => {
  try {
    const { token, formKey } = req.params;
    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const steps = getSessionSteps(session.sessionNumber);
    const allowed = steps.some((step) => step.type === "form" && step.key === formKey);
    if (!allowed) {
      return res.status(400).json({ error: "Form not part of this session." });
    }

    const responses = req.body?.responses || {};
    await markSessionStarted(session.sessionId);
    await saveFormResponse({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      formKey,
      responses
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Failed to save form", error);
    res.status(500).json({ error: error?.message || "Could not save form." });
  }
});

app.post("/api/session/:token/message", async (req, res) => {
  try {
    const sessionToken = req.params.token;
    const { message } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    const session = await getSessionByToken(sessionToken);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    await markSessionStarted(session.sessionId);

    let conversationId = session.conversationId;
    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
      await saveConversationId(session.sessionId, conversationId);
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

    await saveMessage({ participantId: session.participantId, sessionNumber: session.sessionNumber, role: "user", content: message });
    await saveMessage({ participantId: session.participantId, sessionNumber: session.sessionNumber, role: "assistant", content: assistantText });

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

// Legacy route kept for backward compatibility
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

app.post("/api/session/:token/complete", async (req, res) => {
  try {
    const sessionToken = req.params.token;
    const session = await getSessionByToken(sessionToken);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    await markSessionCompleted(session.sessionId);

    if (session.sessionNumber >= session.totalSessions) {
      await updateParticipantStatus(session.participantId, "completed");
    } else {
      await updateParticipantStatus(session.participantId, "in_progress");
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Failed to mark session complete", error);
    res.status(500).json({ error: error?.message || "Could not complete session." });
  }
});

app.get("/admin", adminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "admin.html"));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "client", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
