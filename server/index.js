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
  listFormResponses,
  updateParticipantStatus,
  getSessionPersonas,
  resetSessionByToken,
  saveSessionPersonaConversationId,
  markSessionPersonaFirstMessage,
  markSessionPersonaMidPromptSent,
  markSessionPersonaFeedbackSent,
  getSessionPersona,
  listMessagesBySessionPersona,
  listSessionsByParticipant,
  saveModuleQuestionResponse,
  listModuleQuestionResponses
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

const CHAT_DURATION_MINUTES = 8;
const CHAT_DURATION_MS = CHAT_DURATION_MINUTES * 60 * 1000;
const CONSENT_LOCK_WINDOW_MS = 60 * 60 * 1000;
const MID_PROMPT_MINUTES = 9;
const MID_PROMPT_MS = MID_PROMPT_MINUTES * 60 * 1000;
const FEEDBACK_MIN_PARTICIPANT_MESSAGES = 2;
const FEEDBACK_FALLBACK_TEXT = "feedback could not be provided as the chat did not meet the requirements";

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "12345";

function adminAuth(req, res, next) {
  if (isAdminAuthorized(req)) return next();
  res.set("WWW-Authenticate", "Basic realm=admin");
  return res.status(401).send("Invalid credentials");
}

function isAdminAuthorized(req) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return false;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  const [user, pass] = decoded.split(":");
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
}

