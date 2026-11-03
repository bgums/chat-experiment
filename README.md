# Alliance rupture repair experiment

Four separate Hebrew sessions with two AI patient conversations each. All new
participants belong to `experiment`.

## Run

Requires Node.js 18+ and `npm install`. Set these environment variables in `.env`:
`OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4.1`), `ADMIN_USER`, `ADMIN_PASSWORD`, and optionally `PORT` (default 3000).

Run `npm start`, open `http://localhost:3000/admin`, and create participant links.
`SQLITE_PATH` optionally selects the database; default: `server/data/experiment.db`.
Use a separate database for pilots. Schema migrations run on startup; back up an
existing research database before upgrading it.

## Flow

`server/config/sessionFlow.json` defines the four meetings. Each includes consent,
confidentiality request. Demographics appears only in session 1, alongside the existing alliance
introduction module. Each patient interaction includes pre-chat instructions,
an eight-minute chat, the existing post-chat questionnaire,
and deliberate practice with inline feedback and hint messages. In session 1, practice occurs only after the
second conversation. Sessions 2–4 include them after both conversations.
Each meeting ends with completion; session 4 shows the final study thank-you.

Control allocation, reading-order logic, associated modules and obsolete checks
have been removed. Existing control participant records remain an inactive research
archive. Existing `experimental` assignments migrate to `experiment`; the database
column `group_assignment` is renamed to `group`, and `reading_order` is removed.

## Researcher editing points

| File | Purpose |
| --- | --- |
| `server/instructions/practice_feedback.txt` | Initial DP feedback instructions |
| `server/instructions/practice_hint.txt` | Tip instructions; composed with feedback in one model response |
| `server/instructions/deliberate_practice_selection.txt` | **Dedicated location for your selection prompt**; contains a working draft |
| `server/instructions/deliberate_practice_evaluation.txt` | Verbal attempt feedback; receives score, successful, strategyComplete and nextAction |
| `server/instructions/deliberate_practice_score.txt` | Separate study-adapted quality score for the original response and each attempt |
| `server/config/deliberatePractice.json` | `maxAttemptsPerStrategy`: **3**; `strategiesPerChat`: **2**; `showScoresToParticipant`: **true** for current testing |

Restart after editing prompts/configuration. The first round snapshots the attempt
limit and model for that conversation. The current strategy count and score visibility
apply also to existing practice sequences; old extra rounds remain in research data.
Selection, coaching and evaluation prompt hashes identify the versions actually used. Archive
the corresponding prompt files with each research deployment.

The selector receives the original transcript and the participant's strategy
history across sessions. It classifies the original repair strategy and proposes
an alternative with a stable `snake_case` ID, explanation, principles, application
and application. One call generates feedback and hint using the two dedicated prompts. The server validates the selected patient message and copies the
excerpt directly from the transcript. A subsequent round in the same conversation
must use a different strategy. Earlier sessions inform selection without forbidding
repetition across sessions.

The participant sees three original messages in the order
therapist → patient → therapist, followed by feedback and hint in matching coaching cards. They write a replacement for
the last therapist response. The original response is excluded from the rehearsal
model's dialogue context. Every therapist message receives a patient reply and short
assessment. Each strategy ends at score 5 or after three attempts. Two strategies are practised:
when the original score is below 5, first improve the original strategy and then try
an alternative; at 5, try two different alternatives. Both use the same original excerpt.
After the final feedback and tip, Continue advances to the next session step.
Only three dialogue messages are expanded. Scrolling up reveals a light, centered
history button inside the chat.

Consent and confidentiality screens are temporarily hidden. Set
`showConsentAndConfidentiality` to `true` in `server/config/sessionFlow.json` to
restore both screens in their original order.

Each assessment also returns a separate numeric `score`, stored in the database
and shown at the beginning of feedback while `showScoresToParticipant` is true.
Set this flag to **false before participant runs**: scores are then removed from
participant API responses while remaining available to admin/export. The study rubric in `server/knowledge/3rs-2022.json`
defines 1/3/5 quality scores. This is an explicitly adapted DP measure, not the manual's
salience scale or repair-effectiveness scale. Five is the practice progression threshold.

Patient replies and scoring run in parallel; feedback and tip are then generated together. Practice does not modify
the original conversation. An attempt is saved only after all required calls succeed;
network retries return an already saved matching attempt. Concurrent requests for
one patient are guarded in memory: deployment assumes one Node.js server process.

A temporary “התחלה מחדש של האימון” button in practice deletes this conversation’s practice rounds and attempts and starts fresh from its original transcript. It creates no archive and leaves other conversations intact.

## Research data

- `participants`: a single `group` column, `experiment` for new participants.
- `messages`, `form_responses`, `session_personas`, `module_question_responses`:
  original conversation, questionnaires and introduction-module data.
- `practice_rounds`: participant/session/patient references, round number, original
  and selected strategy, source message ID and exact excerpt, explanation, hint,
  configuration snapshot, model and selection prompt hash.
- `practice_attempts`: ordered therapist message, patient reply, feedback, numeric score,
  summary, evaluation prompt hash and timestamp.

Round status (`active`, `attempt_limit`, or future `early_stopped`) is derived from attempts,
avoiding a second mutable source of truth. Session reset and participant deletion
also clear associated practice data.

`server/utils/practiceProgress.js` defines strategy routing, the score-5 success rule,
the attempt cap and the next action passed to coaching. Attempt tips are saved alongside
feedback. Original scores are saved in the round plan.

Admin participant details contain a **Deliberate Practice** section for each session
and a JSON download of all rounds/attempts. The authenticated export route is
`/api/admin/participant/:participantCode/practice/export`. Form CSV exports include
`group`. Original dialogue and practice remain separate.

## Validation

`npm test` uses a temporary database and simulated AI. It checks legacy migration,
assignment, session flows, source selection, attempt limits even for high scores,
duplicate retries, persistence, ownership, read-only access, completion gating,
export, reset and balanced allocation. It does not call OpenAI or modify research data.

`node scripts/preview-practice.mjs` serves an isolated UI fixture at
`http://127.0.0.1:3117/preview`, without a database or model calls.

Before recruitment, review/replace the draft practice prompts and run a pilot
against the configured real model to assess instructional quality.

## Local 3RS knowledge

`server/knowledge/3rs-2022.json` is a curated, page-referenced digest of the supplied
2022 manual, with a source PDF hash and a separately labelled study quality rubric.
`server/utils/practiceKnowledge.js` selects the relevant sections for each role.
Chat uses rupture definitions/markers; selection uses the marker/strategy catalogue;
scoring gets its target strategy and the quality rubric; coaching gets the relevant
strategy definitions. Legacy unrecognized strategy IDs receive the full catalogue.
There are no runtime PDF searches; `OPENAI_VECTOR_STORE_ID` and `OPENAI_FILE_ID`
are no longer required. Existing environment values can remain unused.

Initial DP uses three sequential model calls for recognized strategies: selection,
original score, then feedback + tip. The next strategy needs two calls. Each attempt
uses three calls in two stages: patient reply + score concurrently, then feedback + tip.
Prompt and knowledge hashes identify the version. Restart the server and restart
practice to apply changes to saved plans. Actual latency and coaching quality still
need a real-model pilot; simulation verifies orchestration, not clinical validity.

See `docs/3rs-knowledge-review.md` for the per-prompt review and source pages.
