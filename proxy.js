/**
 * Foxcode Unified Cache Proxy
 * 
 * 统一代理，支持：
 * - Claude API: 注入 metadata.user_id
 * - Codex API: 注入 prompt_cache_key
 * 
 * @author 琦琦 & 三胖
 */

import { createServer } from 'http';
import { randomUUID } from 'crypto';

// ============ 配置 ============
const CONFIG = {
  port: parseInt(process.env.PROXY_PORT || '18800'),
  targetHost: process.env.TARGET_HOST || 'code.newcli.com',
  userId: process.env.USER_ID || 'openclaw-user',
  
  // Claude 渠道
  claudeChannels: ['droid', 'aws', 'super', 'ultra', 'foxcode-droid'],
  defaultClaudeChannel: 'droid',
  
  // Codex 渠道
  codexChannels: ['codex'],
  
  // Gemini 渠道
  geminiChannels: ['gemini'],
  
  // Antigravity 渠道 (转发到本地 antigravity-manager)
  antigravityChannels: ['antigravity-claude'],
  antigravityTarget: 'http://192.168.3.111:8045',
  
  // 重试配置
  retry: {
    maxAttempts: parseInt(process.env.RETRY_MAX || '3'),
    initialDelayMs: parseInt(process.env.RETRY_DELAY || '1000'),
    maxDelayMs: parseInt(process.env.RETRY_MAX_DELAY || '10000'),
  },
  
  timeoutMs: parseInt(process.env.TIMEOUT_MS || '180000'),
};

// ============ 日志 ============
const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] ✅ ${msg}`),
  claude: (msg) => console.log(`[${new Date().toISOString()}] 🟣 ${msg}`),
  codex: (msg) => console.log(`[${new Date().toISOString()}] 🟢 ${msg}`),
  gemini: (msg) => console.log(`[${new Date().toISOString()}] 🔵 ${msg}`),
  antigravity: (msg) => console.log(`[${new Date().toISOString()}] 🟠 ${msg}`),
};

// ============ 会话缓存 Key 管理 ============
const sessionCacheKeys = new Map();

function getCacheKey(sessionId) {
  if (!sessionCacheKeys.has(sessionId)) {
    const key = `openclaw-${sessionId}-${randomUUID().slice(0, 8)}`;
    sessionCacheKeys.set(sessionId, key);
  }
  return sessionCacheKeys.get(sessionId);
}

// ============ 工具函数 ============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 移除系统提示中的时间戳行
 * 匹配格式: "Current date and time: Monday, February 2, 2026 at 12:13:18 PM GMT+8"
 */
function removeTimestamp(text) {
  if (!text || typeof text !== 'string') return text;
  // 匹配 "Current date and time: ..." 整行（包括换行符）
  return text.replace(/\n?Current date and time:[^\n]*/g, '');
}

function getRetryDelay(attempt) {
  const delay = CONFIG.retry.initialDelayMs * Math.pow(2, attempt);
  return Math.min(delay, CONFIG.retry.maxDelayMs);
}

function isRetryableError(error) {
  const codes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
  return codes.includes(error.code) || error.message?.includes('fetch failed');
}

// 解析请求类型
function parseRequestType(url) {
  const match = url.match(/^\/([^\/]+)/);
  if (!match) return { type: 'unknown', channel: null };
  
  const channel = match[1];
  
  if (CONFIG.claudeChannels.includes(channel)) {
    return { type: 'claude', channel };
  }
  if (CONFIG.codexChannels.includes(channel)) {
    return { type: 'codex', channel };
  }
  if (CONFIG.geminiChannels.includes(channel)) {
    return { type: 'gemini', channel };
  }
  if (CONFIG.antigravityChannels.includes(channel)) {
    return { type: 'antigravity', channel };
  }
  
  return { type: 'unknown', channel };
}

// ============ 主请求处理 ============
async function handleRequest(req, res) {
  // 健康检查
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok',
      codexSessions: sessionCacheKeys.size,
      timestamp: Date.now() 
    }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const { type, channel } = parseRequestType(req.url);

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const data = JSON.parse(body);

    if (type === 'claude') {
      await handleClaudeRequest(data, req, res, channel);
    } else if (type === 'codex') {
      await handleCodexRequest(data, req, res);
    } else if (type === 'gemini') {
      await handleGeminiRequest(data, req, res);
    } else if (type === 'antigravity') {
      await handleAntigravityRequest(data, req, res, channel);
    } else {
      // 未知类型，直接转发
      await forwardRaw(body, req, res);
    }
  } catch (err) {
    log.error(`Request failed: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