function challengeAdminAuth(res) {
  res.set("WWW-Authenticate", "Basic realm=admin");
  return res.status(401).json({ error: "Admin credentials are required for this session." });
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

function getOrderedReadingHalf(readingOrder, halfOrder) {
  const normalizedOrder = readingOrder === "confrontation_first" ? "confrontation_first" : "withdrawal_first";
  const firstHalf = normalizedOrder === "withdrawal_first" ? "withdrawal" : "confrontation";
  const secondHalf = firstHalf === "withdrawal" ? "confrontation" : "withdrawal";
  return Number(halfOrder) === 2 ? secondHalf : firstHalf;
}

function resolveModuleKeyByOrder(session, step) {
  const half = getOrderedReadingHalf(session.readingOrder, step.moduleOrder);
  const moduleKey = step?.moduleByHalf?.[half] || null;
  return { half, moduleKey };
}

function getGroupSessions(flow, groupAssignment) {
  const key = groupAssignment === "control" ? "control" : "experimental";
  return flow?.groups?.[key]?.sessions || [];
}

function getSessionDefinition(groupAssignment, sessionNumber) {
  const flow = loadSessionFlow();
  const sessions = getGroupSessions(flow, groupAssignment);
  const match = sessions.find((session) => Number(session.session) === Number(sessionNumber));
  if (match) {
    return match;
  }
  return { session: sessionNumber, label: `מפגש ${sessionNumber}`, steps: [{ type: "chat" }] };
}

function getSessionSteps(session) {
  const definition = getSessionDefinition(session.groupAssignment, session.sessionNumber);
  const rawSteps = Array.isArray(definition.steps) ? definition.steps : [{ type: "chat" }];
  return rawSteps.map((step) => {
    if (step.type !== "module") return { ...step };
    let resolvedKey = step.key || null;
    let resolvedHalf = null;
    if (!resolvedKey && step.keySource === "reading_order") {
      const resolved = resolveModuleKeyByOrder(session, step);
      resolvedHalf = resolved.half;
      resolvedKey = resolved.moduleKey;
    }
    return { ...step, key: resolvedKey, resolvedHalf };
  });
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

function personaFieldStatus(personaObj) {
  const required = [
    "name",
    "gender",
    "age",
    "main_markers",
    "emotional_intelligence",
    "style_of_expression",
    "background"
  ];
  const missing = required.filter((key) => {
    const v = personaObj?.[key];
    return v === undefined || v === null || String(v).trim() === "";
  });
  return { required, missing };
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
  const steps = getSessionSteps(session);
  const hasChat = steps.some((step) => step.type === "chat");
  const moduleSteps = steps.filter((step) => step.type === "module" && step.key);

  if (hasChat) {
    const personas = await getSessionPersonas(session.sessionId);
    if (!personas || !personas.length) return false;

    const now = Date.now();
    const allChatsCompleted = personas.every((persona) => {
      if (!persona.firstMessageAt) return false;
      const elapsed = now - new Date(persona.firstMessageAt).getTime();
      return elapsed >= CHAT_DURATION_MS;
    });

    if (!allChatsCompleted) return false;
  } else if (moduleSteps.length) {
    for (const moduleStep of moduleSteps) {
      const moduleDef = loadModuleDefinition(moduleStep.key);
      if (!moduleDef) return false;

      const sections = Array.isArray(moduleDef.sections) ? moduleDef.sections : [];
      const questions = sections.flatMap((section) =>
        (section.questions || []).map((question) => ({
          sectionId: section.section_id,
          questionId: question.question_id
        }))
      );
      if (!questions.length) {
        continue;
      }

      const responses = await listModuleQuestionResponses({
        participantId: session.participantId,
        sessionNumber: session.sessionNumber,
        moduleName: moduleStep.key
      });

      const answeredSet = new Set(
        responses.map((r) => `${String(r.sectionId || "")}::${String(r.questionId || "")}`)
      );

      for (const question of questions) {
        const sectionId = String(question.sectionId || "");
        const questionId = String(question.questionId || "");
        if (!sectionId || !questionId) continue;
        const key = `${sectionId}::${questionId}`;
        if (!answeredSet.has(key)) {
          return false;
        }
      }
    }
  }

  await markSessionCompleted(session.sessionId);
  const sessions = await listSessionsByParticipant(session.participantId);
  const allSessionsCompleted = sessions.length > 0 && sessions.every((s) => s.status === "completed" || s.completedAt);
  await updateParticipantStatus(session.participantId, allSessionsCompleted ? "completed" : "in_progress");
  return true;
}

async function getSessionLockState(session) {
  if (!session) {
    return { locked: false, reason: null, code: null };
  }

  if (session.sessionStatus === "completed" || session.completedAt) {
    return { locked: true, reason: "Session flow is complete.", code: "session_completed" };
  }

  const forms = await listFormResponses({
    participantId: session.participantId,
    sessionNumber: session.sessionNumber
  });
  const consentResponse = forms.find((row) => row.formKey === "consent");
  if (!consentResponse?.createdAt) {
    return { locked: false, reason: null, code: null };
  }

  const elapsed = Date.now() - new Date(consentResponse.createdAt).getTime();
  if (elapsed > CONSENT_LOCK_WINDOW_MS) {
    return {
      locked: true,
      reason: "More than 1 hour passed since consent was completed.",
      code: "consent_expired"
    };
  }

  return { locked: false, reason: null, code: null };
}

async function enforceLockedSessionAdmin(req, res, next) {
  try {
    const sessionToken = req.params?.token || req.query?.token;
    if (!sessionToken) return next();

    const session = await getSessionByToken(sessionToken);
    if (!session) return next();

    await maybeMarkSessionCompleted(session);
    const refreshed = await getSessionByToken(sessionToken);
    const lockState = await getSessionLockState(refreshed || session);
    if (!lockState.locked) return next();
    if (isAdminAuthorized(req)) return next();

    return challengeAdminAuth(res);
  } catch (error) {
    console.error("Failed to enforce locked-session auth", error);
    return res.status(500).json({ error: "Could not validate session lock state." });
  }
}

app.get("/", enforceLockedSessionAdmin, (_req, res, next) => {
  next();
});
app.use("/api/session/:token", enforceLockedSessionAdmin);
app.use(express.static(path.join(__dirname, "..", "client")));

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

function findModuleSectionAndQuestion(moduleDef, sectionId, questionId) {
  const sections = Array.isArray(moduleDef?.sections) ? moduleDef.sections : [];
  const section = sections.find((candidate) => String(candidate.section_id) === String(sectionId));
  if (!section) return { section: null, question: null, questionNumber: null };
  const questions = Array.isArray(section.questions) ? section.questions : [];
  const questionIndex = questions.findIndex((candidate) => String(candidate.question_id) === String(questionId));
  if (questionIndex < 0) {
    return { section, question: null, questionNumber: null };
  }
  return {
    section,
    question: questions[questionIndex],
    questionNumber: questionIndex + 1
  };
}

app.use("/api/admin", adminAuth);

app.post("/api/admin/invite", async (req, res) => {
  try {
    const groupAssignment = req.body?.groupAssignment === "control" ? "control" : "experimental";
    const readingOrder = req.body?.readingOrder === "confrontation_first"
      ? "confrontation_first"
      : "withdrawal_first";
    const invite = await createInvite({ groupAssignment, readingOrder });

    const origin = req.get("origin") || `${req.protocol}://${req.get("host")}`;
    const sessions = invite.sessionTokens.map(({ sessionNumber, token }) => ({
      sessionNumber,
      token,
      url: `${origin}/?token=${token}`,
      path: `/?token=${token}`
    }));

    res.json({
      participantCode: invite.participantCode,
      groupAssignment,
      readingOrder,
      sessions
    });
  } catch (error) {
    console.error("Failed to create invite", error);
    res.status(500).json({ error: error?.message || "Could not create invite." });
  }
});

app.get("/api/admin/session-options", (_req, res) => {
  try {
    res.json({
      groups: [
        { key: "experimental", label: "Experimental" },
        { key: "control", label: "Control" }
      ],
      readingOrders: [
        { key: "withdrawal_first", label: "Withdrawal → Confrontation" },
        { key: "confrontation_first", label: "Confrontation → Withdrawal" }
      ]
    });
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

app.post("/api/admin/session/reset", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Session token is required." });
    }

    const resetResult = await resetSessionByToken(token);
    if (!resetResult) {
      return res.status(404).json({ error: "Session not found for token." });
    }

    return res.json({
      ok: true,
      participantCode: resetResult.participantCode,
      sessionNumber: resetResult.sessionNumber,
      participantStatus: resetResult.participantStatus
    });
  } catch (error) {
    console.error("Failed to reset session", error);
    return res.status(500).json({ error: error?.message || "Could not reset session." });
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
  // Ensure clients do not cache module JSON; always fetch fresh content.
  res.setHeader("Cache-Control", "no-store, max-age=0");
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

    const definition = getSessionDefinition(session.groupAssignment, session.sessionNumber);
    const configuredSteps = getSessionSteps(session);
    const hasChatSteps = configuredSteps.some((step) => step.type === "chat");

    let persistedPersonas = [];
    if (hasChatSteps) {
      await ensureSessionPersonas({
        sessionId: session.sessionId,
        participantId: session.participantId,
        sessionNumber: session.sessionNumber,
        participantCode: session.participantCode
      });
      persistedPersonas = await getSessionPersonas(session.sessionId);
    }

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
    const preChatInstructionStep = orderedPersonaSteps.length
      ? [{
        type: "participant_instruction",
        key: "pre_chat_instruction",
      }]
      : [];
    const steps = [...nonChatSteps, ...preChatInstructionStep, ...orderedPersonaSteps, ...afterPersonaSteps];

    res.json({
      participantCode: session.participantCode,
      sessionNumber: session.sessionNumber,
      status: session.sessionStatus,
      sessionLabel: definition?.label || null,
      groupAssignment: session.groupAssignment,
      readingOrder: session.readingOrder,
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

    const steps = getSessionSteps(session);
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

app.get("/api/session/:token/forms/:formKey", async (req, res) => {
  try {
    const { token, formKey } = req.params;
    const requestedSessionPersonaId = req.query?.sessionPersonaId ? Number(req.query.sessionPersonaId) : null;
    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const steps = getSessionSteps(session);
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

    const allResponses = await listFormResponses({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber
    });

    const match = allResponses
      .filter((row) => row.formKey === formKey)
      .find((row) => {
        const rowPersonaId = row.sessionPersonaId ? Number(row.sessionPersonaId) : null;
        if (requestedSessionPersonaId) {
          return rowPersonaId === requestedSessionPersonaId;
        }
        return rowPersonaId === null;
      });

    res.json({ responses: match?.responses || {} });
  } catch (error) {
    console.error("Failed to load form responses", error);
    res.status(500).json({ error: error?.message || "Could not load form responses." });
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
    const personaFields = personaFieldStatus(personaData);

    logPromptEvent("chat", {
      sessionNumber: session.sessionNumber,
      participantCode: session.participantCode,
      sessionPersonaId,
      includeMid: shouldAttachMidInstructions || personaRecord.midPromptSent,
      conversationId,
      personaFields,
      instructionsLength: instructions.length,
      instructions
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

app.get("/api/session/:token/modules/:moduleKey/responses", async (req, res) => {
  try {
    const { token, moduleKey } = req.params;
    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const steps = getSessionSteps(session);
    const allowed = steps.some((step) => step.type === "module" && step.key === moduleKey);
    if (!allowed) {
      return res.status(400).json({ error: "Module not part of this session." });
    }

    const responses = await listModuleQuestionResponses({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      moduleName: moduleKey
    });
    return res.json({ responses });
  } catch (error) {
    console.error("Failed to load module responses", error);
    return res.status(500).json({ error: error?.message || "Could not load module responses." });
  }
});

app.post("/api/session/:token/modules/:moduleKey/answer", async (req, res) => {
  try {
    const { token, moduleKey } = req.params;
    const {
      sectionId,
      sectionNumber,
      questionId,
      answer
    } = req.body || {};
    if (!sectionId || !questionId || answer == null) {
      return res.status(400).json({ error: "sectionId, questionId and answer are required." });
    }

    const session = await getSessionByToken(token);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const steps = getSessionSteps(session);
    const allowed = steps.some((step) => step.type === "module" && step.key === moduleKey);
    if (!allowed) {
      return res.status(400).json({ error: "Module not part of this session." });
    }

    const moduleDef = loadModuleDefinition(moduleKey);
    if (!moduleDef) {
      return res.status(404).json({ error: "Module not found." });
    }
    const resolved = findModuleSectionAndQuestion(moduleDef, sectionId, questionId);
    if (!resolved.section || !resolved.question) {
      return res.status(400).json({ error: "Question not found in module definition." });
    }

    await markSessionStarted(session.sessionId);
    const refreshedSession = await getSessionByToken(token);
    const answeredAt = new Date();
    const startedAtMs = refreshedSession?.startedAt ? new Date(refreshedSession.startedAt).getTime() : null;
    const elapsedMinutes = startedAtMs ? (answeredAt.getTime() - startedAtMs) / 60000 : null;

    const normalizedAnswer = String(answer);
    const correctIndex = Number.isInteger(Number(resolved.question.correct_answer_index))
      ? Number(resolved.question.correct_answer_index)
      : null;
    const moduleOptions = Array.isArray(resolved.question.options) ? resolved.question.options : [];
    const normalizedCorrectAnswer = correctIndex == null ? null : String(moduleOptions[correctIndex] ?? "");
    const isCorrect = normalizedCorrectAnswer == null ? null : (normalizedAnswer === normalizedCorrectAnswer);

    const saveResult = await saveModuleQuestionResponse({
      participantId: session.participantId,
      sessionId: session.sessionId,
      sessionNumber: session.sessionNumber,
      moduleName: moduleKey,
      sectionId: String(sectionId),
      sectionNumber: Number.isFinite(Number(sectionNumber))
        ? Number(sectionNumber)
        : Number(resolved.section.order_number) || null,
      questionId: String(questionId),
      questionNumber: resolved.questionNumber,
      questionContent: resolved.question.prompt || resolved.question.question_id || null,
      answer: normalizedAnswer,
      correctAnswer: normalizedCorrectAnswer,
      isCorrect,
      timedate: answeredAt.toISOString(),
      timeSinceStart: elapsedMinutes
    });

    if (!saveResult.inserted) {
      return res.status(409).json({ error: "Question already answered and locked." });
    }

    await maybeMarkSessionCompleted(session);
    return res.json({ ok: true, isCorrect });
  } catch (error) {
    console.error("Failed to save module answer", error);
    return res.status(500).json({ error: error?.message || "Could not save module answer." });
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
      return res.status(400).json({ error: "Session cannot be completed until all required steps are finished." });
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
    const personaFields = personaFieldStatus(personaData);

    logPromptEvent("feedback", {
      sessionNumber: session.sessionNumber,
      participantCode: session.participantCode,
      sessionPersonaId,
      conversationId,
      personaFields,
      instructionsLength: instructions.length,
      instructions
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
