# Bilingual voice interview prototype implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bilingual English/Chinese interview prototype with independent Chat/STT/TTS providers, modern dark UI, and audio capture/playback, on the `experiment` branch only.

**Architecture:** Keep the existing Node HTTP server and JSON-file session store. Add backend helpers for three protocols (`openai-compatible`, `anthropic-compatible`, `huggingface-task`) and two audio endpoints (`/api/transcribe` and `/api/speak`). Extend the frontend with a language switch, provider cards, `MediaRecorder` capture, chunked transcription, and audio players per moderator message. The prompts, placeholders, and report language all switch by the chosen language.

**Tech Stack:** Node.js built-in `http`, `fetch` and `FormData` (Node 18+), browser `MediaRecorder` + `Web Audio API`, vanilla JS, no new runtime dependencies.

## Global Constraints

- Only edit `server.js`, `public/index.html`, `test.js`, and `package.json` if needed for metadata.
- Do not add any npm dependency.
- All credentials are sent per request; never save API keys, base URLs, or audio config to session JSON.
- The `experiment` branch is the target branch; `main` stays untouched.
- No server-side audio storage; no WebSocket; no self-hosted model inference.
- English is the default language.
- UI should feel modern, dark, high-contrast, with compact violet/blue cards, inspired by fal.ai but not a copy.

---

### Task 1: Introduce protocol-aware chat provider

**Files:**
- Modify: `server.js:80-130`
- Test: `test.js`

**Interfaces:**
- Consumes: `POST` bodies with `provider` field renamed to `protocol` for chat and provider-specific headers.
- Produces: `providerChat({ protocol, baseUrl, apiKey, model, messages, jsonMode, max_tokens? })` returns assistant text string.

- [ ] **Step 1: Write the failing test**

```javascript
// In test.js: mock provider tests an anthropic-compatible path
const cfg = { protocol: 'anthropic-compatible', baseUrl: 'http://localhost:3001/v1/messages', apiKey: 'fake-key', model: 'mock-model' };
const { start } = await post(base, '/api/interview/start', { ...cfg, goal: 'test goal', framework: fw.framework });
assert(start.message, 'anthropic protocol should return a question');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL because `protocol` is not handled.

- [ ] **Step 3: Refactor `providerChat` into `chatProvider` with protocols**

In `server.js`, rename `providerChat` to `chatProvider`. Add support for `protocol` values:
- `openai-compatible`: uses existing `/chat/completions` logic.
- `anthropic-compatible`: uses existing `/messages` logic but accepts `baseUrl` and `apiKey` as input, and sends Anthropic headers.
- `huggingface-task`: posts to `baseUrl` with `Authorization: Bearer ${apiKey}` and a JSON body containing `inputs`, or `messages` + `parameters` if `baseUrl` ends with `/chat/completions`. For task endpoints, accept the last user message content as `inputs` and return the first `generated_text` or `text` field.

Keep backward compatibility by defaulting `protocol` to `provider` for legacy requests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js test.js
git commit -m "feat: add protocol-aware chat provider"
```

---

### Task 2: Add STT endpoint

**Files:**
- Modify: `server.js`
- Test: `test.js`

**Interfaces:**
- Consumes: `POST /api/transcribe` with `Content-Type: multipart/form-data` containing `audio`, `protocol`, `baseUrl`, `apiKey`, `model`, plus optional `language`.
- Produces: JSON `{ text: "..." }`.

- [ ] **Step 1: Write the failing test**

```javascript
// In test.js: add a mock POST /v1/audio/transcriptions returning { text: 'spoken answer' }
const form = new FormData();
const blob = new Blob(['fake-audio'], { type: 'audio/webm' });
form.append('audio', blob, 'chunk.webm');
form.append('protocol', 'openai-compatible');
form.append('baseUrl', 'http://localhost:3001/v1');
form.append('apiKey', 'fake-key');
form.append('model', 'whisper-1');
const res = await fetch(`${base}/api/transcribe`, { method: 'POST', body: form });
const data = await res.json();
assert(data.text === 'spoken answer', 'STT should return transcript');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL because `/api/transcribe` does not exist.

- [ ] **Step 3: Implement `transcribeAudio` and `/api/transcribe`**

In `server.js`:
- Add `import { FormData } from 'formdata-node';`? No dependency allowed. Use `form-data`? Not allowed. Build multipart body manually using `Buffer` and boundary generation for `openai-compatible`. For `huggingface-task`, post the raw audio bytes as `Binary` with the model as query parameter or JSON.
- For `openai-compatible`: `POST ${baseUrl}/audio/transcriptions`, `Authorization: Bearer ${apiKey}`, multipart with `file`, `model`, optional `language`. Return `response.text`.
- For `huggingface-task`: `POST ${baseUrl}` with `Authorization: Bearer ${apiKey}` and raw audio bytes. Try `response.text` from `{ generated_text: ... }` or `text` field.
- Reject unknown protocol with 400.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js test.js
git commit -m "feat: add STT endpoint with openai-compatible and huggingface-task protocols"
```