// ============ Claude 请求处理 ============
async function handleClaudeRequest(data, req, res, channel) {
  // 注入 metadata.user_id
  data.metadata = { ...data.metadata, user_id: CONFIG.userId };
  
  const targetUrl = `https://${CONFIG.targetHost}/claude/${channel}/v1/messages`;
  log.claude(`[${channel}] model=${data.model}, messages=${data.messages?.length || 0}`);
  
  await forwardWithRetry(data, req.headers, res, targetUrl, 'claude');
}

// ============ Antigravity 请求处理 ============
async function handleAntigravityRequest(data, req, res, channel) {
  // 注入 metadata.user_id（可能不支持，但加上无害）
  data.metadata = { ...data.metadata, user_id: CONFIG.userId };
  
  // 转发到 antigravity-manager，添加 /v1/messages 后缀
  const targetUrl = `${CONFIG.antigravityTarget}/v1/messages`;
  log.antigravity(`[${channel}] model=${data.model}, messages=${data.messages?.length || 0}`);
  
  // 使用专门的转发函数来捕获响应
  await forwardAntigravity(data, req.headers, res, targetUrl);
}

// ============ Gemini 请求处理 ============
async function handleGeminiRequest(data, req, res) {
  // ===== 移除时间戳以稳定缓存 =====
  let timestampRemoved = false;
  
  // Gemini 格式：systemInstruction.parts[0].text
  if (data.systemInstruction?.parts?.[0]?.text) {
    const before = data.systemInstruction.parts[0].text.length;
    data.systemInstruction.parts[0].text = removeTimestamp(data.systemInstruction.parts[0].text);
    if (data.systemInstruction.parts[0].text.length !== before) {
      timestampRemoved = true;
      log.gemini(`[CACHE] Removed timestamp from systemInstruction (${before} -> ${data.systemInstruction.parts[0].text.length})`);
    }
  }
  
  if (timestampRemoved) {
    log.gemini(`[CACHE] Timestamp removed for stable caching`);
  }
  // ===== 时间戳移除完成 =====
  
  // 保存请求用于分析（调试完成后可注释）
  // saveGeminiDump(data);
  
  // 转发到 Gemini 端点（硬编码 v1beta 前缀）
  // 原始路径: /gemini/models/xxx → 转发到: /gemini/v1beta/models/xxx
  const geminiPath = req.url.replace(/^\/gemini/, '/gemini/v1beta');
  const targetUrl = `https://${CONFIG.targetHost}${geminiPath}`;
  log.gemini(`contents=${data.contents?.length || 0}, timestampRemoved=${timestampRemoved}, path=${geminiPath}`);
  
  await forwardDirect(data, req.headers, res, targetUrl, log.gemini);
}

function saveGeminiDump(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `gemini-${timestamp}.json`;
  const filepath = join(DUMP_DIR, filename);
  
  const dump = {
    timestamp: new Date().toISOString(),
    model: data.model,
    messages_count: data.messages?.length || 0,
    // 保存完整请求结构
    full_request: data,
  };
  
  writeFileSync(filepath, JSON.stringify(dump, null, 2));
  log.gemini(`[DUMP] Saved to ${filename}`);
}

// ============ Antigravity 请求/响应保存 ============
function saveAntigravityDump(requestData, responseData = null, error = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `antigravity-${timestamp}.json`;
  const filepath = join(DUMP_DIR, filename);
  
  // 提取系统提示
  let systemPrompt = '';
  if (requestData.system) {
    systemPrompt = typeof requestData.system === 'string' 
      ? requestData.system 
      : JSON.stringify(requestData.system);
  }
  
  const dump = {
    timestamp: new Date().toISOString(),
    model: requestData.model,
    // 请求信息
    request: {
      messages_count: requestData.messages?.length || 0,
      system_prompt_length: systemPrompt.length,
      system_prompt: systemPrompt,
      messages: requestData.messages,
      max_tokens: requestData.max_tokens,
      temperature: requestData.temperature,
      stream: requestData.stream,
      metadata: requestData.metadata,
      // 完整请求（备用）
      full_request: requestData,
    },
    // 响应信息
    response: responseData ? {
      status: responseData.status,
      content_length: responseData.content?.length || 0,
      // 完整响应
      full_response: responseData.content,
      // 解析后的响应（如果是 JSON）
      parsed: responseData.parsed,
    } : null,
    // 错误信息
    error: error ? {
      message: error.message,
      stack: error.stack,
    } : null,
  };
  
  writeFileSync(filepath, JSON.stringify(dump, null, 2));
  log.antigravity(`[DUMP] Saved to ${filename}`);
  return filepath;
}

// ============ 请求保存 ============
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const DUMP_DIR = '/home/zyq/clawd/foxcode-proxy/dumps';
if (!existsSync(DUMP_DIR)) mkdirSync(DUMP_DIR, { recursive: true });

