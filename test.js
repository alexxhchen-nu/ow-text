import http from 'http';
import { spawn } from 'child_process';

const mockQuestion = JSON.stringify({ question: 'mock-question', stage: 'opening', reason: 'mock-reason', probe_target: '' });
const mockEvaluate = JSON.stringify({
  scores: { naturalness: 4, relevance: 4, probing: 3, single_question: 5, no_bias: 4, progression: 4 },
  overall_comment: 'mock overall comment',
  top_strength: 'mock strength',
  top_weakness: 'mock weakness',
  bad_cases: []
});

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
      let content = mockQuestion;
      if (body.includes('评估')) content = mockEvaluate;
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
  const cfg = { provider: 'openai', baseUrl: 'http://localhost:3001/v1', apiKey: 'fake-key', model: 'mock-model' };

  try {
    // List models
    const modelsRes = await fetch(`${base}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const models = await modelsRes.json();
    console.assert(models.models[0].id === 'mock-model', 'models list failed');

    // Start interview
    const startRes = await fetch(`${base}/api/interview/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfg, goal: 'test goal' }) });
    const start = await startRes.json();
    console.assert(start.message === 'mock-question', 'start question failed');
    console.assert(start.stage === 'opening', 'start stage failed');

    // Send message
    const msgRes = await fetch(`${base}/api/interview/${start.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello', apiKey: cfg.apiKey }) });
    const msg = await msgRes.json();
    console.assert(msg.message === 'mock-question', 'message reply failed');

    // Generate report
    const reportRes = await fetch(`${base}/api/interview/${start.id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: cfg.apiKey }) });
    const report = await reportRes.json();
    console.assert(report.goal === 'test goal', 'report goal failed');

    // Evaluate conversation
    const evalRes = await fetch(`${base}/api/interview/${start.id}/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: cfg.apiKey }) });
    const evaluation = await evalRes.json();
    console.assert(evaluation.evaluation.overall_comment === 'mock overall comment', 'evaluate failed');

    console.log('All checks passed');
  } catch (e) {
    console.error('Check failed:', e);
    process.exitCode = 1;
  } finally {
    main.kill();
    mockProvider.close();
  }
});
