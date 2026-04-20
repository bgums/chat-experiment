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
  createSessionPersonas,
  getSessionByToken,
  getParticipantByCode,
  listParticipants,
  markSessionStarted,
  markSessionCompleted,
  saveFormResponse,
  savePersonaMessage,
  listMessagesByParticipant,
  listAllFormResponses,
  listParticipantFormResponses,
  listFormResponses,
  updateParticipantStatus,
  updateParticipantMetadata,
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
  listModuleQuestionResponses,
  listIncompleteSessionsForAdmin,
  listScheduleLockDisabledSessionsForAdmin,
  listPersonaSessionDistribution,
  deleteParticipantByCode,
  updateSessionScheduleLockByToken
} from "./db.js";
import { ensureSessionPersonas, buildPersonaPrompt, getAllPersonas } from "./utils/personaLoader.js";
import { nowGmtPlus3Iso } from "./utils/timezone.js";

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
const CONSENT_LOCK_WINDOW_MS = 2 * 60 * 60 * 1000;
const SESSION_SCHEDULE_LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const MID_PROMPT_MINUTES = 9;
const MID_PROMPT_MS = MID_PROMPT_MINUTES * 60 * 1000;
const CHAT_MAX_OUTPUT_TOKENS = Math.max(1, Number(process.env.OPENAI_CHAT_MAX_OUTPUT_TOKENS || 500));
const FEEDBACK_MAX_OUTPUT_TOKENS = Math.max(1, Number(process.env.OPENAI_FEEDBACK_MAX_OUTPUT_TOKENS || 1500));
const FEEDBACK_MIN_PARTICIPANT_MESSAGES = 2;
const FEEDBACK_FALLBACK_TEXT = "feedback could not be provided as the chat did not meet the requirements";
const FEEDBACK_SYSTEM_BUSY_TEXT = "Feedback is delayed due to temporary system load. Please wait a moment and it will appear automatically.";
const FEEDBACK_POLL_AFTER_MS = Math.max(500, Number(process.env.FEEDBACK_POLL_AFTER_MS || 2000));
const FEEDBACK_MAX_CONCURRENCY = Math.max(1, Number(process.env.FEEDBACK_MAX_CONCURRENCY || 3));
const FEEDBACK_MAX_RETRIES = Math.max(0, Number(process.env.FEEDBACK_MAX_RETRIES || 6));
const FEEDBACK_RETRY_BASE_MS = Math.max(250, Number(process.env.FEEDBACK_RETRY_BASE_MS || 1000));
const FEEDBACK_RETRY_MAX_MS = Math.max(FEEDBACK_RETRY_BASE_MS, Number(process.env.FEEDBACK_RETRY_MAX_MS || 15000));

const feedbackJobsByPersona = new Map();
const feedbackJobQueue = [];
let activeFeedbackWorkers = 0;

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

