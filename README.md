# Alliance rupture repair experiment

Four separate Hebrew sessions with two AI patient conversations each. All new
participants belong to `experiment`.

## Run

Requires Node.js 18+ and `npm install`. Set these environment variables in `.env`:
`OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4.1`), `OPENAI_VECTOR_STORE_ID`,
`OPENAI_FILE_ID`, `ADMIN_USER`, `ADMIN_PASSWORD`, and optionally `PORT` (default 3000).

Run `npm start`, open `http://localhost:3000/admin`, and create participant links.
`SQLITE_PATH` optionally selects the database; default: `server/data/experiment.db`.
Use a separate database for pilots. Schema migrations run on startup; back up an
existing research database before upgrading it.

## Flow

`server/config/sessionFlow.json` defines the four meetings. Each includes consent,
confidentiality request and demographics. Session 1 adds the existing alliance
introduction module. Each patient interaction includes pre-chat instructions,
an eight-minute chat, the existing post-chat questionnaire, the existing feedback,
and deliberate practice. In session 1, feedback and practice occur only after the
second conversation. Sessions 2–4 include them after both conversations.
Each meeting ends with completion; session 4 shows the final study thank-you.

Control allocation, reading-order logic, associated modules and obsolete checks
have been removed. Existing control participant records remain an inactive research
archive. Existing `experimental` assignments migrate to `experiment`; the database
column `group_assignment` is renamed to `group`, and `reading_order` is removed.

## Researcher editing points

| File | Purpose |
| --- | --- |
| `server/instructions/feedback_instructions.txt` | Existing conversation feedback, retained |
| `server/instructions/deliberate_practice_selection.txt` | **Dedicated location for your selection prompt**; contains a working draft |
| `server/instructions/deliberate_practice_evaluation.txt` | Assessment and short feedback for each attempt; contains a working draft |
| `server/config/deliberatePractice.json` | `maxAttemptsPerStrategy`: **3**; `strategiesPerChat`: **2**; version and message length limit |

Restart after editing prompts/configuration. The first round snapshots the limits
and model for that conversation, so an ongoing practice sequence keeps its limits.
Selection and evaluation prompt hashes identify the versions actually used. Archive
the corresponding prompt files with each research deployment.

The selector receives the original transcript and the participant's strategy
history across sessions. It classifies the original repair strategy and proposes
an alternative with a stable `snake_case` ID, explanation, principles, application
and brief hint. The server validates the selected patient message and copies the
excerpt directly from the transcript. A subsequent round in the same conversation
must use a different strategy. Earlier sessions inform selection without forbidding
repetition across sessions.

The participant sees the explanation, then the excerpt and a coaching card below
the patient message. Every therapist message receives a patient reply and short
assessment. A sufficient assessment ends the round; otherwise dialogue continues
up to the attempt limit. Reaching the limit is distinguished from success. A round
summary leads to the next strategy explanation or onward to session completion.

Patient replies and evaluation use separate model calls. Practice does not modify
the original conversation. An attempt is saved only after both calls succeed;
network retries return an already saved matching attempt. Concurrent requests for
one patient are guarded in memory: deployment assumes one Node.js server process.

## Research data

- `participants`: a single `group` column, `experiment` for new participants.
- `messages`, `form_responses`, `session_personas`, `module_question_responses`:
  original conversation, questionnaires and introduction-module data.
- `practice_rounds`: participant/session/patient references, round number, original
  and selected strategy, source message ID and exact excerpt, explanation, hint,
  configuration snapshot, model and selection prompt hash.
- `practice_attempts`: ordered therapist message, patient reply, feedback,
  sufficient flag, summary, evaluation prompt hash and timestamp.

Round status (`active`, `mastered`, `attempt_limit`) is derived from attempts,
avoiding a second mutable source of truth. Session reset and participant deletion
also clear associated practice data.

Admin participant details contain a **Deliberate Practice** section for each session
and a JSON download of all rounds/attempts. The authenticated export route is
`/api/admin/participant/:participantCode/practice/export`. Form CSV exports include
`group`. Original dialogue and practice remain separate.

## Validation

`npm test` uses a temporary database and simulated AI. It checks legacy migration,
assignment, session flows, source selection, attempt limits, early mastery,
duplicate retries, persistence, ownership, read-only access, completion gating,
export, reset and balanced allocation. It does not call OpenAI or modify research data.

`node scripts/preview-practice.mjs` serves an isolated UI fixture at
`http://127.0.0.1:3117/preview`, without a database or model calls.

Before recruitment, review/replace the draft practice prompts and run a pilot
against the configured real model to assess instructional quality.
