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

function mockApi({ rounds = [['清淡', '轻食', '沙拉']], pois = [], choices = [], convert = '121.445839,31.223167', deepseekStatus = null }) {
  process.env.AMAP_WEB_KEY = 'test-amap';
  process.env.DEEPSEEK_API_KEY = 'test-deepseek';
  const calls = { amap: [], ai: [], convert: 0 };
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
      return { ok: true, json: async () => ({ status: '1', pois: typeof pois === 'function' ? pois(keyword, calls.amap.length) : pois }) };
    }
    if (path.includes('deepseek')) {
      const body = JSON.parse(options.body);
      calls.ai.push(body);
      if (deepseekStatus) return { ok: false, status: deepseekStatus, json: async () => ({}) };
      const index = calls.ai.length - 1;
      const keyword = body.tool_choice === 'none' ? undefined : rounds[0]?.[index];
      const message = keyword === undefined
        ? { content: JSON.stringify({ choices }) }
        : { content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: {
          name: 'searchRestaurants', arguments: JSON.stringify({ keyword }),
        } }] };
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    }
    throw new Error(`Unexpected URL ${path}`);
  };
  return calls;
}

test('AI changes search terms and receives real POI candidates', async () => {
  const calls = mockApi({ rounds: [['清淡', '轻食']],
    pois: keyword => keyword === '轻食' ? [poi('real-1', 121.45, 31.224)] : [],
    choices: [{ id: 'real-1', reasonCode: 'taste' }] });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['real-1']);
  assert.equal(res.body.diagnostics.searchRounds, 2);
  assert.equal(res.body.diagnostics.amapCalls, 9);
  assert.equal(calls.convert, 1);
  assert.equal(calls.ai[0].messages[1].content.includes('121.445839'), false);
});

test('at most three rounds and twelve AMap calls, even if AI wants more', async () => {
  const calls = mockApi({ rounds: [['a', 'b', 'c', 'd']], pois: [poi('real-1', 121.45, 31.224)],
    choices: [{ id: 'real-1', reasonCode: 'distance' }] });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.amap.length, 11);
  assert.equal(calls.amap.length + calls.convert, 12);
  assert.equal(res.body.diagnostics.searchRounds, 3);
  assert.equal(calls.ai.at(-1).tool_choice, 'none');
  assert.ok(calls.amap.every(params => params.get('types') === '050000'));
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

test('DeepSeek authentication failures return a safe actionable error code', async () => {
  mockApi({ deepseekStatus: 401 });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'DEEPSEEK_KEY_INVALID');
  assert.doesNotMatch(res.body.message, /test-deepseek|Bearer/);
});
