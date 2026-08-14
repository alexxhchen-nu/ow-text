import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PROMPTS, transcriptText, getTopicName } from './prompts.js';

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

function normalizeBaseUrl(protocol, baseUrl) {
  if (baseUrl) return baseUrl.replace(/\/(chat\/completions|messages|models|audio\/transcriptions|audio\/speech)\/?$/, '').replace(/\/$/, '');
  const legacy = protocol === 'anthropic' || protocol === 'anthropic-compatible' ? 'anthropic' : 'openai';
  return DEFAULT_BASE_URLS[legacy] || '';
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

async function listModels({ protocol, provider, baseUrl, apiKey }) {
  if (!apiKey) throw new Error('API key is required');
  const p = protocol || provider || 'openai-compatible';
  const url = `${normalizeBaseUrl(p, baseUrl)}/models`;
  const headers = { 'Content-Type': 'application/json' };
  if (p === 'anthropic' || p === 'anthropic-compatible') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Models endpoint ${res.status}: ${await res.text()}`);
    const text = await res.text();
    const data = JSON.parse(extractFirstJson(text));
    const items = data.data || data.models || [];
    return items.map(m => ({ id: m.id, name: m.id })).sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    throw new Error(`Cannot fetch models from ${url}: ${e.message}${e.cause ? ` (${e.cause.message})` : ''}`);
  }
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

async function chatProvider({ protocol, provider, baseUrl, apiKey, model, messages, jsonMode = false, max_tokens = 4096 }) {
  if (!apiKey) throw new Error('API key is required');
  const p = protocol || provider || 'openai-compatible';
  const base = normalizeBaseUrl(p, baseUrl);
  if (!base) throw new Error('Provider base URL is required');
  try {
    if (!model) throw new Error('model is required');
    if (p === 'anthropic' || p === 'anthropic-compatible') {
      const { system, chat } = splitSystem(messages);
      const body = { model, messages: chat, max_tokens, system: system + (jsonMode ? '\nRespond only with valid JSON.' : '') };
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
    if (p === 'huggingface-task') {
      const isChatCompletion = base.endsWith('/chat/completions');
      const body = isChatCompletion
        ? { model, messages, max_tokens, temperature: 0.7 }
        : { inputs: lastUserContent(messages) };
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Hugging Face ${res.status}: ${await res.text()}`);
      const text = await res.text();
      const data = JSON.parse(extractFirstJson(text));
      if (isChatCompletion) return data.choices?.[0]?.message?.content ?? '';
      return data.generated_text ?? data.text ?? data[0]?.generated_text ?? data[0]?.text ?? '';
    }
    const body = { model, messages };
    if (max_tokens) body.max_tokens = max_tokens;
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
  } catch (e) {
    throw new Error(`Provider ${base} unreachable: ${e.message}${e.cause ? ` (${e.cause.message})` : ''}`);
  }
}

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function validateFramework(fw) {
  if (!fw || !Array.isArray(fw.topics) || fw.topics.length === 0) return false;
  for (const t of fw.topics) {
    if (!t.id || !t.name || !t.goal) return false;
  }
  return true;
}

async function generateFramework(design, apiKey, protocol, baseUrl, model, lang = 'en') {
  const p = PROMPTS[lang] || PROMPTS.en;
  const ctx = p.designContext(design);
  const raw = await chatProvider({
    protocol, baseUrl, apiKey, model,
    messages: [
      { role: 'system', content: p.frameworkSystem },
      { role: 'user', content: p.framework(ctx) },
    ],
    jsonMode: true,
  });
  try {
    const fw = JSON.parse(extractFirstJson(raw));
    if (!validateFramework(fw)) throw new Error('invalid framework structure');
    return fw;
  } catch {
    return { topics: p.defaultTopics(design), endingCriteria: p.defaultEndingCriteria(), estimatedTurns: 12 };
  }
}

