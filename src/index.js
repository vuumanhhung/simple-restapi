/**
 * REST API trên Cloudflare Workers, dữ liệu lưu ở D1 (SQLite).
 *
 * Worker không giữ state giữa các request: mỗi request có thể chạy trên một
 * isolate khác, và isolate bị thu hồi bất cứ lúc nào. Vì vậy mọi dữ liệu đều
 * đi qua env.DB, không có biến toàn cục nào đóng vai trò "database".
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);
const USER_COLUMNS = 'id, name, email, age, created_at';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    // Preflight CORS trả lời ngay, không vào router.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      // Log ra `wrangler tail`, không trả chi tiết lỗi về client.
      console.error('Unhandled error:', err?.stack ?? err);
      response = fail(500, 'Lỗi nội bộ');
    }

    // Gắn CORS cho mọi phản hồi tại một chỗ duy nhất.
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(env))) {
      headers.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers });
  },
};

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const ROUTES = [
  ['GET', new URLPattern({ pathname: '/' }), index],
  ['GET', new URLPattern({ pathname: '/health' }), health],
  ['GET', new URLPattern({ pathname: '/users' }), listUsers],
  ['POST', new URLPattern({ pathname: '/users' }), createUser],
  ['GET', new URLPattern({ pathname: '/users/:id' }), getUser],
  ['PUT', new URLPattern({ pathname: '/users/:id' }), updateUser],
  ['DELETE', new URLPattern({ pathname: '/users/:id' }), deleteUser],
];

async function route(request, env) {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/users') && !env.DB) {
    return fail(503, 'Chưa gắn D1 database. Kiểm tra binding DB trong wrangler.toml.');
  }

  let pathMatched = false;

  for (const [method, pattern, handler] of ROUTES) {
    const match = pattern.exec({ pathname: url.pathname });
    if (!match) continue;

    pathMatched = true;
    if (method !== request.method) continue;

    const denied = authorize(request, env);
    if (denied) return denied;

    return handler({ request, env, url, params: match.pathname.groups });
  }

  return pathMatched
    ? fail(405, `Method ${request.method} không hỗ trợ cho đường dẫn này`)
    : fail(404, 'Endpoint không tồn tại');
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

function index() {
  return ok({
    name: 'rest-api-worker',
    endpoints: [
      'GET    /users?limit=20&offset=0',
      'GET    /users/:id',
      'POST   /users',
      'PUT    /users/:id',
      'DELETE /users/:id',
      'GET    /health',
    ],
    note: 'POST/PUT/DELETE cần header Authorization: Bearer <API_KEY>',
  });
}

async function health({ env }) {
  const checks = { worker: 'ok', database: 'not_bound' };

  if (env.DB) {
    try {
      await env.DB.prepare('SELECT 1').first();
      checks.database = 'ok';
    } catch (err) {
      console.error('D1 health check failed:', err?.message);
      checks.database = 'error';
    }
  }

  const healthy = checks.database === 'ok';
  return json(
    { status: healthy ? 'ok' : 'degraded', checks, time: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}

async function listUsers({ env, url }) {
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1_000_000);

  // batch() gộp hai câu lệnh vào một lượt đi, rẻ hơn hai await riêng.
  const [page, count] = await env.DB.batch([
    env.DB
      .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id LIMIT ? OFFSET ?`)
      .bind(limit, offset),
    env.DB.prepare('SELECT COUNT(*) AS total FROM users'),
  ]);

  return ok(page.results, {
    meta: { total: count.results[0].total, limit, offset },
  });
}

async function getUser({ env, params }) {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'id phải là số nguyên dương');

  const user = await env.DB
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(id)
    .first();

  if (!user) return fail(404, `Không tìm thấy user id ${id}`);
  return ok(user);
}

async function createUser({ request, env }) {
  const parsed = await readJson(request);
  if (parsed.error) return fail(400, parsed.error);

  const { value, errors } = validateUser(parsed.body, { partial: false });
  if (errors.length) return fail(422, 'Dữ liệu không hợp lệ', { details: errors });

  try {
    const user = await env.DB
      .prepare(`INSERT INTO users (name, email, age) VALUES (?, ?, ?) RETURNING ${USER_COLUMNS}`)
      .bind(value.name, value.email, value.age ?? null)
      .first();

    return ok(user, { status: 201, headers: { location: `/users/${user.id}` } });
  } catch (err) {
    if (isUniqueViolation(err)) return fail(409, `Email ${value.email} đã tồn tại`);
    throw err;
  }
}

async function updateUser({ request, env, params }) {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'id phải là số nguyên dương');

  const parsed = await readJson(request);
  if (parsed.error) return fail(400, parsed.error);

  // partial: chỉ cập nhật những trường có mặt trong body.
  const { value, errors } = validateUser(parsed.body, { partial: true });
  if (errors.length) return fail(422, 'Dữ liệu không hợp lệ', { details: errors });

  const fields = Object.keys(value);
  if (fields.length === 0) {
    return fail(422, 'Không có trường nào để cập nhật', {
      details: ['Gửi ít nhất một trong: name, email, age'],
    });
  }

  // Tên cột lấy từ whitelist do validateUser sinh ra, không phải từ input thô,
  // nên nội suy vào SQL ở đây là an toàn. Giá trị vẫn đi qua bind().
  const setSql = fields.map((field) => `${field} = ?`).join(', ');

  try {
    const user = await env.DB
      .prepare(`UPDATE users SET ${setSql} WHERE id = ? RETURNING ${USER_COLUMNS}`)
      .bind(...fields.map((field) => value[field]), id)
      .first();

    if (!user) return fail(404, `Không tìm thấy user id ${id}`);
    return ok(user);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(409, `Email ${value.email} đã tồn tại`);
    throw err;
  }
}

async function deleteUser({ env, params }) {
  const id = parseId(params.id);
  if (id === null) return fail(400, 'id phải là số nguyên dương');

  const user = await env.DB
    .prepare(`DELETE FROM users WHERE id = ? RETURNING ${USER_COLUMNS}`)
    .bind(id)
    .first();

  if (!user) return fail(404, `Không tìm thấy user id ${id}`);
  return ok(user);
}

/* ------------------------------------------------------------------ *
 * Xác thực
 * ------------------------------------------------------------------ */

