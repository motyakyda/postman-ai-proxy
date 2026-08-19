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
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

// Конфигурация
const PORT = process.env.PORT || 8787;
const POSTMAN_GATEWAY = 'https://gateway.postman.com/chat';
const DEFAULT_WORKSPACE_ID = process.env.POSTMAN_WORKSPACE_ID || 'proxy-workspace';
const TOKENS_FILE = path.join(__dirname, 'tokens.json');

// OAuth (реверс Postman desktop: identity.getpostman.com/client/login, app_id из auth-бандла)
const IDENTITY_LOGIN_URL = 'https://identity.getpostman.com/client/login';
const POSTMAN_APP_ID = 'erisedstraehruoytubecafruoytonwohsi';
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
  const pool = getAllTokens();
  if (pool.length === 0) return '';
  if (pool.length === 1) return pool[0].access_token;
  const idx = tokenCursor++ % pool.length;
  return pool[idx].access_token;
}
let tokenCursor = 0;

// ===== Аккаунты (tokens.json) =====
function loadAccounts() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function saveAccounts(accounts) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(accounts, null, 2));
}

function getAllTokens() {
  const accounts = loadAccounts();
  const envPool = (process.env.POSTMAN_TOKEN || '').split(',').map(t => t.trim()).filter(Boolean)
    .map(t => ({ access_token: t, user_id: 'env', email: null, added_at: null }));
  return [...accounts, ...envPool];
}

function upsertAccount(params) {
  const accounts = loadAccounts();
  const entry = {
    user_id: params.user_id || null,
    email: params.email || null,
    username: params.username || null,
    name: params.name || null,
    team_id: params.team_id || null,
    region: params.region || null,
    multi_login_token: params.multi_login_token || null,
    access_token: params.access_token,
    added_at: new Date().toISOString()
  };
  const existing = accounts.findIndex(a => a.access_token === entry.access_token || (a.user_id && a.user_id === entry.user_id));
  if (existing >= 0) {
    accounts[existing] = { ...accounts[existing], ...entry };
  } else {
    accounts.push(entry);
  }
  saveAccounts(accounts);
  return entry;
}

function buildLoginUrl(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  const redirectUri = `${proto}://${host}/oauth/callback`;
  const qs = new URLSearchParams({
    app_id: POSTMAN_APP_ID,
    redirect_uri: redirectUri,
    action_type: 'authorization_grant'
  });
  return `${IDENTITY_LOGIN_URL}?${qs.toString()}`;
}

