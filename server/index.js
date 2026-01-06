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
  getParticipantByCode,
  listParticipants,
  markSessionStarted,
  markSessionCompleted,
  saveFormResponse,
  savePersonaMessage,
  listMessagesByParticipant,
  updateParticipantStatus,
  getSessionPersonas,
  saveSessionPersonaConversationId,
  markSessionPersonaFirstMessage,
  markSessionPersonaMidPromptSent,
  markSessionPersonaFeedbackSent,
  getSessionPersona,
  listMessagesBySessionPersona,
  saveConversationId
} from "./db.js";
import { ensureSessionPersonas, buildPersonaPrompt } from "./utils/personaLoader.js";

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

const chatInstructionsPath = path.join(__dirname, "instructions", "chat_instructions.txt");
const midChatInstructionsPath = path.join(__dirname, "instructions", "mid_chat_instructions.txt");
const feedbackInstructionsPath = path.join(__dirname, "instructions", "feedback_instructions.txt");

const chatInstructions = fs.readFileSync(chatInstructionsPath, "utf-8");
const midChatInstructions = fs.readFileSync(midChatInstructionsPath, "utf-8");
const feedbackInstructions = fs.readFileSync(feedbackInstructionsPath, "utf-8");

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
const modulesDir = path.join(__dirname, "modules");

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

function combineChatPrompt(personaObj, includeMid = false) {
  const personaPrompt = buildPersonaPrompt(personaObj);
  const parts = [personaPrompt, chatInstructions];
  if (includeMid) parts.push(midChatInstructions);
  return parts.filter(Boolean).join("\n\n---\n\n");
}

function combineFeedbackPrompt(personaObj) {
  const personaPrompt = buildPersonaPrompt(personaObj);
  return [personaPrompt, feedbackInstructions].filter(Boolean).join("\n\n---\n\n");
}

function withPersonaDisplay(personaJson) {
  try {
    const parsed = typeof personaJson === "string" ? JSON.parse(personaJson) : personaJson;
    return parsed || {};
  } catch (error) {
    return {};
  }
}