function initState(framework) {
  return {
    currentTopicId: framework.topics[0]?.id || null,
    topicStage: framework.topics[0]?.stage || 'introduce',
    topicTurns: 0,
    totalTurns: 0,
    interviewEnded: false,
  };
}

function getTopic(framework, topicId) {
  return framework.topics.find(t => t.id === topicId) || framework.topics[0];
}

function getNextTopicId(framework, currentTopicId) {
  const idx = framework.topics.findIndex(t => t.id === currentTopicId);
  if (idx >= 0 && idx < framework.topics.length - 1) return framework.topics[idx + 1].id;
  return null;
}

function buildQaPairs(messages) {
  const pairs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'assistant') continue;
    const next = messages[i + 1]?.role === 'user' ? messages[i + 1] : null;
    pairs.push({
      index: pairs.length + 1,
      question: messages[i].text,
      answer: next?.text || '',
      questionMeta: {
        action: messages[i].action || '',
        reason: messages[i].reason || '',
        topic_id: messages[i].topic_id || '',
        stage: messages[i].stage || '',
        ts: messages[i].ts || '',
      },
      answerMeta: next ? { ts: next.ts || '' } : null,
    });
    if (next) i++;
  }
  return pairs;
}

function exportSession(session) {
  const lang = session.lang || 'en';
  return {
    id: session.id,
    goal: session.goal,
    lang,
    methodology: session.methodology || 'general',
    targetAudience: session.targetAudience || '',
    scenarios: session.scenarios || '',
    persona: session.persona || '',
    protocol: session.protocol || session.provider || '',
    baseUrl: session.baseUrl || '',
    model: session.model || '',
    createdAt: session.createdAt || '',
    framework: session.framework || null,
    state: session.state || null,
    messages: session.messages || [],
    qaPairs: buildQaPairs(session.messages || []),
    transcript: transcriptText(session, lang),
    report: session.lastReport || null,
    evaluation: session.lastEvaluation || null,
  };
}

function repeatedQuestion(session, text) {
  const norm = s => String(s).replace(/[\s。？！?！,.，]/g, '');
  const current = norm(text);
  return current && session.messages.some(m => m.role === 'assistant' && norm(m.text) === current);
}

async function decideNext(session, userText, apiKey, lang = 'en') {
  const p = PROMPTS[lang] || PROMPTS.en;
  if (session.state.interviewEnded) {
    return { action: 'end', question: p.fallbackEnd, reason: 'already ended', next_topic_id: null, next_stage: null };
  }
  const fw = session.framework;
  const state = session.state;
  const currentTopic = getTopic(fw, state.currentTopicId);
  const nextTopicId = getNextTopicId(fw, state.currentTopicId);
  const history = transcriptText(session, lang);
  const askedQuestions = session.messages
    .filter(m => m.role === 'assistant')
    .map(m => m.text)
    .slice(-8)
    .join('\n');
  const prompt = p.interview(session, p.designContext(session), fw, state, currentTopic, nextTopicId, history, askedQuestions, userText);
  const raw = await chatProvider({
    protocol: session.protocol || session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages: [
      { role: 'system', content: p.interviewSystem },
      { role: 'user', content: prompt },
    ],
    jsonMode: true,
  });
  try {
    const decision = JSON.parse(extractFirstJson(raw));
    const nextId = decision.next_topic_id || (decision.action === 'transition' ? getNextTopicId(fw, state.currentTopicId) : null);
    let question = decision.question || (decision.action === 'transition' && nextId ? p.transitionFallback(getTopic(fw, nextId)) : raw);
    if (decision.action === 'transition' && nextId && (question.includes('继续往下聊') || question.toLowerCase().includes('let\'s continue') || question.toLowerCase().includes('continue'))) {
      question = p.transitionFallback(getTopic(fw, nextId));
    }
    if (repeatedQuestion(session, question)) {
      question = p.repeatFallback(currentTopic.focus_prompt);
    }
    return {
      action: decision.action || 'ask',
      question,
      reason: decision.reason || '',
      next_topic_id: nextId,
      next_stage: decision.next_stage || 'introduce',
    };
  } catch {
    return { action: 'ask', question: raw, reason: 'fallback after parse error', next_topic_id: null, next_stage: null };
  }
}

