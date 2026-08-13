# Bilingual configurable voice interviews

## Goal

Turn the interview bot into a bilingual English/Chinese voice-capable prototype. Keep text chat usable when audio services fail. Work only on `experiment`; `main` remains untouched.

## Language and UI

- Default language: English.
- A language switch changes every visible label, placeholder, status message, interview prompt, framework, and report language.
- The interface is a dark, high-contrast configuration-and-conversation workspace with restrained violet/blue gradients, compact cards, clear progress states, and responsive mobile layout. It takes visual direction from fal.ai without copying its implementation or layout.
- Setup presents one expandable card each for Chat, Speech-to-text, and Text-to-speech. Simple fields stay visible; advanced fields are progressively disclosed.

## Provider configuration

Each service configuration is independent and contains a protocol, base URL, API key, and model.

### Chat protocols

- `openai-compatible`: POST `<baseUrl>/chat/completions` with Bearer auth.
- `anthropic-compatible`: POST `<baseUrl>/messages` with `x-api-key` and an Anthropic API version header.
- `huggingface-task`: chat via an HF-compatible task/router endpoint with Bearer auth.

### Speech-to-text protocols

- `openai-compatible`: POST `<baseUrl>/audio/transcriptions` multipart audio upload.
- `huggingface-task`: POST audio bytes to a configured Hugging Face automatic-speech-recognition task endpoint with Bearer auth.

### Text-to-speech protocols

- `openai-compatible`: POST `<baseUrl>/audio/speech`, returning playable audio.
- `huggingface-task`: POST JSON text input to a configured Hugging Face text-to-speech task endpoint with Bearer auth, returning playable audio.

TTS also accepts voice and speed. All credentials are passed per request only and never written to session JSON or local storage.

## Audio interaction

- Browser `MediaRecorder` captures microphone audio after explicit user action.
- While recording, the browser periodically sends a rolling audio chunk for transcription. The partial transcript visibly updates roughly every 1–2 seconds.
- Stop-recording performs one final transcription. The final transcript is placed in the answer input, allowing user edits before sending.
- After every moderator message, the browser requests TTS and attaches an audio player to that message. Audio failures show a small retry control and never block text interview flow.
- Audio blobs are transient and are not persisted by this app.

## Interview behavior

- Existing stateful interview framework, progress, report, evaluation, and CSV export remain.
- All model prompts and fallback text are parameterized by the chosen language.
- Session records retain text only. API keys and audio configuration are not saved.

## Error handling

- Validate required provider fields before requests.
- Surface protocol-specific endpoint errors next to the relevant card.
- Gracefully retain typed text if microphone access, transcription, or speech synthesis fails.
- Do not assume custom endpoint responses beyond the selected protocol.

## Verification

- Extend the Node integration test to cover English language prompts and mocked OpenAI-compatible STT/TTS routes.
- Verify existing interview, report, and evaluation paths still pass.
- Manually test language switching, microphone-denied fallback, STT partial/final transcript display, and TTS playback in a browser.

## Deliberate boundary

No self-hosted models, server-side audio storage, WebSocket/STT streaming server, voice cloning, or arbitrary provider adapters. Add them only after this configurable HTTP prototype proves useful.