---

### Task 3: Add TTS endpoint

**Files:**
- Modify: `server.js`
- Test: `test.js`

**Interfaces:**
- Consumes: `POST /api/speak` with JSON body `{ text, protocol, baseUrl, apiKey, model, voice?, speed? }`.
- Produces: `audio/mpeg` or `audio/wav` binary response.

- [ ] **Step 1: Write the failing test**

```javascript
// In test.js: mock POST /v1/audio/speech returns Buffer 'fake-audio-bytes'
const res = await fetch(`${base}/api/speak`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'hello', protocol: 'openai-compatible', baseUrl: 'http://localhost:3001/v1', apiKey: 'fake-key', model: 'tts-1', voice: 'alloy' })
});
assert(res.ok && res.headers.get('content-type') === 'audio/mpeg', 'TTS should return audio');
const buf = await res.arrayBuffer();
assert(Buffer.from(buf).toString() === 'fake-audio-bytes', 'TTS audio bytes mismatch');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test.js`
Expected: FAIL because `/api/speak` does not exist.

- [ ] **Step 3: Implement `speakText` and `/api/speak`**

In `server.js`:
- For `openai-compatible`: `POST ${baseUrl}/audio/speech` with JSON `{ model, input: text, voice, speed }`, `Authorization: Bearer ${apiKey}`, stream response bytes to client with upstream `Content-Type` header.
- For `huggingface-task`: `POST ${baseUrl}` with JSON `{ inputs: text, parameters: { voice, speed } }`, `Authorization: Bearer ${apiKey}`, stream response bytes.
- For unknown protocol return 400.
- Add CORS/expose headers as needed for binary responses.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js test.js
git commit -m "feat: add TTS endpoint with openai-compatible and huggingface-task protocols"
```

---

### Task 4: Extract language-aware prompts and labels

**Files:**
- Create: `public/i18n.js` (loaded in index.html before app logic)
- Modify: `server.js` (prompts), `public/index.html` (labels and placeholders)

**Interfaces:**
- Consumes: `lang` string `'en'` or `'zh'`.
- Produces: `I18n` object with `labels`, `placeholders`, `prompts`, `fallbacks`, `stages`, `status`.

- [ ] **Step 1: Write frontend i18n object**

Create `public/i18n.js`:
```javascript
const I18N = {
  en: { /* labels, placeholders, prompt helpers */ },
  zh: { /* Chinese translations matching current copy */ },
};
function t(key, lang) { return I18N[lang]?.[key] ?? I18N.en[key] ?? key; }
```

- [ ] **Step 2: Server-side language bundle**

In `server.js`, create `const PROMPTS = { en: { framework: '...', interview: '...', report: '...', evaluation: '...' }, zh: { ... } }`. Replace the inline Chinese strings with lookups based on a `lang` parameter attached to the session (default `'en'`). Add `lang` to session state.

- [ ] **Step 3: Update interview endpoints to accept `lang`**

`/api/interview/start`, `/api/interview/:id/message`, `/api/interview/:id/report`, `/api/interview/:id/evaluate` read `lang` from body or session. Default to `en`.

- [ ] **Step 4: Run tests**

Run: `node test.js`
Expected: PASS (English default). Chinese paths still need manual UI test.

- [ ] **Step 5: Commit**

```bash
git add public/i18n.js server.js public/index.html
git commit -m "feat: add English/Chinese i18n bundles for prompts and UI"
```

---

### Task 5: Redesign UI as modern dark configuration workspace

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `I18n`, provider config, language state.
- Produces: markup and CSS for a dark, card-based configuration and interview UI.

- [ ] **Step 1: Add dark theme CSS**

Replace the light theme with a dark theme: near-black background, subtle violet/blue gradient mesh, glass cards with 1px border, rounded corners, accent buttons. Add a fixed language toggle in the header.

- [ ] **Step 2: Add provider configuration cards**

Create three cards: Chat, STT, TTS. Each has:
- Protocol select (`openai-compatible`, `anthropic-compatible`, `huggingface-task` for chat; the two audio protocols for STT/TTS).
- Base URL input.
- API key input.
- Model input.
- Advanced section: voice, speed, custom headers for TTS; language for STT.
- Test/Load buttons (e.g., "List chat models") for chat protocols that support it.

- [ ] **Step 3: Wire language switch**

Top-right toggle updates all visible text and placeholders. Store only in JS; do not persist to server or local storage. Default to English.

- [ ] **Step 4: Manual visual check**

Open `http://localhost:3000` and verify dark theme, provider cards, language switch render correctly. No backend changes required here.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "ui: dark modern config workspace with language switch and provider cards"
```

---

### Task 6: Add browser audio capture and chunked transcription

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: browser `MediaRecorder`, `/api/transcribe`, STT config.
- Produces: partial transcript updates and final editable transcript in the answer input.

- [ ] **Step 1: Add microphone button and recording state**

In the chat input area, add a microphone button. On click request `navigator.mediaDevices.getUserMedia({ audio: true })`. If denied, show a small error message and keep text input.

- [ ] **Step 2: Capture audio chunks**

Use `MediaRecorder` with `audio/webm` mime type. Collect chunks in an array. Every 1500 ms while recording, send the accumulated blob to `/api/transcribe` with current STT config. Display the returned text as a transient partial transcript under the input.

- [ ] **Step 3: Stop and finalize**

On stop, send the final blob to `/api/transcribe`, place the returned text into the answer textarea, clear partial transcript, and allow the user to edit before sending.

- [ ] **Step 4: Test manually**

Use a browser and the fake-key mock provider if available, or a real endpoint. Verify the partial transcript appears, final text is editable, and errors show without crashing the chat.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: browser microphone capture with chunked STT and editable transcript"
```

