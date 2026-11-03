// Deterministic DP flow. Prompts assess performance; this file decides progression.
export const GOOD_PRACTICE_SCORE = 5;

export function isGoodPerformance(score) {
  return score === GOOD_PRACTICE_SCORE;
}

export function practiceStrategyMode(originalScore, roundNumber) {
  return roundNumber === 1 && !isGoodPerformance(originalScore) ? "improve_original" : "alternative";
}

export function shouldStopPracticeEarly({ attempts }) {
  return isGoodPerformance(attempts.at(-1)?.score);
}

export function getPracticeStatus(round) {
  if (shouldStopPracticeEarly(round)) return "early_stopped";
  if (round.attempts.length >= round.config.maxAttemptsPerStrategy) return "attempt_limit";
  return "active";
}

export function practiceFeedbackContext(score, attemptNumber, config, roundNumber) {
  const successful = isGoodPerformance(score);
  const strategyComplete = successful || attemptNumber >= config.maxAttemptsPerStrategy;
  return {
    score, successful, strategyComplete,
    nextAction: !strategyComplete ? "retry_strategy" : roundNumber < config.strategiesPerChat ? "next_strategy" : "next_conversation"
  };
}
