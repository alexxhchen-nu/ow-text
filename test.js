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

const mockEvaluate = JSON.stringify({
  scores: { naturalness: 4, relevance: 4, probing: 3, single_question: 5, no_bias: 4, progression: 4, ending: 4, persona_fit: 4 },
  overall_comment: 'mock overall comment',
  top_strength: 'mock strength',
  top_weakness: 'mock weakness',
  bad_cases: []
});
const mockReport = JSON.stringify({ summary: 'mock summary', themes: [], insights: [], sentiment: 'mock', recommendations: [] });

function pickQuestion(stage, asked) {
  const questions = {
    introduce: [
      '你平时主要用什么工具？',
      '能简单介绍一下你的工作背景吗？',
      '你在这个领域工作多久了？',
      '你的一天通常从哪类任务开始？',
      '你最常协作的角色是哪些？',
      '你目前最关注的业务指标是什么？',
    ],
    explore: [
      '这个场景下你最常遇到什么问题？',
      '这个问题对你影响有多大？',
      '你现在的解决方案是什么？',
      '这类问题平均多久出现一次？',
      '你会向谁反馈这个问题？',
      '解决它之后最理想的结果是什么？',
    ],
    probe: [
      '为什么这一点对你来说很重要？',
      '你能举一个具体的例子吗？',
      '这种感觉是从什么时候开始的？',
      '如果这个问题不解决会怎样？',
      '你之前尝试过哪些方法？',
      '这些尝试里哪个最接近你想要的？',
    ],
    confirm: [
      '所以你的核心诉求是更高效的流程，对吗？',
      '还有什么需要补充的吗？',
      '我理解的关键点是否准确？',
      '如果排优先级，你最想先解决哪一点？',
      '你希望下一步我们怎么配合？',
    ],
  };
  const pool = questions[stage] || ['能再多说一些吗？'];
  // Avoid exact duplicates if possible.
  const fresh = pool.find(q => !asked.includes(q)) || pool[pool.length - 1];
  return fresh;
}

function lastQuestionFromBody(body) {
  const start = body.indexOf('已经问过的问题');
  if (start === -1) return [];
  const block = body.slice(start).split(/\n\n|\r?\n(?:\r?\n)/)[0];
  return block
    .split('\n')
    .slice(1)
    .map(s => s.trim())
    .filter(s => s.endsWith('？') || s.endsWith('?'));
}

