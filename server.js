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
  if (baseUrl) return baseUrl.replace(/\/(chat\/completions|messages|models)\/?$/, '').replace(/\/$/, '');
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

function designContext(design) {
  const { goal, targetAudience, scenarios, persona, methodology } = design;
  let ctx = `研究目标："${goal}"\n`;
  if (targetAudience) ctx += `目标受众：${targetAudience}\n`;
  if (scenarios) ctx += `研究场景：${scenarios}\n`;
  if (persona) ctx += `受访者画像/上下文：${persona}\n`;
  if (methodology && methodology !== 'general') ctx += `采用方法学：${methodology}\n`;
  return ctx;
}

function validateFramework(fw) {
  if (!fw || !Array.isArray(fw.topics) || fw.topics.length === 0) return false;
  for (const t of fw.topics) {
    if (!t.id || !t.name || !t.goal) return false;
  }
  return true;
}

async function generateFramework(design, apiKey, provider, baseUrl, model) {
  const ctx = designContext(design);
  const prompt = `你是一位资深用户研究设计师。请根据下面的研究设计，生成一份结构化访谈框架。\n\n` +
    `${ctx}\n\n` +
    `要求：\n` +
    `- 把访谈拆成 4-8 个话题（topic），每个话题有清晰的目标。\n` +
    `- 每个话题包含：id、name（话题名称）、goal（探索目标）、stage（建议进入阶段：introduce/explore/probe/confirm）、min_questions（最少问题数）、max_questions（最多问题数）、focus_prompt（提问时的关注焦点）。\n` +
    `- 提供 3-5 条自然结束标准。\n` +
    `- 输出必须是 JSON，格式如下：\n` +
    `{\n  "topics": [{\n    "id": "t1",\n    "name": "string",\n    "goal": "string",\n    "stage": "introduce",\n    "min_questions": 2,\n    "max_questions": 5,\n    "focus_prompt": "string"\n  }],\n  "endingCriteria": ["string"],\n  "estimatedTurns": 12\n}`;
  const raw = await providerChat({
    provider, baseUrl, apiKey, model,
    messages: [
      { role: 'system', content: '你是一位资深用户研究设计师，擅长把研究目标拆成可执行、可追踪的访谈话题。所有输出必须使用简体中文；不得夹杂其他语言。' },
      { role: 'user', content: prompt },
    ],
    jsonMode: true,
  });
  try {
    const fw = JSON.parse(extractFirstJson(raw));
    if (!validateFramework(fw)) throw new Error('invalid framework structure');
    return fw;
  } catch {
    return { topics: defaultTopics(design), endingCriteria: defaultEndingCriteria(), estimatedTurns: 12 };
  }
}

function defaultTopics(design) {
  return [
    { id: 't1', name: '开场与背景', goal: '建立信任并了解受访者基本情况', stage: 'introduce', min_questions: 2, max_questions: 3, focus_prompt: '让对方感到轻松，收集基本背景' },
    { id: 't2', name: '核心探索', goal: `深入理解研究目标：${design.goal}`, stage: 'explore', min_questions: 3, max_questions: 6, focus_prompt: '围绕研究目标收集事实、行为和痛点' },
    { id: 't3', name: '深度追问', goal: '挖掘动机、感受和具体例子', stage: 'probe', min_questions: 2, max_questions: 4, focus_prompt: '追问为什么、情绪和具体场景' },
    { id: 't4', name: '收尾确认', goal: '总结关键信息并感谢受访者', stage: 'confirm', min_questions: 1, max_questions: 2, focus_prompt: '确认理解无误，给对方补充机会' },
  ];
}

