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
  listAllFormResponses,
  updateParticipantStatus,
  getSessionPersonas,
  saveSessionPersonaConversationId,
  markSessionPersonaFirstMessage,
  markSessionPersonaMidPromptSent,
  markSessionPersonaFeedbackSent,
  getSessionPersona,
  listMessagesBySessionPersona,
  saveConversationId,
  listSessionsByParticipant
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

const CHAT_DURATION_MINUTES = 2.5;
const CHAT_DURATION_MS = CHAT_DURATION_MINUTES * 60 * 1000;
const MID_PROMPT_MINUTES = 7;
const MID_PROMPT_MS = MID_PROMPT_MINUTES * 60 * 1000;
const FEEDBACK_MIN_PARTICIPANT_MESSAGES = 2;
const FEEDBACK_FALLBACK_TEXT = "feedback could not be provided as the chat did not meet the requirements";

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

function escapeCsvValue(value) {
  const safe = value == null ? "" : String(value);
  const escaped = safe.replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildFormResponsesCsv(rows) {
  const baseColumns = [
    "formKey",
    "participantCode",
    "sessionNumber",
    "sessionPersonaId",
    "personaName",
    "personaCsvId",
    "createdAt"
  ];

  const dynamicKeys = new Set();
  rows.forEach((row) => {
    Object.keys(row.responses || {}).forEach((key) => dynamicKeys.add(key));
  });
  const dynamicColumns = Array.from(dynamicKeys).sort();
  const columns = [...baseColumns, ...dynamicColumns];

  const header = columns.map(escapeCsvValue).join(",");
  const lines = rows.map((row) => {
    return columns
      .map((col) => {
        if (col === "formKey") return escapeCsvValue(row.formKey);
        if (col === "participantCode") return escapeCsvValue(row.participantCode);
        if (col === "sessionNumber") return escapeCsvValue(row.sessionNumber);
        if (col === "sessionPersonaId") return escapeCsvValue(row.sessionPersonaId);
        if (col === "personaName") return escapeCsvValue(row.personaName);
        if (col === "personaCsvId") return escapeCsvValue(row.personaCsvId);
        if (col === "createdAt") return escapeCsvValue(row.createdAt);

        const value = row.responses?.[col];
        if (Array.isArray(value)) return escapeCsvValue(value.join(" | "));
        if (value && typeof value === "object") return escapeCsvValue(JSON.stringify(value));
        return escapeCsvValue(value ?? "");
      })
      .join(",");
  });

  return [header, ...lines].join("\n");
}

async function maybeMarkSessionCompleted(session) {
  if (!session?.sessionId) return false;
  const personas = await getSessionPersonas(session.sessionId);
  if (!personas || !personas.length) return false;

  const now = Date.now();
  const allChatsCompleted = personas.every((persona) => {
    if (!persona.firstMessageAt) return false;
    const elapsed = now - new Date(persona.firstMessageAt).getTime();
    return elapsed >= CHAT_DURATION_MS;
  });

  if (!allChatsCompleted) return false;

  await markSessionCompleted(session.sessionId);
  const sessions = await listSessionsByParticipant(session.participantId);
  const allSessionsCompleted = sessions.length > 0 && sessions.every((s) => s.status === "completed" || s.completedAt);
  await updateParticipantStatus(session.participantId, allSessionsCompleted ? "completed" : "in_progress");
  return true;
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
    const requestedSession = Number(req.body?.sessionNumber) || 1;
    const availableSessions = (flow.sessions || []).map((s) => Number(s.session)).filter((n) => Number.isFinite(n));
    const sessionNumber = availableSessions.includes(requestedSession)
      ? requestedSession
      : (availableSessions[0] || 1);
    const invite = await createInvite({ sessionNumber });

    const origin = req.get("origin") || `${req.protocol}://${req.get("host")}`;
    const sessions = invite.sessionTokens.map(({ sessionNumber, token }) => ({
      sessionNumber,
      token,
      url: `${origin}/?token=${token}`,
      path: `/?token=${token}`
    }));

    res.json({ participantCode: invite.participantCode, sessions });
  } catch (error) {
    console.error("Failed to create invite", error);
    res.status(500).json({ error: error?.message || "Could not create invite." });
  }
});