function decide(body) {
  const stageMatch = body.match(/当前阶段：(\w+)/);
  const stage = stageMatch ? stageMatch[1] : 'introduce';
  const turnMatch = body.match(/本话题已进行轮数：(\d+)/);
  const topicTurns = turnMatch ? Number(turnMatch[1]) : 0;
  const totalMatch = body.match(/总轮数：(\d+)/);
  const totalTurns = totalMatch ? Number(totalMatch[1]) : 0;
  const userMatch = body.match(/受访者刚说：「([\s\S]*?)」/);
  const userText = userMatch ? userMatch[1] : '';
  const asked = lastQuestionFromBody(body);

  // If user asks a question, assistant should clarify/answer and then continue with a new question.
  const isQuestion = /[?？]|吗|为什么|怎么|是什么/.test(userText);
  if (isQuestion && userText) {
    return {
      action: 'ask',
      question: `你提的“${userText.slice(0, 12)}”是个很好的问题。我的理解是这与你的实际体验有关；接下来，${pickQuestion(stage, asked)}`,
      reason: 'clarify user question first, then continue',
      next_topic_id: null,
      next_stage: stage,
    };
  }

  // Vague answer -> probe/clarify.
  const isVague = /可能|大概|也许|差不多|不太清楚|不知道/.test(userText);
  if (isVague && userText && stage !== 'introduce') {
    return {
      action: 'probe',
      question: `为了避免理解偏差，能否举一个更具体的例子？${pickQuestion(stage, asked)}`,
      reason: 'user answer vague, ask for concrete example',
      next_topic_id: null,
      next_stage: stage,
    };
  }

  // End if confirm stage has enough turns.
  if (stage === 'confirm' && topicTurns >= 1) {
    return {
      action: 'end',
      question: '访谈已经结束，谢谢你的时间。',
      reason: 'all topics explored',
      next_topic_id: null,
      next_stage: null,
    };
  }

  // Transition if current topic has enough turns.
  const minByStage = { introduce: 2, explore: 2, probe: 1, confirm: 1 };
  if (topicTurns >= minByStage[stage]) {
    const nextMap = { introduce: 't2', explore: 't3', probe: 't4', confirm: null };
    const nextTopic = nextMap[stage];
    if (nextTopic) {
      const nextStage = nextTopic === 't2' ? 'explore' : nextTopic === 't3' ? 'probe' : 'confirm';
      return {
        action: 'transition',
        question: pickQuestion(nextStage, asked),
        reason: 'topic explored, move to next topic',
        next_topic_id: nextTopic,
        next_stage: nextStage,
      };
    }
  }

  // Continue asking in current topic.
  return {
    action: 'ask',
    question: pickQuestion(stage, asked),
    reason: 'continue exploring current topic',
    next_topic_id: null,
    next_stage: stage,
  };
}

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
      let content = JSON.stringify(decide(body));
      if (body.includes('生成一份结构化访谈框架')) content = mockFramework;
      else if (body.includes('请决定下一步动作')) {
        if (!body.includes('所有字段必须使用简体中文')) {
          res.writeHead(500); res.end('missing language guard'); return;
        }
        if (!body.includes('不要重复已经问过的问题')) {
          res.writeHead(500); res.end('missing dedupe guard'); return;
        }
        content = JSON.stringify(decide(body));
      } else if (body.includes('评估下面这段')) {
        if (!body.includes('所有字段必须使用简体中文')) {
          res.writeHead(500); res.end('missing evaluation language guard'); return;
        }
        content = mockEvaluate;
      } else if (body.includes('结构化研究报告')) {
        if (!body.includes('所有字段必须使用简体中文')) {
          res.writeHead(500); res.end('missing report language guard'); return;
        }
        content = mockReport;
      }
      res.end(JSON.stringify({ choices: [{ message: { content } }] }) + 'data: [DONE]');
      return;
    }
    if (req.url === '/v1/messages') {
      res.writeHead(200);
      res.end(JSON.stringify({ content: [{ text: JSON.stringify(decide(body)) }] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
});

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

mockProvider.listen(3001, async () => {
  const main = spawn('node', ['server.js'], { env: { ...process.env, PORT: '3002' }, stdio: 'inherit' });
  await new Promise(r => setTimeout(r, 800));

  const base = 'http://localhost:3002';
  const cfg = { protocol: 'openai-compatible', baseUrl: 'http://localhost:3001/v1', apiKey: 'fake-key', model: 'mock-model' };
  const cfgAnthropic = { protocol: 'anthropic-compatible', baseUrl: 'http://localhost:3001/v1', apiKey: 'fake-key', model: 'mock-model' };
  const design = { goal: 'test goal', targetAudience: 'test audience', scenarios: 'test scenario', persona: 'test persona', methodology: 'JTBD' };

  const askedQuestions = [];
  const pushQuestion = (q) => {
    if (q && !askedQuestions.includes(q)) askedQuestions.push(q);
  };

  try {
    // List models
    const models = await post(base, '/api/models', cfg);
    assert(models.models[0].id === 'mock-model', 'models list failed');

    // Generate framework
    const fw = await post(base, '/api/interview/framework', { ...cfg, ...design });
    assert(fw.framework.topics.length === 4, 'framework generation failed');

    // Start interview with anthropic-compatible protocol
    const anthStart = await post(base, '/api/interview/start', { ...cfgAnthropic, ...design, framework: fw.framework });
    assert(anthStart.topic_id === 't1', 'anthropic-compatible start topic_id failed');
    assert(anthStart.action === 'ask', 'anthropic-compatible start action should be ask');

    // Start interview with openai-compatible protocol
    const start = await post(base, '/api/interview/start', { ...cfg, ...design, framework: fw.framework });
    assert(start.topic_id === 't1', 'start topic_id failed');
    assert(start.action === 'ask', 'start action should be ask');
    pushQuestion(start.message);

    // Turn 1: normal answer, stays in introduce
    const m1 = await post(base, `/api/interview/${start.id}/message`, { text: '我是产品经理', apiKey: cfg.apiKey });
    assert(m1.topic_id === 't1', 'should stay in t1');
    assert(m1.action !== 'end', 'should not end yet');
    pushQuestion(m1.message);

    // Turn 2: user asks a question -> assistant should clarify and continue, not repeat
    const m2 = await post(base, `/api/interview/${start.id}/message`, { text: '你为什么问这个？', apiKey: cfg.apiKey });
    assert(m2.action === 'ask' || m2.action === 'probe', 'user question should be answered/clarified');
    assert(!askedQuestions.includes(m2.message), 'question should not repeat previous');
    pushQuestion(m2.message);

    // Turn 3: concrete answer -> transition to explore, question must be specific, not "继续往下聊"
    const m3 = await post(base, `/api/interview/${start.id}/message`, { text: '我们经常加班处理数据，很烦', apiKey: cfg.apiKey });
    assert(m3.action === 'transition', 'should transition from introduce');
    assert(m3.topic_id === 't2', 'should move to t2');
    assert(m3.stage === 'explore', 'next stage should be explore');
    assert(!m3.message.includes('继续往下聊') && !m3.message.includes('往下聊'), 'transition must ask a specific question, not generic filler');
    assert(!askedQuestions.includes(m3.message), 'transition question must not repeat');
    pushQuestion(m3.message);

    // Turn 4: vague answer -> probe/clarify
    const m4 = await post(base, `/api/interview/${start.id}/message`, { text: '可能吧，我也说不太清楚', apiKey: cfg.apiKey });
    assert(m4.topic_id === 't2', 'should stay in t2');
    assert(m4.action === 'probe' || m4.action === 'ask', 'vague answer should be clarified');
    pushQuestion(m4.message);

    // Turn 5: concrete answer -> transition to probe (transition question counts as first explore turn)
    const m5 = await post(base, `/api/interview/${start.id}/message`, { text: '我们团队三个人都受影响', apiKey: cfg.apiKey });
    assert(m5.action === 'transition', 'should transition from explore');
    assert(m5.topic_id === 't3', 'should move to t3');
    pushQuestion(m5.message);

    // Turn 6: answer in probe -> transition to confirm (probe min=1, transition question counts as first probe turn)
    const m6 = await post(base, `/api/interview/${start.id}/message`, { text: '每周浪费五小时', apiKey: cfg.apiKey });
    assert(m6.action === 'transition', 'should transition from probe');
    assert(m6.topic_id === 't4', 'should move to t4');
    pushQuestion(m6.message);

    // Turn 7: confirm -> end (transition question counts as first confirm turn)
    const m7 = await post(base, `/api/interview/${start.id}/message`, { text: '因为不想重复工作', apiKey: cfg.apiKey });
    assert(m7.action === 'end', 'should end after confirm');
    assert(m7.interviewEnded, 'interviewEnded should be true');

    // Turn 8: trying to send after end returns neutral end message
    const m8 = await post(base, `/api/interview/${start.id}/message`, { text: '自动化能减少出错', apiKey: cfg.apiKey });
    assert(m8.interviewEnded, 'after-end should keep ended flag');
    assert(!m8.message.includes('生成报告'), 'end message should not mention report for respondent mode');

    // Turn 9: another after-end message stays ended
    const m9 = await post(base, `/api/interview/${start.id}/message`, { text: '对的，没有了', apiKey: cfg.apiKey });
    assert(m9.interviewEnded, 'after-end should keep ended flag');

    // Generate report
    const report = await post(base, `/api/interview/${start.id}/report`, { apiKey: cfg.apiKey });
    assert(report.goal === 'test goal', 'report goal failed');
    assert(report.report.summary === 'mock summary', 'report summary failed');

    // Evaluate conversation
    const evaluation = await post(base, `/api/interview/${start.id}/evaluate`, { apiKey: cfg.apiKey });
    assert(evaluation.evaluation.overall_comment === 'mock overall comment', 'evaluate failed');

    console.log('All checks passed');
  } catch (e) {
    console.error('Check failed:', e);
    process.exitCode = 1;
  } finally {
    main.kill();
    mockProvider.close();
  }
});
