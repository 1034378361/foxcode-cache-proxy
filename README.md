# Foxcode Unified Cache Proxy

统一代理，为 Foxcode API 请求优化缓存命中率。

## 功能

- ✅ **Claude 渠道** - 注入 `metadata.user_id` 启用 Prompt 缓存
- ✅ **Codex 渠道** - 移除动态时间戳 + 注入 `prompt_cache_key` 稳定前缀缓存
- ✅ **Gemini 渠道** - 移除动态时间戳 + v1beta 路径转换
- ✅ 多渠道路由支持
- ✅ 网络异常自动重试
- ✅ 健康检查端点
- ✅ 流式响应支持
- ✅ Systemd 服务配置

## 背景

### Claude 缓存
Foxcode 需要在请求中包含 `metadata.user_id` 字段才能启用 Prompt 缓存。

### Codex 缓存
OpenAI Codex API 使用自动前缀缓存，但 `@mariozechner/pi-coding-agent` 的 `buildSystemPrompt()` 每次请求都注入动态时间戳（`Current date and time: ...`），导致前缀永远不匹配。本代理移除该时间戳以稳定缓存。

### Gemini 缓存
Gemini 2.5+ 支持隐式缓存，同样需要移除动态时间戳。

> ⚠️ **注意：foxcode 中转站的 Gemini 渠道不支持隐式缓存，暂时不可用。其他中转站请自行测试。**

## 安装

```bash
git clone https://github.com/1034378361/foxcode-cache-proxy.git
cd foxcode-cache-proxy
```

## 使用

### 直接运行

```bash
node proxy.js
```

### 多渠道路由

| 渠道类型 | 路径前缀 | 处理方式 |
|----------|----------|----------|
| Claude | `/droid`, `/aws`, `/super`, `/ultra` | 注入 `metadata.user_id` |
| Codex | `/codex` | 移除时间戳 + 注入 `prompt_cache_key` |
| Gemini | `/gemini` | 移除时间戳 + 添加 `/v1beta` 前缀 |

### 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | 18800 | 代理监听端口 |
| `TARGET_HOST` | code.newcli.com | Foxcode API 地址 |
| `USER_ID` | openclaw-user | Claude 缓存用户标识 |
| `RETRY_MAX` | 3 | 最大重试次数 |
| `RETRY_DELAY` | 1000 | 初始重试延迟(ms) |
| `TIMEOUT_MS` | 180000 | 请求超时时间(ms) |

### Systemd 服务（推荐）

```bash
# 复制服务文件
cp foxcode-proxy.service ~/.config/systemd/user/

# 启用并启动
systemctl --user daemon-reload
systemctl --user enable foxcode-proxy
systemctl --user start foxcode-proxy

# 查看状态
systemctl --user status foxcode-proxy
journalctl --user -u foxcode-proxy -f
```

## 配置示例

### OpenClaw

修改 `~/.openclaw/openclaw.json`：

```json
{
  "models": {
    "providers": {
      "foxcode-droid": {
        "baseUrl": "http://127.0.0.1:18800/droid",
        "apiKey": "your-api-key",
        "api": "anthropic-messages"
      },
      "foxcode-codex": {
        "baseUrl": "http://127.0.0.1:18800/codex",
        "apiKey": "your-api-key",
        "api": "openai-responses"
      }
    }
  }
}
```

## 健康检查

```bash
curl http://127.0.0.1:18800/health
# {"status":"ok","codexSessions":0,"timestamp":1234567890}
```

## 缓存效果

### Codex 缓存命中示例
```
🟢 [CACHE] Removed timestamp from instructions (16124 -> 16055)
🟢 [CACHE] Timestamp removed for stable caching
```

### Claude 缓存命中
通过 `metadata.user_id` 启用，缓存信息在 API 响应的 `usage` 字段中。

## License

MIT
