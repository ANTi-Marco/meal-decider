const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const PAGE_SIZE = 25;
const MAX_PAGES_PER_AREA = 2;

function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(status).json(body);
}

function radiusFor(value) {
  switch (value) {
    case '1': return 1000;
    case '3': return 3000;
    case '5': return 5000;
    case 'all': return 10000;
    default: return null;
  }
}

async function geocode(address, key) {
  const params = new URLSearchParams({ key, address });
  const response = await fetch(`https://restapi.amap.com/v3/geocode/geo?${params}`);
  if (!response.ok) return null;
  const data = await response.json();
  const location = data.geocodes?.[0]?.location;
  if (data.status !== '1' || !location) return null;
  const [lng, lat] = location.split(',').map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

function distanceInMeters(a, b) {
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

function offsetPoint(center, meters, bearing) {
  const angle = bearing * Math.PI / 180;
  return {
    lng: center.lng + meters * Math.sin(angle) / (111320 * Math.max(0.01, Math.cos(center.lat * Math.PI / 180))),
    lat: center.lat + meters * Math.cos(angle) / 111320,
  };
}

function searchAreas(center, radius) {
  if (radius <= 1000) return [{ center, radius }];
  const outerRadius = Math.min(Math.round(radius * 0.3), 2500);
  return [
    { center, radius },
    // A larger AMap search has a different first page; include the inner area
    // explicitly so 10km does not lose restaurants found by the 5km search.
    ...(radius > 5000 ? [{ center, radius: 5000 }] : []),
    ...[0, 120, 240].map(bearing => ({
      center: offsetPoint(center, radius * 0.7, bearing),
      radius: outerRadius,
    })),
  ];
}

function normalizePoi(poi, center) {
  const [lng, lat] = String(poi.location || '').split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const costValue = poi.biz_ext?.cost;
  const cost = costValue == null || costValue === '' ? null : Number(costValue);
  return {
    id: poi.id,
    name: poi.name,
    address: poi.address || '',
    category: poi.type?.split(';').pop() || '餐厅',
    type: poi.type || '餐饮服务',
    distance: distanceInMeters(center, { lng, lat }),
    cost: Number.isFinite(cost) ? cost : null,
    location: { lng, lat },
    tel: poi.tel || '',
  };
}

async function searchArea(area, key, keywords) {
  const pois = [];
  let pagesAttempted = 0;
  let pageFailed = false;
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES_PER_AREA; page++) {
    const params = new URLSearchParams({
      key,
      location: `${area.center.lng.toFixed(6)},${area.center.lat.toFixed(6)}`,
      radius: String(area.radius),
      sortrule: 'distance',
      offset: String(PAGE_SIZE),
      page: String(page),
      extensions: 'all',
    });
    // Dietary keywords are queried separately from the broad restaurant type.
    if (keywords) params.set('keywords', keywords);
    else params.set('types', '050000');
    pagesAttempted++;
    try {
      const response = await fetch(`https://restapi.amap.com/v3/place/around?${params}`);
      if (!response.ok) throw new Error(`AMap HTTP ${response.status}`);
      const data = await response.json();
      if (data.status !== '1') throw new Error(`AMap ${data.info || 'query failed'}`);
      const pagePois = Array.isArray(data.pois) ? data.pois : [];
      pois.push(...pagePois);
      const total = Number(data.count);
      const hasMore = pagePois.length === PAGE_SIZE && (!Number.isFinite(total) || total > page * PAGE_SIZE);
      if (!hasMore) break;
      if (page === MAX_PAGES_PER_AREA) truncated = true;
    } catch (error) {
      if (page === 1) throw error;
      console.warn('amap extra page unavailable', error);
      pageFailed = true;
      break;
    }
  }
  return { pois, pagesAttempted, pageFailed, truncated };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET 请求' });
  }

  const key = process.env.AMAP_WEB_KEY;
  if (!key) {
    return json(res, 503, { ok: false, code: 'AMAP_NOT_CONFIGURED', message: '高德服务还没有配置' });
  }

  const range = String(req.query.range || '1');
  const radius = radiusFor(range);
  if (!radius) {
    return json(res, 400, { ok: false, code: 'INVALID_RANGE', message: '距离范围无效' });
  }
  const theme = ['light', 'protein'].includes(req.query.theme) ? req.query.theme : '';
  const keywords = theme === 'light'
    ? '轻食|沙拉|健康餐|低脂|减脂|素食|蔬食|健身餐|鸡胸肉'
    : theme === 'protein' ? '牛肉|鸡肉|鸡蛋|鱼|虾|海鲜|豆腐|牛排' : '';

  let lng = Number(req.query.lng);
  let lat = Number(req.query.lat);
  if (req.query.lng == null || req.query.lat == null || req.query.lng === '' || req.query.lat === '') {
    lng = Number.NaN;
    lat = Number.NaN;
  }
  const hasCoords = Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
  const address = String(req.query.address || '').trim().slice(0, 100);

  if (!hasCoords && address && address !== '当前位置' && address !== '已使用当前位置') {
    try {
      const point = await geocode(address, key);
      if (point) ({ lng, lat } = point);
    } catch (error) {
      console.error('amap geocode failed', error);
    }
  }

  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
    return json(res, 400, { ok: false, code: 'LOCATION_REQUIRED', message: '请开启定位或输入城市、商圈或地点' });
  }

  const cacheKey = `${lng.toFixed(4)},${lat.toFixed(4)}:${radius}:${theme}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return json(res, 200, { ...cached.body, cached: true });
  }

  try {
    const origin = { lng, lat };
    const areas = searchAreas(origin, radius);
    const queries = areas.map(area => ({ area, keywords }));
    // Keep one broad page for clearly labelled alternatives when a targeted
    // protein search has too few restaurants at the chosen budget.
    if (theme === 'protein') queries.push({ area: { center: origin, radius: Math.min(radius, 5000) }, keywords: '' });
    const results = [];
    // 每次最多并发两个请求；一片区域失败时仍可使用其他区域的结果。
    for (let index = 0; index < queries.length; index += 2) {
      results.push(...await Promise.allSettled(queries.slice(index, index + 2).map(query => searchArea(query.area, key, query.keywords))));
    }
    const successes = results.filter(result => result.status === 'fulfilled');
    if (!successes.length) {
      console.error('amap nearby search failed', results.map(result => result.reason?.message));
      return json(res, 502, { ok: false, code: 'AMAP_ERROR', message: '高德餐厅查询失败，请稍后再试' });
    }
    const partial = successes.length < queries.length || successes.some(result => result.value.pageFailed);
    const restaurants = [...new Map(successes.flatMap(result => result.value.pois)
      .map(poi => normalizePoi(poi, origin))
      .filter(poi => poi && poi.id && poi.distance <= radius && (!theme || poi.type.includes('餐饮服务')))
      .map(poi => [poi.id, poi])).values()];

    const body = {
      ok: true,
      source: 'amap',
      center: origin,
      partial,
      truncated: successes.some(result => result.value.truncated),
      diagnostics: {
        areasRequested: queries.length,
        areasSucceeded: successes.length,
        pagesAttempted: successes.reduce((sum, result) => sum + result.value.pagesAttempted, 0) + queries.length - successes.length,
        poisReturned: successes.reduce((sum, result) => sum + result.value.pois.length, 0),
        restaurantsAfterDedup: restaurants.length,
      },
      restaurants,
    };
    // A transient area or page failure must not poison the next five minutes.
    if (!partial) {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, { createdAt: Date.now(), body });
    }
    return json(res, 200, body);
  } catch (error) {
    console.error('amap restaurant search failed', error);
    return json(res, 502, { ok: false, code: 'UPSTREAM_ERROR', message: '附近餐厅暂时查不到' });
  }
}
