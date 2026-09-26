import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import handler from '../api/restaurants.mjs';

const oldFetch = globalThis.fetch;
const oldKey = process.env.AMAP_WEB_KEY;
after(() => {
  globalThis.fetch = oldFetch;
  if (oldKey === undefined) delete process.env.AMAP_WEB_KEY;
  else process.env.AMAP_WEB_KEY = oldKey;
});

function response() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    setHeader() { return this; },
    json(value) { this.body = value; return this; },
  };
}

test('10km search keeps distant restaurants when one sampled area fails', async () => {
  process.env.AMAP_WEB_KEY = 'test-key';
  let requests = 0;
  const requestedRadii = [];
  globalThis.fetch = async url => {
    requests++;
    const params = new URL(url).searchParams;
    requestedRadii.push(Number(params.get('radius')));
    const [lng, lat] = params.get('location').split(',').map(Number);
    if (lng > 121.46) throw new Error('sample area unavailable');
    const far = lat > 31.27;
    return {
      ok: true,
      json: async () => ({ status: '1', pois: [{
        id: far ? 'far' : 'near',
        name: far ? '远一点的餐厅' : '楼下的餐厅',
        location: far ? '121.445839,31.286000' : '121.445839,31.223600',
        distance: '1', // 高德的 distance 相对每次查询中心，不能用于用户距离。
        biz_ext: { cost: '50' },
      }] }),
    };
  };
  const res = response();
  await handler({ method: 'GET', query: { range: 'all', lng: '121.445839', lat: '31.223167' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.partial, true);
  assert.equal(requests, 5);
  assert.ok(requestedRadii.includes(5000));
  assert.ok(res.body.restaurants.some(item => item.id === 'far' && item.distance > 6000));
  assert.ok(res.body.restaurants.some(item => item.id === 'near' && item.distance < 100));
});

test('all failed queries are reported as an upstream error', async () => {
  process.env.AMAP_WEB_KEY = 'test-key';
  globalThis.fetch = async () => { throw new Error('network unavailable'); };
  const res = response();
  await handler({ method: 'GET', query: { range: 'all', lng: '120.445839', lat: '30.223167' } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'AMAP_ERROR');
  assert.equal(res.body.ok, false);
});

test('light theme sends a targeted AMap keyword query', async () => {
  process.env.AMAP_WEB_KEY = 'test-key';
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(new URL(url));
    return { ok: true, json: async () => ({ status: '1', pois: [{
      id: 'salad', name: '轻食沙拉', location: '121.445839,31.223200',
      biz_ext: { cost: '45' },
    }] }) };
  };
  const res = response();
  await handler({ method: 'GET', query: { range: '1', theme: 'light', lng: '121.445839', lat: '31.223167' } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.restaurants[0].name, '轻食沙拉');
  assert.equal(urls.length, 1);
  assert.match(urls[0].searchParams.get('keywords'), /轻食\|沙拉/);
  assert.equal(urls[0].searchParams.has('types'), false);
});

test('protein theme searches ingredient keywords and excludes non-restaurants', async () => {
  process.env.AMAP_WEB_KEY = 'test-key';
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(new URL(url));
    return { ok: true, json: async () => ({ status: '1', pois: [
      { id: 'chicken', name: '鸡肉饭', type: '餐饮服务;快餐厅', location: '121.445839,31.223200', biz_ext: { cost: '45' } },
      { id: 'market', name: '鸡肉专卖', type: '购物服务;市场', location: '121.445839,31.223300' },
    ] }) };
  };
  const res = response();
  await handler({ method: 'GET', query: { range: '1', theme: 'protein', lng: '121.445839', lat: '31.223167' } }, res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.restaurants.map(item => item.id), ['chicken']);
  assert.equal(urls.length, 2);
  assert.match(urls[0].searchParams.get('keywords'), /牛肉\|鸡肉/);
  assert.equal(urls[0].searchParams.has('types'), false);
  assert.equal(urls[1].searchParams.get('types'), '050000');
});

test('a full first page fetches the second page and reports candidate counts', async () => {
  process.env.AMAP_WEB_KEY = 'test-key';
  const pages = [];
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    const start = (page - 1) * 25;
    const size = page === 1 ? 25 : 2;
    return { ok: true, json: async () => ({
      status: '1', count: '27',
      pois: Array.from({ length: size }, (_, index) => ({
        id: `poi-${start + index}`, name: `餐厅${start + index}`,
        location: '119.000100,29.000100', type: '餐饮服务;中餐厅',
      })),
    }) };
  };
  const res = response();
  await handler({ method: 'GET', query: { range: '1', lng: '119', lat: '29' } }, res);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(res.body.restaurants.length, 27);
  assert.deepEqual(res.body.diagnostics, {
    areasRequested: 1, areasSucceeded: 1, pagesAttempted: 2,
    poisReturned: 27, restaurantsAfterDedup: 27,
  });
  assert.equal(res.body.partial, false);
  assert.equal(res.body.truncated, false);
});

test('a failed extra page preserves the first page but is not cached', async () => {
  process.env.AMAP_WEB_KEY = 'test-key';
  const pages = [];
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    if (page === 2) throw new Error('temporary page failure');
    return { ok: true, json: async () => ({
      status: '1', count: '50',
      pois: Array.from({ length: 25 }, (_, index) => ({
        id: `first-${index}`, name: `餐厅${index}`,
        location: '118.000100,28.000100', type: '餐饮服务;中餐厅',
      })),
    }) };
  };
  const query = { range: '1', lng: '118', lat: '28' };
  const first = response();
  const second = response();
  await handler({ method: 'GET', query }, first);
  await handler({ method: 'GET', query }, second);
  assert.deepEqual(pages, [1, 2, 1, 2]);
  assert.equal(first.body.restaurants.length, 25);
  assert.equal(first.body.partial, true);
  assert.equal(second.body.cached, undefined);
});
