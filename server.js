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

const STAGES = {
  opening: { label: '开场', maxRounds: 1, instruction: '建立信任、说明目的，问一个轻松开放的问题。' },
  background: { label: '背景', maxRounds: 2, instruction: '了解受访者基本情况、使用场景、相关背景。' },
  core_exploration: { label: '核心探索', maxRounds: 3, instruction: '围绕研究目标深入探索需求、痛点、行为。' },
  deep_probing: { label: '深度追问', maxRounds: 3, instruction: '对关键回答追问动机、感受、具体例子、因果关系。' },
  closing: { label: '收尾', maxRounds: 99, instruction: '总结确认，感谢受访者，结束访谈。' },
};

const STAGE_ORDER = ['opening', 'background', 'core_exploration', 'deep_probing', 'closing'];

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

function extractFirstJson(text) {
  let depth = 0, inString = false, escape = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"' && inString) { inString = false; continue; }
    if (ch === '"' && !inString) { inString = true; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if ((ch === '}' || ch === ']') && depth > 0) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('No valid JSON found in response');
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
  const text = await res.text();
  const data = JSON.parse(extractFirstJson(text));
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
    const text = await res.text();
    const data = JSON.parse(extractFirstJson(text));
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
  const text = await res.text();
  const data = JSON.parse(extractFirstJson(text));
  return data.choices?.[0]?.message?.content ?? '';
}

function determineStage(messages) {
  const assistantCount = messages.filter(m => m.role === 'assistant').length;
  let cumulative = 0;
  for (const stage of STAGE_ORDER) {
    cumulative += STAGES[stage].maxRounds;
    if (assistantCount < cumulative) return stage;
  }
  return 'closing';
}

function stageDefinitions() {
  return STAGE_ORDER.map(key => `- ${key}（${STAGES[key].label}）：${STAGES[key].instruction} 最多 ${STAGES[key].maxRounds} 轮`).join('\n');
}

function fewShotExamples() {
  return `\n\n示例（用户研究目标：了解用户为什么在新手引导阶段流失）：\n` +
    `---\n` +
    `阶段 opening：\n` +
    `问题：「你好，可以先简单聊聊你平时是怎么接触这类产品的吗？」\n` +
    `原因：建立信任，降低受访者防御，开启对话。\n\n` +
    `阶段 background：\n` +
    `问题：「你最近一次注册类似产品时，印象最深的一步是什么？」\n` +
    `原因：了解真实使用场景，为后续痛点探索做铺垫。\n\n` +
    `阶段 core_exploration：\n` +
    `问题：「你觉得新手引导里哪一步最让你困惑？」\n` +
    `原因：直接围绕研究目标探索关键痛点。\n\n` +
    `阶段 deep_probing：\n` +
    `问题：「当时你为什么会觉得那一步很困惑？能描述一下你当时的想法吗？」\n` +
    `原因：追问情绪和具体原因，避免表面回答。\n\n` +
    `阶段 closing：\n` +
    `问题：「谢谢你分享这些。如果让你给新手引导提一个建议，你会提什么？」\n` +
    `原因：收尾前再确认一次核心观点。`;
}

function interviewerSystem(goal) {
  return `你是一位经验丰富的定性研究访谈主持人。\n` +
    `研究目标："${goal}"\n\n` +
    `访谈阶段定义：\n${stageDefinitions()}\n\n` +
    `规则：\n` +
    `- 一次只问一个简洁的问题。\n` +
    `- 语气自然、对话式，避免像问卷。\n` +
    `- 追问时可以先简短回应受访者，再提下一个问题。\n` +
    `- 不要给出分析、总结、bullet list。\n` +
    `- 当接近收尾阶段时，主动结束访谈并感谢受访者。\n` +
    `- 必须根据当前阶段选择合适的提问策略。\n` +
    `- 输出必须是 JSON，格式如下：\n` +
    `{\n  "question": "下一个问题",\n  "stage": "当前阶段英文名（opening/background/core_exploration/deep_probing/closing）",\n  "reason": "为什么选择这个问题，它如何服务于当前阶段或研究目标",\n  "probe_target": "如果这个问题是追问，追问的目标是什么（可选）"\n}` +
    fewShotExamples();
}

async function askQuestion({ session, apiKey, userText = null, stage = null }) {
  const messages = [{ role: 'system', content: interviewerSystem(session.goal) }];
  for (const m of session.messages) {
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  }
  if (userText) messages.push({ role: 'user', content: userText });
  const currentStage = stage || determineStage(session.messages);
  messages.push({
    role: 'user',
    content: `请生成下一个问题。当前应处于阶段：${currentStage}（${STAGES[currentStage].label}）。严格输出 JSON，不要加 markdown 代码块。`,
  });
  const raw = await providerChat({
    provider: session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages,
    jsonMode: true,
  });
  try {
    const parsed = JSON.parse(extractFirstJson(raw));
    return {
      question: parsed.question || raw,
      stage: parsed.stage || currentStage,
      reason: parsed.reason || '',
      probe_target: parsed.probe_target || '',
    };
  } catch {
    return { question: raw, stage: currentStage, reason: '', probe_target: '' };
  }
}

async function generateFirstQuestion(session, apiKey) {
  return askQuestion({ session, apiKey, stage: 'opening' });
}

async function nextQuestion(session, userText, apiKey) {
  return askQuestion({ session, apiKey, userText });
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
    return JSON.parse(extractFirstJson(raw));
  } catch {
    return { summary: raw, themes: [], insights: [], sentiment: 'unknown', recommendations: [] };
  }
}

