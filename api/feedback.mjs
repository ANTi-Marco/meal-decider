const CATEGORIES = new Set(['recommendation', 'home-cooking', 'draw', 'usability', 'other']);
const WINDOW_MS = 10 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 5;
const submissionsByIp = new Map();

function reply(res, status, body) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function limited(ip) {
  const now = Date.now();
  const recent = (submissionsByIp.get(ip) || []).filter(at => now - at < WINDOW_MS);
  if (recent.length >= MAX_SUBMISSIONS_PER_WINDOW) return true;
  recent.push(now);
  submissionsByIp.set(ip, recent);
  if (submissionsByIp.size > 500) {
    for (const [key, times] of submissionsByIp) {
      if (!times.some(at => now - at < WINDOW_MS)) submissionsByIp.delete(key);
    }
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return reply(res, 405, { ok: false, message: '只支持提交反馈' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  // Hidden honeypot field used to discard simple automated spam.
  if (typeof body.company === 'string' && body.company.trim()) return reply(res, 200, { ok: true });
  const category = typeof body.category === 'string' ? body.category : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
  const pagePath = typeof body.pagePath === 'string' ? body.pagePath.slice(0, 160) : '/';
  if (!CATEGORIES.has(category) || message.length < 5 || message.length > 1200 || contact.length > 120) {
    return reply(res, 400, { ok: false, message: '请检查反馈内容，正文需为 5–1200 字' });
  }

  const ip = String(req.headers?.['x-real-ip'] || req.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim().slice(0, 80);
  if (limited(ip)) return reply(res, 429, { ok: false, message: '提交得有点频繁，请稍后再试' });

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return reply(res, 503, { ok: false, message: '反馈服务还未配置，请稍后再试' });
  }

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/meal_feedback`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        ...(serviceKey.startsWith('eyJ') ? { authorization: `Bearer ${serviceKey}` } : {}),
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({ category, message, contact: contact || null, page_path: pagePath }),
    });
    if (!response.ok) {
      console.error('Feedback storage failed', response.status);
      return reply(res, 502, { ok: false, message: '暂时没能提交成功，请稍后再试' });
    }
    return reply(res, 201, { ok: true, message: '收到啦，谢谢你愿意告诉我们' });
  } catch (error) {
    console.error('Feedback storage request failed', error?.name || 'unknown');
    return reply(res, 502, { ok: false, message: '暂时没能提交成功，请稍后再试' });
  }
}