function saveRequestDump(data, sessionId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `codex-${timestamp}.json`;
  const filepath = join(DUMP_DIR, filename);
  
  // 提取系统提示（可能在 instructions 或 input[0]）
  let systemPrompt = data.instructions || '';
  if (!systemPrompt && Array.isArray(data.input)) {
    const systemMsg = data.input.find(m => m.role === 'system');
    if (systemMsg) {
      systemPrompt = typeof systemMsg.content === 'string' 
        ? systemMsg.content 
        : JSON.stringify(systemMsg.content);
    }
  }
  
  const dump = {
    timestamp: new Date().toISOString(),
    sessionId,
    model: data.model,
    prompt_cache_key: data.prompt_cache_key,
    instructions_length: data.instructions?.length || 0,
    input_count: Array.isArray(data.input) ? data.input.length : 0,
    // 保存完整系统提示
    system_prompt: systemPrompt,
    system_prompt_length: systemPrompt.length,
    // 保存 input 结构
    input_structure: Array.isArray(data.input) 
      ? data.input.map(item => ({ 
          role: item.role, 
          content_length: JSON.stringify(item.content || item).length,
          // 保存前500字符预览
          preview: JSON.stringify(item.content || item).slice(0, 500)
        }))
      : null,
  };
  
  writeFileSync(filepath, JSON.stringify(dump, null, 2));
  log.codex(`[DUMP] Saved to ${filename}`);
  return filepath;
}

// ============ Codex 请求处理 ============
async function handleCodexRequest(data, req, res) {
  // 提取会话ID
  const sessionId = req.headers['x-session-key'] 
    || data.metadata?.session_id 
    || data.user 
    || 'default';
  
  // 打印原始请求信息（调试用）
  const originalCacheKey = data.prompt_cache_key;
  log.codex(`[DEBUG] Original prompt_cache_key: ${originalCacheKey || 'none'}`);
  
  // ===== 移除时间戳以稳定缓存 =====
  let timestampRemoved = false;
  
  // 1. 处理 instructions 字段
  if (data.instructions && typeof data.instructions === 'string') {
    const before = data.instructions.length;
    data.instructions = removeTimestamp(data.instructions);
    if (data.instructions.length !== before) {
      timestampRemoved = true;
      log.codex(`[CACHE] Removed timestamp from instructions (${before} -> ${data.instructions.length})`);
    }
  }
  
  // 2. 处理 input 数组中的 system 消息
  if (Array.isArray(data.input)) {
    for (const msg of data.input) {
      if (msg.role === 'system' && typeof msg.content === 'string') {
        const before = msg.content.length;
        msg.content = removeTimestamp(msg.content);
        if (msg.content.length !== before) {
          timestampRemoved = true;
          log.codex(`[CACHE] Removed timestamp from system message (${before} -> ${msg.content.length})`);
        }
      }
    }
  }
  
  if (timestampRemoved) {
    log.codex(`[CACHE] Timestamp removed for stable caching`);
  }
  // ===== 时间戳移除完成 =====
  
  // 保存请求内容（移除时间戳后）- 调试完成，已禁用
  // saveRequestDump(data, sessionId);
  
  // 注入 prompt_cache_key
  if (!data.prompt_cache_key) {
    data.prompt_cache_key = getCacheKey(sessionId);
  }
  
  // 固定转发到 /codex/v1/responses（和 Claude 风格一致）
  const targetUrl = `https://${CONFIG.targetHost}/codex/v1/responses`;
  log.codex(`[${sessionId}] model=${data.model}, cache_key=${data.prompt_cache_key}, injected=${!originalCacheKey}`);
  
  await forwardDirect(data, req.headers, res, targetUrl);
}

