import http from 'http';
import { spawn } from 'child_process';

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
      res.end(JSON.stringify({ choices: [{ message: { content: 'mock-question' } }] }));
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

    // Send message
    const msgRes = await fetch(`${base}/api/interview/${start.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello', apiKey: cfg.apiKey }) });
    const msg = await msgRes.json();
    console.assert(msg.message === 'mock-question', 'message reply failed');

    // Generate report
    const reportRes = await fetch(`${base}/api/interview/${start.id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: cfg.apiKey }) });
    const report = await reportRes.json();
    console.assert(report.goal === 'test goal', 'report goal failed');

    console.log('All checks passed');
  } catch (e) {
    console.error('Check failed:', e);
    process.exitCode = 1;
  } finally {
    main.kill();
    mockProvider.close();
  }
});
