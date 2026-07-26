# ow-text

Text version of the OW Chatbot Tool — 一个最小可用的 AI 主持用户访谈平台。

## 功能

1. 在界面配置模型提供商、API Key 和模型。
2. 输入研究目标。
3. AI 逐题访谈并自动追问深挖。
4. 结束访谈后一键生成结构化洞察报告（摘要、主题、原话引用、洞察、情绪、建议）。

## 本地运行

```bash
npm install   # 无需依赖，仅安装空 package.json 也可跳过
node server.js
# 打开 http://localhost:3000
```

然后在页面里选择：
- 提供商：OpenAI / Anthropic / 自定义 OpenAI 兼容端点
- API Key（仅在请求中使用，不保存到服务器）
- 点击“获取模型”列出可用模型并选择
- 输入研究目标，开始访谈

## 支持的提供商

- **OpenAI**：默认 `https://api.openai.com/v1`，使用 `/chat/completions`。
- **Anthropic**：默认 `https://api.anthropic.com/v1`，使用 `/messages`。
- **自定义 OpenAI 兼容端点**：例如 Ollama、OpenRouter、Groq 等，需填写自定义 API 地址。

## API

- `POST /api/models` — body `{ provider, baseUrl?, apiKey }` → 列出可用模型。
- `POST /api/interview/start` — body `{ provider, baseUrl?, apiKey, model, goal }` → 开始访谈并返回首问。
- `POST /api/interview/:id/message` — body `{ text, apiKey }` → 继续访谈。
- `POST /api/interview/:id/report` — body `{ apiKey }` → 生成洞察报告。
- `GET /api/interview/:id` → 获取原始会话。

会话以 JSON 文件保存在 `data/` 目录。

## 后续可扩展

- 云端部署与持久化数据库。
- 受访者招募链接与配额控制。
- 多人协作与评论。
- 语音输入/输出。
