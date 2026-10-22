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
const zh = {
  balance: '余额', toppedUp: '充值', granted: '赠送', loading: '加载中…', notSignedIn: '账户未登录',
  balanceFailed: '余额获取失败', clickToRetry: '点击刷新余额', noSession: '无活动会话',
  waitingUsage: '等待用量数据', usage: '本会话', contextLeft: '上下文剩余', tokens: 'tokens',
  balanceOk: '余额充足', balanceLow: '余额偏低', balanceCritical: '余额预警，建议及时充值',
  balanceBandHint: '充足 ≥ {low}，偏低 < {low}，预警 < {critical}',
  tokenOk: '用量正常', tokenHigh: '用量偏高', tokenCritical: '用量预警',
  tokenBandHint: '低于 {warn} 正常，低于 {danger} 偏高，{danger} 及以上预警',
  contextOk: '上下文充足', contextLow: '上下文偏低', contextCritical: '上下文预警',
  contextBandHint: '剩余 ≥ {warn} 充足，< {warn} 偏低，< {danger} 预警',
  metricAria: '{status}（{value}）',
};
const props = {
  t: (key, params) => {
    const template = zh[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  },
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

// Platform wallets arrive as decimal strings; zero wallets and scientific
// notation must not leak into the strip.
const messyProps = {
  ...props,
  useBalance: (selector) => selector({
    phase: 'ready',
    normal: [{ currency: 'USD', balance: '0E-16' }, { currency: 'CNY', balance: '8.2703571000000000' }],
    bonus: [{ currency: 'CNY', balance: '0' }],
  }),
};
const out3 = [];
texts(Component(messyProps), out3);
const text3 = out3.join(' ');
console.log('messy amounts render:', text3);
if (!text3.includes('充值 ¥8.27')) throw new Error('money formatting failed: ' + text3);
if (text3.includes('0E-16') || text3.includes('8.2703571') || text3.includes('赠送')) throw new Error('raw/zero wallet leaked: ' + text3);

// --- severity bands: green >= low, yellow >= critical, red below ---
function renderBalance(normal, bonus) {
  const tree = Component({
    ...props,
    useBalance: (selector) => selector({ phase: 'ready', normal, bonus }),
  });
  const clickable = tree.children[0].children[1];
  const out = [];
  texts(clickable, out);
  return { clickable, text: out.join(' ') };
}

const colorOf = (rendered) => rendered.clickable.children[0].props.style.background;

const sufficient = renderBalance(
  [{ currency: 'CNY', balance: '42.50' }],
  [{ currency: 'CNY', balance: '3.00' }],
);
console.log('sufficient:', sufficient.text, '|', sufficient.clickable.props.title);
if (sufficient.clickable.props['data-balance-severity'] !== 'ok') throw new Error('45.50 should be ok');
if (colorOf(sufficient) !== 'var(--dsw-alias-state-success-primary)') throw new Error('ok color missing');
if (!sufficient.clickable.props.title.includes('余额充足')) throw new Error('ok title missing');
if (!sufficient.clickable.props.title.includes('¥20')) throw new Error('ok threshold missing from title');
if (!sufficient.clickable.props['aria-label'].includes('余额充足')) throw new Error('ok aria missing');

const low = renderBalance([{ currency: 'CNY', balance: '8.27' }], []);
console.log('low:', low.text, '|', low.clickable.props.title);
if (low.clickable.props['data-balance-severity'] !== 'low') throw new Error('8.27 should be low');
if (colorOf(low) !== 'var(--dsw-alias-state-warn-primary)') throw new Error('low color missing');
if (!low.clickable.props.title.includes('余额偏低')) throw new Error('low title missing');

const critical = renderBalance([{ currency: 'CNY', balance: '3.00' }], []);
console.log('critical:', critical.text, '|', critical.clickable.props.title);
if (critical.clickable.props['data-balance-severity'] !== 'critical') throw new Error('3.00 should be critical');
if (colorOf(critical) !== 'var(--dsw-alias-state-error-primary)') throw new Error('critical color missing');
if (!critical.clickable.props['aria-label'].includes('余额预警')) throw new Error('critical aria missing');

// Bonus wallets count toward the band, and the thresholds are inclusive.
const bonusLifts = renderBalance(
  [{ currency: 'CNY', balance: '4.00' }],
  [{ currency: 'CNY', balance: '2.00' }],
);
if (bonusLifts.clickable.props['data-balance-severity'] !== 'low') throw new Error('bonus must count toward the band');
if (renderBalance([{ currency: 'CNY', balance: '5.00' }], []).clickable.props['data-balance-severity'] !== 'low') throw new Error('5.00 should be low');
if (renderBalance([{ currency: 'CNY', balance: '20.00' }], []).clickable.props['data-balance-severity'] !== 'ok') throw new Error('20.00 should be ok');
if (renderBalance([{ currency: 'USD', balance: '2.50' }], []).clickable.props['data-balance-severity'] !== 'low') throw new Error('$2.50 should be low');
if (renderBalance([{ currency: 'USD', balance: '3.00' }], []).clickable.props['data-balance-severity'] !== 'ok') throw new Error('$3.00 should be ok');
if (renderBalance([], []).clickable.props['data-balance-severity'] !== 'critical') throw new Error('empty wallet should be critical');

// An all-zero USD wallet keeps its own currency and USD band.
const emptyUsd = renderBalance([{ currency: 'USD', balance: '0E-16' }], []);
if (emptyUsd.text !== '$0.00') throw new Error('empty USD text mismatch: ' + emptyUsd.text);
if (emptyUsd.clickable.props['data-balance-severity'] !== 'critical') throw new Error('empty USD should be critical');
if (!emptyUsd.clickable.props.title.includes('$1')) throw new Error('USD band missing from title');

// A stale zero USD wallet does not outrank the funded CNY wallet.
const staleUsd = renderBalance(
  [{ currency: 'USD', balance: '0E-16' }, { currency: 'CNY', balance: '8.27' }],
  [],
);
if (staleUsd.clickable.props['data-balance-severity'] !== 'low') throw new Error('funded CNY should be graded');

// With both wallets funded, CNY is the documented primary currency.
const multiCurrency = renderBalance(
  [{ currency: 'USD', balance: '10.00' }, { currency: 'CNY', balance: '3.00' }],
  [],
);
if (multiCurrency.clickable.props['data-balance-severity'] !== 'critical') throw new Error('CNY should be graded');

// Error and signed-out states carry no severity dot.
const signedOutClickable = Component(signedOutProps).children[0].children[1];
if (signedOutClickable.props['data-balance-severity'] !== 'unknown') throw new Error('signed-out severity should be unknown');
if (signedOutClickable.children[0] !== null) throw new Error('signed-out dot should not render');

// --- token spend and remaining-context bands ---
function renderMetrics(usage, pressure) {
  const state = {
    ids: ['s1'],
    byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } },
    projectionsBySession: {
      s1: {
        state: 'ready',
        values: {
          ...(usage === null ? {} : { tokenUsage: usage }),
          ...(pressure === null ? {} : { contextPressure: pressure }),
        },
      },
    },
  };
  return Component({ ...props, useSessions: (selector) => selector(state) });
}

