# Postman AI Proxy

Прокси, превращающий AI-агента Postman Desktop (GPT-5.6 Sol, Claude Opus 4.8 и др.) в OpenAI-совместимый API.

## Как работает

```
Клиент (curl/SDK/LiteLLM/...) → OpenAI format → [proxy :8790] → Postman format → gateway.postman.com/chat
```

- `POST /v1/chat/completions` — streaming и non-streaming
- `GET /v1/models` — реальный список моделей из `GET gateway.postman.com/config`
- `GET /health` — проверка живости

## Модели

| OpenAI-имя (в запросе) | Postman ключ |
|---|---|
| `gpt-5.6-sol` | `GPT_56_SOL` |
| `gpt-5.6-terra` | `GPT_56_TERRA` |
| `gpt-5.6-luna` | `GPT_56_LUNA` |
| `gpt-5.5` | `GPT_55` |
| `gpt-5.4` | `GPT_54` |
| `claude-opus-4.8` | `CLAUDE_OPUS_48_BEDROCK` |
| `claude-opus-4.7` | `CLAUDE_OPUS_47_BEDROCK` |
| `claude-opus-4.5` | `CLAUDE_OPUS_45_BEDROCK` |
| `claude-sonnet-4.6` | `CLAUDE_46_SONNET_BEDROCK` |
| `claude-sonnet-4.5` | `CLAUDE_45_SONNET_BEDROCK` |
| `claude-haiku-4.5` | `CLAUDE_45_HAIKU_BEDROCK` |

Любой сырой Postman-ключ (например `GPT_56_TERRA`) тоже принимается как имя модели.

## Запуск

```bash
POSTMAN_TOKEN=<access_token> PORT=8790 node server.js
```

Несколько аккаунтов (round-robin):

```bash
POSTMAN_TOKEN=<token1>,<token2>,<token3> node server.js
```

## Как достать access_token

1. Открой Postman Desktop, залогинься
2. DevTools (Cmd+Shift+I или через `View → Toggle DevTools`) → Console:
   ```js
   copy(JSON.parse(localStorage.getItem('postmanDesktop').match(/"access_token":"([^"]+)"/)[1] ? RegExp.$1 : ''))
   ```
   Проще:
   ```js
   JSON.parse(localStorage.getItem('currentUser') || '{}')
   ```
   либо искать ключ `access_token` в localStorage.
3. Либо через CDP-порт (файл `~/Library/Application Support/Postman/DevToolsActivePort`):
   ```bash
   PORT=$(head -1 ~/Library/Application\ Support/Postman/DevToolsActivePort)
   # через /json/list найти page target и выполнить Runtime.evaluate на localStorage
   ```

## Использование

```bash
curl http://localhost:8790/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <postman_access_token>" \
  -d '{"model":"gpt-5.6-sol","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

Если `Authorization` не передан (или передан `sk-...`), прокси использует токен из `POSTMAN_TOKEN`.

### Особенности

- **Thinking-режим**: thinking-контент Postman транслируется в `reasoning_content` (как у DeepSeek/o1)
- **Продолжение диалога**: ответ содержит `_postman_conversation_id` — передайте его обратно в теле запроса (`_postman_conversation_id` или `conversation_id`), чтобы продолжить тот же диалог на стороне Postman
- **Квота**: в ответе есть `_postman_usage` (`usage/limit`, личный лимит PAID_USER ~800k)

## Переменные окружения

| Переменная | Default | Описание |
|---|---|---|
| `PORT` | `8787` | Порт прокси |
| `POSTMAN_TOKEN` | — | Токен(ы) через запятую |
| `POSTMAN_WORKSPACE_ID` | захардкожен | workspaceId для mandatoryContext |
| `POSTMAN_TOOLS_HASH` | от 12.23.1 | nativeToolsHash (меняется между версиями Postman!) |
| `POSTMAN_TERMS_HASH` | от 12.23.1 | nativeTermsHash |

**Важно**: хэши `clientTools`/`clientKBTerms` привязаны к версии Postman. Если Postman обновится и появится ошибка `TOOL_VALIDATION_ERROR: clientTools.nativeToolsHash is not valid` — перехватите новые хэши (sniff `gateway.postman.com/chat`) или обновите дефолты в server.js.