function getLockFormKey(lockCode) {
  if (lockCode === "session_completed") return "session_locked_completion";
  if (lockCode === "consent_expired") return "session_locked_consent_expired";
  if (lockCode === "scheduled_time_expired") return "session_locked_scheduled_expired";
  return "session_locked_completion";
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

function shouldIncludeFeedbackForSession(session) {
  if (!session) return false;
  return session.groupAssignment === "experimental";
}

function shouldIncludePreFeedbackInstructionForSession(session) {
  if (!session) return false;
  const isExperimental = session.groupAssignment === "experimental";
  const sessionNumber = Number(session.sessionNumber);
  return isExperimental && sessionNumber === 1;
}

function isSessionOneExperimental(session) {
  if (!session) return false;
  return session.groupAssignment === "experimental" && Number(session.sessionNumber) === 1;
}

function getLastPersonaId(personas) {
  if (!Array.isArray(personas) || !personas.length) return null;
  const sorted = [...personas].sort((a, b) => {
    const orderDiff = Number(a?.personaOrder || 0) - Number(b?.personaOrder || 0);
    if (orderDiff !== 0) return orderDiff;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
  return Number(sorted[sorted.length - 1]?.id || 0) || null;
}

async function isFeedbackAllowedForPersona(session, sessionPersonaId) {
  if (!shouldIncludeFeedbackForSession(session)) return false;
  if (!isSessionOneExperimental(session)) return true;

  const personas = await getSessionPersonas(session.sessionId);
  const lastPersonaId = getLastPersonaId(personas);
  return Number(sessionPersonaId) === Number(lastPersonaId);
}

async function hasPostChatFormForPersona(session, sessionPersonaId) {
  if (!session?.participantId || !session?.sessionNumber || !sessionPersonaId) return false;

  const responses = await listFormResponses({
    participantId: session.participantId,
    sessionNumber: session.sessionNumber,
  });

  return (responses || []).some((row) =>
    row.formKey === "post_chat" && Number(row.sessionPersonaId) === Number(sessionPersonaId)
  );
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

function getErrorMessage(error) {
  return error?.response?.data?.error?.message || error?.message || "Unknown error";
}

function getErrorStatus(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

function isRetryableFeedbackError(error) {
  const status = getErrorStatus(error);
  if (status === 429 || status >= 500) {
    return true;
  }

  const code = String(error?.code || error?.response?.data?.error?.code || "").toLowerCase();
  const message = getErrorMessage(error).toLowerCase();
  if (code.includes("rate") || code.includes("timeout") || code.includes("tempor")) {
    return true;
  }
  if (message.includes("rate limit") || message.includes("timeout") || message.includes("tempor")) {
    return true;
  }

  return false;
}

function feedbackRetryDelayMs(attemptNumber) {
  const expDelay = FEEDBACK_RETRY_BASE_MS * (2 ** Math.max(0, attemptNumber - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(FEEDBACK_RETRY_MAX_MS, expDelay) + jitter;
}

async function getExistingFeedbackMessage(sessionPersonaId) {
  const existingMessages = await listMessagesBySessionPersona(sessionPersonaId);
  return [...existingMessages].reverse().find((m) => m.role === "assistant_feedback") || null;
}

async function persistFeedbackMessage({ session, sessionPersonaId, conversationId, content }) {
  await savePersonaMessage({
    participantId: session.participantId,
    sessionNumber: session.sessionNumber,
    role: "assistant_feedback",
    content,
    sessionPersonaId,
    conversationId: conversationId || null
  });
  await markSessionPersonaFeedbackSent(sessionPersonaId);
  await maybeMarkSessionCompleted(session);
}

async function generateEligibleFeedback({ session, sessionPersonaId, personaRecord }) {
  const personaData = withPersonaDisplay(personaRecord.personaJson);

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
    max_output_tokens: FEEDBACK_MAX_OUTPUT_TOKENS,
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
  await persistFeedbackMessage({
    session,
    sessionPersonaId,
    conversationId,
    content: assistantText
  });
}

function runFeedbackQueue() {
  while (activeFeedbackWorkers < FEEDBACK_MAX_CONCURRENCY && feedbackJobQueue.length > 0) {
    const job = feedbackJobQueue.shift();
    if (!job || job.status === "running") {
      continue;
    }

    activeFeedbackWorkers += 1;
    job.status = "running";

    processFeedbackJob(job)
      .catch((error) => {
        console.error("Unexpected feedback worker failure", error);
      })
      .finally(() => {
        activeFeedbackWorkers -= 1;
        runFeedbackQueue();
      });
  }
}

function scheduleFeedbackRetry(job) {
  const delay = feedbackRetryDelayMs(job.attempt);
  job.status = "retry_scheduled";
  setTimeout(() => {
    if (!feedbackJobsByPersona.has(job.key)) {
      return;
    }
    job.status = "queued";
    feedbackJobQueue.push(job);
    runFeedbackQueue();
  }, delay);
}

async function processFeedbackJob(job) {
  const session = await getSessionByToken(job.token);
  if (!session) {
    feedbackJobsByPersona.delete(job.key);
    return;
  }

  const personaRecord = await getSessionPersona(job.sessionPersonaId);
  if (!personaRecord || personaRecord.sessionId !== session.sessionId) {
    feedbackJobsByPersona.delete(job.key);
    return;
  }

  const existingFeedback = await getExistingFeedbackMessage(job.sessionPersonaId);
  if (existingFeedback) {
    job.status = "completed";
    feedbackJobsByPersona.delete(job.key);
    return;
  }

  try {
    await generateEligibleFeedback({ session, sessionPersonaId: job.sessionPersonaId, personaRecord });
    job.status = "completed";
    feedbackJobsByPersona.delete(job.key);
  } catch (error) {
    job.lastError = getErrorMessage(error);
    const retryable = isRetryableFeedbackError(error);

    if (retryable && job.attempt < FEEDBACK_MAX_RETRIES) {
      job.attempt += 1;
      scheduleFeedbackRetry(job);
      return;
    }

    console.error("Feedback job failed permanently", {
      sessionPersonaId: job.sessionPersonaId,
      attempts: job.attempt,
      retryable,
      error: job.lastError
    });

    const fallbackFeedback = await getExistingFeedbackMessage(job.sessionPersonaId);
    if (!fallbackFeedback) {
      await persistFeedbackMessage({
        session,
        sessionPersonaId: job.sessionPersonaId,
        conversationId: personaRecord.conversationId || null,
        content: FEEDBACK_SYSTEM_BUSY_TEXT
      });
    }
    job.status = "failed";
    feedbackJobsByPersona.delete(job.key);
  }
}

function enqueueFeedbackJob({ token, sessionPersonaId }) {
  const key = String(sessionPersonaId);
  const existing = feedbackJobsByPersona.get(key);
  if (existing) {
    return existing;
  }

  const job = {
    key,
    token,
    sessionPersonaId: Number(sessionPersonaId),
    status: "queued",
    createdAt: Date.now(),
    attempt: 0,
    lastError: null
  };

  feedbackJobsByPersona.set(key, job);
  feedbackJobQueue.push(job);
  runFeedbackQueue();
  return job;
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
  if (session.sessionStatus === "completed" || session.completedAt) return true;

  const formResponses = await listFormResponses({
    participantId: session.participantId,
    sessionNumber: session.sessionNumber
  });
  const completionConfirmed = formResponses.some((row) =>
    row.formKey === "session_completion_confirmed" && (row.sessionPersonaId == null || row.sessionPersonaId === "")
  );

  if (!completionConfirmed) return false;

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

  if (session.scheduledFor && !session.scheduleLockDisabled) {
    const scheduledMs = new Date(session.scheduledFor).getTime();
    if (!Number.isNaN(scheduledMs)) {
      const elapsedSinceSchedule = Date.now() - scheduledMs;
      if (elapsedSinceSchedule > SESSION_SCHEDULE_LOCK_WINDOW_MS) {
        return {
          locked: true,
          reason: "More than 24 hours passed since this session's scheduled time.",
          code: "scheduled_time_expired"
        };
      }
    }
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
      reason: "More than 2 hours passed since consent was completed.",
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
    req.sessionLockState = lockState;
    if (!lockState.locked) return next();

    const unlockRequested = String(req.headers["x-session-unlock"] || "") === "1";
    if (isAdminAuthorized(req) && unlockRequested) return next();

    const isSessionOverviewRoute = req.method === "GET" && (req.path === "/" || req.path === "");
    if (isSessionOverviewRoute) return next();

    return res.status(423).json({
      error: "Session is locked.",
      lockState
    });
  } catch (error) {
    console.error("Failed to enforce locked-session auth", error);
    return res.status(500).json({ error: "Could not validate session lock state." });
  }
}

app.use("/api/session/:token", enforceLockedSessionAdmin);
app.use("/forms-assets", express.static(formsDir));
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

function buildFormQuestionMap(formDef) {
  const map = new Map();
  if (!formDef || typeof formDef !== "object") {
    return map;
  }

  const statements = Array.isArray(formDef.statements) ? formDef.statements : [];
  statements.forEach((statement, idx) => {
    map.set(`statement_${idx}`, String(statement));
  });

  const items = Array.isArray(formDef.items) ? formDef.items : [];
  items.forEach((item) => {
    const key = String(item?.id || "").trim();
    if (!key) return;
    map.set(key, String(item?.prompt || key));
  });

  if (formDef.requireSignature) {
    map.set("signature", "שם/חתימה");
  }

  if (formDef.confirmationText) {
    map.set("confirmation", String(formDef.confirmationText));
  }

  return map;
}

function normalizeAnswerText(value) {
  if (Array.isArray(value)) return value.join(" | ");
  if (value && typeof value === "object") return JSON.stringify(value);
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "כן" : "לא";
  return String(value);
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

function getModuleQuestionId(section, question, questionIndex) {
  const raw = question?.question_id;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    return String(raw);
  }
  return `${String(section?.section_id || "")}__q${Number(questionIndex) + 1}`;
}

function findModuleSectionAndQuestion(moduleDef, sectionId, questionId) {
  const sections = Array.isArray(moduleDef?.sections) ? moduleDef.sections : [];
  const section = sections.find((candidate) => String(candidate.section_id) === String(sectionId));
  if (!section) return { section: null, question: null, questionNumber: null };
  const questions = Array.isArray(section.questions) ? section.questions : [];
  let questionIndex = questions.findIndex((candidate, idx) => getModuleQuestionId(section, candidate, idx) === String(questionId || ""));
  if (questionIndex < 0 && !questionId && questions.length === 1) questionIndex = 0;
  if (questionIndex < 0) return { section, question: null, questionNumber: null };
  return {
    section,
    question: questions[questionIndex],
    questionId: getModuleQuestionId(section, questions[questionIndex], questionIndex),
    questionNumber: questionIndex + 1
  };
}

function shuffleArray(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function groupPersonasByGroupKey(personas) {
  const grouped = new Map();
  (personas || []).forEach((persona) => {
    const key = String(persona?.group ?? "").trim();
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(persona);
  });
  return grouped;
}

function buildPersonaRowsForGroup(groupedPersonas, groupKey) {
  const personas = groupedPersonas.get(groupKey) || [];
  const randomized = shuffleArray(personas);
  return randomized.map((persona, idx) => ({
    personaCsvId: Number(persona?.patient_id || idx + 1),
    order: idx + 1,
    name: persona?.name || `Persona ${idx + 1}`,
    data: persona
  }));
}

function buildBalancedBatchPlan(groupKeys) {
  const normalizedGroups = (groupKeys || []).map((g) => String(g)).filter(Boolean);
  if (!normalizedGroups.length) {
    throw new Error("No persona groups were found for balanced batch allocation.");
  }

  const armSize = normalizedGroups.length;
  const experimentalBase = shuffleArray(normalizedGroups);
  const controlSession1Base = shuffleArray(normalizedGroups);
  const controlSession4Base = shuffleArray(normalizedGroups);
  const readingBase = shuffleArray(Array.from({ length: armSize }, (_, idx) => idx));

  const experimentalParticipants = Array.from({ length: armSize }, (_, idx) => {
    const sessionGroupMap = {
      1: experimentalBase[(idx + 0) % armSize],
      2: experimentalBase[(idx + 1) % armSize],
      3: experimentalBase[(idx + 2) % armSize],
      4: experimentalBase[(idx + 3) % armSize]
    };
    return {
      groupAssignment: "experimental",
      readingOrder: "withdrawal_first",
      sessionGroupMap
    };
  });

  const controlParticipants = Array.from({ length: armSize }, (_, idx) => {
    const readingOrder = readingBase[idx] % 2 === 0 ? "withdrawal_first" : "confrontation_first";
    const sessionGroupMap = {
      1: controlSession1Base[idx],
      4: controlSession4Base[idx]
    };
    return {
      groupAssignment: "control",
      readingOrder,
      sessionGroupMap
    };
  });

  const participants = [];
  for (let i = 0; i < armSize; i += 1) {
    participants.push(experimentalParticipants[i]);
    participants.push(controlParticipants[i]);
  }

  return {
    armSize,
    totalParticipants: participants.length,
    participants
  };
}

app.use("/api/admin", adminAuth);

app.post("/api/admin/invite", async (req, res) => {
  try {
    const groupAssignment = req.body?.groupAssignment === "control" ? "control" : "experimental";
    let readingOrder;
    // Randomize reading order for the control group so withdrawal/confrontation
    // assignments vary across participants in the control arm.
    if (groupAssignment === "control") {
      readingOrder = Math.random() < 0.5 ? "withdrawal_first" : "confrontation_first";
    } else {
      readingOrder = req.body?.readingOrder === "confrontation_first"
        ? "confrontation_first"
        : "withdrawal_first";
    }
    const invite = await createInvite({ groupAssignment, readingOrder });

    const participantSessions = await listSessionsByParticipant(invite.participantId);
    for (const participantSession of participantSessions) {
      await ensureSessionPersonas({
        sessionId: participantSession.sessionId,
        participantId: invite.participantId,
        sessionNumber: participantSession.sessionNumber,
        participantCode: invite.participantCode,
        groupAssignment
      });
    }

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

app.post("/api/admin/invite-balanced-batch", async (req, res) => {
  try {
    const allPersonas = getAllPersonas();
    const groupedPersonas = groupPersonasByGroupKey(allPersonas);
    const groupKeys = Array.from(groupedPersonas.keys());
    const plan = buildBalancedBatchPlan(groupKeys);

    const origin = req.get("origin") || `${req.protocol}://${req.get("host")}`;
    const createdParticipants = [];

    for (const slot of plan.participants) {
      const invite = await createInvite({
        groupAssignment: slot.groupAssignment,
        readingOrder: slot.readingOrder
      });

      const participantSessions = await listSessionsByParticipant(invite.participantId);
      for (const participantSession of participantSessions) {
        const assignedGroup = slot.sessionGroupMap[String(participantSession.sessionNumber)]
          || slot.sessionGroupMap[participantSession.sessionNumber]
          || null;
        if (!assignedGroup) continue;

        const personas = buildPersonaRowsForGroup(groupedPersonas, assignedGroup);
        if (!personas.length) {
          throw new Error(`No personas available for group ${assignedGroup}.`);
        }

        await createSessionPersonas({
          sessionId: participantSession.sessionId,
          participantId: invite.participantId,
          sessionNumber: participantSession.sessionNumber,
          personas
        });
      }

      const sessions = invite.sessionTokens.map(({ sessionNumber, token }) => ({
        sessionNumber,
        token,
        url: `${origin}/?token=${token}`,
        path: `/?token=${token}`
      }));

      createdParticipants.push({
        participantCode: invite.participantCode,
        groupAssignment: slot.groupAssignment,
        readingOrder: slot.readingOrder,
        sessionGroupMap: slot.sessionGroupMap,
        sessions
      });
    }

    return res.json({
      ok: true,
      smallestBalancedBatchPerArm: plan.armSize,
      totalParticipants: plan.totalParticipants,
      participants: createdParticipants
    });
  } catch (error) {
    console.error("Failed to create balanced batch", error);
    return res.status(500).json({ error: error?.message || "Could not create balanced batch." });
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
    const firstPass = await listParticipants();

    for (const participant of firstPass) {
      const sessions = participant.sessions || [];
      for (const session of sessions) {
        if (!session?.sessionId) continue;
        const existingPersonas = await getSessionPersonas(session.sessionId);
        if (existingPersonas && existingPersonas.length) continue;
        await ensureSessionPersonas({
          sessionId: session.sessionId,
          participantId: participant.id,
          sessionNumber: session.sessionNumber,
          participantCode: participant.participantCode,
          groupAssignment: participant.groupAssignment
        });
      }
    }

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

app.post("/api/admin/session/schedule-lock", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Session token is required." });
    }

    const scheduleLockDisabled = Boolean(req.body?.scheduleLockDisabled);
    const updated = await updateSessionScheduleLockByToken(token, scheduleLockDisabled);
    if (!updated) {
      return res.status(404).json({ error: "Session not found for token." });
    }

    return res.json({
      ok: true,
      participantCode: updated.participantCode,
      sessionNumber: updated.sessionNumber,
      scheduleLockDisabled: updated.scheduleLockDisabled
    });
  } catch (error) {
    console.error("Failed to update session schedule-lock override", error);
    return res.status(500).json({ error: error?.message || "Could not update session schedule-lock override." });
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

app.get("/api/admin/participant/:participantCode/details", async (req, res) => {
  try {
    const { participantCode } = req.params;
    const participant = await getParticipantByCode(participantCode);
    if (!participant) {
      return res.status(404).json({ error: "Participant not found." });
    }

    const [messages, forms, sessions] = await Promise.all([
      listMessagesByParticipant(participant.id),
      listParticipantFormResponses(participant.id),
      listSessionsByParticipant(participant.id)
    ]);

    const formDefCache = new Map();
    const formsDetailed = forms.map((row) => {
      if (!formDefCache.has(row.formKey)) {
        formDefCache.set(row.formKey, loadFormDefinition(row.formKey));
      }
      const formDef = formDefCache.get(row.formKey);
      const questionMap = buildFormQuestionMap(formDef);
      const responseEntries = Object.entries(row.responses || {});
      const qaPairs = responseEntries.map(([key, value]) => ({
        key,
        question: questionMap.get(key) || key,
        answer: normalizeAnswerText(value)
      }));

      return {
        formKey: row.formKey,
        sessionNumber: row.sessionNumber,
        sessionPersonaId: row.sessionPersonaId,
        personaName: row.personaName,
        personaCsvId: row.personaCsvId,
        createdAt: row.createdAt,
        qaPairs
      };
    });

    return res.json({
      participant,
      sessions,
      forms: formsDetailed,
      messages
    });
  } catch (error) {
    console.error("Failed to load participant details", error);
    return res.status(500).json({ error: error?.message || "Could not load participant details." });
  }
});

app.get("/api/admin/problems/incomplete-sessions", async (_req, res) => {
  try {
    const sessions = await listIncompleteSessionsForAdmin();
    return res.json({ sessions });
  } catch (error) {
    console.error("Failed to load incomplete sessions", error);
    return res.status(500).json({ error: error?.message || "Could not load incomplete sessions." });
  }
});

app.get("/api/admin/problems/lock-disabled-sessions", async (_req, res) => {
  try {
    const sessions = await listScheduleLockDisabledSessionsForAdmin();
    return res.json({ sessions });
  } catch (error) {
    console.error("Failed to load lock-disabled sessions", error);
    return res.status(500).json({ error: error?.message || "Could not load lock-disabled sessions." });
  }
});

app.get("/api/admin/qa/persona-distribution", async (req, res) => {
  try {
    const group = req.query?.group ? String(req.query.group) : "all";
    const groupAssignment = group === "control" || group === "experimental" ? group : undefined;
    const rows = await listPersonaSessionDistribution({ groupAssignment });

    const sessionPerPersona = {};
    const personaPerSession = {};
    for (const row of rows) {
      const persona = row.personaName || "Unknown";
      const sessionNumber = Number(row.sessionNumber) || row.sessionNumber;
      const completedCount = Number(row.completedCount) || 0;
      const openCount = Number(row.openCount) || 0;
      const count = Number(row.appearances) || 0;

      if (!sessionPerPersona[persona]) sessionPerPersona[persona] = [];
      sessionPerPersona[persona].push({ sessionNumber, count, completedCount, openCount });

      const key = String(sessionNumber);
      if (!personaPerSession[key]) personaPerSession[key] = [];
      personaPerSession[key].push({ personaName: persona, count, completedCount, openCount });
    }

    return res.json({
      filter: groupAssignment || "all",
      rows,
      sessionPerPersona,
      personaPerSession
    });
  } catch (error) {
    console.error("Failed to load persona QA distribution", error);
    return res.status(500).json({ error: error?.message || "Could not load QA distribution." });
  }
});

app.delete("/api/admin/participant/:participantCode", async (req, res) => {
  try {
    const participantCode = String(req.params?.participantCode || "").trim();
    if (!participantCode) {
      return res.status(400).json({ error: "participantCode is required." });
    }

    const deleted = await deleteParticipantByCode(participantCode);
    if (!deleted) {
      return res.status(404).json({ error: "Participant not found." });
    }

    return res.json({ ok: true, participantCode: deleted.participantCode });
  } catch (error) {
    console.error("Failed to delete participant", error);
    return res.status(500).json({ error: error?.message || "Could not delete participant." });
  }
});

app.post("/api/admin/participant/:participantId/metadata", async (req, res) => {
  try {
    const participantId = Number(req.params?.participantId || 0);
    if (!participantId) return res.status(400).json({ error: "participantId is required." });

    const subjectId = req.body?.subjectId == null ? null : String(req.body.subjectId);
    const notes = req.body?.notes == null ? null : String(req.body.notes);
    const rawSchedule = req.body?.scheduleStart;
    const scheduleStart = rawSchedule == null || rawSchedule === "" ? null : String(rawSchedule);

    await updateParticipantMetadata(participantId, { subjectId, notes, scheduleStart });
    return res.json({ ok: true, participantId, subjectId, notes, scheduleStart });
  } catch (error) {
    console.error("Failed to update participant metadata", error);
    return res.status(500).json({ error: error?.message || "Could not update participant metadata." });
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

    const lockState = req.sessionLockState || await getSessionLockState(session);
    const unlockRequested = String(req.headers["x-session-unlock"] || "") === "1";
    if (lockState.locked && !(isAdminAuthorized(req) && unlockRequested)) {
      return res.json({
        locked: true,
        lockState,
        lockFormKey: getLockFormKey(lockState.code),
        participantCode: session.participantCode,
        sessionNumber: session.sessionNumber,
        totalSessions: session.totalSessions
      });
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
        participantCode: session.participantCode,
        groupAssignment: session.groupAssignment
      });
      persistedPersonas = await getSessionPersonas(session.sessionId);
    }

    await markSessionStarted(session.sessionId);
    await maybeMarkSessionCompleted(session);

    const includeFeedbackSteps = shouldIncludeFeedbackForSession(session);
    const restrictFeedbackToLastPersona = isSessionOneExperimental(session);
    const lastPersonaId = restrictFeedbackToLastPersona ? getLastPersonaId(persistedPersonas) : null;
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
      const steps = [
        { type: "chat", kind: "persona", order: personaRow.personaOrder, ...personaMeta },
        { type: "form", key: "post_chat", kind: "post_chat", order: personaRow.personaOrder + 0.25, ...personaMeta }
      ];
      const includeFeedbackForPersona = includeFeedbackSteps
        && (!restrictFeedbackToLastPersona || Number(personaRow.id) === Number(lastPersonaId));

      if (includeFeedbackForPersona) {
        const includePreFeedbackInstruction = shouldIncludePreFeedbackInstructionForSession(session);
        if (includePreFeedbackInstruction) {
          steps.push(
            { type: "participant_instruction", key: "pre_feedback", kind: "pre_feedback_instruction", order: personaRow.personaOrder + 0.5, ...personaMeta }
          );
        }

        const feedbackOrder = includePreFeedbackInstruction ? 0.6 : 0.5;
        steps.push(
          { type: "feedback", kind: "persona_feedback", order: personaRow.personaOrder + feedbackOrder, ...personaMeta },
          { type: "form", key: "post_feedback", kind: "post_feedback", order: personaRow.personaOrder + 0.75, ...personaMeta }
        );
      }
      return steps;
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
    const personaFormKeys = shouldIncludeFeedbackForSession(session)
      ? new Set(["post_chat", "post_feedback"])
      : new Set(["post_chat"]);

    let allowed = steps.some((step) => step.type === "form" && step.key === formKey);
    if (!allowed && personaFormKeys.has(formKey)) {
      allowed = Boolean(requestedSessionPersonaId);
    }
    if (allowed && formKey === "post_feedback") {
      allowed = requestedSessionPersonaId
        ? await isFeedbackAllowedForPersona(session, requestedSessionPersonaId)
        : false;
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
    const personaFormKeys = shouldIncludeFeedbackForSession(session)
      ? new Set(["post_chat", "post_feedback"])
      : new Set(["post_chat"]);

    let allowed = steps.some((step) => step.type === "form" && step.key === formKey);
    if (!allowed && personaFormKeys.has(formKey)) {
      allowed = Boolean(requestedSessionPersonaId);
    }
    if (allowed && formKey === "post_feedback") {
      allowed = requestedSessionPersonaId
        ? await isFeedbackAllowedForPersona(session, requestedSessionPersonaId)
        : false;
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
    const isoNow = nowGmtPlus3Iso();
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
      max_output_tokens: CHAT_MAX_OUTPUT_TOKENS,
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

    // save user message with the timestamp recorded when request was received
    await savePersonaMessage({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      role: "user",
      content: message,
      sessionPersonaId,
      conversationId,
      timestampIso: isoNow
    });

    // save assistant message with a timestamp captured after response generation
    const assistantTimestamp = nowGmtPlus3Iso();
    await savePersonaMessage({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      role: "assistant",
      content: assistantText,
      sessionPersonaId,
      conversationId,
      timestampIso: assistantTimestamp
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
    if (!sectionId || answer == null) {
      return res.status(400).json({ error: "sectionId and answer are required." });
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
    const answeredAtIso = nowGmtPlus3Iso();
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
      questionId: String(resolved.questionId || questionId || ""),
      questionNumber: resolved.questionNumber,
      questionContent: resolved.question.prompt || resolved.questionId || null,
      answer: normalizedAnswer,
      correctAnswer: normalizedCorrectAnswer,
      isCorrect,
      timedate: answeredAtIso,
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

    await saveFormResponse({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      formKey: "session_completion_confirmed",
      responses: {
        confirmedAt: nowGmtPlus3Iso()
      },
      sessionPersonaId: null
    });

    const completed = await maybeMarkSessionCompleted(session);
    if (!completed) {
      return res.status(400).json({ error: "Session completion was not confirmed." });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error("Failed to mark session complete", error);
    res.status(500).json({ error: error?.message || "Could not complete session." });
  }
});

app.post("/api/session/:token/completion-viewed", async (req, res) => {
  try {
    const sessionToken = req.params.token;
    const session = await getSessionByToken(sessionToken);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    await saveFormResponse({
      participantId: session.participantId,
      sessionNumber: session.sessionNumber,
      formKey: "session_completion",
      responses: {
        viewedAt: nowGmtPlus3Iso()
      },
      sessionPersonaId: null
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Failed to record completion screen view", error);
    res.status(500).json({ error: error?.message || "Could not record completion screen view." });
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
    if (!shouldIncludeFeedbackForSession(session)) {
      return res.status(400).json({ error: "Feedback is not part of this session flow." });
    }

    const personaRecord = await getSessionPersona(Number(sessionPersonaId));
    if (!personaRecord || personaRecord.sessionId !== session.sessionId) {
      return res.status(404).json({ error: "Persona not found for this session." });
    }
    const feedbackAllowedForPersona = await isFeedbackAllowedForPersona(session, sessionPersonaId);
    if (!feedbackAllowedForPersona) {
      return res.status(400).json({ error: "Feedback is not part of this session flow." });
    }

    const postChatCompleted = await hasPostChatFormForPersona(session, sessionPersonaId);
    if (!postChatCompleted) {
      return res.status(400).json({ error: "Post-chat form must be completed before feedback." });
    }

    const existingMessages = await listMessagesBySessionPersona(sessionPersonaId);
    const existingFeedback = [...existingMessages].reverse().find((m) => m.role === "assistant_feedback");
    if (existingFeedback) {
      return res.json({
        ready: true,
        response: existingFeedback.content,
        conversationId: personaRecord.conversationId || null
      });
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
      await persistFeedbackMessage({
        session,
        sessionPersonaId,
        conversationId: personaRecord.conversationId || null,
        content: FEEDBACK_FALLBACK_TEXT
      });
      return res.json({
        ready: true,
        response: FEEDBACK_FALLBACK_TEXT,
        conversationId: personaRecord.conversationId || null,
        eligible: false
      });
    }

    const job = enqueueFeedbackJob({ token, sessionPersonaId });
    return res.status(202).json({
      ready: false,
      pending: true,
      eligible: true,
      pollAfterMs: FEEDBACK_POLL_AFTER_MS,
      status: job.status,
      attempt: job.attempt,
      queuedAt: job.createdAt
    });
  } catch (error) {
    console.error("Failed to generate feedback", error);
    const message = getErrorMessage(error);
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
