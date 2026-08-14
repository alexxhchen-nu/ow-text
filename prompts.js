export const PROMPTS = {
  en: {
    designContext: (design) => {
      const { goal, targetAudience, scenarios, persona, methodology } = design;
      let ctx = `Research goal: "${goal}"\n`;
      if (targetAudience) ctx += `Target audience: ${targetAudience}\n`;
      if (scenarios) ctx += `Research scenarios: ${scenarios}\n`;
      if (persona) ctx += `Respondent persona / context: ${persona}\n`;
      if (methodology && methodology !== 'general') ctx += `Methodology: ${methodology}\n`;
      return ctx;
    },
    framework: (ctx) =>
      `You are a senior user research designer. Based on the research design below, generate a structured interview framework.\n\n` +
      `${ctx}\n\n` +
      `Requirements:\n` +
      `- Split the interview into 4-8 topics, each with a clear goal.\n` +
      `- Each topic contains: id, name (topic name), goal (exploration goal), stage (suggested stage: introduce/explore/probe/confirm), min_questions (minimum questions), max_questions (maximum questions), focus_prompt (focus when asking).\n` +
      `- Provide 3-5 natural ending criteria.\n` +
      `- Output must be JSON with the following shape:\n` +
      `{\n  "topics": [{\n    "id": "t1",\n    "name": "string",\n    "goal": "string",\n    "stage": "introduce",\n    "min_questions": 2,\n    "max_questions": 5,\n    "focus_prompt": "string"\n  }],\n  "endingCriteria": ["string"],\n  "estimatedTurns": 12\n}\n\n` +
      `All output must be in English; do not include other languages.`,
    frameworkSystem: 'You are a senior user research designer, skilled at breaking research goals into executable, trackable interview topics. All output must be in English; do not include other languages.',
    defaultTopics: (design) => [
      { id: 't1', name: 'Introduction and background', goal: 'Build trust and understand the respondent\'s basic situation', stage: 'introduce', min_questions: 2, max_questions: 3, focus_prompt: 'Make the respondent comfortable and collect basic background' },
      { id: 't2', name: 'Core exploration', goal: `Deeply understand the research goal: ${design.goal}`, stage: 'explore', min_questions: 3, max_questions: 6, focus_prompt: 'Collect facts, behaviors, and pain points around the research goal' },
      { id: 't3', name: 'Deep probing', goal: 'Dig into motivations, feelings, and concrete examples', stage: 'probe', min_questions: 2, max_questions: 4, focus_prompt: 'Probe why, emotions, and specific scenarios' },
      { id: 't4', name: 'Wrap-up and confirmation', goal: 'Summarize key information and thank the respondent', stage: 'confirm', min_questions: 1, max_questions: 2, focus_prompt: 'Confirm understanding and give the respondent a chance to add anything' },
    ],
    defaultEndingCriteria: [
      'All topics have been sufficiently explored and the respondent is not providing new information',
      'The respondent clearly indicates they want to end or have nothing more to add',
      'The moderator has confirmed twice and the respondent has no further additions',
      'Estimated turns reached and each topic has met its minimum questions',
    ],
    transcript: { user: 'Respondent', assistant: 'Moderator' },
    interview: (session, ctx, fw, state, currentTopic, nextTopicId, history, askedQuestions, userText) =>
      `You are an experienced qualitative research interviewer. The interview follows a preset framework; decide the next action based on the conversation state.\n\n` +
      `Interview framework:\n${JSON.stringify(fw, null, 2)}\n\n` +
      `Current state:\n` +
      `- Current topic: ${currentTopic.name} (id: ${currentTopic.id})\n` +
      `- Topic goal: ${currentTopic.goal}\n` +
      `- Current stage: ${state.topicStage}\n` +
      `- Topic turns completed: ${state.topicTurns} (recommended min ${currentTopic.min_questions}, max ${currentTopic.max_questions})\n` +
      `- Total turns: ${state.totalTurns} (estimated ${fw.estimatedTurns || 12})\n` +
      `- Next topic: ${nextTopicId ? getTopicName(fw, nextTopicId) : 'None'}\n` +
      `- Natural ending criteria: ${fw.endingCriteria?.join(' | ') || 'All topics explored'}\n\n` +
      `Conversation history:\n${history}\n\n` +
      `Questions already asked (do not repeat the same intent):\n${askedQuestions || 'None yet'}\n\n` +
      `${userText ? `Respondent just said: "${userText}"\n\n` : ''}` +
      `Decide the next action and generate the next question. Return JSON:\n` +
      `{\n  "action": "ask | probe | transition | end",\n  "question": "The next concise question to ask the respondent. If action=end, use a closing thank-you line.",\n  "reason": "Why this action and question were chosen, based on the topic, stage, and respondent's answer",\n  "next_topic_id": "If action=transition, fill in the next topic id; otherwise omit or leave empty",\n  "next_stage": "If action=transition, fill in the next topic's stage (introduce/explore/probe/confirm); otherwise omit or leave empty"\n}\n\n` +
      `Action notes:\n` +
      `- ask: continue in the current topic/stage with a new question.\n` +
      `- probe: ask a deeper follow-up about what the respondent just said (motivation, example, feeling, reason).\n` +
      `- transition: the current topic has been explored enough; the question field must directly ask the first specific question of the next topic, not just "let's continue".\n` +
      `- end: all topics have been explored, the respondent clearly wants to end, or there has been no new information twice.\n\n` +
      `Rules:\n` +
      `- All fields must be in English; do not include Vietnamese, Chinese, or other languages.\n` +
      `- Ask only one question at a time.\n` +
      `- Only probe when something is genuinely unclear.\n` +
      `- Ask fewer questions, summarize more. Don't probe for the sake of probing.\n` +
      `- Do not repeat already asked questions; if the same intent exists in history, choose a more specific new angle.\n` +
      `- If information is sufficient, transition directly to the next topic.\n` +
      `- If the respondent says "none", "that's it", "end", "I don't know", prefer end (if the topic is sufficient) or transition (if topics remain).\n` +
      `- If the respondent gives new information worth digging into, prefer probe.\n` +
      `- If the respondent asks you a question, answer/clarify it first, then ask a new, different-intent follow-up; do not just repeat the previous question.\n` +
      `- If the respondent's answer is vague, abstract, or ambiguous, first help clarify in natural language: restate your understanding + ask a more specific clarification question; do not repeat the question verbatim.\n` +
      `- If the answer is clear, specific, and includes examples, move forward; do not repeat confirmation.\n` +
      `- If the current topic has met min_questions and the respondent has no new information, prefer transition.\n` +
      `- If all topics are complete, you must choose end.`,
    interviewSystem: 'You are a senior qualitative research interviewer, skilled at managing interview pacing, clarifying respondent questions before moving forward, naturally transitioning topics, and ending at the right time. All output must be in English; do not include other languages. Do not repeat already asked questions; even within the same topic, choose a fresh angle.',
    fallbackEnd: 'The interview has ended. Thank you for your time.',
    transitionFallback: (topic) => `Let's move to "${topic.name}". ${topic.focus_prompt}`,
    repeatFallback: (focus) => `From a different angle: ${focus}`,
    report: (session, ctx, fw) =>
      `Analyze the following interview transcript and output a structured research report.\n\n` +
      `${ctx}\n` +
      `Interview framework:\n${fw.topics.map(t => `- ${t.name}: ${t.goal}`).join('\n')}\n\n` +
      `Interview transcript:\n${transcriptText(session, 'en')}\n\n` +
      `Return JSON with this shape. All fields must be in English; do not include other languages:\n` +
      `{\n  "summary": "string",\n  "themes": [{"name": "string", "description": "string", "quotes": ["string"]}],\n  "insights": [{"finding": "string", "evidence": "string"}],\n  "sentiment": "string",\n  "recommendations": ["string"]\n}`,
    reportSystem: 'You are a senior user research expert, skilled at writing concise, evidence-backed research reports. All output must be in English; do not include other languages.',
    evaluate: (session, ctx, fw) =>
      `You are a senior user research expert. Evaluate the quality of the AI-moderated interview below.\n\n` +
      `${ctx}\n` +
      `Interview framework:\n${fw.topics.map(t => `- ${t.name}: ${t.goal}`).join('\n')}\n\n` +
      `Interview transcript:\n${transcriptText(session, 'en')}\n\n` +
      `Evaluation dimensions (1-5, 5 is best):\n` +
      `naturalness: Are the questions natural and human-like?\n` +
      `relevance: Do the questions tightly follow the research goal and current topic?\n` +
      `probing: Are follow-ups based on the respondent's answers effective?\n` +
      `single_question: Is only one question asked at a time?\n` +
      `no_bias: Does the language avoid leading or biased phrasing?\n` +
      `progression: Are topic transitions natural and is the pace well-managed?\n` +
      `ending: Does it end at the right time without excessive probing?\n` +
      `persona_fit: Do questions fit the target audience and respondent persona?\n\n` +
      `Return JSON. All fields must be in English; do not include other languages:\n` +
      `{\n  "scores": {"naturalness": 1, "relevance": 1, "probing": 1, "single_question": 1, "no_bias": 1, "progression": 1, "ending": 1, "persona_fit": 1},\n  "overall_comment": "Overall evaluation",\n  "top_strength": "Biggest strength",\n  "top_weakness": "Biggest improvement point",\n  "bad_cases": [{"turn": 1, "issue": "Problem description"}]\n}`,
    evaluateSystem: 'You are a rigorous interview quality evaluator. Score objectively and specifically. All output must be in English; do not include other languages.',
    stageLabels: { introduce: 'introduce', explore: 'explore', probe: 'probe', confirm: 'confirm' },
  },
  zh: {
    designContext: (design) => {
      const { goal, targetAudience, scenarios, persona, methodology } = design;
      let ctx = `研究目标："${goal}"\n`;
      if (targetAudience) ctx += `目标受众：${targetAudience}\n`;
      if (scenarios) ctx += `研究场景：${scenarios}\n`;
      if (persona) ctx += `受访者画像/上下文：${persona}\n`;
      if (methodology && methodology !== 'general') ctx += `采用方法学：${methodology}\n`;
      return ctx;
    },
    framework: (ctx) =>
      `你是一位资深用户研究设计师。请根据下面的研究设计，生成一份结构化访谈框架。\n\n` +
      `${ctx}\n\n` +
      `要求：\n` +
      `- 把访谈拆成 4-8 个话题（topic），每个话题有清晰的目标。\n` +
      `- 每个话题包含：id、name（话题名称）、goal（探索目标）、stage（建议进入阶段：introduce/explore/probe/confirm）、min_questions（最少问题数）、max_questions（最多问题数）、focus_prompt（提问时的关注焦点）。\n` +
      `- 提供 3-5 条自然结束标准。\n` +
      `- 输出必须是 JSON，格式如下：\n` +
      `{\n  "topics": [{\n    "id": "t1",\n    "name": "string",\n    "goal": "string",\n    "stage": "introduce",\n    "min_questions": 2,\n    "max_questions": 5,\n    "focus_prompt": "string"\n  }],\n  "endingCriteria": ["string"],\n  "estimatedTurns": 12\n}`,
    frameworkSystem: '你是一位资深用户研究设计师，擅长把研究目标拆成可执行、可追踪的访谈话题。所有输出必须使用简体中文；不得夹杂其他语言。',
    defaultTopics: (design) => [
      { id: 't1', name: '开场与背景', goal: '建立信任并了解受访者基本情况', stage: 'introduce', min_questions: 2, max_questions: 3, focus_prompt: '让对方感到轻松，收集基本背景' },
      { id: 't2', name: '核心探索', goal: `深入理解研究目标：${design.goal}`, stage: 'explore', min_questions: 3, max_questions: 6, focus_prompt: '围绕研究目标收集事实、行为和痛点' },
      { id: 't3', name: '深度追问', goal: '挖掘动机、感受和具体例子', stage: 'probe', min_questions: 2, max_questions: 4, focus_prompt: '追问为什么、情绪和具体场景' },
      { id: 't4', name: '收尾确认', goal: '总结关键信息并感谢受访者', stage: 'confirm', min_questions: 1, max_questions: 2, focus_prompt: '确认理解无误，给对方补充机会' },
    ],
    defaultEndingCriteria: [
      '所有话题已充分探索，受访者没有提供新的信息',
      '受访者明确表示结束或没有更多内容',
      '主持人已连续确认两次，受访者没有补充',
      '已达到预估轮数且每个话题满足最小问题数',
    ],
    transcript: { user: '受访者', assistant: '主持人' },
    interview: (session, ctx, fw, state, currentTopic, nextTopicId, history, askedQuestions, userText) =>
      `你是一位经验丰富的定性研究访谈主持人。当前访谈遵循一个预设框架，请根据对话状态决定下一步动作。\n\n` +
      `访谈框架：\n${JSON.stringify(fw, null, 2)}\n\n` +
      `当前状态：\n` +
      `- 当前话题：${currentTopic.name}（id: ${currentTopic.id}）\n` +
      `- 话题目标：${currentTopic.goal}\n` +
      `- 当前阶段：${state.topicStage}\n` +
      `- 本话题已进行轮数：${state.topicTurns}（建议最少 ${currentTopic.min_questions}，最多 ${currentTopic.max_questions}）\n` +
      `- 总轮数：${state.totalTurns}（预估 ${fw.estimatedTurns || 12}）\n` +
      `- 下一话题：${nextTopicId ? getTopicName(fw, nextTopicId) : '无'}\n` +
      `- 自然结束标准：${fw.endingCriteria?.join('；') || '所有话题探索完毕'}\n\n` +
      `对话历史：\n${history}\n\n` +
      `已经问过的问题（禁止重复同一意图）：\n${askedQuestions || '暂无'}\n\n` +
      `${userText ? `受访者刚说：「${userText}」\n\n` : ''}` +
      `请决定下一步动作并生成下一个问题。返回 JSON：\n` +
      `{\n  "action": "ask | probe | transition | end",\n  "question": "要问受访者的下一个简洁问题。如果 action=end，则是感谢收尾语。",\n  "reason": "选择这个动作和问题的理由，结合当前话题、阶段和受访者回答",\n  "next_topic_id": "如果 action=transition，填写下一话题 id；否则省略或为空",\n  "next_stage": "如果 action=transition，填写下一话题进入阶段（introduce/explore/probe/confirm）；否则省略或为空"\n}\n\n` +
      `动作说明：\n` +
      `- ask：继续在当前话题当前阶段提一个新问题。\n` +
      `- probe：对受访者刚说的内容做一次深入追问（动机、例子、感受、原因）。\n` +
      `- transition：当前话题已探索足够，转移到下一话题；question 字段必须直接提出下一话题的第一个具体问题，不能只说“继续往下聊”。\n` +
      `- end：所有话题已探索完毕，或受访者明确想结束，或已连续无新信息。\n\n` +
      `规则：\n` +
      `- 所有字段必须使用简体中文，不得出现越南语、英语或其他语言。\n` +
      `- 一次只问一个问题。\n` +
      `- 只在非常不清楚时才追问。能推进就推进，别卡在一个问题上。\n` +
      `- 尽量少问，多提炼。不要为了追问而追问。\n` +
      `- 不要重复已经问过的问题；如果历史里已有相同意图，换一个更具体的新角度。\n` +
      `- 如果信息足够，就直接 transition 到下一个话题。\n` +
      `- 如果受访者说「没了」「就这样」「结束」「不知道了」，优先选择 end（如果话题已够）或 transition（如果还有话题）。\n` +
      `- 如果受访者给出了值得深挖的新信息，优先选择 probe。\n` +
      `- 如果受访者向你提问，必须先回答/解释/澄清这个问题，再提出一个新的、不同意图的后续问题；禁止只重复上一题。\n` +
      `- 如果受访者的回答含糊、抽象或可能有歧义，先用自然语言帮助对方澄清（clarify）：复述你理解到的点 + 问一个更具体的澄清问题；不要原样重问。\n` +
      `- 如果受访者的回答已经清楚、具体、有例子，就继续推进，不要重复确认。\n` +
      `- 如果当前话题已满足 min_questions 且受访者没有新信息，优先 transition。\n` +
      `- 如果所有话题都完成，必须选择 end。`,
    interviewSystem: '你是一位资深定性研究访谈主持人，擅长动态把握访谈节奏、先澄清受访者问题再推进、自然过渡话题、并在合适时机结束访谈。所有输出必须使用简体中文；不得夹杂越南语、英语或其他语言。禁止重复已问过的问题；同一话题内也必须换新角度。',
    fallbackEnd: '访谈已经结束，谢谢你的时间。',
    transitionFallback: (topic) => `我们进入「${topic.name}」。${topic.focus_prompt}`,
    repeatFallback: (focus) => `换一个角度说，${focus}`,
    report: (session, ctx, fw) =>
      `分析以下访谈记录，输出一份结构化研究报告。\n\n` +
      `${ctx}\n` +
      `访谈框架：\n${fw.topics.map(t => `- ${t.name}：${t.goal}`).join('\n')}\n\n` +
      `访谈记录：\n${transcriptText(session, 'zh')}\n\n` +
      `返回 JSON，格式如下。所有字段必须使用简体中文，不得出现越南语、英语或其他语言：\n` +
      `{\n  "summary": "string",\n  "themes": [{"name": "string", "description": "string", "quotes": ["string"]}],\n  "insights": [{"finding": "string", "evidence": "string"}],\n  "sentiment": "string",\n  "recommendations": ["string"]\n}`,
    reportSystem: '你是一位资深用户研究专家，擅长撰写简洁、有证据支撑的研究报告。所有输出必须使用简体中文；不得夹杂越南语、英语或其他语言。',
    evaluate: (session, ctx, fw) =>
      `你是一位资深用户研究专家。请评估下面这段 AI 主持的访谈质量。\n\n` +
      `${ctx}\n` +
      `访谈框架：\n${fw.topics.map(t => `- ${t.name}：${t.goal}`).join('\n')}\n\n` +
      `访谈记录：\n${transcriptText(session, 'zh')}\n\n` +
      `评估维度（1-5 分，5 分最好）：\n` +
      `naturalness（自然度）: 问题是否像真人对话，不生硬。\n` +
      `relevance（相关性）: 问题是否紧扣研究目标和当前话题。\n` +
      `probing（追问质量）: 是否基于受访者回答做了有效追问。\n` +
      `single_question（单一问题）: 是否一次只问一个问题。\n` +
      `no_bias（无偏见）: 是否避免引导性或偏见性语言。\n` +
      `progression（节奏推进）: 话题过渡是否自然，是否按框架有序推进。\n` +
      `ending（自然结束）: 是否在合适时机主动结束，没有反复追问。\n` +
      `persona_fit（画像契合）: 问题是否符合目标受众与受访者画像。\n\n` +
      `返回 JSON。所有字段必须使用简体中文；不得夹杂越南语、英语或其他语言：\n` +
      `{\n  "scores": {"naturalness": 1, "relevance": 1, "probing": 1, "single_question": 1, "no_bias": 1, "progression": 1, "ending": 1, "persona_fit": 1},\n  "overall_comment": "总体评价",\n  "top_strength": "最大优点",\n  "top_weakness": "最大改进点",\n  "bad_cases": [{"turn": 1, "issue": "问题"}]\n}`,
    evaluateSystem: '你是一位严格的访谈质量评估专家，评分客观、具体。所有输出必须使用简体中文；不得夹杂越南语、英语或其他语言。',
    stageLabels: { introduce: 'introduce', explore: 'explore', probe: 'probe', confirm: 'confirm' },
  },
};

function getTopicName(framework, topicId) {
  return framework.topics.find(t => t.id === topicId)?.name || topicId;
}

function transcriptText(session, lang) {
  const labels = PROMPTS[lang].transcript;
  return session.messages.map(m => `${m.role === 'user' ? labels.user : labels.assistant}：${m.text}`).join('\n\n');
}

export { transcriptText, getTopicName };
