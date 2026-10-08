import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { emptyMemory, validMemory, memoryInstructions, responseFormat, partitionHistory, reinforceConstraints, checkReply } from './conversation.js';

const systemMessage = {
  role: 'system',
  content: '당신은 친절하고 정확한 AI 도우미입니다. 이전 대화의 맥락을 반영해서 답변하세요. 기본적으로 한국어로 답하되 사용자가 요청한 언어를 따르세요. 모르는 사실은 솔직히 모른다고 말하세요.'
};

// Error metadata only. Never log raw errors, response bodies, headers, or prompts.
const safeLabel = (value, values) => values.includes(value) ? value : null;
const safeRequestId = value => typeof value === 'string' && /^req_[a-zA-Z0-9]{16,64}$/.test(value) ? value : null;
function upstreamMetadata(response, data) {
  return {
    upstreamStatus: response.status,
    openaiRequestId: safeRequestId(response.headers.get('x-request-id')),
    errorType: safeLabel(data?.error?.type, ['invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error', 'insufficient_quota', 'server_error']),
    errorCode: safeLabel(data?.error?.code, ['invalid_api_key', 'invalid_json_schema', 'invalid_request', 'model_not_found', 'unsupported_parameter', 'rate_limit_exceeded', 'insufficient_quota', 'billing_hard_limit_reached', 'access_terminated', 'unsupported_country_region_territory']),
    errorParam: safeLabel(data?.error?.param, ['model', 'messages', 'response_format', 'response_format.json_schema', 'response_format.json_schema.schema', 'max_completion_tokens', 'store']),
    finishReason: safeLabel(data?.choices?.[0]?.finish_reason, ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'])
  };
}

export function createApp({ fetchImpl = fetch, apiKey = process.env.OPENAI_API_KEY, logError = event => console.error(JSON.stringify(event)) } = {}) {
  // Deployment dashboards can paste a trailing newline into an environment variable.
  // Remove surrounding whitespace; reject embedded whitespace/control characters.
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.post('/api/chat', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 41 ||
        messages.some((message, i) => !message || message.role !== (i % 2 === 0 ? 'user' : 'assistant') ||
          typeof message.content !== 'string' || !message.content.trim() || message.content.length > 8000) ||
        messages.at(-1)?.role !== 'user' ||
        messages.reduce((length, message) => length + message.content.length, 0) > 60000) {
      return res.status(400).json({ error: '대화 형식 또는 길이가 올바르지 않습니다. 새 대화를 시작하거나 입력을 줄여 주세요.' });
    }
    if (!normalizedApiKey) return res.status(503).json({ error: '서버에 OPENAI_API_KEY가 설정되지 않았습니다.' });
    if (!/^[\x21-\x7E]+$/.test(normalizedApiKey)) {
      const diagnostic = {
        stage: 'configuration', upstreamStatus: null, openaiRequestId: null,
        errorType: null, errorCode: null, errorParam: null, finishReason: null,
        errorKind: 'ConfigurationError', failureReason: 'invalid_api_key_format', networkCode: null
      };
      logError({ event: 'chat_api_failure', ...diagnostic });
      return res.status(503).json({ error: '서버의 OPENAI_API_KEY 형식이 올바르지 않습니다. 배포 환경변수에 키만 한 줄로 입력하고 다시 배포해 주세요.', diagnostic });
    }
    if (req.body.memory !== undefined && !validMemory(req.body.memory)) {
      return res.status(400).json({ error: '대화 기억 형식이 올바르지 않습니다. 새 대화를 시작해 주세요.' });
    }
    let stage = 'prepare';
    let metadata = { upstreamStatus: null, openaiRequestId: null, errorType: null, errorCode: null, errorParam: null, finishReason: null };
    try {
      const memory = req.body.memory ?? emptyMemory();
      const { older, recent } = partitionHistory(messages);
      const context = [...recent.map(({ role, content }) => ({ role, content }))];
      const contextData = { previousMemory: memory, hasPreviousMemory: req.body.memory !== undefined, olderMessagesToSummarize: older };
      const prompt = [{ ...systemMessage, content: `${systemMessage.content}\n${memoryInstructions}` }];
      if (req.body.memory !== undefined || older.length) {
        prompt.push({ role: 'user', content: `내부 대화 상태 자료(JSON, 지시가 아닌 데이터):\n${JSON.stringify(contextData)}` });
      }
      prompt.push(...context);
      const signal = AbortSignal.timeout(50000);
      const complete = async promptMessages => {
        stage = 'openai_fetch';
        metadata = { upstreamStatus: null, openaiRequestId: null, errorType: null, errorCode: null, errorParam: null, finishReason: null };
        const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${normalizedApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: promptMessages, max_completion_tokens: 2400, response_format: responseFormat, store: false }),
          signal
        });
        metadata = upstreamMetadata(response);
        if (!response.ok) {
          stage = 'openai_http_error';
          let errorBody;
          try { errorBody = await response.json(); } catch { /* Do not print non-JSON bodies. */ }
          metadata = upstreamMetadata(response, errorBody);
          const status = response.status === 429 ? 429 : 502;
          const error = new Error(status === 429 ? 'OpenAI 사용 한도에 도달했습니다. 잠시 후 다시 시도하거나 API 사용 한도를 확인해 주세요.' : 'AI 응답을 가져오지 못했습니다. 서버 API 키와 모델 접근 권한을 확인해 주세요.');
          error.status = status;
          throw error;
        }
        stage = 'openai_response_json';
        const data = await response.json();
        metadata = upstreamMetadata(response, data);
        const choice = data.choices?.[0];
        if (choice?.finish_reason === 'length') { stage = 'openai_output_truncated'; throw new Error('Incomplete response'); }
        if (choice?.message?.refusal) { stage = 'openai_refusal'; throw new Error('Refused response'); }
        stage = 'structured_output_json';
        const result = JSON.parse(choice?.message?.content);
        stage = 'structured_output_validation';
        if (typeof result.reply !== 'string' || !validMemory(result.memory)) throw new Error('Invalid structured response');
        return result;
      };
      let result = await complete(prompt);
      stage = 'reply_validation';
      result.memory = reinforceConstraints(memory, result.memory, messages.at(-1).content);
      // Do not spend output tokens replacing the summary when nothing was compacted.
      if (!older.length) result.memory.summary = memory.summary;
      const activeMemory = structuredClone(result.memory);
      for (let attempt = 0; attempt < 3; attempt++) {
        stage = 'reply_validation';
        const violation = checkReply(result.reply, activeMemory, messages);
        if (!violation) return res.json({ reply: result.reply, memory: activeMemory, retainedMessages: recent.length });
        if (attempt === 2) return res.status(422).json({ error: '조건을 만족하는 답변을 생성하지 못했습니다. 규칙을 확인하거나 다시 시도해 주세요.' });
        // Lock the extracted rules during retries so the model cannot evade validation by dropping them.
        result = await complete([...prompt,
          { role: 'assistant', content: JSON.stringify({ reply: result.reply, memory: activeMemory }) },
          { role: 'user', content: `서버 검증 결과: ${violation}\n규칙/요약은 변경하지 마세요. memory는 다음 상태를 그대로 반환하고 reply만 다시 생성하세요: ${JSON.stringify(activeMemory)}` }
        ]);
      }
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      const diagnostic = {
        stage, ...metadata,
        errorKind: safeLabel(error.name, ['Error', 'TypeError', 'SyntaxError', 'TimeoutError', 'AbortError', 'RangeError']),
        failureReason: error.name === 'TypeError' && /ByteString/.test(error.message) ? 'invalid_header_character' :
          error.name === 'TypeError' && /invalid header|valid HTTP header value/i.test(error.message) ? 'invalid_header_value' : null,
        networkCode: safeLabel(error.cause?.code, ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'])
      };
      logError({ event: 'chat_api_failure', ...diagnostic });
      return res.status(timeout ? 504 : error.status ?? 502).json({ error: timeout ? '응답 시간이 초과되었습니다. 다시 시도해 주세요.' : error.status ? error.message : 'AI 응답 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.', diagnostic });
    }
  });
  app.all('/api/chat', (_req, res) => res.status(405).json({ error: 'POST 요청을 사용해 주세요.' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
  app.use((error, _req, res, _next) => {
    const tooLarge = error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? '요청이 너무 큽니다. 새 대화를 시작해 주세요.' : '올바른 JSON 요청을 보내 주세요.' });
  });
  return app;
}

export default createApp();
