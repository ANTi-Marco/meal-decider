import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import handler from '../api/recommend.mjs';

const originalFetch = globalThis.fetch;
const oldAmap = process.env.AMAP_WEB_KEY;
const oldDeepSeek = process.env.DEEPSEEK_API_KEY;
after(() => {
  globalThis.fetch = originalFetch;
  if (oldAmap === undefined) delete process.env.AMAP_WEB_KEY;
  else process.env.AMAP_WEB_KEY = oldAmap;
  if (oldDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = oldDeepSeek;
});

function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; },
    setHeader() { return this; }, json(body) { this.body = body; return this; } };
}

function request(overrides = {}) {
  return { method: 'POST', body: { range: '5', people: 2, budget: 50,
    tastes: ['清淡'], nutrition: 'light', location: { lng: 121.445839, lat: 31.223167 },
    excludePoiIds: [], ...overrides } };
}

function poi(id, lng, lat, cost = '45') {
  return { id, name: `餐厅${id}`, type: '餐饮服务;中餐厅', location: `${lng},${lat}`,
    address: '测试路', biz_ext: cost == null ? {} : { cost } };
}

let keySequence = 0;
function mockApi({ keywords = ['清淡', '轻食'], pois = [], choices = [], convert = '121.445839,31.223167', deepseekStatus = null, selectionStatus = null, delayedAmap = false }) {
  process.env.AMAP_WEB_KEY = 'test-amap';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek';
  process.env.AMAP_WEB_KEY = `test-amap-${++keySequence}`;
  const calls = { amap: [], ai: [], convert: 0, parallel: false };
  let activeAmap = 0;
  let maxActiveAmap = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/coordinate/convert')) {
      calls.convert++;
      return { ok: true, json: async () => ({ status: '1', locations: convert }) };
    }
    if (path.includes('/place/around')) {
      const params = new URL(path).searchParams;
      calls.amap.push(params);
      const keyword = params.get('keywords') || '';
      activeAmap++;
      maxActiveAmap = Math.max(maxActiveAmap, activeAmap);
      if (delayedAmap) await new Promise(resolve => setTimeout(resolve, 8));
      activeAmap--;
      calls.parallel = maxActiveAmap > 1;
      return { ok: true, json: async () => ({ status: '1', pois: typeof pois === 'function' ? pois(keyword, calls.amap.length) : pois }) };
    }
    if (path.includes('deepseek')) {
      const body = JSON.parse(options.body);
      calls.ai.push(body);
      if (deepseekStatus || (selectionStatus && calls.ai.length % 2 === 0)) return { ok: false, status: deepseekStatus || selectionStatus, json: async () => ({}) };
      const message = calls.ai.length % 2 === 1
        ? { content: JSON.stringify({ keywords }) }
        : { content: JSON.stringify({ choices }) };
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    }
    throw new Error(`Unexpected URL ${path}`);
  };
  return calls;
}

test('AI plans two keywords once, AMap searches them in parallel, and AI selects real POIs', async () => {
  const calls = mockApi({ keywords: ['轻食', '沙拉'], delayedAmap: true,
    pois: keyword => keyword.includes('轻食') ? [poi('real-1', 121.45, 31.224)] : [],
    choices: [{ id: 'real-1', reasonCode: 'taste' }] });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['real-1']);
  assert.equal(res.body.diagnostics.searchRounds, 1);
  assert.equal(res.body.diagnostics.aiCalls, 2);
  assert.equal(res.body.diagnostics.amapCalls, 9);
  assert.equal(res.body.diagnostics.searchRequests, 8);
  assert.equal(calls.parallel, true);
  assert.equal(calls.convert, 1);
  assert.equal(calls.ai[0].messages[1].content.includes('121.445839'), false);
  assert.ok(calls.ai.every(body => body.thinking?.type === 'disabled'));
  assert.deepEqual(calls.ai[0].response_format, { type: 'json_object' });
  assert.equal(calls.ai[1].messages[1].content.includes('real-1'), true);
});