// ============ 转发函数 ============
async function forwardWithRetry(data, headers, res, targetUrl, type) {
  let lastError;
  
  for (let attempt = 0; attempt < CONFIG.retry.maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getRetryDelay(attempt - 1);
        log.info(`Retry ${attempt}/${CONFIG.retry.maxAttempts} after ${delay}ms`);
        await sleep(delay);
      }
      
      await forwardClaude(data, headers, res, targetUrl);
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === CONFIG.retry.maxAttempts - 1) throw err;
      log.error(`Attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastError;
}

async function forwardClaude(data, headers, res, targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  
  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': headers.authorization,
        'anthropic-version': headers['anthropic-version'] || '2023-06-01',
        'anthropic-beta': headers['anthropic-beta'] || '',
      },
      body: JSON.stringify(data),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
    });

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
    log.claude(`Response ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardDirect(data, headers, res, targetUrl, logFn = log.codex) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  
  try {
    // 传递所有可能需要的 header
    const forwardHeaders = {
      'Content-Type': 'application/json',
    };
    // 传递 Authorization 或 x-goog-api-key
    if (headers.authorization) forwardHeaders['Authorization'] = headers.authorization;
    if (headers['x-goog-api-key']) forwardHeaders['x-goog-api-key'] = headers['x-goog-api-key'];
    
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(data),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    
    // 捕获错误响应内容
    if (response.status >= 400) {
      const errorBody = await response.text();
      logFn(`Response ${response.status}: ${errorBody.slice(0, 500)}`);
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') || 'application/json',
      });
      res.end(errorBody);
      return;
    }
    
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
    });

    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      res.write(value);
    }
    res.end();
    
    // 尝试解析响应内容，查找缓存信息
    try {
      const fullResponse = Buffer.concat(chunks).toString();
      // SSE 格式：查找 usageMetadata
      const usageMatch = fullResponse.match(/"usageMetadata"\s*:\s*(\{[^}]+\})/);
      if (usageMatch) {
        logFn(`[USAGE] ${usageMatch[1]}`);
      }
      // 查找 cachedContentTokenCount
      const cacheMatch = fullResponse.match(/"cachedContentTokenCount"\s*:\s*(\d+)/);
      if (cacheMatch) {
        logFn(`[CACHE HIT] cachedContentTokenCount: ${cacheMatch[1]}`);
      }
    } catch (e) {
      // 忽略解析错误
    }
    
    logFn(`Response ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ============ Antigravity 专用转发（带请求/响应保存） ============
async function forwardAntigravity(data, headers, res, targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  
  // 调试：打印收到的 headers
  log.antigravity(`[DEBUG] Received headers: ${JSON.stringify(Object.keys(headers))}`);
  log.antigravity(`[DEBUG] x-api-key: ${headers['x-api-key'] ? 'present' : 'missing'}`);
  
  try {
    const forwardHeaders = {
      'Content-Type': 'application/json',
      'anthropic-version': headers['anthropic-version'] || '2023-06-01',
    };
    // OpenClaw 用 x-api-key，转换为 Authorization: Bearer
    if (headers['x-api-key']) {
      forwardHeaders['Authorization'] = `Bearer ${headers['x-api-key']}`;
    } else if (headers.authorization) {
      forwardHeaders['Authorization'] = headers.authorization;
    }
    
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(data),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    
    // 捕获错误响应
    if (response.status >= 400) {
      const errorBody = await response.text();
      log.antigravity(`Response ${response.status}: ${errorBody.slice(0, 500)}`);
      
      // 保存错误响应
      saveAntigravityDump(data, { status: response.status, content: errorBody }, null);
      
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') || 'application/json',
      });
      res.end(errorBody);
      return;
    }
    
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json',
    });

    // 收集完整响应
    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      res.write(value);
    }
    res.end();
    
    // 解析并保存响应
    const fullResponse = Buffer.concat(chunks).toString();
    let parsed = null;
    try {
      // 尝试解析 JSON（非流式）
      parsed = JSON.parse(fullResponse);
    } catch (e) {
      // 可能是 SSE 流式响应，尝试提取最后的完整消息
      const lines = fullResponse.split('\n').filter(l => l.startsWith('data: '));
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        try {
          parsed = JSON.parse(lastLine.replace('data: ', ''));
        } catch (e2) {
          // 保存原始内容
        }
      }
    }
    
    // 保存请求和响应
    saveAntigravityDump(data, { 
      status: response.status, 
      content: fullResponse,
      parsed 
    }, null);
    
    log.antigravity(`Response ${response.status}, saved dump`);
  } catch (err) {
    clearTimeout(timeout);
    // 保存错误
    saveAntigravityDump(data, null, err);
    throw err;
  }
}

async function forwardRaw(body, req, res) {
  const targetUrl = `https://${CONFIG.targetHost}${req.url}`;
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
    body,
  });
  res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') });
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

// ============ 启动 ============
log.info('Foxcode Unified Cache Proxy starting...');
log.info(`Port: ${CONFIG.port}`);
log.info(`Target: https://${CONFIG.targetHost}`);
log.info(`Claude channels: ${CONFIG.claudeChannels.join(', ')}`);
log.info(`Codex channels: ${CONFIG.codexChannels.join(', ')}`);
log.info(`Gemini channels: ${CONFIG.geminiChannels.join(', ')}`);
log.info(`Antigravity channels: ${CONFIG.antigravityChannels.join(', ')} -> ${CONFIG.antigravityTarget}`);

const server = createServer(handleRequest);
server.on('error', (err) => { log.error(`Server error: ${err.message}`); process.exit(1); });
server.listen(CONFIG.port, '127.0.0.1', () => {
  log.success(`Proxy ready at http://127.0.0.1:${CONFIG.port}`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
