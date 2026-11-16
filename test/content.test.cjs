const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'content.css'), 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 160));

async function setup(t, html, initial = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`, {
    url: 'https://copilot.microsoft.com/', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const settings = { enabled: true, customSelector: '', ...initial };
  const listeners = [];
  let onMessage;
  dom.window.chrome = {
    runtime: { onMessage: { addListener(fn) { onMessage = fn; } } },
    storage: {
      local: { get: async () => ({ ...settings }) },
      onChanged: { addListener(fn) { listeners.push(fn); } }
    }
  };
  dom.window.eval(source);
  await wait();
  const document = dom.window.document;
  return {
    window: dom.window, document,
    buttons: () => [...document.querySelectorAll('.copilot-fold-toggle')],
    open: () => [...document.querySelectorAll('[data-copilot-fold-closed="false"]')].map(n => n.id),
    status: () => { let result; onMessage({ type: 'copilot-fold-status' }, {}, x => { result = x; }); return result; },
    message: type => onMessage({ type }, {}, () => {}),
    change: async patch => {
      Object.assign(settings, patch);
      for (const fn of listeners) fn(Object.fromEntries(Object.entries(patch).map(([k,v]) => [k, { newValue:v }])), 'local');
      await wait();
    }
  };
}
const answer = (id, text = id) => `<article id="${id}" data-content="ai-message"><p>${text}</p></article>`;

// Structural attributes observed in the user's copilot.com/chat/conversation page.
// Conversation content and identifiers are deliberately excluded from this fixture.
const currentAnswer = (id, stopped = false) => `<div ${stopped ? '' : 'data-testid="copilot-message-div"'}>
  <div id="${id}" role="article" class="fai-CopilotMessage"
    aria-labelledby="copilot-message-${id}-title copilot-message-${id}">
    <h5 id="copilot-message-${id}-title">Copilot said:</h5>
    <div id="copilot-message-${id}">${stopped ? 'Stopped generating.' : 'Response body.'}</div>
    <div role="toolbar"><button>Copy</button></div>
  </div></div>`;

test('current copilot.com article markup: four answers, including stopped response, latest only', async t => {
  const s = await setup(t, `<div role="feed">
    <div role="article" aria-labelledby="user-message-u-title"><h5 id="user-message-u-title">You said:</h5>Question</div>
    ${currentAnswer('a')}${currentAnswer('b')}${currentAnswer('c', true)}${currentAnswer('d')}
  </div>`);
  assert.equal(s.status().count, 4);
  assert.equal(s.buttons().length, 4);
  assert.deepEqual(s.open(), ['d']);
  assert.equal(s.status().collapsed, 3);
  s.buttons()[1].click();
  assert.deepEqual(s.open(), ['b']);
  assert.equal(s.document.querySelector('[aria-labelledby="user-message-u-title"]').hasAttribute('data-copilot-fold-closed'), false);
  await s.change({ enabled: false });
  assert.equal(s.buttons().length, 0);
  assert.equal(s.document.querySelectorAll('[data-copilot-fold-closed]').length, 0);
});

test('current article identified after insertion through role and aria-labelledby updates', async t => {
  const s = await setup(t, '<div id="late"><p>Response</p></div>');
  const node = s.document.getElementById('late');
  node.setAttribute('role', 'article');
  node.setAttribute('aria-labelledby', 'copilot-message-late-title copilot-message-late');
  await wait();
  assert.equal(s.status().count, 1);
  assert.deepEqual(s.open(), ['late']);
});

test('latest only, exclusive manual expansion, keyboard button semantics and actual display:none', async t => {
  const s = await setup(t, `<p data-content="user-message">質問</p>${answer('a')}${answer('b')}${answer('c')}`);
  assert.deepEqual(s.open(), ['c']);
  assert.equal(s.window.getComputedStyle(s.document.getElementById('a')).display, 'none');
  assert.equal(s.document.querySelector('[data-content="user-message"]').hasAttribute('data-copilot-fold-closed'), false);
  s.buttons()[0].click();
  assert.deepEqual(s.open(), ['a']);
  assert.equal(s.buttons()[0].getAttribute('aria-controls'), 'a');
  assert.equal(s.buttons()[0].getAttribute('aria-expanded'), 'true');
  s.buttons()[0].click();
  assert.deepEqual(s.open(), []);
  s.message('copilot-fold-latest');
  assert.deepEqual(s.open(), ['c']);
});

test('stream updates do not reopen manually closed answers; new answers do', async t => {
  const s = await setup(t, answer('a') + answer('b'));
  s.buttons()[0].click();
  for (let i = 0; i < 20; i++) s.document.querySelector('#b p').textContent += '続きを生成';
  await wait();
  assert.deepEqual(s.open(), ['a']);
  s.document.body.insertAdjacentHTML('beforeend', answer('c'));
  await wait();
  assert.deepEqual(s.open(), ['c']);
  assert.equal(s.buttons().length, 3);
});

test('older prepended history preserves selected answer', async t => {
  const s = await setup(t, answer('b') + answer('c'));
  s.buttons()[0].click();
  s.document.body.insertAdjacentHTML('afterbegin', answer('a'));
  await wait();
  assert.deepEqual(s.open(), ['b']);
  assert.equal(s.buttons().length, 3);
});

test('nested response markers create a single disclosure and new children remain hidden', async t => {
  const s = await setup(t, `<article id="a" data-content="ai-message"><div data-testid="ai-message">text</div></article>${answer('b')}`);
  assert.equal(s.buttons().length, 2);
  s.document.getElementById('a').insertAdjacentHTML('beforeend', '<p>streamed child</p>');
  await wait();
  assert.equal(s.document.getElementById('a').getAttribute('data-copilot-fold-closed'), 'true');
  assert.equal(s.buttons().length, 2);
});

test('disable restores original DOM identities, removes buttons, reenable initializes latest', async t => {
  const s = await setup(t, '<article data-content="ai-message"><p>Original</p></article>' + answer('b'));
  const original = s.document.querySelector('article');
  await s.change({ enabled: false });
  assert.equal(s.buttons().length, 0);
  assert.equal(original.getAttribute('id'), null);
  assert.equal(original.hasAttribute('data-copilot-fold-closed'), false);
  assert.equal(s.document.querySelector('article'), original);
  assert.equal(s.document.getElementById('b').id, 'b');
  await s.change({ enabled: true });
  assert.deepEqual(s.open(), ['b']);
});

test('conversation replacement prunes detached records and discovers new latest', async t => {
  const s = await setup(t, answer('a') + answer('b'));
  s.document.body.innerHTML = answer('x') + answer('y');
  await wait();
  assert.equal(s.status().count, 2);
  assert.deepEqual(s.open(), ['y']);
});

test('attribute-based delayed identification, detached buttons and response replacement', async t => {
  const s = await setup(t, '<article id="a"><p>Answer</p></article>');
  s.document.getElementById('a').setAttribute('data-content', 'ai-message');
  await wait();
  assert.deepEqual(s.open(), ['a']);
  s.buttons()[0].remove();
  await wait();
  assert.equal(s.buttons().length, 1);
  s.document.getElementById('a').remove();
  await wait();
  assert.equal(s.status().count, 0);
  assert.equal(s.buttons().length, 0);
});

test('custom selector, invalid fallback, and broad selectors protect input and user messages', async t => {
  const s = await setup(t, '<section class="response" id="a">Answer</section>', { customSelector: '.response' });
  assert.deepEqual(s.open(), ['a']);
  await s.change({ customSelector: '[' });
  assert.match(s.status().selectorError, /形式/);
  assert.equal(s.buttons().length, 0);
  s.document.body.innerHTML = '<main><div data-role="user">Question</div><form><textarea></textarea></form></main>';
  await s.change({ customSelector: 'body, main, form, textarea, [data-role="user"]' });
  assert.equal(s.buttons().length, 0);
});

test('a long stream stabilizes without observer feedback and shows a safe text preview', async t => {
  const s = await setup(t, answer('a', '&lt;img src=x onerror=alert(1)&gt;'));
  const button = s.buttons()[0];
  assert.equal(button.querySelector('img'), null);
  const before = button.outerHTML;
  await wait();
  assert.equal(s.buttons()[0], button);
  assert.equal(button.outerHTML, before);
  assert.equal(s.buttons().length, 1);
});

test('rediscovering the same response preserves its button, handler, and open state', async t => {
  const s = await setup(t, currentAnswer('a') + currentAnswer('b'));
  const button = s.buttons()[0];
  button.click();
  s.document.getElementById('a').setAttribute('aria-labelledby', 'copilot-message-a-title copilot-message-a');
  await wait();
  assert.equal(s.buttons()[0], button);
  assert.deepEqual(s.open(), ['a']);
  s.buttons()[1].click();
  await wait();
  assert.deepEqual(s.open(), ['b']);
});

test('Tabster focus sentinel insertion does not repeatedly move the button', async t => {
  const s = await setup(t, currentAnswer('a') + currentAnswer('b'));
  const node = s.document.getElementById('a');
  const button = s.buttons()[0];
  const sentinel = s.document.createElement('i');
  sentinel.setAttribute('data-tabster-dummy', '');
  sentinel.setAttribute('aria-hidden', 'true');
  node.before(sentinel);
  await wait();
  assert.equal(button.nextElementSibling, sentinel);
  button.querySelector('.copilot-fold-preview').click();
  await wait();
  assert.deepEqual(s.open(), ['a']);
});

test('site capture listeners cannot swallow a fold button click', async t => {
  const s = await setup(t, currentAnswer('a') + currentAnswer('b'));
  s.document.addEventListener('click', event => event.stopPropagation(), true);
  s.buttons()[0].querySelector('.copilot-fold-label').click();
  await wait();
  assert.deepEqual(s.open(), ['a']);
  s.buttons()[1].click();
  await wait();
  assert.deepEqual(s.open(), ['b']);
});

test('collapsed response preview updates when historical content loads later, without opening it', async t => {
  const s = await setup(t, '<article id="history" data-content="ai-message"><p></p></article>' + answer('latest'));
  const button = s.buttons()[0];
  s.document.querySelector('#history p').textContent = '履歴から読み込まれた回答です。';
  await wait();
  assert.equal(button.querySelector('.copilot-fold-preview').textContent, '履歴から読み込まれた回答です。');
  assert.deepEqual(s.open(), ['latest']);
  assert.equal(s.document.getElementById('history').getAttribute('data-copilot-fold-closed'), 'true');
});

test('collapsed preview follows text node edits and content replacement', async t => {
  const s = await setup(t, answer('history', '古い本文') + answer('latest'));
  const paragraph = s.document.querySelector('#history p');
  paragraph.firstChild.data = '修正された本文';
  await wait();
  assert.equal(s.buttons()[0].querySelector('.copilot-fold-preview').textContent, '修正された本文');
  paragraph.replaceChildren(s.document.createTextNode('差し替えられた本文'));
  await wait();
  assert.equal(s.buttons()[0].querySelector('.copilot-fold-preview').textContent, '差し替えられた本文');
  assert.deepEqual(s.open(), ['latest']);
});

test('empty historical answers do not claim to be generating', async t => {
  const s = await setup(t, '<article data-content="ai-message"></article>' + answer('latest'));
  assert.doesNotMatch(s.buttons()[0].textContent, /生成中/);
});
