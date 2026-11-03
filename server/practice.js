import fs from "fs";
import { createHash } from "crypto";
import { createResponse } from "./openaiClient.js";
import { extractTextFromResponse } from "./utils/extractText.js";
import { buildPersonaPrompt } from "./utils/personaLoader.js";
import { listPracticeRounds, practiceRun } from "./db.js";
import { practiceStrategyMode, practiceFeedbackContext } from "./utils/practiceProgress.js";
import { createPracticeResponse, practiceKnowledge, knowledgeHash, knowledgeInstructions } from "./utils/practiceKnowledge.js";
import { nowGmtPlus3Iso } from "./utils/timezone.js";

const read = name => fs.readFileSync(new URL(name, import.meta.url), "utf8");
export const practiceConfig = JSON.parse(read("./config/deliberatePractice.json"));
if (typeof practiceConfig.showScoresToParticipant !== "boolean") throw new Error("Invalid practice score visibility flag");
for (const key of ["strategiesPerChat", "maxAttemptsPerStrategy", "maxMessageLength"]) {
  if (!Number.isInteger(practiceConfig[key]) || practiceConfig[key] < 1) throw new Error(`Invalid practice config: ${key}`);
}
const selection = read("./instructions/deliberate_practice_selection.txt");
const evaluation = read("./instructions/deliberate_practice_evaluation.txt");
const scoring = read("./instructions/deliberate_practice_score.txt");
const feedback = read("./instructions/practice_feedback.txt");
const hint = read("./instructions/practice_hint.txt");
const promptHash = createHash("sha256").update(JSON.stringify([selection, scoring, evaluation, feedback, hint, knowledgeHash])).digest("hex");
const locks = new Set();

export async function withPracticeLock(key, action) {
  if (locks.has(key)) throw Object.assign(new Error("Practice request already running. Please retry."), { status: 409 });
  locks.add(key);
  try { return await action(); } finally { locks.delete(key); }
}

const string = { type: "string" };
const planSchema = {
  type: "object", additionalProperties: false,
  properties: {
    sourceMessageId: { type: "integer" },
    originalStrategyId: string, originalStrategyExplanation: string,
    strategyId: string, title: string, explanation: string, principles: string, application: string
  },
  required: ["sourceMessageId", "originalStrategyId", "originalStrategyExplanation", "strategyId", "title", "explanation", "principles", "application"]
};
const evaluationSchema = {
  type: "object", additionalProperties: false,
  properties: { feedback: string, summary: string, hint: string },
  required: ["feedback", "summary", "hint"]
};

const scoreSchema = {
  type: "object", additionalProperties: false,
  properties: { score: { type: "integer", enum: [1, 3, 5] } }, required: ["score"]
};

async function structured(instructions, data, schema, name, model) {
  const response = await createPracticeResponse({
    model: model || process.env.OPENAI_MODEL || "gpt-4.1", instructions,
    input: JSON.stringify(data), max_output_tokens: 2200,
    text: { format: { type: "json_schema", name, strict: true, schema } }
  }, createResponse);
  const result = JSON.parse(extractTextFromResponse(response));
  if (name === "practice_score" && ![1, 3, 5].includes(result.score)) throw new Error("Invalid practice score");
  for (const [key, definition] of Object.entries(schema.properties)) {
    if (definition.type === "string" && (typeof result[key] !== "string" || !result[key].trim())) throw new Error(`Missing practice field: ${key}`);
  }
  return result;
}

const initialCoachingSchema = {
  type: "object", additionalProperties: false,
  properties: { feedback: string, hint: string }, required: ["feedback", "hint"]
};
const coachingPrompt = (feedbackPrompt) => `${feedbackPrompt}\n\nהוראות לשדה hint:\n${hint}\n\nהחזר אובייקט לפי הסכמה. כתוב תחילה את שדה feedback לפי הוראות הפידבק, ואז את שדה hint לפי הוראות הטיפ ובהתאם לפידבק שכתבת באותה תשובה. אם קיים summary בסכמה, כתוב גם אותו. הוראות להחזיר טקסט בלבד מתייחסות לתוכן השדה המתאים, ולא למבנה הפלט הכולל.`;
const cleanPlan = ({ feedback, hint, ...plan }) => plan;