function metricsOf(rendered) {
  return rendered.children[1].children.filter((child) => child && child.props && child.props['data-usage-severity']);
}

function segmentText(segment) {
  const out = [];
  texts(segment, out);
  return out.join(' ');
}

const defaultMetrics = metricsOf(tree);
if (defaultMetrics.length !== 2) throw new Error('expected two metric segments');
if (defaultMetrics[0].props['data-usage-severity'] !== 'ok') throw new Error('5.5k tokens should be ok');
if (defaultMetrics[1].props['data-usage-severity'] !== 'ok') throw new Error('95% context should be ok');
if (!defaultMetrics[0].props.title.includes('用量正常')) throw new Error('usage title missing');
if (!defaultMetrics[1].props.title.includes('上下文充足')) throw new Error('context title missing');

const highUsage = renderMetrics(
  { uncachedInputTokens: 1_500_000 },
  { projectedTokens: 64_000, contextWindow: 128_000 },
);
const highSegments = metricsOf(highUsage);
console.log('high usage:', highSegments.map(segmentText).join(' | '));
if (highSegments[0].props['data-usage-severity'] !== 'low') throw new Error('1.5M should be high');
if (highSegments[1].props['data-usage-severity'] !== 'ok') throw new Error('50% context should be ok');
if (highSegments[0].children[1].props.style.background !== 'var(--dsw-alias-state-warn-primary)') throw new Error('high usage dot missing');
if (!highSegments[0].props.title.includes('用量偏高')) throw new Error('high usage title missing');
if (!highSegments[0].props['aria-label'].includes('用量偏高')) throw new Error('high usage aria missing');
if (!highSegments[0].children[2].props.style.color.includes('state-warn')) throw new Error('high usage text color missing');

const criticalUsage = renderMetrics(
  { uncachedInputTokens: 6_000_000 },
  { projectedTokens: 120_000, contextWindow: 128_000 },
);
const criticalSegments = metricsOf(criticalUsage);
console.log('critical usage:', criticalSegments.map(segmentText).join(' | '));
if (criticalSegments[0].props['data-usage-severity'] !== 'critical') throw new Error('6M should be critical');
if (criticalSegments[1].props['data-usage-severity'] !== 'critical') throw new Error('6% context should be critical');
if (criticalSegments[1].children[1].props.style.background !== 'var(--dsw-alias-state-error-primary)') throw new Error('context error dot missing');
if (!criticalSegments[1].props.title.includes('上下文预警')) throw new Error('critical context title missing');

// Both bands are inclusive at their lower boundary.
if (metricsOf(renderMetrics({ uncachedInputTokens: 1_000_000 }, null))[0].props['data-usage-severity'] !== 'low') throw new Error('1M should be high');
if (metricsOf(renderMetrics({ uncachedInputTokens: 5_000_000 }, null))[0].props['data-usage-severity'] !== 'critical') throw new Error('5M should be critical');

const contextAt = (projectedTokens) => metricsOf(renderMetrics(null, { projectedTokens, contextWindow: 100 }))[0];
if (contextAt(70).props['data-usage-severity'] !== 'ok') throw new Error('30% left should be ok');
if (contextAt(90).props['data-usage-severity'] !== 'low') throw new Error('10% left should be low');
if (contextAt(95).props['data-usage-severity'] !== 'critical') throw new Error('5% left should be critical');

// No usage projections leaves one neutral placeholder segment.
const noMetrics = metricsOf(Component({
  ...props,
  useSessions: (selector) => selector({ ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }),
}));
if (noMetrics.length !== 1) throw new Error('expected one placeholder segment');
if (noMetrics[0].props['data-usage-severity'] !== 'unknown') throw new Error('placeholder severity should be unknown');
if (segmentText(noMetrics[0]) !== '无活动会话') throw new Error('placeholder text mismatch: ' + segmentText(noMetrics[0]));

// click the balance span
const clickable = tree.children[0].children[1];
if (typeof clickable.props.onClick !== 'function') throw new Error('balance click missing');
clickable.props.onClick();
if (refreshCalls !== 1) throw new Error('refresh not wired');
console.log('smoke test OK');