function updateState(session, decision) {
  const state = session.state;
  const fw = session.framework;
  if (decision.action === 'end') {
    state.interviewEnded = true;
  } else if (decision.action === 'transition') {
    const nextId = decision.next_topic_id || getNextTopicId(fw, state.currentTopicId);
    if (nextId) {
      state.currentTopicId = nextId;
      state.topicStage = decision.next_stage || getTopic(fw, nextId).stage || 'introduce';
      state.topicTurns = 1;
    } else {
      state.interviewEnded = true;
    }
  } else {
    state.topicTurns++;
  }
  state.totalTurns++;
}

async function generateReport(session, apiKey, lang = 'en') {
  const p = PROMPTS[lang] || PROMPTS.en;
  const raw = await chatProvider({
    protocol: session.protocol || session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages: [
      { role: 'system', content: p.reportSystem },
      { role: 'user', content: p.report(session, p.designContext(session), session.framework) },
    ],
    jsonMode: true,
  });
  try {
    return JSON.parse(extractFirstJson(raw));
  } catch {
    return { summary: raw, themes: [], insights: [], sentiment: 'unknown', recommendations: [] };
  }
}

async function evaluateConversation(session, apiKey, lang = 'en') {
  const p = PROMPTS[lang] || PROMPTS.en;
  const raw = await chatProvider({
    protocol: session.protocol || session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages: [
      { role: 'system', content: p.evaluateSystem },
      { role: 'user', content: p.evaluate(session, p.designContext(session), session.framework) },
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

async function readBufferBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function parseMultipart(buf, contentType) {
  const match = String(contentType).match(/boundary=([^;]+)/i);
  if (!match) throw new Error('missing multipart boundary');
  const boundary = match[1].trim().replace(/^"|"$/g, '');
  const parts = buf.toString('binary').split('--' + boundary);
  const fields = {};
  const files = [];
  for (const part of parts) {
    const trimmed = part.replace(/\r\n$/, '');
    if (trimmed === '' || trimmed === '--') continue;
    const delim = '\r\n\r\n';
    const idx = trimmed.indexOf(delim);
    if (idx === -1) continue;
    const headerText = trimmed.slice(0, idx);
    const rawBody = trimmed.slice(idx + delim.length);
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > -1) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    const disp = headers['content-disposition'] || '';
    const nameMatch = disp.match(/name="([^"]+)"/);
    const filenameMatch = disp.match(/filename="([^"]*)"/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (filenameMatch) {
      files.push({ name, filename: filenameMatch[1] || 'blob', type: headers['content-type'] || 'application/octet-stream', data: Buffer.from(rawBody, 'binary') });
    } else {
      fields[name] = Buffer.from(rawBody, 'binary').toString('utf8');
    }
  }
  return { fields, files };
}

