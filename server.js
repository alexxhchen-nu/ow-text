import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const MODEL = 'gpt-4o-mini';

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch {}
}

async function loadSession(id) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveSession(session) {
  await fs.writeFile(path.join(DATA_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

async function openaiChat({ messages, jsonMode = false }) {
  const body = { model: MODEL, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

function interviewerSystem(goal) {
  return `You are an expert qualitative interviewer conducting a user research interview.\n` +
    `Research goal: "${goal}"\n\n` +
    `Rules:\n` +
    `- Ask one concise question at a time.\n` +
    `- Listen to the answer, then probe deeper with a natural follow-up about motivations, feelings, or specific examples.\n` +
    `- Keep the tone conversational and respectful.\n` +
    `- After about 5-8 exchanges, or when the goal is satisfied, wrap up by saying the interview is complete and thanking the participant.\n` +
    `- Do not give analysis, summaries, or lists during the interview. Just the next question.`;
}

async function generateFirstQuestion(goal) {
  return openaiChat({
    messages: [
      { role: 'system', content: interviewerSystem(goal) },
      { role: 'user', content: 'Generate a warm, open-ended first question to begin the interview.' },
    ],
  });
}

async function nextQuestion(session, userText) {
  const messages = [{ role: 'system', content: interviewerSystem(session.goal) }];
  for (const m of session.messages) {
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  }
  messages.push({ role: 'user', content: userText });
  return openaiChat({ messages });
}

async function generateReport(session) {
  const transcript = session.messages.map(m => `${m.role === 'user' ? 'Participant' : 'Interviewer'}: ${m.text}`).join('\n\n');
  const prompt = `Analyze the following interview transcript and produce a structured research report.\n` +
    `Research goal: "${session.goal}"\n\n` +
    `Transcript:\n${transcript}\n\n` +
    `Return JSON with this exact shape:\n` +
    `{\n  "summary": "string",\n  "themes": [{"name": "string", "description": "string", "quotes": ["string"]}],\n  "insights": [{"finding": "string", "evidence": "string"}],\n  "sentiment": "string",\n  "recommendations": ["string"]\n}`;
  const raw = await openaiChat({
    messages: [
      { role: 'system', content: 'You are a senior UX researcher who writes concise, evidence-based reports.' },
      { role: 'user', content: prompt },
    ],
    jsonMode: true,
  });
  try {
    return JSON.parse(raw);
  } catch {
    return { summary: raw, themes: [], insights: [], sentiment: 'unknown', recommendations: [] };
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function bad(res, msg) { json(res, 400, { error: msg }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/api/interview/start' && req.method === 'POST') {
    if (!OPENAI_KEY) return bad(res, 'OPENAI_API_KEY not set');
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.goal?.trim()) return bad(res, 'goal is required');
    const id = crypto.randomUUID();
    const firstQuestion = await generateFirstQuestion(body.goal);
    const session = { id, goal: body.goal, createdAt: new Date().toISOString(), messages: [{ role: 'assistant', text: firstQuestion }] };
    await saveSession(session);
    return json(res, 201, { id, message: firstQuestion });
  }

  const messageMatch = pathname.match(/^\/api\/interview\/([^/]+)\/message$/);
  if (messageMatch && req.method === 'POST') {
    if (!OPENAI_KEY) return bad(res, 'OPENAI_API_KEY not set');
    const id = messageMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.text?.trim()) return bad(res, 'text is required');
    session.messages.push({ role: 'user', text: body.text, ts: new Date().toISOString() });
    const reply = await nextQuestion(session, body.text);
    session.messages.push({ role: 'assistant', text: reply, ts: new Date().toISOString() });
    await saveSession(session);
    return json(res, 200, { message: reply });
  }

  const reportMatch = pathname.match(/^\/api\/interview\/([^/]+)\/report$/);
  if (reportMatch && req.method === 'GET') {
    if (!OPENAI_KEY) return bad(res, 'OPENAI_API_KEY not set');
    const id = reportMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const report = await generateReport(session);
    return json(res, 200, { id, goal: session.goal, report });
  }

  const sessionMatch = pathname.match(/^\/api\/interview\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') {
    const session = await loadSession(sessionMatch[1]);
    if (!session) return json(res, 404, { error: 'session not found' });
    return json(res, 200, session);
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

await ensureDataDir();
server.listen(PORT, () => {
  console.log(`Interview server running at http://localhost:${PORT}`);
  if (!OPENAI_KEY) console.warn('Warning: OPENAI_API_KEY is not set. API calls will fail.');
});