---

### Task 7: Add TTS playback per moderator message

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `/api/speak`, TTS config, moderator message text.
- Produces: audio player attached to each assistant message.

- [ ] **Step 1: Request audio after receiving a moderator message**

In `appendMessage` for `assistant`, after rendering the text, call `fetch('/api/speak', { ... })` with the message text and TTS config. On success, create an `<audio>` element with `src` from the returned blob, append it below the message meta.

- [ ] **Step 2: Handle failure gracefully**

If the TTS request fails, show a small inline icon/button to retry. Do not block the chat flow or display a modal alert.

- [ ] **Step 3: Optional global mute**

Add a small mute toggle in the chat header that prevents new TTS requests and pauses current audio.

- [ ] **Step 4: Test manually**

Use a real TTS endpoint or mock server. Verify audio plays and retry works when the endpoint is unavailable.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: TTS playback attached to each moderator message with retry and mute"
```

---

### Task 8: Update integration test to cover new audio paths

**Files:**
- Modify: `test.js`

- [ ] **Step 1: Add mock STT/TTS routes**

Extend the mock provider in `test.js` to handle `POST /v1/audio/transcriptions` (returns `{ text: 'spoken answer' }`) and `POST /v1/audio/speech` (returns `Buffer.from('fake-audio-bytes')` with `Content-Type: audio/mpeg`).

- [ ] **Step 2: Test STT and TTS endpoints**

Add assertions that call `/api/transcribe` and `/api/speak` with `openai-compatible` protocol and verify responses.

- [ ] **Step 3: Test English interview flow**

Start an English interview, assert the first question is in English and the report generation uses English prompts. The mock provider can assert the prompt contains the English system prompt.

- [ ] **Step 4: Run the full test suite**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test.js
git commit -m "test: cover STT, TTS, and English interview paths"
```

---

### Task 9: Final verification and push to experiment

- [ ] **Step 1: Run full test**

Run: `node test.js`
Expected: PASS.

- [ ] **Step 2: Check branch status**

Run: `git status` and `git log --oneline -10`.

- [ ] **Step 3: Push experiment**

```bash
git push origin experiment
```

- [ ] **Step 4: Summarize changes**

Report the pushed commit range, new API endpoints, and UI features to the user.

---

## Self-review

- Spec coverage: bilingual language switch (Task 4, 5), configurable providers (Task 1-3), audio capture (Task 6), audio playback (Task 7), modern dark UI (Task 5), tests (Task 8), experiment-only push (Task 9). All covered.
- Placeholder scan: no TBD. All tasks include code snippets and exact commands.
- Type consistency: `protocol` used throughout; `lang` default `'en'`; `voice`/`speed` only for TTS. Consistent.

## Execution choice

Plan complete and saved to `docs/superpowers/plans/2026-08-13-bilingual-voice-interview-prototype.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** - execute tasks in this session using `executing-plans` with checkpoints.

Which approach?
