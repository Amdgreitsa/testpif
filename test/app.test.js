const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const getPort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('authenticated dashboard API persists a seeded account and protects private data', async () => {
  const port = await getPort(); const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pifpaf-test-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'long-test-password', TELEGRAM_BOT_USERNAME: 'pifpaf_test_bot', TELEGRAM_BOT_TOKEN: '123456:telegram-test-token' } });
  try {
    let health;
    for (let attempt = 0; attempt < 20; attempt += 1) { try { health = await fetch(`http://127.0.0.1:${port}/api/health`); if (health.ok) break; } catch { await wait(50); } }
    assert.equal(health.status, 200); assert.equal((await health.json()).telegramConfigured, true);
    const telegramConfig = await fetch(`http://127.0.0.1:${port}/api/auth/telegram/config`);
    assert.equal(telegramConfig.status, 200); assert.equal((await telegramConfig.json()).botUsername, 'pifpaf_test_bot');
    const telegramPayload = { id: '12345', first_name: 'Telegram', username: 'creator', auth_date: String(Math.floor(Date.now() / 1000)) };
    const signedFields = Object.entries(telegramPayload).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('\n');
    telegramPayload.hash = crypto.createHmac('sha256', crypto.createHash('sha256').update('123456:telegram-test-token').digest()).update(signedFields).digest('hex');
    const telegramLogin = await fetch(`http://127.0.0.1:${port}/api/auth/telegram/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(telegramPayload) });
    assert.equal(telegramLogin.status, 200); assert.equal((await telegramLogin.json()).user.role, 'creator'); const creatorCookie = telegramLogin.headers.get('set-cookie');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/dashboard`)).status, 401);
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'long-test-password' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/);
    const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { cookie } }); const data = await dashboard.json();
    assert.equal(dashboard.status, 200); assert.equal(data.accounts[0].handle, '@alina.creates'); assert.equal(data.analytics.reels, 0); assert.deepEqual(data.analytics.rhythm.dayViews, [0, 0, 0, 0, 0, 0, 0]); assert.equal(data.analytics.rhythm.bestDay, null);
    const crossAccountReel = await fetch(`http://127.0.0.1:${port}/api/reels`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: creatorCookie }, body: JSON.stringify({ sourceUrl: 'https://instagram.com/reel/not-owned/', accountId: data.accounts[0].id }) });
    assert.equal(crossAccountReel.status, 403);
    const invalidReel = await fetch(`http://127.0.0.1:${port}/api/reels`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ sourceUrl: 'https://example.com' }) });
    assert.equal(invalidReel.status, 422);
    assert.equal((await fetch(`http://127.0.0.1:${port}/server.js`)).status, 404);
    const favicon = await fetch(`http://127.0.0.1:${port}/favicon.svg`); assert.equal(favicon.status, 200); assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
  } finally { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('configured administrator credentials replace credentials from a previous installation', async () => {
  const port = await getPort(); const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pifpaf-admin-test-'));
  const start = env => spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env } });
  const waitForHealth = async () => { for (let attempt = 0; attempt < 40; attempt += 1) { try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return; } catch {} await wait(50); } throw new Error('Server did not start'); };
  let child = start({ ADMIN_EMAIL: 'old@example.com', ADMIN_PASSWORD: 'old-install-password' });
  try {
    await waitForHealth(); child.kill(); await new Promise(resolve => child.once('exit', resolve));
    child = start({ ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'correct-install-password' });
    await waitForHealth();
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'correct-install-password' }) });
    assert.equal(login.status, 200);
  } finally { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('installer normalizes a copied URL and the browser never embeds an Apify secret', () => {
  const server = fs.readFileSync('server.js', 'utf8'); const app = fs.readFileSync('app.js', 'utf8'); const install = fs.readFileSync('install.sh', 'utf8'); const html = fs.readFileSync('index.html', 'utf8'); const packageManifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(server, /api\.apify\.com/); assert.match(server, /requested: imported\.requested/); assert.match(server, /APIFY_TOKEN/); assert.match(server, /telegramConfigured/); assert.match(server, /syncConfiguredAdmin/); assert.match(server, /verifyTelegramAuth/); assert.match(server, /TELEGRAM_BOT_TOKEN/); assert.match(server, /auth\/telegram\/login/); assert.match(server, /telegramId/); assert.match(server, /role: 'creator'/); assert.doesNotMatch(server, /require\(['"](?:qrcode|telegram)/); assert.doesNotMatch(server, /TELEGRAM_API_HASH|TELEGRAM_ALLOWED_USER_IDS/); assert.deepEqual(packageManifest.dependencies || {}, {}); assert.match(install, /certbot/); assert.match(install, /systemctl enable/); assert.match(install, /APP_DIR="\/opt\/pifpaf-creators"/); assert.match(install, /tar --exclude='\.\/data'/); assert.match(install, /--exclude='\.\/node_modules'/); assert.match(install, /nodejs npm/); assert.match(install, /command -v npm/); assert.match(install, /command -v fuser/); assert.match(install, /wait_for_package_manager/); assert.match(install, /DPkg::Lock::Timeout/); assert.match(install, /npm ci --omit=dev --prefix/); assert.match(install, /TELEGRAM_BOT_TOKEN/); assert.doesNotMatch(install, /TELEGRAM_API_HASH|TELEGRAM_ALLOWED_USER_IDS/); assert.match(install, /verify_runtime_settings/); assert.match(install, /listen 443 ssl/); assert.match(install, /ssl_certificate/); assert.match(install, /wait_for_public_https/); assert.match(install, /https:\/\/\$domain\/api\/health/); assert.match(install, /curl nginx/); assert.match(install, /while true; do/); assert.match(install, /normalize_domain/); assert.match(install, /--update/); assert.match(install, /check_dns/); assert.match(install, /wait_for_health/); assert.match(app, /onTelegramAuth/); assert.match(app, /data\.received/); assert.match(app, /api\/accounts\/import/); assert.match(app, /dismissCookieNotice/); assert.match(app, /renderRhythm/); assert.match(html, /id="acceptCookies" type="button"/); assert.match(html, /id="rhythmBars"/); assert.match(html, /favicon\.svg/); assert.match(html, /value="50"/); assert.match(html, /telegramLogin/); assert.doesNotMatch(app, /apify_api_/); assert.doesNotMatch(html, /APIFY_TOKEN|APIFY_ACTOR|SYNC_INTERVAL_MS|\.env|переменные окружения/);
});
