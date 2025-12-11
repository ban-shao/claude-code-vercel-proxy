# Claude Code Vercel Proxy

一个运行在 Cloudflare Workers 上的代理服务，将 Anthropic API 请求转发到 Vercel AI Gateway。

## ✨ 特性

- 🔄 **多 Key 负载均衡** - 支持多个 Vercel AI Gateway Key，自动轮询
- 💰 **额度耗尽自动切换** - Key 额度用完自动切换到下一个
- 📅 **每月自动重置** - 每月15日自动重置被禁用的 Key
- 🧠 **Extended Thinking** - 完整支持 Claude 的深度思考功能
- 🛠 **工具调用** - 支持 tool_use 和 tool_result
- 📄 **多模态输入** - 支持图片和 PDF 文档
- 💾 **缓存控制** - 支持 Anthropic 的 cache_control 功能
- 🌊 **流式输出** - 完整的 SSE 流式响应支持

## 🚀 部署指南

### 1. 创建 KV 命名空间

```bash
# 创建 KV 命名空间用于存储 Key 状态
npx wrangler kv:namespace create KEY_STATUS
```

这会输出类似：
```
🌀 Creating namespace with title "claude-code-vercel-proxy-KEY_STATUS"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "KEY_STATUS"
id = "xxxxxxxxxxxxxxxxxxxx"
```

### 2. 更新 wrangler.toml

将上面输出的 `id` 替换到 `wrangler.toml` 中：

```toml
[[kv_namespaces]]
binding = "KEY_STATUS"
id = "你的实际KV命名空间ID"
```

### 3. 配置 API Keys

```bash
# 添加多个 Key（用逗号分隔）
npx wrangler secret put VERCEL_AI_GATEWAY_KEYS
# 输入: key1,key2,key3,key4
```

### 4. 部署

```bash
npm install
npm run deploy
```

## 📖 使用方式

### 基本请求

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Extended Thinking

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 16000,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 10000
    },
    "messages": [{"role": "user", "content": "Solve this complex problem..."}]
  }'
```

### 健康检查（查看 Key 状态）

```bash
curl https://your-worker.workers.dev/health
```

返回：
```json
{
  "status": "ok",
  "message": "Claude Code Vercel Proxy is running",
  "keys": {
    "total": 5,
    "available": 3,
    "disabled": 2
  },
  "nextReset": "2025-02-15T00:00:00.000Z"
}
```

## 🔧 Key 管理机制

### 负载均衡

- 多个 Key 按顺序轮询使用
- 每次请求自动选择下一个可用的 Key

### 额度耗尽检测

当检测到以下错误时，Key 会被自动禁用：
- `quota` / `insufficient` / `exceeded`
- `billing` / `payment required`
- `credit` / `balance`
- `usage limit` / `spending limit`

### 自动重置

- 每月 **15日凌晨 (UTC)** 自动重置所有被禁用的 Key
- 这与 Vercel 免费额度的月度重置周期对应

## 📋 支持的模型

### 🆕 最新模型（推荐）

| 模型 | API Model ID | 说明 |
|------|-------------|------|
| Claude Sonnet 4.5 | `claude-sonnet-4-5-20250929` | 🌟 最智能，适合复杂编码和代理任务 |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | ⚡ 最快速，适合简单任务 |
| Claude Opus 4.5 | `claude-opus-4-5-20251101` | 🧠 最强大旗舰模型 |
| Claude Opus 4.1 | `claude-opus-4-1-20250805` | 专业推理任务 |

### Claude 4 系列

| 模型 | API Model ID |
|------|-------------|
| Claude Opus 4 | `claude-opus-4-20250514` |
| Claude Sonnet 4 | `claude-sonnet-4-20250514` |

### 旧版模型

| 模型 | API Model ID |
|------|-------------|
| Claude 3.7 Sonnet | `claude-3-7-sonnet-20250219` |
| Claude 3.5 Sonnet | `claude-3-5-sonnet-20241022` |
| Claude 3.5 Haiku | `claude-3-5-haiku-20241022` |

> 💡 **提示**：Claude Code 支持模型别名，可在启动时使用 `claude --model sonnet`、`claude --model opus`、`claude --model haiku` 等简写。

## 🖥️ Claude Code 配置

### 方法一：设置环境变量

```bash
# 设置代理地址
export ANTHROPIC_BASE_URL="https://your-worker.workers.dev"

# API Key 可以随意填（代理会用自己的 Key）
export ANTHROPIC_API_KEY="any"

# 启动 Claude Code
claude
```

### 方法二：永久配置

在 `~/.bashrc` 或 `~/.zshrc` 中添加：

```bash
# Claude Code Vercel Proxy 配置
export ANTHROPIC_BASE_URL="https://your-worker.workers.dev"
export ANTHROPIC_API_KEY="any"
```

然后重新加载配置：

```bash
source ~/.bashrc  # 或 source ~/.zshrc
```

### 方法三：启动时指定模型

```bash
# 使用 Sonnet 模型
claude --model sonnet

# 使用 Opus 模型
claude --model opus

# 使用混合模式（规划用 Opus，执行用 Sonnet）
claude --model opusplan
```

## 📄 License

MIT