app.get("/api/admin/session-options", (_req, res) => {
  try {
    const flow = loadSessionFlow();
    const options = (flow.sessions || []).map((session) => ({
      sessionNumber: Number(session.session),
      label: session.label || `מפגש ${session.session}`
    }));
    res.json({ sessions: options });
  } catch (error) {
    console.error("Failed to load session options", error);
    res.status(500).json({ error: error?.message || "Could not load session options." });
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

app.get("/api/admin/forms/responses", async (req, res) => {
  try {
    const formKey = req.query?.formKey ? String(req.query.formKey) : null;
    const responses = await listAllFormResponses({ formKey });
    const formKeys = Array.from(new Set(responses.map((r) => r.formKey))).sort();
    res.json({ responses, formKeys });
  } catch (error) {
    console.error("Failed to load form responses", error);
    res.status(500).json({ error: error?.message || "Could not load form responses." });
  }
});

app.get("/api/admin/forms/export", async (req, res) => {
  try {
    const formKey = req.query?.formKey ? String(req.query.formKey) : null;
    const responses = await listAllFormResponses({ formKey });
    const csv = buildFormResponsesCsv(responses);
    const safeName = formKey ? `form-${formKey}-responses.csv` : "form-responses.csv";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${safeName}`);
    res.send(csv);
  } catch (error) {
    console.error("Failed to export form responses", error);
    res.status(500).json({ error: error?.message || "Could not export form responses." });
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
    await maybeMarkSessionCompleted(session);

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
          gender: personaData.gender || "",
          background: personaData.background || "",
          background_ui: personaData.background_ui || personaData.background || "",
          emotional_intelligence: personaData.emotional_intelligence ?? null,
          style_of_expression: personaData.style_of_expression || ""
        }
      };
      return [
        { type: "chat", kind: "persona", order: personaRow.personaOrder, ...personaMeta },
        { type: "form", key: "post_chat", kind: "post_chat", order: personaRow.personaOrder + 0.25, ...personaMeta },
        { type: "feedback", kind: "persona_feedback", order: personaRow.personaOrder + 0.5, ...personaMeta },
        { type: "form", key: "post_feedback", kind: "post_feedback", order: personaRow.personaOrder + 0.75, ...personaMeta }
      ];
    });

    const nonChatSteps = configuredSteps
      .filter((step) => step.type !== "chat" && step.position !== "after_personas")
      .map((step) => ({ ...step }));
    const afterPersonaSteps = configuredSteps
      .filter((step) => step.type !== "chat" && step.position === "after_personas")
      .map((step) => ({ ...step }));
    const orderedPersonaSteps = personaSteps.sort((a, b) => (a.order || 0) - (b.order || 0));
    const steps = [...nonChatSteps, ...orderedPersonaSteps, ...afterPersonaSteps];

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
    const requestedSessionPersonaId = req.body?.sessionPersonaId ? Number(req.body.sessionPersonaId) : null;
    const personaFormKeys = new Set(["post_chat", "post_feedback"]);

    let allowed = steps.some((step) => step.type === "form" && step.key === formKey);
    if (!allowed && personaFormKeys.has(formKey)) {
      allowed = Boolean(requestedSessionPersonaId);
    }
    if (!allowed) {
      return res.status(400).json({ error: "Form not part of this session." });
    }

    if (requestedSessionPersonaId) {
      const personaRecord = await getSessionPersona(requestedSessionPersonaId);
      if (!personaRecord || personaRecord.sessionId !== session.sessionId) {
        return res.status(400).json({ error: "Persona not linked to this session." });
      }
    }

    const responses = req.body?.responses || {};
    await markSessionStarted(session.sessionId);
    await saveFormResponse({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      formKey,
      responses,
      sessionPersonaId: requestedSessionPersonaId
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

    if (elapsedMs >= CHAT_DURATION_MS) {
      await maybeMarkSessionCompleted(session);
      return res.status(400).json({ error: `זמן השיחה הסתיים (${CHAT_DURATION_MINUTES} דקות).` });
    }

    const midPromptEligible = elapsedMs >= MID_PROMPT_MS;
    const shouldAttachMidInstructions = midPromptEligible && !personaRecord.midPromptSent;

    const instructions = combineChatPrompt(personaData, shouldAttachMidInstructions || personaRecord.midPromptSent);

    logPromptEvent("chat", {
      sessionNumber: session.sessionNumber,
      participantCode: session.participantCode,
      sessionPersonaId,
      includeMid: shouldAttachMidInstructions || personaRecord.midPromptSent,
      conversationId,
      instructionsPreview: instructions.slice(0, 1200)
    });

    const responsePayload = {
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
    };

    const response = await createResponse(responsePayload);

    const assistantText = extractTextFromResponse(response);

    if (shouldAttachMidInstructions) {
      await markSessionPersonaMidPromptSent(sessionPersonaId);
    }

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
      midPromptSent: shouldAttachMidInstructions || personaRecord.midPromptSent
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

    const responsePayload = {
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
    };

    const response = await createResponse(responsePayload);

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
    const completed = await maybeMarkSessionCompleted(session);
    if (!completed) {
      return res.status(400).json({ error: "Session cannot be completed until all chats reach the time requirement." });
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
    if (elapsedMs < MID_PROMPT_MS) {
      return res.status(400).json({ error: "Mid-chat instructions not due yet." });
    }

    logPromptEvent("mid-prime", {
      sessionNumber: session.sessionNumber,
      sessionPersonaId,
      participantCode: session.participantCode,
      elapsedMinutes
    });

    return res.json({ ok: true, midPromptPending: !personaRecord.midPromptSent });
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
    const existingMessages = await listMessagesBySessionPersona(sessionPersonaId);
    const existingFeedback = [...existingMessages].reverse().find((m) => m.role === "assistant_feedback");
    if (existingFeedback) {
      return res.json({ response: existingFeedback.content, conversationId: personaRecord.conversationId || null });
    }

    const participantMessageCount = existingMessages.filter((m) => m.role === "user").length;
    const hasFirstMessage = Boolean(personaRecord.firstMessageAt);
    const elapsedMs = hasFirstMessage
      ? Date.now() - new Date(personaRecord.firstMessageAt).getTime()
      : 0;
    const eligible = hasFirstMessage
      && elapsedMs >= CHAT_DURATION_MS
      && participantMessageCount >= FEEDBACK_MIN_PARTICIPANT_MESSAGES;

    if (!eligible) {
      await savePersonaMessage({
        participantId: session.participantId,
        sessionNumber: session.sessionNumber,
        role: "assistant_feedback",
        content: FEEDBACK_FALLBACK_TEXT,
        sessionPersonaId,
        conversationId: personaRecord.conversationId || null
      });
      await markSessionPersonaFeedbackSent(sessionPersonaId);
      await maybeMarkSessionCompleted(session);
      return res.json({
        response: FEEDBACK_FALLBACK_TEXT,
        conversationId: personaRecord.conversationId || null,
        eligible: false
      });
    }

    let conversationId = personaRecord.conversationId;
    if (!conversationId) {
      const conversation = await createConversation();
      conversationId = conversation.id;
      await saveSessionPersonaConversationId(sessionPersonaId, conversationId);
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
    await maybeMarkSessionCompleted(session);

    return res.json({
      conversationId,
      response: assistantText,
      eligible: true
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