async function speakText({ text, protocol, baseUrl, apiKey, model, voice, speed }) {
  if (!apiKey) throw new Error('API key is required');
  if (!text) throw new Error('text is required');
  const p = protocol || 'openai-compatible';
  if (p === 'openai-compatible') {
    const base = normalizeBaseUrl(p, baseUrl);
    const body = { model, input: text, voice: voice || 'alloy' };
    if (speed) body.speed = Number(speed);
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
    return { body: res.body, contentType: res.headers.get('content-type') || 'audio/mpeg' };
  }
    if (p === 'elevenlabs') {
      if (!voice) throw new Error('ElevenLabs voice ID is required');
      const base = (baseUrl || 'https://api.elevenlabs.io').replace(/\/v1\/?$/, '').replace(/\/$/, '');
      const body = { text, model_id: model || 'eleven_multilingual_v2' };
      if (speed !== undefined && speed !== '') {
        const value = Number(speed);
        if (!Number.isFinite(value)) throw new Error('ElevenLabs speed must be a number');
        body.voice_settings = { speed: value };
      }
      const res = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
      return { body: res.body, contentType: res.headers.get('content-type') || 'audio/mpeg' };
    }
    if (p === 'huggingface-task') {
      const body = { inputs: text, parameters: { voice, speed } };
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}: ${await res.text()}`);
    return { body: res.body, contentType: res.headers.get('content-type') || 'audio/wav' };
  }
  throw new Error(`unsupported TTS protocol: ${p}`);
}

async function transcribeAudio({ audio, protocol, baseUrl, apiKey, model, language }) {
  if (!apiKey) throw new Error('API key is required');
  if (!audio?.data) throw new Error('audio is required');
  const p = protocol || 'openai-compatible';
  if (p === 'openai-compatible') {
    const base = normalizeBaseUrl(p, baseUrl);
    const boundary = '----VoiceFormBoundary' + Math.random().toString(36).slice(2);
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: ${audio.type || 'audio/webm'}\r\n\r\n`, 'utf8'));
    parts.push(audio.data);
    parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}`, 'utf8'));
    if (language) parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}`, 'utf8'));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
    const text = await res.text();
    const data = JSON.parse(extractFirstJson(text));
    return data.text || '';
  }
  if (p === 'huggingface-task') {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': audio.type || 'audio/webm' },
      body: audio.data,
    });
    if (!res.ok) throw new Error(`STT ${res.status}: ${await res.text()}`);
    const text = await res.text();
    const data = JSON.parse(extractFirstJson(text));
    return data.text || data.generated_text || '';
  }
  throw new Error(`unsupported STT protocol: ${p}`);
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
      const models = await listModels({ protocol: body.protocol || body.provider, provider: body.provider, baseUrl: body.baseUrl, apiKey: body.apiKey });
      return json(res, 200, { models });
    } catch (e) { return bad(res, e.message); }
  }

  if (pathname === '/api/transcribe' && req.method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) return bad(res, 'expected multipart/form-data');
    try {
      const buf = await readBufferBody(req);
      const { fields, files } = parseMultipart(buf, contentType);
      const audio = files.find(f => f.name === 'audio');
      if (!audio) return bad(res, 'audio file is required');
      const text = await transcribeAudio({ audio, protocol: fields.protocol, baseUrl: fields.baseUrl, apiKey: fields.apiKey, model: fields.model, language: fields.language });
      return json(res, 200, { text });
    } catch (e) { return bad(res, e.message); }
  }

  if (pathname === '/api/speak' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.text) return bad(res, 'text is required');
    try {
      const { body: stream, contentType } = await speakText({ text: body.text, protocol: body.protocol, baseUrl: body.baseUrl, apiKey: body.apiKey, model: body.model, voice: body.voice, speed: body.speed });
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Disposition': 'inline' });
      if (stream) {
        const reader = stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
      return;
    } catch (e) { return bad(res, e.message); }
  }

  if (pathname === '/api/interview/framework' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.goal?.trim()) return bad(res, 'goal is required');
    const protocol = body.protocol || body.provider;
    if (!protocol || !body.apiKey || !body.model) return bad(res, 'protocol/provider, apiKey, model are required');
    const design = {
      goal: body.goal,
      targetAudience: body.targetAudience || '',
      scenarios: body.scenarios || '',
      persona: body.persona || '',
      methodology: body.methodology || 'general',
    };
    try {
      const framework = await generateFramework(design, body.apiKey, protocol, normalizeBaseUrl(protocol, body.baseUrl), body.model, body.lang || 'en');
      return json(res, 200, { framework });
    } catch (e) { return bad(res, e.message); }
  }

  if (pathname === '/api/interview/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.goal?.trim()) return bad(res, 'goal is required');
    const protocol = body.protocol || body.provider;
    if (!protocol || !body.apiKey || !body.model) return bad(res, 'protocol/provider, apiKey, model are required');
    if (!body.framework || !validateFramework(body.framework)) return bad(res, 'framework is required');
    const id = crypto.randomUUID();
    const session = {
      id,
      goal: body.goal,
      targetAudience: body.targetAudience || '',
      scenarios: body.scenarios || '',
      persona: body.persona || '',
      methodology: body.methodology || 'general',
      protocol,
      provider: protocol,
      lang: body.lang || 'en',
      baseUrl: normalizeBaseUrl(protocol, body.baseUrl),
      model: body.model,
      framework: body.framework,
      state: initState(body.framework),
      createdAt: new Date().toISOString(),
      messages: [],
    };
    const first = await decideNext(session, null, body.apiKey, body.lang || session.lang || 'en');
    updateState(session, first);
    session.messages.push({ role: 'assistant', text: first.question, action: first.action, reason: first.reason, topic_id: session.state.currentTopicId, stage: session.state.topicStage, ts: new Date().toISOString() });
    await saveSession(session);
    return json(res, 201, { id, message: first.question, action: first.action, reason: first.reason, topic_id: session.state.currentTopicId, topic_name: getTopic(session.framework, session.state.currentTopicId).name, stage: session.state.topicStage, interviewEnded: session.state.interviewEnded });
  }

  const messageMatch = pathname.match(/^\/api\/interview\/([^/]+)\/message$/);
  if (messageMatch && req.method === 'POST') {
    const id = messageMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.text?.trim()) return bad(res, 'text is required');
    if (!body.apiKey) return bad(res, 'apiKey is required');
    if (session.state.interviewEnded) return json(res, 200, { message: '访谈已经结束，谢谢你的时间。', interviewEnded: true });
    session.messages.push({ role: 'user', text: body.text, ts: new Date().toISOString() });
    const reply = await decideNext(session, body.text, body.apiKey, body.lang || session.lang || 'en');
    updateState(session, reply);
    session.messages.push({ role: 'assistant', text: reply.question, action: reply.action, reason: reply.reason, topic_id: session.state.currentTopicId, stage: session.state.topicStage, ts: new Date().toISOString() });
    await saveSession(session);
    return json(res, 200, { message: reply.question, action: reply.action, reason: reply.reason, topic_id: session.state.currentTopicId, topic_name: getTopic(session.framework, session.state.currentTopicId).name, stage: session.state.topicStage, interviewEnded: session.state.interviewEnded });
  }

  const reportMatch = pathname.match(/^\/api\/interview\/([^/]+)\/report$/);
  if (reportMatch && req.method === 'POST') {
    const id = reportMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.apiKey) return bad(res, 'apiKey is required');
    const report = await generateReport(session, body.apiKey, body.lang || session.lang || 'en');
    session.lastReport = report;
    await saveSession(session);

    return json(res, 200, { id, goal: session.goal, report });
  }

  const evaluateMatch = pathname.match(/^\/api\/interview\/([^/]+)\/evaluate$/);
  if (evaluateMatch && req.method === 'POST') {
    const id = evaluateMatch[1];
    const session = await loadSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.apiKey) return bad(res, 'apiKey is required');
    const evaluation = await evaluateConversation(session, body.apiKey, body.lang || session.lang || 'en');
    session.lastEvaluation = evaluation;
    await saveSession(session);

    return json(res, 200, { id, evaluation });
  }

  const exportMatch = pathname.match(/^\/api\/interview\/([^/]+)\/export$/);
  if (exportMatch && req.method === 'GET') {
    const session = await loadSession(exportMatch[1]);
    if (!session) return json(res, 404, { error: 'session not found' });
    return json(res, 200, exportSession(session));
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
