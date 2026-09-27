import { convertGps, distanceInMeters, geocode, normalizePoi, offsetPoint, radiusFor } from './restaurants.mjs';

const AMAP_URL = 'https://restapi.amap.com/v3/place/around';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MAX_AMAP_CALLS = 12;
const SEARCH_CACHE_TTL_MS = 3 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;
const searchCache = new Map();
const VALID_TASTES = new Set(['随便', '清淡', '香辣', '酸甜', '咸香']);
const VALID_NUTRITION = new Set(['none', 'light', 'lowcal', 'balanced', 'protein']);

function reply(res, status, body) {
  res.status(status).setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  return res.json(body);
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求内容无效');
  const radius = radiusFor(String(body.range || ''));
  const budget = Number(body.budget);
  const people = Number(body.people);
  const tastes = Array.isArray(body.tastes) ? body.tastes : [];
  const nutrition = String(body.nutrition || 'none');
  const location = body.location && typeof body.location === 'object' ? body.location : {};
  const lng = Number(location.lng);
  const lat = Number(location.lat);
  const hasCoords = location.lng != null && location.lat != null && Number.isFinite(lng) && Number.isFinite(lat)
    && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
  const address = typeof location.address === 'string' ? location.address.trim().slice(0, 100) : '';
  if (!radius || !Number.isFinite(budget) || budget < 10 || budget > 1000 ||
      !Number.isInteger(people) || people < 1 || people > 20 ||
      !tastes.every(t => VALID_TASTES.has(t)) || !VALID_NUTRITION.has(nutrition) ||
      (!hasCoords && (!address || address === '当前位置' || address === '已使用当前位置'))) {
    throw new Error('请检查地点、距离、人数和预算');
  }
  const excludePoiIds = Array.isArray(body.excludePoiIds)
    ? new Set(body.excludePoiIds.slice(0, 300).filter(id => typeof id === 'string' && /^[\w-]{2,40}$/.test(id)))
    : new Set();
  return { radius, budget, people, tastes, nutrition, lng, lat, hasCoords, address, excludePoiIds };
}

function withinBudget(poi, budget) {
  if (poi.cost == null || poi.cost <= 0) return true;
  const low = Math.max(10, Math.floor(budget * .75 / 5) * 5);
  const high = Math.ceil(budget * 1.2 / 5) * 5;
  return poi.cost >= low && poi.cost <= high;
}

function compatibleWithNutrition(poi, nutrition) {
  if (!['light', 'lowcal'].includes(nutrition)) return true;
  const label = `${poi.name} ${poi.type} ${poi.category}`;
  return !/(火锅|烧烤|烤肉|炸鸡|炸串|油炸|麻辣香锅|干锅)/.test(label);
}

function searchAreas(center, radius) {
  if (radius <= 1000) return [{ center, radius }];
  const bearings = [0, 120, 240];
  return [
    { center, radius },
    ...bearings.map(bearing => ({
      center: offsetPoint(center, radius * .68, bearing),
      radius: Math.min(3000, Math.round(radius * .38)),
    })),
  ];
}

async function amapSearch(area, keyword, key, signal) {
  const params = new URLSearchParams({
    key,
    location: `${area.center.lng.toFixed(6)},${area.center.lat.toFixed(6)}`,
    radius: String(area.radius),
    types: '050000',
    sortrule: 'distance',
    offset: '25',
    page: '1',
    extensions: 'all',
  });
  if (keyword) params.set('keywords', keyword);
  const response = await fetch(`${AMAP_URL}?${params}`, { signal });
  if (!response.ok) throw new Error(`AMap HTTP ${response.status}`);
  const data = await response.json();
  if (data.status !== '1') throw new Error(`AMap ${data.info || 'search failed'}`);
  return Array.isArray(data.pois) ? data.pois : [];
}

async function cachedAmapSearch(area, keyword, key, signal, diagnostics) {
  const cacheKey = [key, area.center.lng.toFixed(4), area.center.lat.toFixed(4), area.radius, keyword].join(':');
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL_MS) {
    diagnostics.cacheHits++;
    return cached.promise;
  }
  diagnostics.amapCalls++;
  const promise = amapSearch(area, keyword, key, signal);
  searchCache.set(cacheKey, { createdAt: Date.now(), promise });
  try {
    const pois = await promise;
    if (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
      const oldestKey = searchCache.keys().next().value;
      if (oldestKey !== cacheKey) searchCache.delete(oldestKey);
    }
    return pois;
  } catch (error) {
    searchCache.delete(cacheKey);
    throw error;
  }
}