function htmlPage(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#e8e8e8;background:#1e1e2e}
  a{color:#89b4fa} .card{background:#2a2a3c;border-radius:12px;padding:24px;margin:16px 0}
  .ok{color:#a6e3a1} .tok{font-family:monospace;background:#181825;padding:8px 12px;border-radius:8px;word-break:break-all;font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:14px} td,th{padding:8px 12px;text-align:left;border-bottom:1px solid #3a3a4e}
  .btn{display:inline-block;background:#89b4fa;color:#1e1e2e;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;margin-top:12px}
</style></head><body>${bodyHtml}</body></html>`;
}

// ===== Импорт токена из запущенного Postman desktop (через CDP) =====
function importFromDesktop() {
  const { execFileSync } = require('child_process');
  const portFile = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Postman', 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) {
    return { error: 'Postman desktop is not running (no DevToolsActivePort file). Launch Postman and sign in first.' };
  }
  const port = fs.readFileSync(portFile, 'utf-8').trim().split('\n')[0];
  try {
    // 1. список targets
    const listRaw = execFileSync('curl', ['-s', `http://127.0.0.1:${port}/json/list`], { timeout: 5000 }).toString();
    const targets = JSON.parse(listRaw);
    const page = targets.find(t => t.type === 'page');
    if (!page) return { error: 'No page target in Postman. Open the Postman app window.' };
    
    // 2. читаем localStorage через CDP (небольшой node-скрипт)
    const script = `
      const WebSocket = require('ws');
      const ws = new WebSocket(${JSON.stringify(page.webSocketDebuggerUrl)});
      let id = 0; const pending = new Map();
      function call(method, params) {
        return new Promise((resolve, reject) => {
          const msgId = ++id;
          const to = setTimeout(() => { pending.delete(msgId); reject(new Error('timeout')); }, 10000);
          pending.set(msgId, (msg) => { clearTimeout(to); resolve(msg); });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      }
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      });
      ws.on('open', async () => {
        try {
          const r = await call('Runtime.evaluate', {
            expression: '(function() { const o = {}; o.access_token = localStorage.getItem(\\"access_token\\"); for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/user-details|external/i.test(k)) o[k] = localStorage.getItem(k); } return JSON.stringify(o); })()',
            returnByValue: true
          });
          console.log(r.result?.result?.value);
        } catch (e) { console.error('ERR ' + e.message); }
        process.exit(0);
      });
      ws.on('error', (e) => { console.error('WSERR ' + e.message); process.exit(1); });
      setTimeout(() => process.exit(1), 15000);
    `;
    const tmpScript = path.join(__dirname, '.import_desktop.tmp.js');
    fs.writeFileSync(tmpScript, script);
    let out;
    try {
      // ws может лежать в node_modules прокси или глобально
      try {
        out = execFileSync('node', [tmpScript], { timeout: 20000, cwd: __dirname }).toString();
      } catch (e1) {
        // попробуем /tmp где уже установлен ws
        const tmp2 = '/tmp/.import_desktop.tmp.js';
        fs.copyFileSync(tmpScript, tmp2);
        out = execFileSync('node', [tmp2], { timeout: 20000, cwd: '/tmp' }).toString();
      }
    } finally {
      try { fs.unlinkSync(tmpScript); } catch (e) {}
    }
    
    const data = JSON.parse(out.trim().split('\n').pop());
    if (!data.access_token || data.access_token === 'null') {
      return { error: 'No access_token in Postman localStorage. Sign in inside Postman desktop first.' };
    }
    
    // вытаскиваем user_id из ключей вида user-details-<id>-externalId
    let userId = null;
    for (const k of Object.keys(data)) {
      const m = k.match(/user-details-(\d+)/);
      if (m) { userId = m[1]; break; }
    }
    
    const account = upsertAccount({
      access_token: data.access_token,
      user_id: userId,
      email: null,
      source: 'desktop-import'
    });
    return { ok: true, account };
  } catch (e) {
    return { error: 'CDP import failed: ' + e.message };
  }
}

function handleImportDesktop(req, res) {
  const result = importFromDesktop();
  if (result.error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.error }));
    console.error('[DESKTOP-IMPORT] failed:', result.error);
    return;
  }
  console.log(`[DESKTOP-IMPORT] OK: user_id=${result.account.user_id}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    user_id: result.account.user_id,
    message: 'Token imported from Postman desktop. See /accounts'
  }));
}

function handleLogin(req, res) {
  const loginUrl = buildLoginUrl(req);
  console.log(`[OAUTH] Login start → ${loginUrl}`);
  res.writeHead(302, { Location: loginUrl });
  res.end();
}

function handleOAuthCallback(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams;
  
  if (p.get('error')) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('Login failed', `<div class="card"><h2>Login failed</h2>
      <p><b>${p.get('error')}</b>: ${p.get('error_description') || ''}</p>
      <a class="btn" href="/login">Try again</a></div>`));
    return;
  }
  
  const accessToken = p.get('access_token');
  if (!accessToken) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlPage('No token', `<div class="card"><h2>No access_token in callback</h2>
      <p>Query params received: ${[...p.keys()].join(', ') || 'none'}</p>
      <a class="btn" href="/login">Try again</a></div>`));
    return;
  }
  
  const account = upsertAccount({
    access_token: accessToken,
    user_id: p.get('user_id'),
    team_id: p.get('team_id'),
    email: p.get('email'),
    username: p.get('username'),
    name: p.get('name'),
    region: p.get('region'),
    multi_login_token: p.get('multi_login_token')
  });
  
  console.log(`[OAUTH] Login OK: user_id=${account.user_id} email=${account.email}`);
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlPage('Logged in', `<div class="card">
    <h2 class="ok">✔ Logged in as ${account.email || account.name || account.user_id || 'user'}</h2>
    <table>
      <tr><th>user_id</th><td>${account.user_id || '—'}</td></tr>
      <tr><th>team_id</th><td>${account.team_id || '—'}</td></tr>
      <tr><th>region</th><td>${account.region || '—'}</td></tr>
      <tr><th>access_token</th><td><span class="tok">${accessToken.slice(0, 12)}…${accessToken.slice(-8)}</span></td></tr>
    </table>
    <p>Token saved to <b>tokens.json</b>. The proxy now uses it automatically.</p>
    <a class="btn" href="/accounts">Accounts</a>
  </div>`));
}

function handleAccounts(req, res) {
  const accounts = loadAccounts();
  const envCount = (process.env.POSTMAN_TOKEN || '').split(',').filter(t => t.trim()).length;
  const rows = accounts.map((a, i) => `<tr>
    <td>${a.email || a.name || '—'}</td>
    <td>${a.user_id || '—'}</td>
    <td>${a.team_id || '—'}</td>
    <td><span class="tok">${(a.access_token || '').slice(0, 10)}…</span></td>
    <td>${a.added_at || '—'}</td>
    <td><a href="/logout/${i}">remove</a></td>
  </tr>`).join('');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(htmlPage('Accounts', `
    <h1>Postman AI Proxy — Accounts</h1>
    <div class="card">
      ${accounts.length || envCount ? `<table>
        <tr><th>Email</th><th>User ID</th><th>Team</th><th>Token</th><th>Added</th><th></th></tr>
        ${rows}
      </table>` : '<p>No accounts. Login with Postman:</p>'}
      ${envCount ? `<p>+ ${envCount} token(s) from POSTMAN_TOKEN env</p>` : ''}
      <a class="btn" href="/login">+ Add account via Postman login</a>
      <a class="btn" style="background:#a6e3a1" href="/import-desktop">⬇ Import from Postman desktop</a>
    </div>
    <div class="card"><p>Total tokens in pool: <b>${accounts.length + envCount}</b> (round-robin)</p>
    <p style="font-size:13px;opacity:.7">/import-desktop — берёт токен из запущенного Postman desktop (нужен включённый Postman с активным логином)</p></div>`));
}

function handleLogout(req, res, idx) {
  const accounts = loadAccounts();
  if (idx >= 0 && idx < accounts.length) {
    const removed = accounts.splice(idx, 1)[0];
    saveAccounts(accounts);
    console.log(`[OAUTH] Removed account: ${removed.email || removed.user_id}`);
  }
  res.writeHead(302, { Location: '/accounts' });
  res.end();
}

// Postman валидирует размер input.query (~10k символов), но backgroundContext
// (AGENTS_MD) не лимитирован — проверено на 54k. Системный промпт кладём туда.
const MAX_QUERY_BYTES = 9000;

function byteLen(s) {
  return Buffer.byteLength(s, 'utf-8');
}

function truncateText(s, maxBytes) {
  if (byteLen(s) <= maxBytes) return s;
  let out = '';
  for (const ch of s) {
    if (byteLen(out + ch) > maxBytes - 60) break;
    out += ch;
  }
  return out + '\n[...truncated...]';
}

// Возвращает { query, systemContext }
function buildQuery(messages) {
  const systemParts = [];
  const history = [];
  let lastUser = '';
  
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(c);
    } else if (m.role === 'user') {
      if (lastUser) history.push({ role: 'user', content: lastUser });
      lastUser = c || '';
    } else if (m.role === 'assistant') {
      history.push({ role: 'assistant', content: c });
    } else if (m.role === 'tool') {
      history.push({ role: 'tool', content: `[Tool result]: ${c}` });
    }
  }
  
  const systemText = systemParts.join('\n\n');
  const lastUserLen = byteLen(lastUser);
  
  // Бюджеты: последнему сообщению пользователя — максимум места
  let sysBudget;
  if (lastUserLen >= MAX_QUERY_BYTES - 1500) {
    sysBudget = 500;
  } else {
    sysBudget = Math.min(3500, Math.floor((MAX_QUERY_BYTES - lastUserLen) / 2));
  }
  
  let query = '';
  if (systemText) {
    query += '[System instructions]: ' + truncateText(systemText, sysBudget) + '\n\n';
  }
  
  // История — с конца (самые свежие), пока влезает
  const histBudget = MAX_QUERY_BYTES - byteLen(query) - lastUserLen - 100;
  if (histBudget > 300 && history.length) {
    const parts = [];
    let used = 0;
    let omitted = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      const label = h.role === 'assistant' ? "[Assistant's previous reply]" : (h.role === 'tool' ? '[Tool]' : '[User]');
      const line = `${label}: ${h.content}`;
      if (used + byteLen(line) + 2 <= histBudget) {
        parts.unshift(line);
        used += byteLen(line) + 2;
      } else {
        const remain = histBudget - used - 60;
        if (remain > 200) parts.unshift(line.slice(-remain) + '\n[...truncated...]');
        omitted = true;
        break;
      }
    }
    if (omitted) query += '[...earlier messages omitted...]\n\n';
    query += parts.join('\n\n') + '\n\n';
  }
  
  // Последнее сообщение пользователя — приоритет
  const lastBudget = MAX_QUERY_BYTES - byteLen(query);
  query += lastUserLen > 0 ? truncateText(lastUser, Math.max(lastBudget, 500)) : '';
  
  return {
    query: query.trim() || 'Hello',
    // Полный system-промпт (без урезания) — уйдёт в backgroundContext.AGENTS_MD
    systemContext: systemText || null
  };
}

function convertOpenAIToPostman(openaiBody, workspaceId) {
  const messages = openaiBody.messages || [];
  const { query, systemContext } = buildQuery(messages);
  
  // Извлекаем conversationId для продолжения диалога (из тела или последнего сообщения)
  const conversationId = openaiBody._postman_conversation_id || openaiBody.conversation_id || null;
  
  const backgroundContext = [
    { type: 'ACTIVE_ENVIRONMENT', value: null },
    { type: 'ACTIVE_WORKSPACE', value: { name: 'Proxy Workspace', id: workspaceId } }
  ];
  // Полный системный промпт — в нелимитированный контекст (Postman подмешивает его как AGENTS_MD)
  if (systemContext) {
    backgroundContext.push({ type: 'AGENTS_MD', value: { agentsMdFileContent: systemContext } });
  }
  
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
    backgroundContext: backgroundContext,
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
    res.end(JSON.stringify({ error: { message: 'No Postman token. Open http://localhost:' + PORT + '/login to sign in with Postman, or pass access_token as Bearer, or set POSTMAN_TOKEN env.', type: 'authentication_error' } }));
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
    const token = (getAllTokens()[0] || {}).access_token || '';
    const req = https.request('https://gateway.postman.com/config?platform=DESKTOP_MACOS', {
      method: 'GET',
      headers: {
        'x-access-token': token,
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
  } else if (url.pathname === '/login') {
    handleLogin(req, res);
  } else if (url.pathname === '/oauth/callback') {
    handleOAuthCallback(req, res);
  } else if (url.pathname === '/accounts') {
    handleAccounts(req, res);
  } else if (url.pathname === '/import-desktop') {
    handleImportDesktop(req, res);
  } else if (url.pathname.startsWith('/logout/')) {
    handleLogout(req, res, parseInt(url.pathname.split('/')[2], 10));
  } else if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', service: 'postman-ai-proxy', port: PORT,
      accounts: loadAccounts().length,
      login_url: '/login'
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use /v1/chat/completions, /v1/models, /login, /accounts' }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Postman AI Proxy running on http://localhost:${PORT}`);
  console.log(`\n   ┌──────────────────────────────────────────────────┐`);
  console.log(`   │  Login:   http://localhost:${PORT}/login`.padEnd(53) + `│`);
  console.log(`   │  Accounts: http://localhost:${PORT}/accounts`.padEnd(53) + `│`);
  console.log(`   │  API:     http://localhost:${PORT}/v1/chat/completions`.padEnd(53) + `│`);
  console.log(`   │  Models:  http://localhost:${PORT}/v1/models`.padEnd(53) + `│`);
  console.log(`   └──────────────────────────────────────────────────┘`);
  const accounts = loadAccounts();
  const envTokens = (process.env.POSTMAN_TOKEN || '').split(',').filter(t => t.trim()).length;
  console.log(`\n   Token pool: ${accounts.length} OAuth account(s) + ${envTokens} env token(s)`);
  if (accounts.length === 0 && envTokens === 0) {
    console.log(`   ⚠ No tokens. Open http://localhost:${PORT}/login to sign in with Postman`);
  }
  console.log();
});
