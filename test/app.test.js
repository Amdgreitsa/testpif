const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const getPort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('authenticated dashboard API persists a seeded account and protects private data', async () => {
  const port = await getPort(); const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pifpaf-test-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'long-test-password' } });
  try {
    let health;
    for (let attempt = 0; attempt < 20; attempt += 1) { try { health = await fetch(`http://127.0.0.1:${port}/api/health`); if (health.ok) break; } catch { await wait(50); } }
    assert.equal(health.status, 200);
    const telegramDisabled = await fetch(`http://127.0.0.1:${port}/api/auth/telegram/start`, { method: 'POST' });
    assert.equal(telegramDisabled.status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/dashboard`)).status, 401);
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'long-test-password' }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/);
    const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers: { cookie } }); const data = await dashboard.json();
    assert.equal(dashboard.status, 200); assert.equal(data.accounts[0].handle, '@alina.creates'); assert.equal(data.analytics.reels, 0);
    const invalidReel = await fetch(`http://127.0.0.1:${port}/api/reels`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ sourceUrl: 'https://example.com' }) });
    assert.equal(invalidReel.status, 422);
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
  const server = fs.readFileSync('server.js', 'utf8'); const app = fs.readFileSync('app.js', 'utf8'); const install = fs.readFileSync('install.sh', 'utf8'); const html = fs.readFileSync('index.html', 'utf8');
  assert.match(server, /api\.apify\.com/); assert.match(server, /APIFY_TOKEN/); assert.match(server, /syncConfiguredAdmin/); assert.match(server, /auth\/telegram\/start/); assert.match(server, /TELEGRAM_ALLOWED_USER_IDS/); assert.match(server, /api\/accounts\/import/); assert.match(server, /fetchProfileReels/); assert.match(install, /certbot/); assert.match(install, /systemctl enable/); assert.match(install, /APP_DIR="\/opt\/pifpaf-creators"/); assert.match(install, /tar --exclude='\.\/data'/); assert.match(install, /TELEGRAM_API_HASH/); assert.match(install, /curl nginx/); assert.match(install, /while true; do/); assert.match(install, /normalize_domain/); assert.match(install, /--update/); assert.match(install, /check_dns/); assert.match(install, /wait_for_health/); assert.match(app, /telegramLogin/); assert.match(app, /api\/accounts\/import/); assert.match(html, /Войти через Telegram/); assert.doesNotMatch(app, /apify_api_/); assert.doesNotMatch(html, /APIFY_TOKEN|APIFY_ACTOR|SYNC_INTERVAL_MS|\.env|переменные окружения/);
});
