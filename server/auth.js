import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const hashPassword = promisify(scrypt);
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'myscan_owner';

export async function createAuth({ dataDir, now, publicUrl }) {
  const credentialsPath = path.join(dataDir, 'owner.json');
  let credentials = null;
  try {
    credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
    if (credentials.version !== 1 || !/^[a-f0-9]{32}$/.test(credentials.salt)
      || !/^[a-f0-9]{128}$/.test(credentials.hash)) throw new Error('Dữ liệu đăng nhập không hợp lệ.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sessions = new Map();
  const attempts = new Map();
  let setupPending = Promise.resolve();

  function authenticated(req) {
    const match = (req.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`));
    const token = match?.slice(COOKIE_NAME.length + 1);
    if (!token) return false;
    const expiry = sessions.get(token);
    if (!expiry || expiry <= now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function issueSession(req, res) {
    for (const [token, expiry] of sessions) if (expiry <= now()) sessions.delete(token);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, now() + SESSION_DURATION_MS);
    let httpsOrigin = false;
    try { httpsOrigin = new URL(req.headers.origin).protocol === 'https:'; } catch { /* Native clients may omit Origin. */ }
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || httpsOrigin,
      maxAge: SESSION_DURATION_MS,
      path: '/',
    });
  }

  function requireOwner(req, res, next) {
    if (!authenticated(req)) return res.status(401).json({ error: 'Vui lòng đăng nhập vào myscan.' });
    next();
  }

  function protectOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
    let origin;
    try { origin = new URL(req.headers.origin).origin; } catch { /* Reject malformed origins. */ }
    const allowed = new Set([`http://${req.get('host')}`, `https://${req.get('host')}`]);
    if (publicUrl) allowed.add(publicUrl);
    if (!allowed.has(origin)) return res.status(403).json({ error: 'Yêu cầu phải được gửi từ ứng dụng myscan.' });
    next();
  }

  function mount(app) {
    app.get('/api/auth', (req, res) => res.json({ configured: Boolean(credentials), authenticated: authenticated(req) }));
    app.post('/api/auth/setup', async (req, res, next) => {
      const operation = setupPending.then(async () => {
        if (credentials) return res.status(409).json({ error: 'Mật khẩu đã được thiết lập. Vui lòng đăng nhập.' });
        const password = req.body?.password;
        if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
          return res.status(400).json({ error: 'Mật khẩu cần có từ 8 đến 256 ký tự.' });
        }
        const salt = randomBytes(16).toString('hex');
        const hash = (await hashPassword(password, salt, 64)).toString('hex');
        const saved = { version: 1, salt, hash };
        const temporaryPath = `${credentialsPath}.${randomBytes(8).toString('hex')}.tmp`;
        try {
          await writeFile(temporaryPath, JSON.stringify(saved), { mode: 0o600 });
          await rename(temporaryPath, credentialsPath);
        } catch (error) {
          await rm(temporaryPath, { force: true });
          throw error;
        }
        credentials = saved;
        issueSession(req, res);
        res.status(201).json({ configured: true, authenticated: true });
      });
      setupPending = operation.catch(() => {});
      await operation.catch(next);
    });
    app.post('/api/auth/login', async (req, res, next) => {
      try {
        if (!credentials) return res.status(409).json({ error: 'Hãy thiết lập mật khẩu trước khi đăng nhập.' });
        const password = req.body?.password;
        if (typeof password !== 'string' || password.length > 256) {
          return res.status(400).json({ error: 'Mật khẩu không hợp lệ.' });
        }
        const key = req.ip;
        const previous = attempts.get(key);
        const attempt = previous && previous.expiresAt > now() ? previous : { count: 0, expiresAt: now() + 10 * 60 * 1000 };
        attempts.set(key, attempt);
        if (attempt.count >= 8) return res.status(429).json({ error: 'Đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau 10 phút.' });
        attempt.count += 1;
        const hash = await hashPassword(password, credentials.salt, 64);
        if (!timingSafeEqual(hash, Buffer.from(credentials.hash, 'hex'))) {
          return res.status(401).json({ error: 'Mật khẩu chưa đúng.' });
        }
        attempts.delete(key);
        issueSession(req, res);
        res.json({ configured: true, authenticated: true });
      } catch (error) { next(error); }
    });
    app.post('/api/auth/logout', (req, res) => {
      const match = (req.headers.cookie || '').split(';').map((part) => part.trim())
        .find((part) => part.startsWith(`${COOKIE_NAME}=`));
      if (match) sessions.delete(match.slice(COOKIE_NAME.length + 1));
      res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'strict', path: '/' });
      res.status(204).end();
    });
  }
  return { mount, requireOwner, protectOrigin, authenticated };
}
