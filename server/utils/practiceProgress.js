// Researcher extension point. No early-stop rule is active yet.
// Later, implement a deterministic rule using the saved attempts, config and plan.
// This is an application decision; it is not a flag requested from the AI agent.
export function shouldStopPracticeEarly({ attempts, config, plan }) {
  return false;
}

export function getPracticeStatus(round) {
  if (round.attempts.length >= round.config.maxAttemptsPerStrategy) return "attempt_limit";
  if (round.attempts.length && shouldStopPracticeEarly(round)) return "early_stopped";
  return "active";
}
