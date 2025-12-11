# Claude Code Vercel Proxy

一个 Cloudflare Worker 代理，让 Claude Code 能够使用 Vercel AI Gateway（每月 $5 免费额度）。

## 功能特性

- ✅ **完整的 Anthropic API 兼容** - 与 Claude Code 无缝配合
- ✅ **Extended Thinking** - 完整支持 Claude 的思考模式
- ✅ **图像输入** - 支持 base64 图像
- ✅ **工具调用** - 完整的 tool use 支持
- ✅ **流式输出** - 实时 SSE 流式响应
- ✅ **PDF 文档** - 文档输入支持
- ✅ **System Prompt** - 完整的系统提示支持
- ✅ **免费部署** - Cloudflare Workers 免费套餐

## 架构

```
Claude Code CLI          CF Worker                 Vercel AI Gateway
(Anthropic API)          (This Proxy)              (AI SDK)
      │                       │                          │
      │  POST /v1/messages    │                          │
      │  {                    │                          │
      │    thinking: {...}    │    Vercel AI SDK         │
      │    tools: [...] ────────► providerOptions ─────────► Claude
      │    messages: [...]    │    generateText()        │
      │  }                    │    streamText()          │
      │                       │                          │
      │ ◀─────────────────────│◀─────────────────────────│
      │  Anthropic SSE format │    Convert response      │
```

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/ban-shao/claude-code-vercel-proxy.git
cd claude-code-vercel-proxy
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置 Vercel AI Gateway API Key

```bash
# 设置为 Cloudflare secret
npx wrangler secret put VERCEL_AI_GATEWAY_KEY
# 根据提示输入你的 vck_xxx key
```

### 4. 部署到 Cloudflare Workers

```bash
npm run deploy
```

### 5. 配置 Claude Code

```bash
# 设置环境变量
export ANTHROPIC_BASE_URL="https://claude-code-vercel-proxy.<your-account>.workers.dev"
export ANTHROPIC_API_KEY="dummy"  # 代理不验证此值

# 启动 Claude Code
claude
```

## 配置说明

### Cloudflare Workers 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `VERCEL_AI_GATEWAY_KEY` | 你的 Vercel AI Gateway API key (vck_xxx) | 是 |

### Claude Code 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_BASE_URL` | 你部署的 worker URL |
| `ANTHROPIC_API_KEY` | 任意值（不会被验证） |

## 本地开发

```bash
# 启动本地开发服务器
npm run dev

# 代理将在 http://localhost:8787 运行
```

## API 兼容性

### 支持的端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/messages` | POST | 主聊天完成端点 |

### 功能支持

| 功能 | Anthropic 格式 | 状态 |
|------|---------------|------|
| 基础对话 | `messages` | ✅ 完整 |
| 流式输出 | `stream: true` | ✅ 完整 |
| Extended Thinking | `thinking.type/budget_tokens` | ✅ 完整 |
| 图像输入 | `image` content blocks | ✅ 完整 |
| 工具调用 | `tools` + `tool_choice` | ✅ 完整 |
| 工具结果 | `tool_result` content blocks | ✅ 完整 |
| System Prompt | `system` | ✅ 完整 |
| PDF 文档 | `document` content blocks | ✅ 基础 |
| 缓存控制 | `cache_control` | ⚠️ 部分 |

## 工作原理

1. **接收** Claude Code 发送的 Anthropic 格式请求
2. **转换** 请求为 Vercel AI SDK 格式
3. **调用** Vercel AI Gateway，使用正确的 `providerOptions`
4. **转换** 响应回 Anthropic SSE 格式
5. **返回** 响应给 Claude Code

### 关键转换：Extended Thinking

```typescript
// Claude Code 发送的格式 (Anthropic)
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}

// 转换为 Vercel AI SDK 格式
{
  providerOptions: {
    anthropic: {
      thinking: {
        type: 'enabled',
        budgetTokens: 10000
      }
    }
  }
}
```

## 故障排除

### "thinking requires a budget" 错误

确保使用正确的 thinking 格式：
```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

### 连接被拒绝

1. 检查 worker 是否已部署：`npm run deploy`
2. 验证 `ANTHROPIC_BASE_URL` 设置正确
3. 在 Cloudflare Workers 控制台检查错误

### API key 错误

1. 验证你的 Vercel AI Gateway key 是否有效
2. 重新运行 `npx wrangler secret put VERCEL_AI_GATEWAY_KEY`

## 费用

- **Cloudflare Workers**: 免费套餐（每天 100,000 请求）
- **Vercel AI Gateway**: 每月 $5 免费额度

## 许可证

MIT

## 贡献

欢迎 Pull Request！请随时提交 issue 和功能请求。
