import http from 'http';
import { spawn } from 'child_process';

const mockFramework = JSON.stringify({
  topics: [
    { id: 't1', name: '开场与背景', goal: '建立信任并了解背景', stage: 'introduce', min_questions: 2, max_questions: 3, focus_prompt: '让对方感到轻松' },
    { id: 't2', name: '核心探索', goal: '探索核心问题', stage: 'explore', min_questions: 2, max_questions: 4, focus_prompt: '收集事实和痛点' },
    { id: 't3', name: '深度追问', goal: '挖掘动机', stage: 'probe', min_questions: 1, max_questions: 3, focus_prompt: '追问原因和感受' },
    { id: 't4', name: '收尾', goal: '确认并感谢', stage: 'confirm', min_questions: 1, max_questions: 2, focus_prompt: '总结确认' },
  ],
  endingCriteria: ['all topics explored', 'user says stop'],
  estimatedTurns: 10,
});

const mockDecision = JSON.stringify({ action: 'ask', question: 'mock-question', reason: 'mock-reason', next_topic_id: null, next_stage: null });
const mockTransition = JSON.stringify({ action: 'transition', question: 'mock-transition-question', reason: 'mock-transition-reason', next_topic_id: 't2', next_stage: 'introduce' });
const mockEvaluate = JSON.stringify({
  scores: { naturalness: 4, relevance: 4, probing: 3, single_question: 5, no_bias: 4, progression: 4, ending: 4, persona_fit: 4 },
  overall_comment: 'mock overall comment',
  top_strength: 'mock strength',
  top_weakness: 'mock weakness',
  bad_cases: []
});
const mockReport = JSON.stringify({ summary: 'mock summary', themes: [], insights: [], sentiment: 'mock', recommendations: [] });

// Mock provider server
const mockProvider = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
      if (req.url === '/v1/chat/completions') {
      res.writeHead(200);
      let content = mockDecision;
      if (body.includes('生成一份结构化访谈框架')) content = mockFramework;
      else if (body.includes('请决定下一步动作')) {
        if (!body.includes('所有字段必须使用简体中文')) throw new Error('missing language guard');
        if (!body.includes('不要重复已经问过的问题')) throw new Error('missing dedupe guard');
        content = body.includes('当前阶段：confirm') ? mockTransition : mockDecision;
      }
      else if (body.includes('评估下面这段')) {
        if (!body.includes('所有字段必须使用简体中文')) throw new Error('missing evaluation language guard');
        content = mockEvaluate;
      }
      else if (body.includes('结构化研究报告')) {
        if (!body.includes('所有字段必须使用简体中文')) throw new Error('missing report language guard');
        content = mockReport;
      }
      res.end(JSON.stringify({ choices: [{ message: { content } }] }) + 'data: [DONE]');
      return;
    }
    if (req.url === '/v1/messages') {
      res.writeHead(200);
      res.end(JSON.stringify({ content: [{ text: 'mock-anthropic-reply' }] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});

mockProvider.listen(3001, async () => {
  // Start main server
  const main = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3002' }, stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 800));

  const base = 'http://localhost:3002';
  const cfg = { provider: 'openai', baseUrl: 'http://localhost:3001/v1/chat/completions', apiKey: 'fake-key', model: 'mock-model' };
  const design = { goal: 'test goal', targetAudience: 'test audience', scenarios: 'test scenario', persona: 'test persona', methodology: 'JTBD' };

  try {
    // List models
    const modelsRes = await fetch(`${base}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const models = await modelsRes.json();
    if (models.models[0].id !== 'mock-model') throw new Error('models list failed');

    // Generate framework
    const fwRes = await fetch(`${base}/api/interview/framework`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfg, ...design }) });
    const fw = await fwRes.json();
    if (!fw.framework.topics.length) throw new Error('framework generation failed');

    // Start interview with framework
    const startRes = await fetch(`${base}/api/interview/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfg, ...design, framework: fw.framework }) });
    const start = await startRes.json();
    if (start.message !== 'mock-question') throw new Error('start question failed: ' + start.message);
    if (start.action !== 'ask') throw new Error('start action failed');
    if (start.topic_id !== 't1') throw new Error('start topic_id failed');

    // Send message
    const msgRes = await fetch(`${base}/api/interview/${start.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello', apiKey: cfg.apiKey }) });
    const msg = await msgRes.json();
    if (msg.message !== 'mock-question') throw new Error('message reply failed: ' + msg.message);

    // Generate report
    const reportRes = await fetch(`${base}/api/interview/${start.id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: cfg.apiKey }) });
    const report = await reportRes.json();
    if (report.goal !== 'test goal') throw new Error('report goal failed');

    // Evaluate conversation
    const evalRes = await fetch(`${base}/api/interview/${start.id}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: cfg.apiKey }) });
    const evaluation = await evalRes.json();
    if (evaluation.evaluation.overall_comment !== 'mock overall comment') throw new Error('evaluate failed: ' + JSON.stringify(evaluation));

    console.log('All checks passed');
  } catch (e) {
    console.error('Check failed:', e);
    process.exitCode = 1;
  } finally {
    main.kill();
    mockProvider.close();
  }
});
