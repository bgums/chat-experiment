// Deterministic DP flow. Prompts assess performance; this file decides progression.
export const GOOD_PRACTICE_SCORE = 5;

export function isGoodPerformance(score) {
  return score === GOOD_PRACTICE_SCORE;
}

export function getPracticeStatus(round) {
  if (round.attempts.length >= round.config.maxAttemptsPerStrategy) return "attempt_limit";
  return "active";
}

export function practiceFeedbackContext(score, attemptNumber, config, roundNumber) {
  const successful = isGoodPerformance(score);
  const strategyComplete = attemptNumber >= config.maxAttemptsPerStrategy;
  return {
    score, successful, strategyComplete,
    nextAction: !strategyComplete ? "retry_strategy" : roundNumber < config.strategiesPerChat ? "next_strategy" : "next_conversation"
  };
}