function publicPoi(poi) {
  return { id: poi.id, name: poi.name, type: poi.type, category: poi.category,
    distance: poi.distance, cost: poi.cost, address: poi.address };
}

function safeReason(code, poi) {
  if (code === 'taste') return '店名或类型与想吃的口味有关，具体菜品请到店确认';
  if (code === 'nutrition') return '店名或类型有相关线索，实际做法与营养信息请到店确认';
  if (code === 'group') return '店铺类型可能适合一起吃，座位和菜单请到店确认';
  if (code === 'budget') return poi.cost == null ? '暂无人均价格，到店前建议确认' : `高德参考人均 ¥${poi.cost}，请以店内实际价格为准`;
  return `距你约 ${poi.distance < 1000 ? `${poi.distance} 米` : `${(poi.distance / 1000).toFixed(1)} 公里`}，具体菜品请到店确认`;
}

async function deepseek(messages, key, signal) {
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    // DeepSeek defaults to thinking mode. Keeping it enabled requires replaying
    // reasoning_content on every tool turn; this flow intentionally uses the
    // simpler non-thinking tool-call protocol.
    body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: .3, max_tokens: 900,
      messages, response_format: { type: 'json_object' } }),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const providerMessage = String(payload?.error?.message || payload?.message || '')
      .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[hidden]')
      .slice(0, 180);
    const error = new Error(`DEEPSEEK_HTTP_${response.status}`);
    error.providerMessage = providerMessage;
    throw error;
  }
  const data = await response.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('DeepSeek response empty');
  return message;
}

function fallbackKeywords(input) {
  if (input.nutrition === 'light' || input.nutrition === 'lowcal' || input.tastes.includes('清淡')) return ['轻食', '沙拉'];
  if (input.nutrition === 'protein') return ['高蛋白', '鸡肉'];
  const tasteWords = { 香辣: ['川菜', '湘菜'], 酸甜: ['糖醋', '酸甜'], 咸香: ['烧烤', '卤味'] };
  return input.tastes.flatMap(taste => tasteWords[taste] || []).slice(0, 2);
}

function parseKeywords(content, input) {
  try {
    const parsed = JSON.parse(String(content || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed.keywords)) return fallbackKeywords(input);
    const keywords = [...new Set(parsed.keywords
      .filter(value => typeof value === 'string')
      .map(value => value.trim().slice(0, 20))
      .filter(value => value && /^[\p{L}\p{N}\s·_-]+$/u.test(value)))].slice(0, 2);
    return keywords.length ? keywords : fallbackKeywords(input);
  } catch { return fallbackKeywords(input); }
}

function fallbackSelection(candidates, radius) {
  const buckets = [[], [], []];
  for (const poi of candidates.values()) buckets[Math.min(2, Math.floor(poi.distance / radius * 3))].push(poi);
  const selected = [];
  for (const bucket of buckets) {
    if (bucket.length && selected.length < 3) selected.push(bucket[Math.floor(Math.random() * bucket.length)]);
  }
  const remaining = [...candidates.values()].filter(poi => !selected.some(item => item.id === poi.id));
  while (selected.length < 3 && remaining.length) {
    selected.push(remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0]);
  }
  return selected;
}

