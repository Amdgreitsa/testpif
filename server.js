const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const dbFile = path.join(dataDir, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_ACTOR = process.env.APIFY_ACTOR || 'apify/instagram-scraper';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 14;
const isProduction = process.env.NODE_ENV === 'production';
const loginAttempts = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

fs.mkdirSync(dataDir, { recursive: true });
const id = () => crypto.randomUUID();
const hash = password => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; };
const verify = (password, stored) => { const [salt, key] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(key, 'hex'), crypto.scryptSync(password, salt, 64)); };
function seed() {
  const user = { id: id(), name: 'Алина Романова', email: process.env.ADMIN_EMAIL || 'admin@pifpaf.local', passwordHash: hash(process.env.ADMIN_PASSWORD || 'change-me-now'), role: 'admin', createdAt: new Date().toISOString() };
  return { users: [user], accounts: [{ id: id(), userId: user.id, handle: '@alina.creates', name: 'Алина Романова' }], reels: [], snapshots: [], sessions: [] };
}
function readDb() { if (!fs.existsSync(dbFile)) { const db = seed(); fs.writeFileSync(dbFile, JSON.stringify(db, null, 2)); return db; } return JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
function saveDb(db) { const temporary = `${dbFile}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(db, null, 2), { mode: 0o600 }); fs.renameSync(temporary, dbFile); }
function send(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers }); res.end(JSON.stringify(value)); }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(v => v.trim().split('=').map(decodeURIComponent))); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Некорректный JSON')); } }); }); }
function currentUser(req, db) { const token = cookies(req).pif_session; const session = db.sessions.find(s => s.token === token && new Date(s.expiresAt) > new Date()); return session && db.users.find(user => user.id === session.userId); }
function auth(req, res, db) { const user = currentUser(req, db); if (!user) { send(res, 401, { error: 'Требуется вход' }); return null; } return user; }
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role }; }
const compact = number => new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(number || 0);
function reelDto(reel) { return { ...reel, formattedViews: compact(reel.views), formattedLikes: compact(reel.likes) }; }
function analytics(db, user) { const accounts = db.accounts.filter(a => user.role === 'admin' || a.userId === user.id); const accountIds = new Set(accounts.map(a => a.id)); const reels = db.reels.filter(r => accountIds.has(r.accountId)); const views = reels.reduce((sum, r) => sum + (r.views || 0), 0); const likes = reels.reduce((sum, r) => sum + (r.likes || 0), 0); const comments = reels.reduce((sum, r) => sum + (r.comments || 0), 0); const engagement = views ? ((likes + comments) / views) * 100 : 0; return { views, likes, comments, engagement: Number(engagement.toFixed(1)), reels: reels.length, updatedAt: reels.map(r => r.syncedAt).filter(Boolean).sort().at(-1) || null }; }
function apifyEndpoint() { return `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}`; }
async function runApify(input) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN не настроен на сервере');
  const response = await fetch(apifyEndpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`Apify вернул ${response.status}`);
  return response.json();
}
async function fetchInstagram(url) { const [item] = await runApify({ directUrls: [url], resultsType: 'posts', resultsLimit: 1 }); if (!item) throw new Error('Apify не вернул данные по этой ссылке'); return item; }
function profileUrl(handle) { const clean = String(handle || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0]; if (!/^[a-z0-9._]{1,30}$/i.test(clean)) throw new Error('Укажите корректный Instagram handle'); return { handle: `@${clean}`, url: `https://www.instagram.com/${clean}/` }; }
async function fetchProfileReels(handle, limit) {
  const profile = profileUrl(handle); const items = await runApify({ directUrls: [profile.url], resultsType: 'posts', resultsLimit: Math.min(Math.max(Number(limit) || 12, 1), 50), onlyPostsNewerThan: '10 years' });
  return { ...profile, items: items.filter(item => item.type === 'Video' || item.productType === 'clips' || /\/reel\//.test(item.url || item.shortCode || '')) };
}
function normalize(item, url) { const sourceUrl = item.url || (item.shortCode ? `https://www.instagram.com/reel/${item.shortCode}/` : url); return { sourceUrl, title: (item.caption || 'Новый рилс').replace(/\s+/g, ' ').slice(0, 90), publishedAt: item.timestamp || new Date().toISOString(), views: Number(item.videoViewCount || item.videoPlayCount || 0), likes: Number(item.likesCount || 0), comments: Number(item.commentsCount || 0), duration: Number(item.videoDuration || 0), coverUrl: item.displayUrl || item.thumbnailUrl || null }; }
async function syncReel(db, reel) { const item = await fetchInstagram(reel.sourceUrl); Object.assign(reel, normalize(item, reel.sourceUrl), { syncedAt: new Date().toISOString(), syncStatus: 'synced', syncError: null }); db.snapshots.push({ id: id(), reelId: reel.id, views: reel.views, likes: reel.likes, comments: reel.comments, capturedAt: reel.syncedAt }); saveDb(db); return reel; }

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`); const db = readDb(); const user = currentUser(req, db);
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, apifyConfigured: Boolean(APIFY_TOKEN) });
    if (url.pathname === '/api/auth/me' && req.method === 'GET') return user ? send(res, 200, { user: publicUser(user) }) : send(res, 401, { error: 'Требуется вход' });
    if (url.pathname === '/api/auth/login' && req.method === 'POST') { const remote = req.socket.remoteAddress || 'unknown'; const attempts = (loginAttempts.get(remote) || []).filter(at => Date.now() - at < 15 * 60 * 1000); if (attempts.length >= 10) return send(res, 429, { error: 'Слишком много попыток входа. Повторите через 15 минут.' }); const { email, password } = await body(req); const found = db.users.find(item => item.email.toLowerCase() === String(email).toLowerCase()); if (!found || !verify(password || '', found.passwordHash)) { loginAttempts.set(remote, [...attempts, Date.now()]); return send(res, 401, { error: 'Неверный email или пароль' }); } loginAttempts.delete(remote); const token = crypto.randomBytes(32).toString('hex'); db.sessions = db.sessions.filter(s => new Date(s.expiresAt) > new Date()); db.sessions.push({ token, userId: found.id, expiresAt: new Date(Date.now() + SESSION_TTL).toISOString() }); saveDb(db); const secure = isProduction ? '; Secure' : ''; return send(res, 200, { user: publicUser(found) }, { 'Set-Cookie': `pif_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${secure}` }); }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { db.sessions = db.sessions.filter(s => s.token !== cookies(req).pif_session); saveDb(db); return send(res, 204, {}, { 'Set-Cookie': `pif_session=; HttpOnly; Path=/; Max-Age=0${isProduction ? '; Secure' : ''}` }); }
    if (url.pathname === '/api/dashboard' && req.method === 'GET') { const signed = auth(req, res, db); if (!signed) return; const data = analytics(db, signed); const ids = new Set(db.accounts.filter(a => signed.role === 'admin' || a.userId === signed.id).map(a => a.id)); return send(res, 200, { analytics: data, reels: db.reels.filter(r => ids.has(r.accountId)).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).map(reelDto), accounts: db.accounts.filter(a => ids.has(a.id)) }); }
    if (url.pathname === '/api/reels' && req.method === 'POST') { const signed = auth(req, res, db); if (!signed) return; const { sourceUrl, accountId } = await body(req); if (!/^https:\/\/(www\.)?instagram\.com\/reel\//i.test(sourceUrl || '')) return send(res, 422, { error: 'Укажите корректную ссылку Instagram Reel' }); const account = db.accounts.find(a => a.id === accountId) || db.accounts.find(a => a.userId === signed.id) || db.accounts[0]; const reel = { id: id(), accountId: account.id, sourceUrl, title: 'Рилс добавлен — ожидает синхронизации', publishedAt: new Date().toISOString(), views: 0, likes: 0, comments: 0, duration: 0, coverUrl: null, syncStatus: 'pending', syncedAt: null, createdAt: new Date().toISOString() }; db.reels.push(reel); saveDb(db); try { await syncReel(db, reel); } catch (error) { reel.syncStatus = 'failed'; reel.syncError = error.message; saveDb(db); } return send(res, 201, { reel: reelDto(reel) }); }
    const match = url.pathname.match(/^\/api\/reels\/([^/]+)\/sync$/); if (match && req.method === 'POST') { const signed = auth(req, res, db); if (!signed) return; const reel = db.reels.find(r => r.id === match[1]); if (!reel) return send(res, 404, { error: 'Рилс не найден' }); const account = db.accounts.find(a => a.id === reel.accountId); if (signed.role !== 'admin' && account.userId !== signed.id) return send(res, 403, { error: 'Нет доступа' }); try { await syncReel(db, reel); return send(res, 200, { reel: reelDto(reel) }); } catch (error) { reel.syncStatus = 'failed'; reel.syncError = error.message; saveDb(db); return send(res, 502, { error: error.message }); } }

    if (url.pathname === '/api/accounts/import' && req.method === 'POST') { const signed = auth(req, res, db); if (!signed) return; const { handle, limit } = await body(req); let imported; try { imported = await fetchProfileReels(handle, limit); } catch (error) { return send(res, error.message.includes('handle') ? 422 : 502, { error: error.message }); } let account = db.accounts.find(a => a.userId === signed.id && a.handle.toLowerCase() === imported.handle.toLowerCase()); if (!account) { account = { id: id(), userId: signed.id, handle: imported.handle, name: signed.name }; db.accounts.push(account); } let created = 0; let updated = 0; for (const item of imported.items) { const data = normalize(item, item.url || imported.url); const existing = db.reels.find(r => r.sourceUrl === data.sourceUrl); if (existing) { Object.assign(existing, data, { accountId: account.id, syncedAt: new Date().toISOString(), syncStatus: 'synced', syncError: null }); updated += 1; db.snapshots.push({ id: id(), reelId: existing.id, views: existing.views, likes: existing.likes, comments: existing.comments, capturedAt: existing.syncedAt }); } else { const reel = { id: id(), accountId: account.id, ...data, syncStatus: 'synced', syncError: null, syncedAt: new Date().toISOString(), createdAt: new Date().toISOString() }; db.reels.push(reel); created += 1; db.snapshots.push({ id: id(), reelId: reel.id, views: reel.views, likes: reel.likes, comments: reel.comments, capturedAt: reel.syncedAt }); } } saveDb(db); return send(res, 201, { account, created, updated, total: imported.items.length }); }
    if (url.pathname === '/api/accounts' && req.method === 'POST') { const signed = auth(req, res, db); if (!signed) return; const { handle, name } = await body(req); if (!handle) return send(res, 422, { error: 'Укажите Instagram handle' }); const account = { id: id(), userId: signed.id, handle: handle.startsWith('@') ? handle : `@${handle}`, name: name || signed.name }; db.accounts.push(account); saveDb(db); return send(res, 201, { account }); }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname; const file = path.resolve(root, `.${requested}`); if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); fs.createReadStream(file).pipe(res);
  } catch (error) { console.error(error); send(res, 500, { error: error.message || 'Ошибка сервера' }); }
}).listen(PORT, () => console.log(`PifPaf Creators running on :${PORT}`));

const interval = Number(process.env.SYNC_INTERVAL_MS || 0);
if (interval > 0) setInterval(async () => { const db = readDb(); for (const reel of db.reels) { try { await syncReel(db, reel); } catch (error) { console.error(`Sync ${reel.id}:`, error.message); } } }, interval).unref();
