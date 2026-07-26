import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  custom: '',
};

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

function normalizeBaseUrl(provider, baseUrl) {
  if (baseUrl) return baseUrl.replace(/\/$/, '');
  return DEFAULT_BASE_URLS[provider] || '';
}

async function listModels({ provider, baseUrl, apiKey }) {
  if (!apiKey) throw new Error('API key is required');
  const url = `${normalizeBaseUrl(provider, baseUrl)}/models`;
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Models endpoint ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const items = data.data || data.models || [];
  return items.map(m => ({ id: m.id, name: m.id })).sort((a, b) => a.id.localeCompare(b.id));
}

function splitSystem(messages) {
  let system = '';
  const chat = [];
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n' : '') + m.content;
    else chat.push(m);
  }
  return { system, chat };
}

async function providerChat({ provider, baseUrl, apiKey, model, messages, jsonMode = false }) {
  if (!apiKey) throw new Error('API key is required');
  if (!model) throw new Error('model is required');
  const base = normalizeBaseUrl(provider, baseUrl);
  if (provider === 'anthropic') {
    const { system, chat } = splitSystem(messages);
    const body = { model, messages: chat, max_tokens: 4096, system: system + (jsonMode ? '\nRespond only with valid JSON.' : '') };
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  }
  // OpenAI / OpenAI-compatible
  const body = { model, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Provider ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function interviewerSystem(goal) {
  return `你是一位经验丰富的定性研究访谈主持人。\n` +
    `研究目标："${goal}"\n\n` +
    `规则：\n` +
    `- 一次只问一个简洁的问题。\n` +
    `- 听完回答后，用自然的方式追问动机、感受或具体例子。\n` +
    `- 语气对话式、尊重受访者。\n` +
    `- 大约 5-8 轮后，或目标已满足时，结束访谈并感谢受访者。\n` +
    `- 访谈过程中不要给出分析、总结或列表，只给出下一个问题。`;
}

async function generateFirstQuestion(session, apiKey) {
  return providerChat({
    provider: session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages: [
      { role: 'system', content: interviewerSystem(session.goal) },
      { role: 'user', content: '生成一个温暖、开放式的问题来开始访谈。' },
    ],
  });
}

async function nextQuestion(session, userText, apiKey) {
  const messages = [{ role: 'system', content: interviewerSystem(session.goal) }];
  for (const m of session.messages) {
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  }
  messages.push({ role: 'user', content: userText });
  return providerChat({ provider: session.provider, baseUrl: session.baseUrl, apiKey, model: session.model, messages });
}

async function generateReport(session, apiKey) {
  const transcript = session.messages.map(m => `${m.role === 'user' ? '受访者' : '主持人'}：${m.text}`).join('\n\n');
  const prompt = `分析以下访谈记录，输出一份结构化研究报告。\n` +
    `研究目标："${session.goal}"\n\n` +
    `访谈记录：\n${transcript}\n\n` +
    `返回 JSON，格式如下：\n` +
    `{\n  "summary": "string",\n  "themes": [{"name": "string", "description": "string", "quotes": ["string"]}],\n  "insights": [{"finding": "string", "evidence": "string"}],\n  "sentiment": "string",\n  "recommendations": ["string"]\n}`;
  const raw = await providerChat({
    provider: session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages: [
      { role: 'system', content: '你是一位资深用户研究专家，擅长撰写简洁、有证据支撑的研究报告。' },
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

  if (pathname === '/api/models' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    try {
      const models = await listModels({ provider: body.provider, baseUrl: body.baseUrl, apiKey: body.apiKey });
      return json(res, 200, { models });
    } catch (e) { return bad(res, e.message); }
  }

  if (pathname === '/api/interview/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.goal?.trim()) return bad(res, 'goal is required');
    if (!body.provider) return bad(res, 'provider is required');
    if (!body.apiKey) return bad(res, 'apiKey is required');
    if (!body.model) return bad(res, 'model is required');
    const id = crypto.randomUUID();
    const session = {
      id,
      goal: body.goal,
      provider: body.provider,
      baseUrl: normalizeBaseUrl(body.provider, body.baseUrl),
      model: body.model,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    const firstQuestion = await generateFirstQuestion(session, body.apiKey);
    session.messages.push({ role: 'assistant', text: firstQuestion });
    await saveSession(session);
    return json(res, 201, { id, message: firstQuestion });
  }

  const messageMatch = pathname.match(/^\/api\/interview\/([^/]+)\/message$/);
  if (messageMatch && req.method === 'POST') {
    const id = messageMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.text?.trim()) return bad(res, 'text is required');
    if (!body.apiKey) return bad(res, 'apiKey is required');
    session.messages.push({ role: 'user', text: body.text, ts: new Date().toISOString() });
    const reply = await nextQuestion(session, body.text, body.apiKey);
    session.messages.push({ role: 'assistant', text: reply, ts: new Date().toISOString() });
    await saveSession(session);
    return json(res, 200, { message: reply });
  }

  const reportMatch = pathname.match(/^\/api\/interview\/([^/]+)\/report$/);
  if (reportMatch && req.method === 'POST') {
    const id = reportMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.apiKey) return bad(res, 'apiKey is required');
    const report = await generateReport(session, body.apiKey);
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
server.listen(PORT, () => console.log(`Interview server running at http://localhost:${PORT}`));