function defaultEndingCriteria() {
  return [
    '所有话题已充分探索，受访者没有提供新的信息',
    '受访者明确表示结束或没有更多内容',
    '主持人已连续确认两次，受访者没有补充',
    '已达到预估轮数且每个话题满足最小问题数',
  ];
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

function transcriptText(session) {
  return session.messages.map(m => `${m.role === 'user' ? '受访者' : '主持人'}：${m.text}`).join('\n\n');
}

async function decideNext(session, userText, apiKey) {
  if (session.state.interviewEnded) {
    return { action: 'end', question: '访谈已经结束，谢谢你的时间。', reason: 'already ended', next_topic_id: null, next_stage: null };
  }
  const fw = session.framework;
  const state = session.state;
  const currentTopic = getTopic(fw, state.currentTopicId);
  const nextTopicId = getNextTopicId(fw, state.currentTopicId);
  const history = transcriptText(session);
  const prompt = `你是一位经验丰富的定性研究访谈主持人。当前访谈遵循一个预设框架，请根据对话状态决定下一步动作。\n\n` +
    `访谈框架：\n${JSON.stringify(fw, null, 2)}\n\n` +
    `当前状态：\n` +
    `- 当前话题：${currentTopic.name}（id: ${currentTopic.id}）\n` +
    `- 话题目标：${currentTopic.goal}\n` +
    `- 当前阶段：${state.topicStage}\n` +
    `- 本话题已进行轮数：${state.topicTurns}（建议最少 ${currentTopic.min_questions}，最多 ${currentTopic.max_questions}）\n` +
    `- 总轮数：${state.totalTurns}（预估 ${fw.estimatedTurns || 12}）\n` +
    `- 下一话题：${nextTopicId ? getTopic(fw, nextTopicId).name : '无'}\n` +
    `- 自然结束标准：${fw.endingCriteria?.join('；') || '所有话题探索完毕'}\n\n` +
    `对话历史：\n${history}\n\n` +
    `${userText ? `受访者刚说：「${userText}」\n\n` : ''}` +
    `请决定下一步动作并生成下一个问题。返回 JSON：\n` +
    `{\n  "action": "ask | probe | transition | end",\n  "question": "要问受访者的下一个简洁问题。如果 action=end，则是感谢收尾语。",\n  "reason": "选择这个动作和问题的理由，结合当前话题、阶段和受访者回答",\n  "next_topic_id": "如果 action=transition，填写下一话题 id；否则省略或为空",\n  "next_stage": "如果 action=transition，填写下一话题进入阶段（introduce/explore/probe/confirm）；否则省略或为空"\n}\n\n` +
    `动作说明：\n` +
    `- ask：继续在当前话题当前阶段提一个新问题。\n` +
    `- probe：对受访者刚说的内容做一次深入追问（动机、例子、感受、原因）。\n` +
    `- transition：当前话题已探索足够，转移到下一话题。\n` +
    `- end：所有话题已探索完毕，或受访者明确想结束，或已连续无新信息。\n\n` +
    `规则：\n` +
    `- 所有字段必须使用简体中文，不得出现越南语、英语或其他语言。\n` +
    `- 一次只问一个问题。\n` +
    `- 不要重复已经问过的问题；如果历史里已有相同意图，必须换一个更具体的新角度。\n` +
    `- 每个问题必须基于受访者刚刚说过的具体内容或当前话题目标。\n` +
    `- 问题要自然、对话式，不要像问卷。\n` +
    `- 如果受访者说「没了」「就这样」「结束」「不知道了」，优先选择 end（如果话题已够）或 transition（如果还有话题）。\n` +
    `- 如果受访者给出了值得深挖的新信息，优先选择 probe。\n` +
    `- 如果当前话题已满足 min_questions 且受访者没有新信息，优先 transition。\n` +
    `- 如果所有话题都完成，必须选择 end。`;
  const raw = await providerChat({
    provider: session.provider,
    baseUrl: session.baseUrl,
    apiKey,
    model: session.model,
    messages: [
      { role: 'system', content: '你是一位资深定性研究访谈主持人，擅长动态把握访谈节奏、自然过渡话题、并在合适时机结束访谈。所有输出必须使用简体中文；不得夹杂越南语、英语或其他语言。避免重复已问过的问题。' },
      { role: 'user', content: prompt },
    ],
    jsonMode: true,
  });
  try {
    const decision = JSON.parse(extractFirstJson(raw));
    return {
      action: decision.action || 'ask',
      question: decision.question || raw,
      reason: decision.reason || '',
      next_topic_id: decision.next_topic_id || null,
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
      state.topicTurns = 0;
    } else {
      state.interviewEnded = true;
    }
  } else {
    state.topicTurns++;
  }
  state.totalTurns++;
}

async function generateReport(session, apiKey) {
  const ctx = designContext(session);
  const fw = session.framework;
  const prompt = `分析以下访谈记录，输出一份结构化研究报告。\n\n` +
    `${ctx}\n` +
    `访谈框架：\n${fw.topics.map(t => `- ${t.name}：${t.goal}`).join('\n')}\n\n` +
    `访谈记录：\n${transcriptText(session)}\n\n` +
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
  const ctx = designContext(session);
  const rubric = `\n` +
    `naturalness（自然度）: 问题是否像真人对话，不生硬。\n` +
    `relevance（相关性）: 问题是否紧扣研究目标和当前话题。\n` +
    `probing（追问质量）: 是否基于受访者回答做了有效追问。\n` +
    `single_question（单一问题）: 是否一次只问一个问题。\n` +
    `no_bias（无偏见）: 是否避免引导性或偏见性语言。\n` +
    `progression（节奏推进）: 话题过渡是否自然，是否按框架有序推进。\n` +
    `ending（自然结束）: 是否在合适时机主动结束，没有反复追问。\n` +
    `persona_fit（画像契合）: 问题是否符合目标受众与受访者画像。`;
  const prompt = `你是一位资深用户研究专家。请评估下面这段 AI 主持的访谈质量。\n\n` +
    `${ctx}\n` +
    `访谈框架：\n${session.framework.topics.map(t => `- ${t.name}：${t.goal}`).join('\n')}\n\n` +
    `访谈记录：\n${transcriptText(session)}\n\n` +
    `评估维度（1-5 分，5 分最好）：${rubric}\n\n` +
    `返回 JSON：\n` +
    `{\n  "scores": {"naturalness": 1, "relevance": 1, "probing": 1, "single_question": 1, "no_bias": 1, "progression": 1, "ending": 1, "persona_fit": 1},\n  "overall_comment": "总体评价",\n  "top_strength": "最大优点",\n  "top_weakness": "最大改进点",\n  "bad_cases": [{"turn": 1, "issue": "问题"}]\n}`;
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

  if (pathname === '/api/interview/framework' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.goal?.trim()) return bad(res, 'goal is required');
    if (!body.provider || !body.apiKey || !body.model) return bad(res, 'provider, apiKey, model are required');
    const design = {
      goal: body.goal,
      targetAudience: body.targetAudience || '',
      scenarios: body.scenarios || '',
      persona: body.persona || '',
      methodology: body.methodology || 'general',
    };
    try {
      const framework = await generateFramework(design, body.apiKey, body.provider, normalizeBaseUrl(body.provider, body.baseUrl), body.model);
      return json(res, 200, { framework });
    } catch (e) { return bad(res, e.message); }
  }

  if (pathname === '/api/interview/start' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.goal?.trim()) return bad(res, 'goal is required');
    if (!body.provider || !body.apiKey || !body.model) return bad(res, 'provider, apiKey, model are required');
    if (!body.framework || !validateFramework(body.framework)) return bad(res, 'framework is required');
    const id = crypto.randomUUID();
    const session = {
      id,
      goal: body.goal,
      targetAudience: body.targetAudience || '',
      scenarios: body.scenarios || '',
      persona: body.persona || '',
      methodology: body.methodology || 'general',
      provider: body.provider,
      baseUrl: normalizeBaseUrl(body.provider, body.baseUrl),
      model: body.model,
      framework: body.framework,
      state: initState(body.framework),
      createdAt: new Date().toISOString(),
      messages: [],
    };
    const first = await decideNext(session, null, body.apiKey);
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
    if (session.state.interviewEnded) return json(res, 200, { message: '访谈已经结束。你可以点击生成报告。', interviewEnded: true });
    session.messages.push({ role: 'user', text: body.text, ts: new Date().toISOString() });
    const reply = await decideNext(session, body.text, body.apiKey);
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