/**
 * Đọc thì công khai, ghi thì cần Bearer token.
 * Fail-closed: chưa cấu hình API_KEY thì chặn ghi, không mở cửa.
 */
function authorize(request, env) {
  if (!WRITE_METHODS.has(request.method)) return null;

  if (!env.API_KEY) {
    return fail(503, 'API_KEY chưa được cấu hình nên thao tác ghi bị chặn.');
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || !constantTimeEqual(token, env.API_KEY)) {
    return fail(401, 'Thiếu hoặc sai Bearer token', {
      headers: { 'www-authenticate': 'Bearer' },
    });
  }

  return null;
}

/** So sánh không phụ thuộc nội dung, tránh rò rỉ token qua thời gian phản hồi. */
function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);

  if (x.length !== y.length) return false;

  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Validate
 * ------------------------------------------------------------------ */

function validateUser(body, { partial }) {
  const errors = [];
  const value = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { value, errors: ['Body phải là một JSON object'] };
  }

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      errors.push('name: phải là chuỗi không rỗng');
    } else if (body.name.trim().length > 120) {
      errors.push('name: tối đa 120 ký tự');
    } else {
      value.name = body.name.trim();
    }
  } else if (!partial) {
    errors.push('name: bắt buộc');
  }

  if (body.email !== undefined) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) {
      errors.push('email: định dạng không hợp lệ');
    } else if (email.length > 254) {
      errors.push('email: tối đa 254 ký tự');
    } else {
      value.email = email;
    }
  } else if (!partial) {
    errors.push('email: bắt buộc');
  }

  // age không bắt buộc; gửi null để xoá giá trị đang có.
  if (body.age !== undefined) {
    if (body.age === null) {
      value.age = null;
    } else if (!Number.isInteger(body.age) || body.age < 0 || body.age > 150) {
      errors.push('age: phải là số nguyên từ 0 đến 150');
    } else {
      value.age = body.age;
    }
  }

  return { value, errors };
}

/* ------------------------------------------------------------------ *
 * Tiện ích
 * ------------------------------------------------------------------ */

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function ok(data, { status = 200, meta, headers } = {}) {
  return json({ success: true, data, ...(meta ? { meta } : {}) }, { status, headers });
}

function fail(status, message, { details, headers } = {}) {
  return json(
    { success: false, error: { message, ...(details ? { details } : {}) } },
    { status, headers },
  );
}

async function readJson(request) {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/json')) {
    return { error: 'Cần header Content-Type: application/json' };
  }
  try {
    return { body: await request.json() };
  } catch {
    return { error: 'Body không phải JSON hợp lệ' };
  }
}

/** Chỉ nhận số nguyên dương. Regex chặn trước để "12abc" không lọt qua. */
function parseId(raw) {
  if (!/^\d{1,15}$/.test(raw ?? '')) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

function clampInt(raw, fallback, min, max) {
  if (!/^\d{1,9}$/.test(raw ?? '')) return fallback;
  return Math.min(Math.max(Number(raw), min), max);
}

/** D1 bọc lỗi SQLite, nên soi cả message lẫn cause. */
function isUniqueViolation(err) {
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  return /UNIQUE constraint failed/i.test(text);
}
