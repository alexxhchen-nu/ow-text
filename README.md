# ow-text

Text version of the OW Chatbot Tool — a minimal AI-moderated interview platform.

## What it does

1. Enter a research goal (e.g. “Understand why users churn during onboarding”).
2. An AI interviewer asks open-ended questions and probes answers.
3. Transcripts are saved locally as JSON.
4. One click generates a structured insight report with themes, quotes, insights, and recommendations.

## Run locally

```bash
# 1. Set your OpenAI API key
export OPENAI_API_KEY=sk-...

# 2. Start the server
node server.js

# 3. Open http://localhost:3000
```

No dependencies are required; it uses Node’s built-in HTTP module and native `fetch`.

## API

- `POST /api/interview/start` — body `{ goal }` → starts a session and returns the first question.
- `POST /api/interview/:id/message` — body `{ text }` → continues the interview.
- `GET /api/interview/:id/report` — generates the insight report.
- `GET /api/interview/:id` — fetches the raw session.

Sessions are stored in `data/` as JSON files.

## What’s missing (for later)

- Authentication, multi-user accounts, and cloud deployment.
- Panel/recruitment links and demographic quotas.
- Real-time collaboration and commenting.
- Audio/voice input and output.
- Persistent database (currently local filesystem).