export async function startPractice(session, persona, messages) {
  const history = await listPracticeRounds(session.participantId);
  const rounds = history.filter(r => r.session_persona_id === persona.id);
  const last = rounds.at(-1);
  if (last?.status === "active" || rounds.length >= practiceConfig.strategiesPerChat) return rounds;
  const transcript = messages.filter(m => ["user", "assistant"].includes(m.role));
  const first = rounds[0];
  const eligibleSourceMessageIds = first ? [first.plan.sourceMessageId] : transcript.filter((message, index) => message.role === "assistant" && transcript[index - 1]?.role === "user" && transcript[index + 1]?.role === "user").map(message => message.id);
  if (!eligibleSourceMessageIds.length) throw Object.assign(new Error("A therapist–patient–therapist exchange is required for rehearsal."), { status: 400 });
  const config = { ...(last?.config || practiceConfig), strategiesPerChat: practiceConfig.strategiesPerChat, maxAttemptsPerStrategy: practiceConfig.maxAttemptsPerStrategy, promptHash, knowledgeHash, rubricVersion: practiceKnowledge.practiceRubric.version, model: last?.config.model || process.env.OPENAI_MODEL || "gpt-4.1" };
  const selectionData = {
    transcript, eligibleSourceMessageIds,
    previousStrategies: history.map(r => ({ strategyId: r.plan.strategyId, session: r.session_number, personaId: r.session_persona_id })),
    excludedStrategyIds: rounds.map(r => r.plan.strategyId)
  };
  let plan;
  let originalScore = first?.plan.originalScore;
  let originalStrategyId = first?.plan.originalStrategyId;
  if (!first) {
    plan = await structured(selection, selectionData, planSchema, "practice_selection", config.model);
    const index = transcript.findIndex(m => m.id === plan.sourceMessageId && m.role === "assistant");
    if (!eligibleSourceMessageIds.includes(plan.sourceMessageId)) throw new Error("Invalid practice source selection.");
    originalStrategyId = plan.originalStrategyId;
    const originalDialogue = transcript.slice(0, index + 2);
    const result = await structured(scoring, {
      plan: { ...plan, strategyId: originalStrategyId }, dialogue: originalDialogue,
      therapistMessage: transcript[index + 1].content, assessmentType: "original"
    }, scoreSchema, "practice_score", config.model);
    originalScore = result.score;
  } else if (originalScore == null) {
    // Older saved rounds predate original-message scoring.
    const index = transcript.findIndex(m => m.id === first.plan.sourceMessageId);
    originalScore = (await structured(scoring, {
      plan: { ...first.plan, strategyId: originalStrategyId }, dialogue: transcript.slice(0, index + 2),
      therapistMessage: transcript[index + 1].content, assessmentType: "original"
    }, scoreSchema, "practice_score", config.model)).score;
  }
  const strategyMode = practiceStrategyMode(originalScore, rounds.length + 1);
  const originalDefinition = practiceKnowledge.strategies[originalStrategyId];
  if (plan && strategyMode === "improve_original" && originalDefinition) {
    plan = { ...plan, strategyId: originalStrategyId, title: originalDefinition.name,
      explanation: originalDefinition.definition, principles: originalDefinition.definition, application: originalDefinition.definition };
  }
  if (!plan || (strategyMode === "improve_original" && !originalDefinition)) {
    const sourceId = first?.plan.sourceMessageId || plan.sourceMessageId;
    const schema = { ...planSchema, properties: {
      ...planSchema.properties,
      sourceMessageId: { type: "integer", enum: [sourceId] },
      originalStrategyId: { type: "string", enum: [originalStrategyId] },
      ...(strategyMode === "improve_original" ? { strategyId: { type: "string", enum: [originalStrategyId] } } : {})
    } };
    plan = await structured(selection, {
      ...selectionData, eligibleSourceMessageIds: [sourceId], originalScore, strategyMode,
      requiredStrategyId: strategyMode === "improve_original" ? originalStrategyId : null,
      excludedStrategyIds: strategyMode === "alternative" ? [...new Set([...selectionData.excludedStrategyIds, originalStrategyId])] : []
    }, schema, "practice_selection", config.model);
  }
  if (!eligibleSourceMessageIds.includes(plan.sourceMessageId) || plan.originalStrategyId !== originalStrategyId ||
      (strategyMode === "improve_original" ? plan.strategyId !== originalStrategyId : plan.strategyId === originalStrategyId || rounds.some(r => r.plan.strategyId === plan.strategyId))) {
    throw new Error("Invalid practice selection. Retry to select the required strategy.");
  }
  const index = transcript.findIndex(m => m.id === plan.sourceMessageId && m.role === "assistant");
  plan.excerpt = transcript.slice(index - 1, index + 2).map(m => ({ id: m.id, role: m.role, content: m.content }));
  plan.replacedTherapistMessageId = transcript[index + 1].id;
  plan.originalScore = originalScore;
  plan.strategyMode = strategyMode;
  const context = { plan: cleanPlan(plan), ...practiceFeedbackContext(originalScore, 0, config, rounds.length + 1) };
  // The original score controls the curriculum, never skips its first exercise.
  context.nextAction = "practice_strategy";
  context.strategyComplete = false;
  const coaching = await structured(coachingPrompt(feedback), context, initialCoachingSchema, "practice_initial_coaching", config.model);
  plan.feedback = coaching.feedback;
  plan.hint = coaching.hint;
  await practiceRun(`INSERT INTO practice_rounds
    (participant_id, session_id, session_persona_id, round_number, plan_json, config_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [session.participantId, session.sessionId, persona.id, rounds.length + 1, JSON.stringify(plan), JSON.stringify(config), nowGmtPlus3Iso()]);
  return listPracticeRounds(session.participantId, persona.id);
}

// Temporary tuning control: replace practice data for this conversation, without an archive.
export async function restartPractice(session, persona, messages) {
  await practiceRun("DELETE FROM practice_attempts WHERE round_id IN (SELECT id FROM practice_rounds WHERE participant_id = ? AND session_persona_id = ?)", [session.participantId, persona.id]);
  await practiceRun("DELETE FROM practice_rounds WHERE participant_id = ? AND session_persona_id = ?", [session.participantId, persona.id]);
  return startPractice(session, persona, messages);
}

export async function attemptPractice(session, persona, body) {
  const rounds = await listPracticeRounds(session.participantId, persona.id);
  const round = rounds.at(-1);
  if (!round || round.id !== body.roundId) throw Object.assign(new Error("Practice round is no longer current."), { status: 409 });
  // Optimistic sequence doubles as idempotency: a retry returns the stored response.
  if (Number.isInteger(body.attemptNumber) && body.attemptNumber <= round.attempts.length) {
    const saved = round.attempts[body.attemptNumber - 1];
    if (saved?.therapist_message === body.message) return rounds;
    throw Object.assign(new Error("Attempt already recorded."), { status: 409 });
  }
  if (round.status !== "active" || body.attemptNumber !== round.attempts.length + 1) throw Object.assign(new Error("Invalid attempt sequence."), { status: 409 });
  const message = body.message;
  if (typeof message !== "string" || !message.trim() || message.length > round.config.maxMessageLength) throw Object.assign(new Error("Invalid practice message."), { status: 400 });
  // Rehearse a replacement for the original therapist response.
  const dialogue = round.plan.replacedTherapistMessageId ? round.plan.excerpt.slice(0, -1) : [...round.plan.excerpt];
  for (const attempt of round.attempts) dialogue.push({ role: "user", content: attempt.therapist_message }, { role: "assistant", content: attempt.patient_message });
  dialogue.push({ role: "user", content: message });
  const patientRequest = createResponse({
    model: round.config.model,
    instructions: `${knowledgeInstructions("patient")}\n\n${buildPersonaPrompt(JSON.parse(persona.personaJson))}\nהמשך לגלם את המטופל בעברית בהמשך השיחה הנתונה. אל תיתן פידבק ואל תמלא את תפקיד המטפל.`,
    input: dialogue.map(({ role, content }) => ({ role, content })), max_output_tokens: 500
  });
  const scoreRequest = structured(scoring, { plan: cleanPlan(round.plan), dialogue, therapistMessage: message, assessmentType: "attempt" }, scoreSchema, "practice_score", round.config.model);
  const [response, scoreResult] = await Promise.all([patientRequest, scoreRequest]);
  const patient = extractTextFromResponse(response);
  if (!patient.trim()) throw new Error("Empty patient response.");
  const context = {
    plan: cleanPlan(round.plan), dialogue, patientReply: patient,
    ...practiceFeedbackContext(scoreResult.score, body.attemptNumber, { ...round.config, strategiesPerChat: practiceConfig.strategiesPerChat }, round.round_number)
  };
  const result = await structured(coachingPrompt(evaluation), context, evaluationSchema, "practice_evaluation", round.config.model);
  // One SQL statement commits the complete attempt; status is derived from it below.
  await practiceRun(`INSERT INTO practice_attempts
    (round_id, attempt_number, therapist_message, patient_message, feedback, summary, score, hint, evaluation_prompt_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [round.id, body.attemptNumber, message, patient, result.feedback, result.summary, scoreResult.score, result.hint, promptHash, nowGmtPlus3Iso()]);
  return listPracticeRounds(session.participantId, persona.id);
}

export async function practiceComplete(session, personas) {
  const rounds = await listPracticeRounds(session.participantId);
  const eligible = Number(session.sessionNumber) === 1 ? personas.slice(-1) : personas;
  return eligible.length > 0 && eligible.every(persona => {
    const own = rounds.filter(r => r.session_persona_id === persona.id);
    return own.length >= practiceConfig.strategiesPerChat && own.slice(0, practiceConfig.strategiesPerChat).every(r => r.status !== "active");
  });
}
