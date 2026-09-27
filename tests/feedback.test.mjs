import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import handler from '../api/feedback.mjs';

const originalFetch = globalThis.fetch;
const oldUrl = process.env.SUPABASE_URL;
const oldServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const oldSecretKey = process.env.SUPABASE_SECRET_KEY;
after(() => {
  globalThis.fetch = originalFetch;
  if (oldUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = oldUrl;
  if (oldServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = oldServiceKey;
  if (oldSecretKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = oldSecretKey;
});

function response() {
  return { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; }, json(body) { this.body = body; return this; } };
}

function request(body, ip = '192.0.2.42') {
  return { method: 'POST', headers: { 'x-real-ip': ip }, body };
}

test('feedback validates and writes privately through Supabase REST using server credentials', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co/';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_server-only-test-key';
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return { ok: true, status: 201 };
  };
  const res = response();
  await handler(request({ category: 'recommendation', message: '希望能多推荐一些店', contact: 'test@example.com', pagePath: '/demo' }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.ok, true);
  assert.equal(call.url, 'https://example.supabase.co/rest/v1/meal_feedback');
  assert.equal(call.options.headers.apikey, 'sb_secret_server-only-test-key');
  assert.equal('authorization' in call.options.headers, false);
  assert.deepEqual(JSON.parse(call.options.body), {
    category: 'recommendation', message: '希望能多推荐一些店', contact: 'test@example.com', page_path: '/demo',
  });
});

test('feedback rejects malformed content and quietly drops honeypot submissions', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_server-only-test-key';
  let writes = 0;
  globalThis.fetch = async () => { writes++; return { ok: true }; };
  const invalid = response();
  await handler(request({ category: 'not-real', message: 'x' }, '192.0.2.43'), invalid);
  assert.equal(invalid.statusCode, 400);
  const spam = response();
  await handler(request({ category: 'other', message: 'automated spam', company: 'filled' }, '192.0.2.44'), spam);
  assert.equal(spam.statusCode, 200);
  assert.equal(writes, 0);
});

test('feedback endpoint fails safely when Supabase is not configured', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = response();
  await handler(request({ category: 'other', message: '这是一个建议' }, '192.0.2.45'), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
});
