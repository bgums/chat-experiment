// Scores remain in research/admin data; participant responses obey the current flag.
export function participantPracticePayload(config, rounds, messages) {
  return {
    config,
    originalMessages: messages.filter(message => ["user", "assistant"].includes(message.role)).map(({ id, role, content }) => ({ id, role, content })),
    rounds: rounds.slice(0, config.strategiesPerChat).map(round => ({
      ...round,
      config: { ...round.config, strategiesPerChat: config.strategiesPerChat, showScoresToParticipant: config.showScoresToParticipant },
      attempts: round.attempts.map(attempt => {
        if (config.showScoresToParticipant) return attempt;
        const { score, ...visible } = attempt;
        return visible;
      })
    }))
  };
}
