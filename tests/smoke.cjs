// Smoke test for lib/client.js.
// Simulates the browser module loader, React, a cordis ctx, and the slot
// renderer's props so registration and rendering can be exercised in Node.
// Run with: npm test (plain Node, no dependencies).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'lib', 'client.js');
const code = fs.readFileSync(file, 'utf8');

let captured = null;
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) };
  },
};
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(record) { captured = record; },
    },
    __DSH_BOOT__: { release: { version: '0.2.1-rc.2' } },
    setInterval: () => 0,
    clearInterval: () => {},
  },
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: file });

if (!captured) throw new Error('module loader registration missing');
if (captured.id !== 'dsh-plugin-balance-tokens') throw new Error('id mismatch: ' + captured.id);
const plugin = captured.factory((spec) => {
  if (spec === 'react') return React;
  throw new Error('unexpected require: ' + spec);
});
if (typeof plugin.apply !== 'function') throw new Error('apply missing');
if (!Array.isArray(plugin.inject)) throw new Error('inject missing');

// --- fake cordis ctx ---
const registrations = [];
let slotInjectName = null;
let slotInjectCallback = null;
const dicts = [];
let refreshCalls = 0;

const sessionState = {
  ids: ['s1'],
  byId: { s1: { id: 's1', displayTitle: 'Session 1', retainedBy: { mainView: 1 } } },
  projectionsBySession: {
    s1: {
      state: 'ready',
      values: {
        tokenUsage: { uncachedInputTokens: 1200, outputTokens: 3400, cacheReadTokens: 800, cacheWriteTokens: 100 },
        contextPressure: { pressureTokens: 5500, projectedTokens: 6000, contextWindow: 128000 },
      },
    },
  },
  phase: 'ready',
};

const balanceSnapshot = {
  phase: 'ready',
  normal: [{ currency: 'CNY', balance: '42.50' }],
  bonus: [{ currency: 'CNY', balance: '3.00' }],
};

const ctx = {
  locale: {
    getSnapshot: () => ({ active: 'zh', revision: 1, locales: [] }),
    register: (ns, locale, dict) => { dicts.push({ ns, locale, dict }); return () => {}; },
  },
  remote: {
    account: {
      getBalance: async () => ({
        ok: true,
        value: { status: 'ready', value: balanceSnapshot.normal, bonusWallets: balanceSnapshot.bonus },
      }),
    },
  },
  effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  slots: {
    inject(name, cb) { slotInjectName = name; slotInjectCallback = cb; return () => {}; },
    register(options, component) { registrations.push({ options, component }); return () => {}; },
  },
};

plugin.apply(ctx);
console.log('inject list:', plugin.inject.join(', '));
console.log('locale dicts registered:', dicts.map((d) => d.ns + '/' + d.locale).join(', '));
if (slotInjectName !== 'shell.bottom') throw new Error('expected shell.bottom inject, got ' + slotInjectName);
slotInjectCallback();
if (registrations.length !== 1) throw new Error('expected one registration');
const reg = registrations[0];
console.log('registration name:', reg.options.name, '| locale:', reg.options.locale);
const face = reg.options.inject();
console.log('inject face keys:', Object.keys(face).join(', '), '| hooks:', Object.keys(face.hooks).join(', '));

// --- render the component ---
const Component = reg.component;
const props = {
  t: (key) => ({
    balance: '余额', toppedUp: '充值', granted: '赠送', loading: '加载中…', notSignedIn: '账户未登录',
    balanceFailed: '余额获取失败', clickToRetry: '点击刷新余额', noSession: '无活动会话',
    waitingUsage: '等待用量数据', usage: '本会话', contextLeft: '上下文剩余', tokens: 'tokens',
  }[key] ?? key),
  useBalance: (selector) => selector(balanceSnapshot),
  useSessions: (selector) => selector(sessionState),
  refresh: () => { refreshCalls++; },
};

function texts(node, out) {
  if (node === null || node === undefined || node === false) return;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
  for (const child of node.children || []) texts(child, out);
}

const tree = Component(props);
const out = [];
texts(tree, out);
const text = out.join(' ');
console.log('rendered text:', text);
for (const part of ['余额', '充值 ¥42.50', '赠送 ¥3.00', '本会话', '5.5k', '上下文剩余', '122k', '128k']) {
  if (!text.includes(part)) throw new Error('missing expected text: ' + part);
}

// signed-out + no session path
const signedOutProps = {
  ...props,
  useBalance: (selector) => selector({ phase: 'signed-out', normal: [], bonus: [] }),
  useSessions: (selector) => selector({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }),
};
const out2 = [];
texts(Component(signedOutProps), out2);
const text2 = out2.join(' ');
console.log('signed-out render:', text2);
if (!text2.includes('账户未登录')) throw new Error('signed-out copy missing');
if (!text2.includes('无活动会话')) throw new Error('no-session copy missing');

// click the balance span
const clickable = tree.children[0].children[1];
if (typeof clickable.props.onClick !== 'function') throw new Error('balance click missing');
clickable.props.onClick();
if (refreshCalls !== 1) throw new Error('refresh not wired');
console.log('smoke test OK');
