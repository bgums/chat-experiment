const strategiesByCategory = {
  task_goal: ["discuss_changing_task_goal", "change_task_goal", "illustrate_task_rationale", "redirect_to_task"],
  explore_rupture: ["validate_rupture_experience", "invite_rupture_exploration", "engage_rupture_exploration", "redirect_to_rupture", "disclose_rupture_experience"],
  acknowledge_contribution: ["acknowledge_contribution"],
  link_to_patterns: ["link_interpersonal_pattern"]
};

export const strategyCategories = new Map(
  Object.entries(strategiesByCategory).flatMap(([category, strategies]) => strategies.map(id => [id, category]))
);

export function preferredUnpracticedStrategies(allowedStrategyIds, rounds) {
  const practiced = new Set(rounds.filter(round => round.attempts.length).map(round => round.plan.strategyId));
  return ["disclose_rupture_experience", "acknowledge_contribution"].filter(id =>
    allowedStrategyIds.includes(id) && !practiced.has(id)
  );
}

export function alternativeStrategyGroups(history, first) {
  const categoryOf = round => strategyCategories.get(round.plan.strategyId);
  const current = history.filter(round => round.session_id === first.session_id);
  const previous = history.filter(round => round.session_number < first.session_number && round.attempts.length);
  const previousSession = Math.max(...previous.map(round => round.session_number), 0);
  const covered = new Set(current.map(categoryOf).filter(Boolean));
  const usedAlternatives = new Set(current.filter(round => round.round_number > 1 && round.session_persona_id !== first.session_persona_id).map(categoryOf));
  const originalCategory = strategyCategories.get(first.plan.originalStrategyId);
  const firstCategory = categoryOf(first);
  const candidates = Object.keys(strategiesByCategory).filter(category =>
    category !== originalCategory && category !== firstCategory && !usedAlternatives.has(category)
  );
  const newCategories = candidates.filter(category => !covered.has(category));
  // Prefer new coverage, and within it make up for gaps in the previous session.
  const pool = newCategories.length ? newCategories : candidates;
  const missed = pool.filter(category => !previous.some(round =>
    round.session_number === previousSession && categoryOf(round) === category
  ));
  return Object.fromEntries((missed.length ? missed : pool).map(category => [category, strategiesByCategory[category]]));
}
