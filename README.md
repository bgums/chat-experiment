# Therapeutic Patient Chat

A minimal single-window chat UI that uses OpenAI's Conversations API to role-play a patient while a therapist interacts with it. Conversation memory is persisted by OpenAI, and the chat leverages the specified vector store and file for grounded knowledge.

## Prerequisites

- Node.js 18+
- An OpenAI API key with access to the Conversations API
- Access to the vector store `vs_68f62cd846f48191a200e536464c0e5e` and file `file-3FuXaXhpFhWnJaidwacTji`

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials:

   ```env
   OPENAI_API_KEY=sk-...
   OPENAI_MODEL=gpt-4.1
   OPENAI_VECTOR_STORE_ID=vs_68f62cd846f48191a200e536464c0e5e
   OPENAI_FILE_ID=file-3FuXaXhpFhWnJaidwacTji
   PORT=3000
   ```

2. Install dependencies:

   ```powershell
   npm install
   ```

3. Run the server (serves both the API and static client):

   ```powershell
   npm run dev
   ```

4. Open `http://localhost:3000` in your browser.

## How it works

- Each new browser session triggers the backend to create an OpenAI conversation. The conversation identifier returned by OpenAI is used for every subsequent turn to maintain full context.
- Conversation history itself never lives on the server or client; only the OpenAI conversation ID is temporarily tracked in memory for routing requests.
- The initial system persona is resolved by reading `server/instructions/patient_persona.md`. This file stores the name of the active persona (for example `persona1.md`), so swapping personas is as simple as pointing it to a different markdown file.
- Every model call enables `file_search` with the configured vector store, keeping the assistant aware of the shared knowledge base without persisting transcripts locally.

## Customization

- Create additional persona files in `server/instructions/` (for example `persona2.md`, `persona3.md`) and update `patient_persona.md` with the filename you want to activate.
- Adjust styling in `client/styles.css` for a different look and feel.

## Production considerations

- Replace the in-memory conversation store with a secure shared session mechanism if you need multiple server replicas.
- Add authentication if you need to restrict access.
- Serve the client bundle from a CDN or dedicated static host for better performance.