async function recommend(input, amapKey, aiKey, signal) {
  let center;
  if (input.hasCoords) center = await convertGps(input.lng, input.lat, amapKey, signal);
  else center = await geocode(input.address, amapKey, signal);
  if (!center) throw new Error('LOCATION_NOT_FOUND');
  const candidates = new Map();
  // Coordinate conversion or geocoding above also consumes one AMap call.
  const diagnostics = { searchRounds: 1, searchRequests: 0, amapCalls: 1, aiCalls: 0, aiDurationMs: 0, cacheHits: 0,
    poisReturned: 0, eligibleCandidates: 0, partial: false, aiPlanFallback: false, aiSelectionFallback: false };
  const budgetRange = [Math.max(10, Math.floor(input.budget * .75 / 5) * 5), Math.ceil(input.budget * 1.2 / 5) * 5];
  const preferences = { distanceMeters: input.radius, people: input.people, perPersonBudget: input.budget,
    budgetRange, tastes: input.tastes, nutrition: input.nutrition };
  let keywords;
  diagnostics.aiCalls++;
  let aiStarted = Date.now();
  try {
    const plan = await deepseek([
      { role: 'system', content: '你负责为高德餐饮 POI 搜索规划关键词。根据用户口味和营养偏好返回 JSON：{"keywords":["词1","词2"]}，最多两个短中文关键词。不要返回地名、距离、价格或其他字段。无明确偏好时返回空数组。' },
      { role: 'user', content: JSON.stringify(preferences) },
    ], aiKey, signal);
    keywords = parseKeywords(plan.content, input);
    diagnostics.aiPlanFallback = keywords.length > 0 && JSON.stringify(keywords) === JSON.stringify(fallbackKeywords(input));
  } catch (error) {
    if (signal.aborted) throw error;
    diagnostics.aiPlanFallback = true;
    keywords = fallbackKeywords(input);
  } finally {
    diagnostics.aiDurationMs += Date.now() - aiStarted;
  }
  const areas = searchAreas(center, input.radius);
  const terms = ['', keywords.join('|')].filter((value, index, all) => index === 0 || Boolean(value));
  const queries = terms.flatMap(keyword => areas.map(area => ({ area, keyword })))
    .slice(0, MAX_AMAP_CALLS - diagnostics.amapCalls);
  diagnostics.searchRequests = queries.length;
  const amapStarted = Date.now();
  const results = await Promise.allSettled(queries.map(({ area, keyword }) => cachedAmapSearch(area, keyword, amapKey, signal, diagnostics)));
  diagnostics.amapDurationMs = Date.now() - amapStarted;
  let succeeded = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') { diagnostics.partial = true; continue; }
    succeeded++;
    diagnostics.poisReturned += result.value.length;
    for (const raw of result.value) {
      const poi = normalizePoi(raw, center);
      if (poi && typeof poi.id === 'string' && poi.type.includes('餐饮服务') && compatibleWithNutrition(poi, input.nutrition) &&
        poi.distance <= input.radius && withinBudget(poi, input.budget) && !input.excludePoiIds.has(poi.id)) {
        candidates.set(poi.id, poi);
      }
    }
  }
  if (!succeeded) throw new Error('AMAP_SEARCH_FAILED');
  diagnostics.eligibleCandidates = candidates.size;
  if (!candidates.size) return { restaurants: [], diagnostics };

  const buckets = [[], [], []];
  for (const poi of candidates.values()) buckets[Math.min(2, Math.floor(poi.distance / input.radius * 3))].push(poi);
  const sampled = buckets.flatMap(bucket => bucket.slice(0, 25));
  let choices;
  diagnostics.aiCalls++;
  aiStarted = Date.now();
  try {
    const selection = await deepseek([
      { role: 'system', content: '你是选餐厅助手。只能从提供的真实高德 POI 中选择最多三家。不要编造评分、热量、价格或营养数据；店名和类型只是线索。返回 JSON：{"choices":[{"id":"原始POI ID","reasonCode":"taste|nutrition|group|budget|distance"}]}。如果偏好线索不足，仍可选择合理候选并使用 distance。' },
      { role: 'user', content: JSON.stringify({ ...preferences, restaurants: sampled.map(publicPoi) }) },
    ], aiKey, signal);
    const parsed = JSON.parse(String(selection.content || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(parsed.choices)) throw new Error('AI_INVALID_OUTPUT');
    choices = parsed.choices;
  } catch (error) {
    if (signal.aborted) throw error;
    diagnostics.aiSelectionFallback = true;
    choices = fallbackSelection(candidates, input.radius).map(poi => ({ id: poi.id, reasonCode: 'distance' }));
  } finally {
    diagnostics.aiDurationMs += Date.now() - aiStarted;
  }
  const seen = new Set();
  const restaurants = [];
  for (const choice of choices) {
    const poi = candidates.get(choice?.id);
    if (!poi || seen.has(poi.id) || poi.distance > input.radius ||
      !withinBudget(poi, input.budget) || !compatibleWithNutrition(poi, input.nutrition) || input.excludePoiIds.has(poi.id)) continue;
    seen.add(poi.id);
    restaurants.push({ ...poi, reason: safeReason(choice.reasonCode, poi) });
    if (restaurants.length === 3) break;
  }
  if (!restaurants.length && candidates.size && !diagnostics.aiSelectionFallback) {
    diagnostics.aiSelectionFallback = true;
    for (const poi of fallbackSelection(candidates, input.radius)) {
      restaurants.push({ ...poi, reason: safeReason('distance', poi) });
    }
  }
  return { restaurants, diagnostics };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return reply(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 POST 请求' });
  }
  let input;
  try { input = validate(req.body); }
  catch (error) { return reply(res, 400, { ok: false, code: 'INVALID_INPUT', message: error.message }); }
  const amapKey = process.env.AMAP_WEB_KEY;
  const aiKey = process.env.DEEPSEEK_API_KEY;
  if (!amapKey || !aiKey) return reply(res, 503, { ok: false, code: 'AI_NOT_CONFIGURED', message: 'Vercel Production 尚未配置 DEEPSEEK_API_KEY，请保存变量并重新部署' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const startedAt = Date.now();
  try {
    const result = await recommend(input, amapKey, aiKey, controller.signal);
    result.diagnostics.durationMs = Date.now() - startedAt;
    return reply(res, 200, { ok: true, source: 'deepseek-amap', ...result });
  } catch (error) {
    console.error('AI restaurant recommendation failed', error);
    const locationFailed = error.message === 'LOCATION_NOT_FOUND';
    const statusMatch = error.message.match(/^DEEPSEEK_HTTP_(\d{3})$/);
    const providerStatus = statusMatch ? Number(statusMatch[1]) : null;
    const errorCode = locationFailed ? 'LOCATION_NOT_FOUND'
      : providerStatus === 401 ? 'DEEPSEEK_KEY_INVALID'
      : providerStatus === 402 ? 'DEEPSEEK_BALANCE_LOW'
      : providerStatus === 429 ? 'DEEPSEEK_RATE_LIMIT'
      : providerStatus === 400 ? 'DEEPSEEK_REQUEST_INVALID'
      : providerStatus === 404 ? 'DEEPSEEK_MODEL_UNAVAILABLE'
      : error.name === 'AbortError' ? 'AI_TIMEOUT'
      : error.message === 'AMAP_SEARCH_FAILED' ? 'AMAP_SEARCH_FAILED'
      : error.message === 'AI_INVALID_OUTPUT' ? 'AI_INVALID_OUTPUT'
      : error.message === 'AI_NO_VALID_CHOICES' ? 'AI_NO_VALID_CHOICES'
      : 'AI_UNAVAILABLE';
    const messages = {
      LOCATION_NOT_FOUND: '找不到这个地点，请换个具体地址',
      DEEPSEEK_KEY_INVALID: 'DeepSeek Key 无效或未开通 API，请检查 Vercel 环境变量',
      DEEPSEEK_BALANCE_LOW: 'DeepSeek API 账户余额不足，请到开放平台查看',
      DEEPSEEK_RATE_LIMIT: 'DeepSeek API 暂时限流，请稍后重试',
      DEEPSEEK_REQUEST_INVALID: 'DeepSeek API 拒绝了请求，请检查 API 配置',
      DEEPSEEK_MODEL_UNAVAILABLE: 'DeepSeek 当前模型不可用，请联系维护者检查配置',
      AI_TIMEOUT: 'AI 搜索超时，已尝试使用常规搜索',
      AMAP_SEARCH_FAILED: '高德搜索暂时失败，已尝试使用常规搜索',
      AI_INVALID_OUTPUT: 'AI 返回格式异常，已尝试使用常规搜索',
      AI_NO_VALID_CHOICES: 'AI 没有从真实搜索结果中选出有效餐厅，已尝试使用常规搜索',
      AI_UNAVAILABLE: 'AI 服务暂时不可用，已尝试使用常规搜索',
    };
    const message = `${messages[errorCode] || messages.AI_UNAVAILABLE}${error.providerMessage ? `（${error.providerMessage}）` : ''}`;
    return reply(res, locationFailed ? 400 : 502, { ok: false, code: errorCode,
      message });
  } finally { clearTimeout(timer); }
}
