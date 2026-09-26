const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

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

function normalizePoi(poi) {
  const [lng, lat] = String(poi.location || '').split(',').map(Number);
  const costValue = poi.biz_ext?.cost;
  const cost = costValue == null || costValue === '' ? null : Number(costValue);
  return {
    id: poi.id,
    name: poi.name,
    address: poi.address || '',
    category: poi.type?.split(';').pop() || '餐厅',
    type: poi.type || '餐饮服务',
    distance: Number(poi.distance || 0),
    cost: Number.isFinite(cost) ? cost : null,
    location: Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null,
    tel: poi.tel || '',
  };
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

  const cacheKey = `${lng.toFixed(4)},${lat.toFixed(4)}:${radius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return json(res, 200, { ...cached.body, cached: true });
  }

  try {
    const params = new URLSearchParams({
      key,
      location: `${lng},${lat}`,
      types: '050000',
      radius: String(radius),
      sortrule: 'distance',
      offset: '25',
      page: '1',
      extensions: 'all',
    });
    const response = await fetch(`https://restapi.amap.com/v3/place/around?${params}`);
    if (!response.ok) {
      return json(res, 502, { ok: false, code: 'AMAP_ERROR', message: '高德查询暂时失败' });
    }
    const data = await response.json();
    if (data.status !== '1') {
      console.error('amap nearby search failed', data.info || 'unknown error');
      return json(res, 502, { ok: false, code: 'AMAP_ERROR', message: '高德查询暂时失败，请稍后再试' });
    }

    const body = {
      ok: true,
      source: 'amap',
      center: { lng, lat },
      restaurants: (data.pois || []).map(normalizePoi),
    };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { createdAt: Date.now(), body });
    return json(res, 200, body);
  } catch (error) {
    console.error('amap restaurant search failed', error);
    return json(res, 502, { ok: false, code: 'UPSTREAM_ERROR', message: '附近餐厅暂时查不到' });
  }
}
