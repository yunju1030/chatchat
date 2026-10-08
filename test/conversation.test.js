import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMemory, validMemory, partitionHistory, reinforceConstraints, checkReply } from '../conversation.js';

test('문자 수는 한글 NFC와 이모지 묶음을 기준으로 검사하고 단어 수도 지원한다', () => {
  const memory = { ...emptyMemory(), length: { unit: 'characters', min: 2, max: 2, scope: 'reply', persistent: false } };
  assert.equal(checkReply('가👨‍👩‍👧', memory, []), null);
  assert.match(checkReply('세글자', memory, []), /길이 위반/);
  memory.length = { ...memory.length, unit: 'words' };
  assert.equal(checkReply('hello world', memory, []), null);
  assert.match(checkReply('hello', memory, []), /길이 위반/);
});

test('끝말잇기 단일 단어/연결 검증 및 길이 해제', () => {
  const memory = { ...emptyMemory(), wordChain: true, length: { unit: 'characters', min: 3, max: 3, scope: 'word', persistent: true } };
  const messages = [{ role: 'user', content: '기차역' }];
  assert.equal(checkReply('역무원', memory, messages), null);
  assert.match(checkReply('자동차', memory, messages), /역/);
  assert.match(checkReply('역무원입니다!', memory, messages), /단어 하나/);
  assert.equal(reinforceConstraints(memory, memory, '글자 수 제한은 취소하자').length, null);
  assert.equal(reinforceConstraints(memory, memory, '글자 수 제한은 취소하자').wordChain, true);
});

test('명시적 규칙은 한글/숫자와 범위를 지원하고 인용문을 규칙으로 덮어쓰지 않는다', () => {
  for (const [text, min, max] of [['앞으로 답변은 정확히 네 글자로 해줘', 4, 4], ['답변은 10자 이내로 해줘', null, 10], ['5단어 이상으로 답해 줘', 5, null], ['답변은 4글자 미만으로 해줘', null, 3], ['답변은 3~5글자로 해줘', 3, 5], ['답변은 세 글자에서 다섯 글자로 해줘', 3, 5]]) {
    const result = reinforceConstraints(emptyMemory(), emptyMemory(), text);
    assert.equal(result.length.min, min);
    assert.equal(result.length.max, max);
    assert.equal(validMemory(result), true);
  }
  assert.equal(reinforceConstraints(emptyMemory(), emptyMemory(), '예를 들어 "세 글자로 하자"라고 한다면?').length, null);
  assert.equal(reinforceConstraints(emptyMemory(), emptyMemory(), '세 글자 규칙은 취소하고 이제 네 글자로 답해 줘').length.max, 4);
  assert.equal(reinforceConstraints(emptyMemory(), emptyMemory(), '길이 제한은 취소하고 4글자로 답해 줘').length.max, 4);
});

test('평범한 게임 턴에서 모델이 기억을 누락해도 합의한 길이 규칙은 보존한다', () => {
  const previous = { ...emptyMemory(), wordChain: true, length: { unit: 'characters', min: 3, max: 3, scope: 'word', persistent: true }, rules: [{ key: 'output_length', text: '세 글자 단어만' }] };
  const result = reinforceConstraints(previous, emptyMemory(), '기차역');
  assert.deepEqual(result, previous);
});

test('압축은 항상 user로 시작하는 최근 창을 남기고 큰 메시지도 예산을 제한한다', () => {
  const messages = Array.from({ length: 11 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'a'.repeat(7000) }));
  const result = partitionHistory(messages);
  assert.equal(result.recent[0].role, 'user');
  assert.ok(result.recent.reduce((n, m) => n + m.content.length, 0) <= 16000);
  assert.deepEqual([...result.older, ...result.recent], messages);
  assert.equal(validMemory({ ...emptyMemory(), length: { unit: 'characters', min: 5, max: 3, scope: 'reply', persistent: true } }), false);
});
