import fs from "node:fs";
import { createHash } from "node:crypto";

const raw = fs.readFileSync(new URL("../knowledge/3rs-2022.json", import.meta.url), "utf8");
export const practiceKnowledge = JSON.parse(raw);
export const knowledgeHash = createHash("sha256").update(raw).digest("hex");

export function knowledgeFor(role, data = {}) {
  const k = practiceKnowledge;
  const core = { source: k.source.title, version: k.version, core: k.core };
  const selected = id => k.strategies[id] ? { [id]: k.strategies[id] } : k.strategies;
  if (role === "patient") return { ...core, markers: k.markers };
  if (role === "practice_selection") return { ...core, markers: k.markers, strategies: k.strategies };
  if (role === "practice_score") return {
    ...core,
    strategies: selected(data.assessmentType === "original" ? data.plan?.originalStrategyId : data.plan?.strategyId),
    scoringDistinction: k.scoringDistinction, practiceRubric: k.practiceRubric
  };
  if (role === "practice_initial_coaching") return {
    ...core, markers: k.markers,
    strategies: { ...selected(data.plan?.originalStrategyId), ...selected(data.plan?.strategyId) }
  };
  if (role === "practice_evaluation") return { ...core, strategies: selected(data.plan?.strategyId) };
  throw new Error(`Unknown 3RS knowledge role: ${role}`);
}

export function knowledgeInstructions(role, data) {
  return `REFERENCE KNOWLEDGE: curated from the supplied 3RS 2022 manual. Use only the relevant definitions below; do not claim to have searched a PDF. The DP quality rubric is a study adaptation, not a validated 3RS rating.\n${JSON.stringify(knowledgeFor(role, data))}`;
}

export async function createPracticeResponse(payload, send) {
  const role = payload.text?.format?.name;
  const data = JSON.parse(payload.input);
  return send({ ...payload, instructions: `${knowledgeInstructions(role, data)}\n\nTASK INSTRUCTIONS:\n${payload.instructions}` });
}