function logPromptEvent(label, payload) {
  const safePayload = JSON.stringify(payload, null, 2);
  console.log(`[prompt-log] ${label}: ${safePayload}`);
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

function loadModuleDefinition(moduleKey) {
  const safeKey = `${moduleKey}`.replace(/[^a-zA-Z0-9_-]/g, "");
  const modulePath = path.join(modulesDir, `${safeKey}.json`);
  if (!fs.existsSync(modulePath)) {
    return null;
  }
  const raw = fs.readFileSync(modulePath, "utf-8");
  return JSON.parse(raw);
}

app.use("/api/admin", adminAuth);

app.post("/api/admin/invite", async (req, res) => {
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

app.get("/api/admin/participant/:participantCode/messages", async (req, res) => {
  try {
    const { participantCode } = req.params;
    const participant = await getParticipantByCode(participantCode);
    if (!participant) {
      return res.status(404).json({ error: "Participant not found." });
    }

    const messages = await listMessagesByParticipant(participant.id);
    return res.json({ participantCode, messages });
  } catch (error) {
    console.error("Failed to load messages", error);
    res.status(500).json({ error: error?.message || "Could not load messages." });
  }
});

app.get("/api/forms/:formKey", (req, res) => {
  const form = loadFormDefinition(req.params.formKey);
  if (!form) {
    return res.status(404).json({ error: "Form not found." });
  }
  res.json(form);
});

app.get("/api/modules/:moduleKey", (req, res) => {
  const moduleDef = loadModuleDefinition(req.params.moduleKey);
  if (!moduleDef) {
    return res.status(404).json({ error: "Module not found." });
  }
  res.json(moduleDef);
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
    const configuredSteps = getSessionSteps(session.sessionNumber);

    const personas = await ensureSessionPersonas({
      sessionId: session.sessionId,
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      participantCode: session.participantCode
    });

    const persistedPersonas = await getSessionPersonas(session.sessionId);

    await markSessionStarted(session.sessionId);

    const personaSteps = (persistedPersonas || []).flatMap((personaRow) => {
      const personaData = withPersonaDisplay(personaRow.personaJson);
      const personaMeta = {
        sessionPersonaId: personaRow.id,
        conversationId: personaRow.conversationId || null,
        firstMessageAt: personaRow.firstMessageAt,
        midPromptSent: Boolean(personaRow.midPromptSent),
        feedbackPromptSent: Boolean(personaRow.feedbackPromptSent),
        persona: {
          csvId: personaRow.personaCsvId,
          name: personaRow.personaName,
          age: personaData.age || null,
          background: personaData.background || "",
          difficulty: personaData.difficulty || "",
          gender: personaData.gender || "",
          diagnosis: personaData.diagnosis || ""
        }
      };
      return [
        { type: "chat", kind: "persona", order: personaRow.personaOrder, ...personaMeta },
        { type: "feedback", kind: "persona_feedback", order: personaRow.personaOrder + 0.5, ...personaMeta }
      ];
    });

    const nonChatSteps = configuredSteps.filter((step) => step.type !== "chat").map((step) => ({ ...step }));
    const orderedPersonaSteps = personaSteps.sort((a, b) => (a.order || 0) - (b.order || 0));
    const steps = [...nonChatSteps, ...orderedPersonaSteps];

    res.json({
      participantCode: session.participantCode,
      sessionNumber: session.sessionNumber,
      status: session.sessionStatus,
      sessionLabel: match?.label || null,
      steps,
      conversationId: null,
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
    const { message, sessionPersonaId } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    if (!sessionPersonaId) {
      return res.status(400).json({ error: "sessionPersonaId is required." });
    }

    const session = await getSessionByToken(sessionToken);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const personaRecord = await getSessionPersona(sessionPersonaId);
    if (!personaRecord || personaRecord.sessionId !== session.sessionId) {
      return res.status(400).json({ error: "Persona not linked to this session." });
    }

    await markSessionStarted(session.sessionId);

    const personaData = withPersonaDisplay(personaRecord.personaJson);

    let conversationId = personaRecord.conversationId;
    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
      await saveSessionPersonaConversationId(sessionPersonaId, conversationId);
    }

    const now = new Date();
    const isoNow = now.toISOString();
    const firstMessageAt = personaRecord.firstMessageAt || isoNow;
    if (!personaRecord.firstMessageAt) {
      await markSessionPersonaFirstMessage(sessionPersonaId, isoNow);
    }

    const elapsedMs = now.getTime() - new Date(firstMessageAt).getTime();
    const elapsedMinutes = elapsedMs / 60000;

    if (elapsedMinutes >= 7) {
      return res.status(400).json({ error: "זמן השיחה הסתיים (7 דקות)." });
    }

    const shouldSendMid = !personaRecord.midPromptSent && elapsedMinutes >= 4.5;
    if (shouldSendMid) {
      await markSessionPersonaMidPromptSent(sessionPersonaId);
    }

    const instructions = combineChatPrompt(personaData, shouldSendMid || personaRecord.midPromptSent);

    logPromptEvent("chat", {
      sessionNumber: session.sessionNumber,
      participantCode: session.participantCode,
      sessionPersonaId,
      includeMid: shouldSendMid || personaRecord.midPromptSent,
      conversationId,
      instructionsPreview: instructions.slice(0, 1200)
    });

    const response = await createResponse({
      model: MODEL_ID,
      conversation: conversationId,
      instructions,
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

    await savePersonaMessage({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      role: "user",
      content: message,
      sessionPersonaId,
      conversationId
    });
    await savePersonaMessage({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      role: "assistant",
      content: assistantText,
      sessionPersonaId,
      conversationId
    });

    return res.json({
      conversationId,
      response: assistantText,
      firstMessageAt,
      midPromptSent: shouldSendMid || personaRecord.midPromptSent
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
      instructions: chatInstructions,
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

app.get("/api/session/:token/persona/:sessionPersonaId/messages", async (req, res) => {
  try {
    const { token, sessionPersonaId } = req.params;
    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const personaRecord = await getSessionPersona(Number(sessionPersonaId));
    if (!personaRecord || personaRecord.sessionId !== session.sessionId) {
      return res.status(404).json({ error: "Persona not found for this session." });
    }

    const messages = await listMessagesBySessionPersona(sessionPersonaId);
    return res.json({
      messages,
      conversationId: personaRecord.conversationId || null,
      firstMessageAt: personaRecord.firstMessageAt,
      midPromptSent: Boolean(personaRecord.midPromptSent),
      feedbackPromptSent: Boolean(personaRecord.feedbackPromptSent)
    });
  } catch (error) {
    console.error("Failed to load persona messages", error);
    return res.status(500).json({ error: error?.message || "Could not load messages." });
  }
});

app.post("/api/session/:token/persona/:sessionPersonaId/mid-prime", async (req, res) => {
  try {
    const { token, sessionPersonaId } = req.params;
    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }
    const personaRecord = await getSessionPersona(Number(sessionPersonaId));
    if (!personaRecord || personaRecord.sessionId !== session.sessionId) {
      return res.status(404).json({ error: "Persona not found for this session." });
    }

    if (!personaRecord.firstMessageAt) {
      return res.status(400).json({ error: "Chat has not started yet." });
    }

    const elapsedMs = Date.now() - new Date(personaRecord.firstMessageAt).getTime();
    const elapsedMinutes = elapsedMs / 60000;
    if (elapsedMinutes < 4.5) {
      return res.status(400).json({ error: "Mid-chat instructions not due yet." });
    }

    if (!personaRecord.midPromptSent) {
      await markSessionPersonaMidPromptSent(sessionPersonaId);
    }

    logPromptEvent("mid-prime", {
      sessionNumber: session.sessionNumber,
      sessionPersonaId,
      participantCode: session.participantCode,
      elapsedMinutes
    });

    return res.json({ ok: true, midPromptSent: true });
  } catch (error) {
    console.error("Failed to prime mid instructions", error);
    return res.status(500).json({ error: error?.message || "Could not prime mid instructions." });
  }
});

app.post("/api/session/:token/persona/:sessionPersonaId/feedback", async (req, res) => {
  try {
    const { token, sessionPersonaId } = req.params;
    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const personaRecord = await getSessionPersona(Number(sessionPersonaId));
    if (!personaRecord || personaRecord.sessionId !== session.sessionId) {
      return res.status(404).json({ error: "Persona not found for this session." });
    }

    const personaData = withPersonaDisplay(personaRecord.personaJson);
    let conversationId = personaRecord.conversationId;
    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
      await saveSessionPersonaConversationId(sessionPersonaId, conversationId);
    }

    const existingMessages = await listMessagesBySessionPersona(sessionPersonaId);
    const existingFeedback = existingMessages.reverse().find((m) => m.role === "assistant_feedback");
    if (existingFeedback) {
      return res.json({ response: existingFeedback.content, conversationId });
    }

    const instructions = combineFeedbackPrompt(personaData);
    logPromptEvent("feedback", {
      sessionNumber: session.sessionNumber,
      participantCode: session.participantCode,
      sessionPersonaId,
      conversationId,
      instructionsPreview: instructions.slice(0, 1200)
    });

    const response = await createResponse({
      model: MODEL_ID,
      conversation: conversationId,
      instructions,
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
            { type: "input_text", text: "סכם פידבק לפי ההנחיות." }
          ]
        }
      ]
    });

    const assistantText = extractTextFromResponse(response);

    await savePersonaMessage({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      role: "assistant_feedback",
      content: assistantText,
      sessionPersonaId,
      conversationId
    });
    await markSessionPersonaFeedbackSent(sessionPersonaId);

    return res.json({
      conversationId,
      response: assistantText
    });
  } catch (error) {
    console.error("Failed to generate feedback", error);
    const message = error?.response?.data?.error?.message || error?.message || "Unknown error";
    return res.status(500).json({ error: message });
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