async function evaluateConversation(session, apiKey) {
  const transcript = session.messages.map(m => `${m.role === 'user' ? '受访者' : '主持人'}：${m.text}`).join('\n\n');
  const rubric = `\n` +
    `naturalness（自然度）: 问题是否像真人对话，不生硬。\n` +
    `relevance（相关性）: 问题是否紧扣研究目标。\n` +
    `probing（追问质量）: 是否基于受访者回答做了有效追问。\n` +
    `single_question（单一问题）: 是否一次只问一个问题。\n` +
    `no_bias（无偏见）: 是否避免引导性或偏见性语言。\n` +
    `progression（阶段推进）: 访谈是否按阶段有序推进，没有跳阶段或反复。`;
  const prompt = `你是一位资深用户研究专家。请评估下面这段 AI 主持的访谈质量。\n\n` +
    `研究目标："${session.goal}"\n\n` +
    `访谈记录：\n${transcript}\n\n` +
    `评估维度（1-5 分，5 分最好）：${rubric}\n\n` +
    `返回 JSON：\n` +
    `{\n  "scores": {"naturalness": 1, "relevance": 1, "probing": 1, "single_question": 1, "no_bias": 1, "progression": 1},\n  "overall_comment": "总体评价",\n  "top_strength": "最大优点",\n  "top_weakness": "最大改进点",\n  "bad_cases": [{"turn": 1, "issue": "问题"}]\n}`;
  const raw = await providerChat({
    provider: session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages: [
      { role: 'system', content: '你是一位严格的访谈质量评估专家，评分客观、具体。' },
      { role: 'user', content: prompt },
    ],
    jsonMode: true,
  });
  try {
    return JSON.parse(extractFirstJson(raw));
  } catch {
    return { scores: {}, overall_comment: raw, top_strength: '', top_weakness: '', bad_cases: [] };
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
    const first = await generateFirstQuestion(session, body.apiKey);
    session.messages.push({ role: 'assistant', text: first.question, stage: first.stage, reason: first.reason, probe_target: first.probe_target });
    await saveSession(session);
    return json(res, 201, { id, message: first.question, stage: first.stage, reason: first.reason, probe_target: first.probe_target });
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
    session.messages.push({ role: 'assistant', text: reply.question, stage: reply.stage, reason: reply.reason, probe_target: reply.probe_target, ts: new Date().toISOString() });
    await saveSession(session);
    return json(res, 200, { message: reply.question, stage: reply.stage, reason: reply.reason, probe_target: reply.probe_target });
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

  const evaluateMatch = pathname.match(/^\/api\/interview\/([^/]+)\/evaluate$/);
  if (evaluateMatch && req.method === 'POST') {
    const id = evaluateMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.apiKey) return bad(res, 'apiKey is required');
    const evaluation = await evaluateConversation(session, body.apiKey);
    return json(res, 200, { id, evaluation });
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
