const form = document.querySelector('#chat-form');
const input = document.querySelector('#input');
const send = document.querySelector('#send');
const reset = document.querySelector('#reset');
const log = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const status = document.querySelector('#status');
const scroller = document.querySelector('#chat-scroll');
const storageKey = 'chatchat-messages-v1';
const stateKey = 'chatchat-state-v2';
let messages = [];
let contextMessages = [];
let memory;
let busy = false;
let followingLatest = true;
try {
  const state = JSON.parse(sessionStorage.getItem(stateKey) || 'null');
  const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
  const validMessages = list => Array.isArray(list) && list.length % 2 === 0 && list.every((m, i) =>
    m && m.role === (i % 2 === 0 ? 'user' : 'assistant') && typeof m.content === 'string' && m.content.length > 0 && m.content.length <= 8000);
  if (state && validMessages(state.messages) && validMessages(state.contextMessages) && state.contextMessages.length <= 40) {
    messages = state.messages;
    contextMessages = state.contextMessages;
    memory = state.memory;
  } else if (validMessages(saved) && saved.length <= 40) {
    messages = saved;
    contextMessages = [...saved];
  }
} catch { /* Storage may be unavailable; in-memory conversation still works. */ }

function persist() {
  try {
    sessionStorage.setItem(stateKey, JSON.stringify({ messages, contextMessages, memory }));
    sessionStorage.removeItem(storageKey);
  }
  catch { status.textContent = '탭 저장소를 사용할 수 없어 새로고침하면 대화가 초기화됩니다.'; }
}
function addMessage(role, content, pending = false) {
  const row = document.createElement('div');
  row.className = `message ${role}${pending ? ' pending' : ''}`;
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '나' : '✳';
  avatar.setAttribute('aria-label', role === 'user' ? '사용자' : 'AI');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  row.append(avatar, bubble);
  log.append(row);
  welcome.hidden = true;
  return row;
}
messages.forEach(m => addMessage(m.role, m.content));
function scrollLatest() {
  if (followingLatest) scroller.scrollTop = scroller.scrollHeight;
}
scroller.addEventListener('scroll', () => {
  followingLatest = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 64;
}, { passive: true });
// Listen before layout shifts, so an upward gesture while waiting for a reply wins.
scroller.addEventListener('wheel', event => { if (event.deltaY < 0) followingLatest = false; }, { passive: true });
scroller.addEventListener('keydown', event => {
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) followingLatest = false;
});
requestAnimationFrame(scrollLatest);
function resize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; scrollLatest(); }
function fitViewport() {
  document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
  scrollLatest();
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.addEventListener('resize', fitViewport);
fitViewport();
function setBusy(value) {
  busy = value;
  send.disabled = value;
  reset.disabled = value;
  input.disabled = value;
  log.setAttribute('aria-busy', String(value));
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = value; });
}
input.addEventListener('input', resize);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) form.requestSubmit();
  }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content || busy) return;
  // Only the recent API window is transmitted; the full visible transcript stays local.
  const history = [...contextMessages];
  status.textContent = '';
  setBusy(true);
  input.value = '';
  resize();
  const userRow = addMessage('user', content);
  const pending = addMessage('assistant', '생각하고 있어요…', true);
  scrollLatest();
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [...history, { role: 'user', content }], memory }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '메시지를 보내지 못했습니다.');
    if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('빈 응답을 받았습니다. 다시 시도해 주세요.');
    if (!data.memory || !Number.isInteger(data.retainedMessages) || data.retainedMessages < 1 || data.retainedMessages > history.length + 1 || data.retainedMessages % 2 !== 1) throw new Error('대화 상태를 처리하지 못했습니다. 다시 시도해 주세요.');
    const turn = [{ role: 'user', content }, { role: 'assistant', content: data.reply }];
    messages = [...messages, ...turn];
    contextMessages = [...history, turn[0]].slice(-data.retainedMessages).concat(turn[1]);
    memory = data.memory;
    pending.classList.remove('pending');
    pending.querySelector('.bubble').textContent = data.reply;
    persist();
    scrollLatest();
  } catch (error) {
    userRow.remove();
    pending.remove();
    welcome.hidden = messages.length > 0;
    input.value = content;
    status.textContent = ['TimeoutError', 'AbortError'].includes(error.name) ? '응답 시간이 초과되었습니다. 다시 보내 주세요.' : error instanceof SyntaxError ? '서버 응답을 읽지 못했습니다. 다시 시도해 주세요.' : error.message;
  } finally {
    setBusy(false);
    resize();
    input.focus({ preventScroll: true });
  }
});
reset.addEventListener('click', () => {
  if (busy) return;
  messages = [];
  contextMessages = [];
  memory = undefined;
  followingLatest = true;
  log.replaceChildren();
  welcome.hidden = false;
  status.textContent = '';
  input.value = '';
  try { sessionStorage.removeItem(stateKey); sessionStorage.removeItem(storageKey); } catch { /* In-memory reset still works. */ }
  persist();
  resize();
  scroller.scrollTop = 0;
  input.focus({ preventScroll: true });
});
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  input.value = button.dataset.prompt;
  form.requestSubmit();
}));
