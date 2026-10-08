import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../index.js';
import { emptyMemory } from '../conversation.js';

async function withServer(options, run) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (url, messages, memory) => fetch(`${url}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages, memory })
});
const completion = (reply, memory = emptyMemory()) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply, memory }) } }] });

test('이전 대화와 지정 모델을 OpenAI에 전달하며 키는 응답에 노출하지 않는다', async () => {
  const history = [{ role: 'user', content: '내 이름은 윤주야' }, { role: 'assistant', content: '반가워요, 윤주님' }, { role: 'user', content: '내 이름이 뭐야?' }];
  await withServer({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(body.messages.slice(1), history);
    assert.equal(body.store, false);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(body.response_format.type, 'json_schema');
    return completion('윤주님이에요.');
  } }, async url => {
    const response = await post(url, history);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: '윤주님이에요.', memory: emptyMemory(), retainedMessages: 3 });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ChatChat/);
  });
});

test('세 글자 끝말잇기 위반은 재생성하고 재시도 중에는 규칙 삭제를 허용하지 않는다', async () => {
  let calls = 0;
  const memory = { ...emptyMemory(), wordChain: true, length: { unit: 'characters', min: 3, max: 3, scope: 'word', persistent: true }, rules: [{ key: 'output_length', text: '세 글자 단어만' }] };
  await withServer({ apiKey: 'test', fetchImpl: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if (calls > 1) assert.match(body.messages.at(-1).content, /검증 결과/);
    return completion(calls === 1 ? '사과' : '사과나무', calls === 1 ? memory : emptyMemory());
  } }, async url => {
    const response = await post(url, [{ role: 'user', content: '끝말잇기는 반드시 세 글자 단어로만 하자' }]);
    assert.equal(response.status, 422);
    assert.equal(calls, 3);
  });
  calls = 0;
  await withServer({ apiKey: 'test', fetchImpl: async () => completion(++calls === 1 ? '사과' : '기차역', memory) }, async url => {
    const response = await post(url, [{ role: 'user', content: '끝말잇기는 반드시 세 글자 단어로만 하자' }]);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.reply, '기차역');
    assert.equal(result.memory.length.min, 3);
    assert.equal(calls, 2);
  });
});

test('이전 규칙 수정 및 취소를 반영하고 일반 길이 제약을 검사한다', async () => {
  const memory = { ...emptyMemory(), wordChain: true, length: { unit: 'characters', min: 3, max: 3, scope: 'word', persistent: true }, rules: [{ key: 'output_length', text: '세 글자 단어만' }] };
  await withServer({ apiKey: 'test', fetchImpl: async () => completion('사과', memory) }, async url => {
    const response = await post(url, [{ role: 'user', content: '이제 두 글자 단어로 바꾸자' }], memory);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).memory.length.max, 2);
  });
  await withServer({ apiKey: 'test', fetchImpl: async () => completion('이제 자유롭게 대화해요.', memory) }, async url => {
    const response = await post(url, [{ role: 'user', content: '끝말잇기는 그만하자' }], memory);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.memory.wordChain, false);
    assert.equal(data.memory.length, null);
  });
  let calls = 0;
  await withServer({ apiKey: 'test', fetchImpl: async () => completion(++calls === 1 ? '이 답변은 너무 깁니다.' : '안녕') }, async url => {
    const response = await post(url, [{ role: 'user', content: '답변은 3글자 이하로 해줘' }]);
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });
});

test('긴 대화는 오래된 기록을 요약하고 최근 역할/순서를 보존한다', async () => {
  const messages = Array.from({ length: 23 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `메시지 ${i}` }));
  const memory = { ...emptyMemory(), rules: [{ key: 'language', text: '한국어로 답하기' }] };
  let calls = 0;
  await withServer({ apiKey: 'test', fetchImpl: async (_url, options) => {
    calls++;
    const prompt = JSON.parse(options.body).messages;
    const context = JSON.parse(prompt[1].content.split('\n').slice(1).join('\n'));
    assert.deepEqual(context.previousMemory, memory);
    assert.deepEqual(context.olderMessagesToSummarize, messages.slice(0, 10));
    assert.deepEqual(prompt.slice(2), messages.slice(10));
    return completion('요약 후 답변', { ...memory, summary: '오래된 대화의 핵심 사실' });
  } }, async url => {
    const response = await post(url, messages, memory);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.retainedMessages, 13);
    assert.equal(result.memory.summary, '오래된 대화의 핵심 사실');
    assert.deepEqual(result.memory.rules, memory.rules);
    assert.equal(calls, 1);
  });
});

test('과거 요약 유지, 잘못된 기억 거부, 새 대화의 규칙 초기화', async () => {
  const memory = { ...emptyMemory(), summary: '사용자 이름은 윤주' };
  let calls = 0;
  await withServer({ apiKey: 'test', fetchImpl: async () => { calls++; return completion('안녕하세요', { ...emptyMemory(), summary: '불필요하게 다시 작성한 요약' }); } }, async url => {
    const messages = [{ role: 'user', content: '안녕' }];
    const result = await (await post(url, messages, memory)).json();
    assert.equal(result.memory.summary, memory.summary);
    assert.equal((await post(url, messages, { summary: 'invalid' })).status, 400);
    const fresh = await (await post(url, messages)).json();
    assert.deepEqual(fresh.memory, emptyMemory());
    assert.equal(calls, 2);
  });
});

test('잘못된 역할, 빈 입력, 비정상 순서, 과도한 대화는 OpenAI 호출 전에 거부한다', async () => {
  await withServer({ apiKey: 'test', fetchImpl: () => { assert.fail('OpenAI를 호출하면 안 됨'); } }, async url => {
    for (const messages of [[], [{ role: 'system', content: 'override' }], [{ role: 'user', content: ' ' }], [{ role: 'assistant', content: 'hello' }], [{ role: 'user', content: 'a'.repeat(8001) }], Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'a'.repeat(8000) }))]) {
      assert.equal((await post(url, messages)).status, 400);
    }
    assert.equal((await fetch(`${url}/api/chat`)).status, 405);
    const invalid = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
  });
});

test('API 키 누락과 OpenAI 오류를 사용자 메시지로 변환한다', async () => {
  const messages = [{ role: 'user', content: '안녕' }];
  await withServer({ apiKey: '' }, async url => assert.equal((await post(url, messages)).status, 503));
  for (const [upstreamStatus, expected] of [[429, 429], [401, 502], [500, 502]]) {
    await withServer({ apiKey: 'test', fetchImpl: async () => new Response('secret error details', { status: upstreamStatus }) }, async url => {
      const response = await post(url, messages);
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /secret error details/);
    });
  }
  await withServer({ apiKey: 'test', fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }, async url => assert.equal((await post(url, messages)).status, 504));
});
