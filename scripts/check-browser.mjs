// Optional local browser regression check. Uses installed Chrome and mock OpenAI responses.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../index.js';
import { emptyMemory } from '../conversation.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = await mkdtemp(join(tmpdir(), 'chatchat-browser-'));
const server = createApp({ apiKey: 'mock-only', fetchImpl: async () => {
  await sleep(600);
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reply: '확인했습니다. '.repeat(100), memory: emptyMemory() }) } }] });
} }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let sessionId;
let id = 0;
const callbacks = new Map();
try {
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 10000);
    let output = '';
    browser.once('error', reject);
    browser.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    const callback = callbacks.get(data.id);
    if (callback) { callbacks.delete(data.id); data.error ? callback.reject(new Error(data.error.message)) : callback.resolve(data.result); }
  });
  const command = (method, params = {}, target = sessionId) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { callbacks.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    callbacks.set(requestId, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params, ...(target ? { sessionId: target } : {}) }));
  });
  const target = await command('Target.createTarget', { url: 'about:blank' }, null);
  sessionId = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId;
  await command('Page.enable');
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(`Browser condition timed out: ${expression}`);
  };
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base });
  await waitFor('!!document.querySelector("#chat-form") && typeof contextMessages !== "undefined"');
  const saved = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: 긴 대화 테스트입니다. `.repeat(15) }));
  await evaluate(`sessionStorage.setItem('chatchat-messages-v1', ${JSON.stringify(JSON.stringify(saved))});`);
  await command('Page.reload');
  await waitFor('document.querySelectorAll(".message").length === 40');
  await sleep(100);
  const layout = await evaluate(`(() => {
    const s = document.querySelector('#chat-scroll');
    return { page: document.documentElement.scrollHeight, viewport: innerHeight,
      header: document.querySelector('header').getBoundingClientRect().top,
      footer: document.querySelector('footer').getBoundingClientRect().bottom,
      scrollable: s.scrollHeight > s.clientHeight, atBottom: s.scrollHeight - s.clientHeight - s.scrollTop < 4 };
  })()`);
  assert.ok(layout.page <= layout.viewport + 1, JSON.stringify(layout));
  assert.equal(layout.header, 0);
  assert.ok(layout.footer <= layout.viewport + 1);
  assert.ok(layout.scrollable && layout.atBottom);
  await evaluate(`document.querySelector('#chat-scroll').scrollTop = 200`);
  await sleep(100);
  await evaluate(`document.querySelector('#input').value = '테스트 질문'; document.querySelector('#chat-form').requestSubmit()`);
  await waitFor('!document.querySelector("#send").disabled');
  assert.equal(await evaluate('document.querySelector("#chat-scroll").scrollTop'), 200, 'Reading position must be preserved');
  const state = await evaluate('JSON.parse(sessionStorage.getItem("chatchat-state-v2"))');
  assert.equal(state.messages.length, 42);
  assert.ok(state.contextMessages.length < state.messages.length);
  assert.equal(await evaluate('sessionStorage.getItem("chatchat-messages-v1")'), null);
  await evaluate(`document.querySelector('#chat-scroll').scrollTop = document.querySelector('#chat-scroll').scrollHeight`);
  await sleep(100);
  await evaluate(`document.querySelector('#input').value = '최신 메시지 확인'; document.querySelector('#chat-form').requestSubmit()`);
  await waitFor('!document.querySelector("#send").disabled');
  assert.ok(await evaluate(`(() => { const s = document.querySelector('#chat-scroll'); return s.scrollHeight - s.clientHeight - s.scrollTop < 4; })()`));
  // If the user scrolls upward while the request is in flight, the reply must not jump down.
  await evaluate(`document.querySelector('#input').value = '대기 중 스크롤'; document.querySelector('#chat-form').requestSubmit()`);
  await evaluate(`document.querySelector('#chat-scroll').scrollTop = 300`);
  await sleep(100);
  await waitFor('!document.querySelector("#send").disabled');
  assert.equal(await evaluate('document.querySelector("#chat-scroll").scrollTop'), 300);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.ok(await evaluate(`document.documentElement.scrollHeight <= innerHeight + 1 && document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight + 1`));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 360, deviceScaleFactor: 1, mobile: true });
  await sleep(100);
  assert.ok(await evaluate(`document.querySelector('#chat-scroll').clientHeight > 0 && document.querySelector('#input').getBoundingClientRect().bottom <= innerHeight + 1`));
  await evaluate(`document.querySelector('#reset').click()`);
  const fresh = await evaluate('JSON.parse(sessionStorage.getItem("chatchat-state-v2"))');
  assert.deepEqual(fresh.messages, []);
  assert.deepEqual(fresh.contextMessages, []);
  assert.equal(fresh.memory, undefined);
  assert.ok(await evaluate('!document.querySelector("#welcome").hidden'));
  await command('Page.reload');
  await waitFor('!!document.querySelector("#welcome") && typeof contextMessages !== "undefined"');
  assert.equal(await evaluate('document.querySelectorAll(".message").length'), 0);
  console.log('Browser checks passed: desktop/mobile fixed layout, independent scrolling, preserved reading position, follow latest, migration, reset.');
} finally {
  socket?.close();
  const exited = new Promise(resolve => browser.once('exit', resolve));
  browser.kill();
  await Promise.race([exited, sleep(2000)]);
  await new Promise(resolve => server.close(resolve));
  const resolvedProfile = resolve(profile);
  assert.ok(resolvedProfile.startsWith(resolve(tmpdir()) + sep) && resolvedProfile.includes('chatchat-browser-'));
  await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
