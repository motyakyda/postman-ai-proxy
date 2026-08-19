#!/usr/bin/env node
/**
 * Postman AI → OpenAI API Proxy Server
 * 
 * Проксирует запросы из формата OpenAI /v1/chat/completions
 * в Postman AI Gateway и обратно.
 * 
 * Использование:
 *   POSTMAN_TOKEN=your_token node server.js
 *   # или
 *   node server.js --token=your_token
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

// Конфигурация
const PORT = process.env.PORT || 8787;
const POSTMAN_GATEWAY = 'https://gateway.postman.com/chat';
const DEFAULT_WORKSPACE_ID = process.env.POSTMAN_WORKSPACE_ID || 'your-workspace-id';
// Реальные хэши инструментов/терминов, снятые с Postman 12.23.1 (darwin)
const NATIVE_TOOLS_HASH = process.env.POSTMAN_TOOLS_HASH || 'clienttools-workspace_localmode_v12-desktop-darwin-12.23.1-ui-260811-0231-828d6b3ed37b';
const NATIVE_TERMS_HASH = process.env.POSTMAN_TERMS_HASH || 'kbterms-workspace_localmode_v12-desktop-darwin-12.23.1-ui-260811-0231-dbc2c7575e92';

// Маппинг моделей OpenAI → Postman (enum'ы подтверждены через GET gateway.postman.com/config)
const MODEL_MAP = {
  // GPT-5.6 Sol (дефолт)
  'gpt-5.6-sol': 'GPT_56_SOL',
  'gpt-5.6': 'GPT_56_SOL',
  // GPT-5.6 Terra
  'gpt-5.6-terra': 'GPT_56_TERRA',
  // GPT-5.6 Luna
  'gpt-5.6-luna': 'GPT_56_LUNA',
  // GPT-5.5
  'gpt-5.5': 'GPT_55',
  // GPT-5.4 (defaultModel Postman)
  'gpt-5.4': 'GPT_54',
  'gpt-5': 'GPT_54',
  // Claude Opus 4.8
  'claude-opus-4.8': 'CLAUDE_OPUS_48_BEDROCK',
  'opus-4.8': 'CLAUDE_OPUS_48_BEDROCK',
  // Claude Opus 4.7
  'claude-opus-4.7': 'CLAUDE_OPUS_47_BEDROCK',
  'opus-4.7': 'CLAUDE_OPUS_47_BEDROCK',
  // Claude Opus 4.5
  'claude-opus-4.5': 'CLAUDE_OPUS_45_BEDROCK',
  'opus-4.5': 'CLAUDE_OPUS_45_BEDROCK',
  // Claude Sonnet 4.6
  'claude-sonnet-4.6': 'CLAUDE_46_SONNET_BEDROCK',
  'sonnet-4.6': 'CLAUDE_46_SONNET_BEDROCK',
  // Claude Sonnet 4.5
  'claude-sonnet-4.5': 'CLAUDE_45_SONNET_BEDROCK',
  'sonnet-4.5': 'CLAUDE_45_SONNET_BEDROCK',
  // Claude Haiku 4.5
  'claude-haiku-4.5': 'CLAUDE_45_HAIKU_BEDROCK',
  'haiku-4.5': 'CLAUDE_45_HAIKU_BEDROCK',
  // Прямые Postman-ключи тоже принимаются
  'GPT_56_SOL': 'GPT_56_SOL',
  'GPT_56_TERRA': 'GPT_56_TERRA',
  'GPT_56_LUNA': 'GPT_56_LUNA',
  'GPT_55': 'GPT_55',
  'GPT_54': 'GPT_54',
  'CLAUDE_OPUS_48_BEDROCK': 'CLAUDE_OPUS_48_BEDROCK',
  'CLAUDE_OPUS_47_BEDROCK': 'CLAUDE_OPUS_47_BEDROCK',
  'CLAUDE_OPUS_45_BEDROCK': 'CLAUDE_OPUS_45_BEDROCK',
  'CLAUDE_46_SONNET_BEDROCK': 'CLAUDE_46_SONNET_BEDROCK',
  'CLAUDE_45_SONNET_BEDROCK': 'CLAUDE_45_SONNET_BEDROCK',
  'CLAUDE_45_HAIKU_BEDROCK': 'CLAUDE_45_HAIKU_BEDROCK',
  // По умолчанию
  'default': 'GPT_56_SOL'
};

function getPostmanModel(openaiModel) {
  if (!openaiModel) return MODEL_MAP['default'];
  const normalized = openaiModel.toLowerCase().replace(/\s+/g, '-');
  if (MODEL_MAP[normalized]) return MODEL_MAP[normalized];
  if (MODEL_MAP[openaiModel]) return MODEL_MAP[openaiModel];
  // Passthrough: если передан сырой Postman-ключ (например GPT_56_TERRA или новые модели)
  if (/^[A-Z][A-Z0-9_]{3,40}$/.test(openaiModel)) return openaiModel;
  return MODEL_MAP['default'];
}

function getToken(req) {
  // Приоритет: заголовок Authorization > пул токенов (round-robin) > env > аргументы
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    // sk-ключи не являются Postman-токенами — используем пул
    if (t && !t.startsWith('sk-')) return t;
  }
  const pool = (process.env.POSTMAN_TOKEN || '').split(',').map(t => t.trim()).filter(Boolean);
  if (pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  const idx = tokenCursor++ % pool.length;
  return pool[idx];
}
let tokenCursor = 0;

function convertOpenAIToPostman(openaiBody, workspaceId) {
  const messages = openaiBody.messages || [];
  
  // Формируем query: если сообщений несколько — флаттим историю в один промпт,
  // если одно — отправляем как есть (нативное поведение Postman)
  let query;
  if (messages.length <= 1) {
    const q = messages[0]?.content || '';
    query = typeof q === 'string' ? q : JSON.stringify(q);
  } else {
    query = messages.map(m => {
      const role = m.role || 'user';
      let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (role === 'system') return `[System instructions]: ${content}`;
      if (role === 'assistant') return `[Assistant's previous reply]: ${content}`;
      return `[User]: ${content}`;
    }).join('\n\n');
  }
  
  // Извлекаем conversationId для продолжения диалога (из тела или последнего сообщения)
  const conversationId = openaiBody._postman_conversation_id || openaiBody.conversation_id || null;
  
  return {
    input: {
      chatType: 'USER_QUERY',
      query: query,
      toolResponse: '',
      useCase: null,
      conversationId: conversationId,
      agent: null,
      product: 'workspace_localmode_v12',
      startedFrom: 'CHAT_INPUT'
    },
    platform: 'DESKTOP_MACOS',
    clientTools: {
      nativeToolsHash: NATIVE_TOOLS_HASH,
      excludedTools: ['askUser'],
      thirdParty: {}
    },
    clientKBTerms: {
      nativeTermsHash: NATIVE_TERMS_HASH,
      excludedKBTerms: []
    },
    mandatoryContext: {
      workspaceId: workspaceId
    },
    selectedContext: [],
    backgroundContext: [
      { type: 'ACTIVE_ENVIRONMENT', value: null },
      { type: 'ACTIVE_WORKSPACE', value: { name: 'Proxy Workspace', id: workspaceId } }
    ],
    devModeOptions: {
      selectedModel: getPostmanModel(openaiBody.model),
      isParallelToolCallingSupported: true,
      autoRun: false,
      supportsAskUser: false,
      supportsActionRecommendations: true,
      useThinkingModeIfAvailable: openaiBody.thinking !== false,
      thinkingLevel: 'medium',
      isAgentModeEnabled: true
    }
  };
}

function parsePostmanSSE(chunk) {
  // Парсит SSE строки вида: data: {...}
  const lines = chunk.split('\n');
  const events = [];
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const json = JSON.parse(line.slice(6));
        events.push(json);
      } catch (e) {
        // ignore parse errors
      }
    }
  }
  return events;
}

function makeChunk(responseId, model, delta, finishReason = null) {
  return {
    id: `chatcmpl-${responseId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      delta: delta,
      finish_reason: finishReason
    }]
  };
}

function convertPostmanEventToOpenAI(event, model, responseId, state) {
  const eventType = event.eventType;
  const data = event.data || {};
  
  // Текстовый контент (реальное поле — textContent)
  if (eventType === 'textChunk' && typeof data.textContent === 'string') {
    // Пропускаем служебный разделитель переключения агента
    if (data.metadata?.id === 'switch-agent-separator') return null;
    return makeChunk(responseId, model, { content: data.textContent });
  }
  
  // Thinking content → reasoning_content (OpenAI o1-style)
  if (eventType === 'thinkingChunk') {
    const thinking = data.thinkingContent || data.thinking || data.textContent || '';
    if (!thinking) return null;
    return makeChunk(responseId, model, { reasoning_content: thinking });
  }
  
  // Метаданные диалога: сохраняем conversationId (data.id) и реальную модель
  if (eventType === 'conversation') {
    if (data.id) state.conversationId = data.id;
    if (data.modelKey) state.postmanModel = data.modelKey;
    return null;
  }
  
  // Квота usage — логируем и запоминаем для финального чанка
  if (eventType === 'usage') {
    state.usage = {
      userType: data.userType,
      usageState: data.usageState,
      limit: data.limit,
      usage: data.usage
    };
    return null;
  }
  
  // Ошибка от Postman — превращаем в OpenAI-style ошибку
  if (eventType === 'failure') {
    state.failure = {
      errorType: data.errorType,
      message: data.userMessage || data.message || 'Postman AI error'
    };
    return null;
  }
  
  // Tool calls
  if (eventType === 'toolCall' || eventType === 'tool_call') {
    return makeChunk(responseId, model, {
      tool_calls: [{
        index: 0,
        id: data.toolCallId || `call_${crypto.randomBytes(12).toString('hex')}`,
        type: 'function',
        function: {
          name: data.toolName || data.name || 'unknown',
          arguments: JSON.stringify(data.arguments || data.parameters || {})
        }
      }]
    });
  }
  
  return null;
}

async function handleChatCompletions(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  
  let openaiBody;
  try {
    openaiBody = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
    return;
  }
  
  const token = getToken(req);
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Missing API key. Pass Postman access_token as Bearer token.', type: 'authentication_error' } }));
    return;
  }
  
  const stream = openaiBody.stream !== false;
  const model = openaiBody.model || 'gpt-5.6-sol';
  const workspaceId = openaiBody.workspace_id || DEFAULT_WORKSPACE_ID;
  const responseId = crypto.randomBytes(12).toString('hex');
  
  const postmanBody = convertOpenAIToPostman(openaiBody, workspaceId);
  
  console.log(`[PROXY] ${model} → ${getPostmanModel(model)} | stream=${stream} | query="${(openaiBody.messages?.[openaiBody.messages.length-1]?.content || '').slice(0, 50)}..."`);
  
  const postData = JSON.stringify(postmanBody);
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'x-access-token': token,
      'x-app-version': '12.23.1',
      'x-pstmn-req-service': 'agent-mode-service',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Postman/12.23.1 Electron/37.10.3 Safari/537.36',
      'Origin': 'https://desktop.postman.com',
      'Referer': 'https://desktop.postman.com/',
      'Content-Length': Buffer.byteLength(postData)
    }
  };
  
  const proxyReq = https.request(POSTMAN_GATEWAY, options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      let errBody = '';
      proxyRes.on('data', c => errBody += c);
      proxyRes.on('end', () => {
        console.error(`[PROXY] Postman error: ${proxyRes.statusCode} ${errBody.slice(0, 200)}`);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Postman API error: ${proxyRes.statusCode}`, type: 'upstream_error', raw: errBody.slice(0, 500) } }));
      });
      return;
    }
    
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      
      let buffer = '';
      const state = { conversationId: null, postmanModel: null, usage: null, failure: null };
      
      const processBuffer = (flush = false) => {
        // SSE-события разделяются \n\n; обрабатываем только полные, хвост держим в буфере
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleRawEvent(raw);
        }
        if (flush && buffer.trim()) {
          handleRawEvent(buffer);
          buffer = '';
        }
      };
      
      const handleRawEvent = (raw) => {
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          
          // Postman сам присылает data: [DONE]
          if (payload === '[DONE]') continue;
          
          let event;
          try {
            event = JSON.parse(payload);
          } catch (e) {
            continue;
          }
          
          const openaiChunk = convertPostmanEventToOpenAI(event, model, responseId, state);
          if (openaiChunk) {
            res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
          }
        }
      };
      
      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString();
        processBuffer(false);
      });
      
      proxyRes.on('end', () => {
        processBuffer(true);
        
        // Финальный чанк с finish_reason (и ошибкой, если была)
        if (state.failure) {
          const errChunk = makeChunk(responseId, model, {
            content: `\n\n[Postman error: ${state.failure.errorType}] ${state.failure.message}`
          }, 'stop');
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify(makeChunk(responseId, model, {}, 'stop'))}\n\n`);
        }
        
        res.write('data: [DONE]\n\n');
        res.end();
        console.log(`[PROXY] Stream completed | conversationId=${state.conversationId} | model=${state.postmanModel} | usage=${state.usage ? `${state.usage.usage}/${state.usage.limit}` : 'n/a'}${state.failure ? ` | FAILURE: ${state.failure.errorType}` : ''}`);
      });
      
      proxyRes.on('error', (err) => {
        console.error(`[PROXY] Stream error: ${err.message}`);
        res.end();
      });
      
    } else {
      // Non-streaming mode
      let fullResponse = '';
      const state = { conversationId: null, postmanModel: null, usage: null, failure: null };
      
      proxyRes.on('data', (chunk) => {
        fullResponse += chunk.toString();
      });
      
      proxyRes.on('end', () => {
        let content = '';
        let thinkingContent = '';
        
        for (const raw of fullResponse.split('\n\n')) {
          for (const line of raw.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            let event;
            try { event = JSON.parse(payload); } catch (e) { continue; }
            
            const d = event.data || {};
            if (event.eventType === 'conversation' && d.id) {
              state.conversationId = d.id;
              if (d.modelKey) state.postmanModel = d.modelKey;
            }
            if (event.eventType === 'usage') state.usage = { usage: d.usage, limit: d.limit, usageState: d.usageState };
            if (event.eventType === 'failure') state.failure = { errorType: d.errorType, message: d.userMessage || d.message };
            if (event.eventType === 'textChunk' && typeof d.textContent === 'string' && d.metadata?.id !== 'switch-agent-separator') {
              content += d.textContent;
            }
            if (event.eventType === 'thinkingChunk') {
              thinkingContent += d.thinkingContent || d.thinking || d.textContent || '';
            }
          }
        }
        
        if (state.failure && !content) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: { message: `Postman AI error (${state.failure.errorType}): ${state.failure.message}`, type: 'upstream_error' } }));
          console.error(`[PROXY] Failure: ${state.failure.errorType} — ${state.failure.message}`);
          return;
        }
        
        const openaiResponse = {
          id: `chatcmpl-${responseId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: content,
              ...(thinkingContent ? { reasoning_content: thinkingContent } : {})
            },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          _postman_conversation_id: state.conversationId,
          _postman_model: state.postmanModel,
          ...(state.usage ? { _postman_usage: state.usage } : {})
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(openaiResponse));
        console.log(`[PROXY] Response completed | ${content.length} chars | conversationId=${state.conversationId} | model=${state.postmanModel}`);
      });
    }
  });
  
  proxyReq.on('error', (err) => {
    console.error(`[PROXY] Request error: ${err.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream error: ${err.message}`, type: 'connection_error' } }));
  });
  
  proxyReq.write(postData);
  proxyReq.end();
}

// Динамический список моделей: тянем из GET /config (кэш 10 мин)
let modelsCache = null;
let modelsCacheTime = 0;

function fetchModels() {
  return new Promise((resolve) => {
    if (modelsCache && Date.now() - modelsCacheTime < 10 * 60 * 1000) {
      return resolve(modelsCache);
    }
    const token = process.env.POSTMAN_TOKEN || '';
    const req = https.request('https://gateway.postman.com/config?platform=DESKTOP_MACOS', {
      method: 'GET',
      headers: {
        'x-access-token': token.split(',')[0].trim(),
        'x-app-version': '12.23.1',
        'x-pstmn-req-service': 'agent-mode-service',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Postman/12.23.1 Electron/37.10.3 Safari/537.36',
        'Origin': 'https://desktop.postman.com',
        'Referer': 'https://desktop.postman.com/'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const cfg = JSON.parse(body);
          modelsCache = cfg;
          modelsCacheTime = Date.now();
          resolve(cfg);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function handleModels(req, res) {
  const cfg = await fetchModels();
  let models;
  if (cfg?.models) {
    // Реальный список из Postman:displayName + key + алиасы из MODEL_MAP
    const aliasMap = {};
    for (const [alias, key] of Object.entries(MODEL_MAP)) {
      if (key === 'default') continue;
      (aliasMap[key] = aliasMap[key] || []).push(alias);
    }
    models = cfg.models.map(m => ({
      id: (aliasMap[m.key] || [])[0] || m.key,
      object: 'model',
      created: 1700000000,
      owned_by: 'postman-ai-proxy',
      _postman_key: m.key,
      _display_name: m.displayName,
      _supports_thinking: m.supportsThinkingMode,
      _supports_images: m.supportsImageUploads
    }));
  } else {
    // Fallback: статический список
    models = Object.keys(MODEL_MAP)
      .filter(k => k !== 'default')
      .map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'postman-ai-proxy' }));
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ object: 'list', data: models }));
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    handleChatCompletions(req, res);
  } else if (url.pathname === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
  } else if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'postman-ai-proxy', port: PORT }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /v1/chat/completions or /v1/models' }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Postman AI Proxy running on http://localhost:${PORT}`);
  console.log(`   OpenAI-compatible endpoint: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   Models endpoint: http://localhost:${PORT}/v1/models`);
  console.log(`\n   Supported models:`);
  Object.entries(MODEL_MAP).filter(([k]) => k !== 'default').forEach(([openai, postman]) => {
    console.log(`     ${openai} → ${postman}`);
  });
  console.log(`\n   Usage:`);
  console.log(`     curl http://localhost:${PORT}/v1/chat/completions \\`);
  console.log(`       -H "Authorization: Bearer YOUR_POSTMAN_ACCESS_TOKEN" \\`);
  console.log(`       -H "Content-Type: application/json" \\`);
  console.log(`       -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Hello"}],"stream":true}'`);
  console.log();
});