test('1km search uses one area per keyword and selector request requires JSON', async () => {
  const calls = mockApi({ keywords: ['a', 'b'], pois: [poi('real-1', 121.45, 31.224)],
    choices: [{ id: 'real-1', reasonCode: 'taste' }] });
  const res = response();
  await handler(request({ range: '1' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.ai.length, 2);
  assert.equal(calls.amap.length, 2);
  assert.deepEqual(calls.ai[1].response_format, { type: 'json_object' });
});

test('search count stays under twelve AMap calls including coordinate conversion', async () => {
  const calls = mockApi({ keywords: ['a', 'b'], pois: [poi('real-1', 121.45, 31.224)],
    choices: [{ id: 'real-1', reasonCode: 'distance' }] });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.amap.length, 8);
  assert.equal(calls.amap.length + calls.convert, 9);
  assert.equal(res.body.diagnostics.searchRequests, 8);
  assert.equal(calls.ai.length, 2);
  assert.ok(calls.amap.every(params => params.get('types') === '050000'));
});

test('repeated identical searches reuse short-lived POI results but still filter and select anew', async () => {
  const calls = mockApi({ keywords: ['轻食'], pois: [poi('cached-poi', 121.45, 31.224)],
    choices: [{ id: 'cached-poi', reasonCode: 'distance' }] });
  const first = response();
  const second = response();
  await handler(request({ range: '1' }), first);
  await handler(request({ range: '1' }), second);
  assert.equal(first.body.restaurants[0].id, 'cached-poi');
  assert.equal(second.body.restaurants[0].id, 'cached-poi');
  assert.equal(calls.amap.length, 2);
  assert.equal(second.body.diagnostics.cacheHits, 2);
  assert.equal(second.body.diagnostics.amapCalls, 1);
  assert.equal(calls.ai.length, 4);
});

test('selection timeout uses already fetched candidates instead of requiring another search', async () => {
  const calls = mockApi({ keywords: ['面馆'], pois: [poi('candidate', 121.45, 31.224)], selectionStatus: 503 });
  const res = response();
  await handler(request({ range: '1' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['candidate']);
  assert.equal(res.body.diagnostics.aiSelectionFallback, true);
  assert.equal(calls.amap.length, 2);
  assert.equal(calls.ai.length, 2);
});

test('backend rejects out-of-range, out-of-budget, repeated and invented POIs', async () => {
  mockApi({ rounds: [['餐厅']], pois: [
    poi('good', 121.45, 31.224), poi('far', 121.45, 31.4),
    poi('expensive', 121.45, 31.225, '120'), poi('repeat', 121.45, 31.226),
  ], choices: ['fake', 'far', 'expensive', 'repeat', 'good'].map(id => ({ id, reasonCode: 'budget' })) });
  const res = response();
  await handler(request({ excludePoiIds: ['repeat'] }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['good']);
});

test('light nutrition deterministically excludes hotpot and barbecue from AI picks', async () => {
  mockApi({ rounds: [['轻食']], pois: [
    { ...poi('hotpot', 121.45, 31.224), name: '谷田稻香', type: '餐饮服务;火锅店' },
    { ...poi('salad', 121.451, 31.224), name: '清爽轻食沙拉', type: '餐饮服务;快餐厅' },
  ], choices: [{ id: 'hotpot', reasonCode: 'taste' }, { id: 'salad', reasonCode: 'nutrition' }] });
  const res = response();
  await handler(request({ nutrition: 'light' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['salad']);
});

test('unknown cost is preserved as null, and fewer than three results are honest', async () => {
  mockApi({ rounds: [['餐厅']], pois: [poi('unknown', 121.45, 31.224, null)],
    choices: [{ id: 'unknown', reasonCode: 'budget' }] });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.restaurants.length, 1);
  assert.equal(res.body.restaurants[0].cost, null);
  assert.match(res.body.restaurants[0].reason, /暂无人均价格/);
});

test('missing DeepSeek key returns a recoverable status for frontend fallback', async () => {
  delete process.env.DEEPSEEK_API_KEY;
  process.env.AMAP_WEB_KEY = 'test-amap';
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'AI_NOT_CONFIGURED');
});

test('DeepSeek selection authentication failure falls back to verified AMap candidates', async () => {
  const calls = mockApi({ keywords: ['轻食'], pois: [poi('verified-fallback', 121.45, 31.224)], selectionStatus: 401 });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['verified-fallback']);
  assert.equal(res.body.diagnostics.aiSelectionFallback, true);
  assert.equal(calls.ai.length, 2);
  assert.doesNotMatch(JSON.stringify(res.body), /test-deepseek|Bearer/);
});

test('AI recommendations demote a disliked category and prefer a liked one without inventing POIs', async () => {
  const calls = mockApi({ pois: [
    { ...poi('hotpot', 121.45, 31.224), type: '餐饮服务;火锅店' },
    { ...poi('noodle', 121.451, 31.224), type: '餐饮服务;面馆' },
    { ...poi('simple', 121.452, 31.224), type: '餐饮服务;快餐厅' },
  ], choices: [{ id: 'hotpot', reasonCode: 'taste' }, { id: 'noodle', reasonCode: 'taste' }] });
  const res = response();
  await handler(request({ range: '1', tastes: ['随便'], nutrition: 'none', feedbackPreferences: {
    categories: [{ category: '火锅店', score: -4 }, { category: '面馆', score: 1 }], items: [],
  } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['noodle', 'simple']);
  assert.ok(calls.ai[1].messages[1].content.includes('feedbackPriority'));
});
