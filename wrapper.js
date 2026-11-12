require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const os = require('os');
const moment = require('moment-timezone');
const chalk = require('chalk');
const crypto = require('crypto');
const { exec } = require('child_process');

moment.locale('id');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const WRAPPER_PORT       = 4005;
const GATEWAY_PORT       = process.env.PORT || 4004;
const API_URL            = `http://localhost:${WRAPPER_PORT}`;
const GATEWAY_URL        = `http://localhost:${GATEWAY_PORT}`;
const API_KEY = process.env.API_KEY || 'shopee-secret-key-2026';
const TWO_FACTOR_CODE = process.env.TWO_FACTOR_CODE || '';
const BACKUP_PASSWORD = process.env.BACKUP_PASSWORD || '';
const ENV_PATH = path.join(__dirname, '.env');
const DB_ADMIN_PATH = path.join(__dirname, 'admin.json');
const DB_USERS_PATH = path.join(__dirname, 'users.json');
const DB_SCHEDULE_PATH = path.join(__dirname, 'schedule.json');
const DB_MODE_PATH = path.join(__dirname, 'mode.json');
const AUDIT_LOG_PATH = path.join(__dirname, 'audit.log');
const BACKUP_DIR = path.join(__dirname, 'backup');
const MAX_BACKUP_FILES = 7;
const POLL_INTERVAL_MS = 5000;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60000;

const BULAN = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const QUOTES = [
  "Konsisten adalah kunci kesuksesan. Teruslah melangkah.",
  "Setiap transaksi adalah bukti kepercayaan. Jaga dengan baik.",
  "Kegagalan hari ini adalah pelajaran untuk kesuksesan esok.",
  "Mimpi besar dimulai dari langkah kecil.",
  "Waktu terbaik untuk memulai adalah sekarang.",
  "Kerja keras tidak pernah mengkhianati hasil.",
  "Fokus pada proses, hasil akan mengikuti.",
  "Pelanggan puas adalah aset paling berharga.",
  "Inovasi kecil setiap hari menciptakan perubahan besar.",
  "Jangan takut gagal, takutlah tidak pernah mencoba."
];

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, d) { try { fs.writeFileSync(p, JSON.stringify(d, null, 2)); } catch {} }

function getAdmins() { return readJson(DB_ADMIN_PATH, []); }
function saveAdmins(d) { writeJson(DB_ADMIN_PATH, d); }
function getUsers() { return readJson(DB_USERS_PATH, {}); }
function saveUsers(d) { writeJson(DB_USERS_PATH, d); }
function getMode() { return readJson(DB_MODE_PATH, { mode: 'public' }).mode; }
function setMode(m) { writeJson(DB_MODE_PATH, { mode: m }); }

function registerUser(ctx) {
  try {
    if (!ctx.from) return;
    const users = getUsers();
    const id = String(ctx.from.id);
    const now = moment().tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss');
    if (!users[id]) {
      users[id] = { id, first_name: ctx.from.first_name || '', username: ctx.from.username || '', first_seen: now, last_seen: now };
    } else {
      users[id].last_seen = now;
    }
    saveUsers(users);
  } catch {}
}
function auditLog(action, by, detail = '') {
  try {
    const line = `[${moment().tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss')}] ${action} | by=${by} | ${detail}\n`;
    fs.appendFileSync(AUDIT_LOG_PATH, line);
  } catch {}
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const isOwner = (id) => String(id) === String(TELEGRAM_CHAT_ID);
const isAdmin = (id) => isOwner(id) || getAdmins().includes(String(id));
const nowUnix = () => Math.floor(Date.now() / 1000);
const rupiah = (n) => Number(n || 0).toLocaleString('id-ID');
const wibNow = () => moment().tz('Asia/Jakarta').format('DD-MM-YYYY HH:mm:ss');
const wibNowLog = () => moment().tz('Asia/Jakarta').format('DD MMMM YYYY - HH:mm:ss');
const namaBulan = (m) => BULAN[typeof m === 'number' ? m : m.month() + 1];

const rateLimitMap = new Map();
function checkRateLimit(userId) {
  const now = Date.now();
  const key = String(userId);
  let d = rateLimitMap.get(key);
  if (!d || now > d.resetAt) d = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  d.count++;
  rateLimitMap.set(key, d);
  return d.count <= RATE_LIMIT_MAX;
}

async function axiosRetry(config, maxAttempts = 3) {
  for (let i = 0; i < maxAttempts; i++) {
    try { return await axios(config); }
    catch (e) {
      if (i === maxAttempts - 1) throw e;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 1000));
    }
  }
}

function encryptBuffer(buf, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([salt, iv, enc]);
}
function decryptBuffer(buf, password) {
  const salt = buf.slice(0, 16);
  const iv = buf.slice(16, 32);
  const ct = buf.slice(32);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

async function reactToMessage(chatId, msgId, emoji) {
  try { await bot.telegram.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji }]); } catch {}
}

async function safeEditOrReply(ctx, text, opts) {
  try { await ctx.editMessageText(text, opts); }
  catch { await ctx.deleteMessage().catch(() => {}); await ctx.reply(text, opts); }
}

function sendNotif(text, options = {}) {
  return bot.telegram.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML', ...options })
    .catch(e => console.error(`[${NOTIF_PREFIX}] Notif error:`, e.message));
}
function broadcastToAdmins(text, options = {}) {
  const ids = [TELEGRAM_CHAT_ID, ...getAdmins()];
  return Promise.all(ids.map(id => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML', ...options }).catch(() => {})));
}

const pending2FA = new Map();
const verified2FA = new Map();

function request2FA(ctx, type, payload) {
  pending2FA.set(String(ctx.from.id), { type, payload });
  return ctx.reply(`🔐 <b>VERIFIKASI 2FA</b>\n\n<blockquote>Kirim kode 6 digit dari <code>.env</code> untuk melanjutkan.\n\n<i>Ketik /cancel untuk batal.</i></blockquote>`, { parse_mode: 'HTML' });
}

bot.use((ctx, next) => {
  registerUser(ctx);
  const mode = getMode();
  if (mode === 'private' && ctx.from && !isAdmin(ctx.from.id)) {
    if (ctx.callbackQuery) {
      ctx.answerCbQuery("🔒 Bot dalam mode private. Hubungi owner.", { show_alert: true }).catch(() => {});
      return;
    }
    if (ctx.message?.text === '/start') {
      return ctx.reply("🔒 <b>Bot dalam mode private</b>\n\nHanya owner & admin yang bisa mengakses bot ini.", { parse_mode: 'HTML' });
    }
    if (ctx.message) {
      return ctx.reply("🔒 Bot dalam mode private. Hanya owner & admin yang bisa mengakses.");
    }
  }
  if (ctx.message?.text?.startsWith('/') && ctx.message.text !== '/start') {
    if (!checkRateLimit(ctx.from.id)) {
      return ctx.reply("⚠️ Terlalu banyak command. Tunggu 1 menit ya.");
    }
  }
  return next();
});

async function fetchRealtimeFromGateway() {
  try {
    const startTime = Math.floor(Date.now() / 1000) - (30 * 86400);
    const res = await axiosRetry({
      url: `${GATEWAY_URL}/transactions?startTime=${startTime}&endTime=${Math.floor(Date.now() / 1000)}&pageSize=100`,
      headers: { 'X-API-Key': API_KEY }, timeout: 30000
    });
    const txs = res.data?.data?.transactions || [];
    const todayStr = moment().tz('Asia/Jakarta').format('YYYY-MM-DD');
    const monthStr = moment().tz('Asia/Jakarta').format('YYYY-MM');

    let todayTotal = 0, todayCount = 0, monthTotal = 0, monthCount = 0;
    const todayIssuers = {}, monthIssuers = {};

    txs.forEach(t => {
      const rawTime = t.time || t.created_at || t.transaction_time || t.date;
      if (!rawTime) return;
      let m;
      if (typeof rawTime === 'string') {
        m = moment.tz(rawTime, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta');
        if (!m.isValid()) m = moment.tz(rawTime, 'Asia/Jakarta');
      } else if (!isNaN(Number(rawTime))) {
        m = moment.unix(Number(rawTime)).tz('Asia/Jakarta');
      }
      if (m.isValid()) {
        const txDate = m.format('YYYY-MM-DD');
        const txMonth = m.format('YYYY-MM');
        const amt = Number(t.amount || t.total || 0);
        const k = t.issuer || 'QRIS';
        if (txDate === todayStr) {
          todayTotal += amt; todayCount++;
          todayIssuers[k] ??= { amount: 0, count: 0 };
          todayIssuers[k].amount += amt; todayIssuers[k].count++;
        }
        if (txMonth === monthStr) {
          monthTotal += amt; monthCount++;
          monthIssuers[k] ??= { amount: 0, count: 0 };
          monthIssuers[k].amount += amt; monthIssuers[k].count++;
        }
      }
    });
    return {
      today: { total: todayTotal, count: todayCount, issuers: todayIssuers },
      month: { total: monthTotal, count: monthCount, issuers: monthIssuers }
    };
  } catch (e) { console.error("fetchRealtime:", e.message); return null; }
}

async function getRealtimeData() {
  for (let i = 0; i < 3; i++) {
    const data = await fetchRealtimeFromGateway();
    if (data) {
      if (data.today.count === 0 && data.month.count === 0 && i < 2) {
        await new Promise(r => setTimeout(r, 2000)); continue;
      }
      return data;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { today: { total: 0, count: 0, issuers: {} }, month: { total: 0, count: 0, issuers: {} } };
}

let lastTokenStatus = null;
let lastAutoRefresh = 0;

async function checkTokenStatus(isStartup = false) {
  try {
    const r = await axios.get(`${GATEWAY_URL}/token-status`, { headers: { 'X-API-Key': API_KEY }, timeout: 15000 });
    const gatewayStatus = r.data?.data?.token_status || 'unknown';
    let finalStatus = gatewayStatus;
    if (gatewayStatus === 'valid') {
      try {
        await axios.get(`${GATEWAY_URL}/transactions?startTime=${nowUnix() - 86400}&endTime=${nowUnix()}&pageSize=1`, { headers: { 'X-API-Key': API_KEY }, timeout: 10000 });
        finalStatus = 'valid';
      } catch { finalStatus = 'invalid'; }
    }
    if (finalStatus === 'invalid' && Date.now() - lastAutoRefresh > 5 * 60 * 1000) {
      const ok = await tryAutoRefreshToken();
      if (ok) { finalStatus = 'valid'; lastAutoRefresh = Date.now(); }
    }
    if (!isStartup && finalStatus !== lastTokenStatus) {
      if (finalStatus === 'valid') sendNotif(`✅ <b>[${NOTIF_PREFIX}] TOKEN VALID</b>\n\n<blockquote>🔑 Token Shopee aktif.</blockquote>`);
      else if (finalStatus === 'invalid') sendNotif(`⚠️ <b>[${NOTIF_PREFIX}] TOKEN INVALID!</b>\n\n<blockquote>Update via tombol Update Token.</blockquote>`);
    }
    lastTokenStatus = finalStatus;
    return finalStatus;
  } catch (e) {
    if (!isStartup && lastTokenStatus !== 'error') {
      sendNotif(`❌ <b>[${NOTIF_PREFIX}] GAGAL CEK TOKEN</b>\n\n<blockquote>${e.message}</blockquote>`);
      lastTokenStatus = 'error';
    }
    return 'error';
  }
}

async function tryAutoRefreshToken() {
  try {
    const r = await axios.post(`${GATEWAY_URL}/refresh-token`, {}, { headers: { 'X-API-Key': API_KEY }, timeout: 20000 });
    if (r.data?.success && r.data?.data?.token) {
      updateEnvToken(r.data.data.token);
      sendNotif(`🔄 <b>TOKEN AUTO-REFRESH BERHASIL</b>`);
      return true;
    }
    return false;
  } catch { return false; }
}

function getCurrentTokenFromEnv() {
  try {
    if (!fs.existsSync(ENV_PATH)) return 'Tidak ditemukan';
    const env = fs.readFileSync(ENV_PATH, 'utf8');
    const m = env.match(/SHOPEE_TOKEN=["']?(.*?)["']?(\r?\n|$)/);
    return m && m[1] ? m[1] : 'Kosong';
  } catch { return 'Error'; }
}
function updateEnvToken(newToken) {
  try {
    if (!fs.existsSync(ENV_PATH)) return false;
    let c = fs.readFileSync(ENV_PATH, 'utf8');
    if (c.includes('SHOPEE_TOKEN=')) c = c.replace(/SHOPEE_TOKEN=.*/g, `SHOPEE_TOKEN="${newToken}"`);
    else c += `\nSHOPEE_TOKEN="${newToken}"\n`;
    fs.writeFileSync(ENV_PATH, c);
    return true;
  } catch { return false; }
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Shopee-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/summary', async (req, res) => { res.json({ success: true, data: await getRealtimeData() }); });

app.post('/webhook/transaction', async (req, res) => {
  try {
    const tx = req.body || {};
    if (!tx.amount && !tx.total) return res.status(400).json({ success: false, error: 'No amount' });
    const amount = Number(tx.amount || tx.total || 0);
    const issuer = tx.issuer || tx.payment_method || 'QRIS';
    sendNotif(`🔔 <b>TRANSAKSI BARU</b>\n\n<blockquote>💰 Rp ${rupiah(amount)}\n💳 ${issuer}\n🕐 ${wibNow()} WIB</blockquote>`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/status', async (req, res) => {
  try {
    const tokenStatus = await checkTokenStatus(true);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const ramPercent = ((os.freemem() / os.totalmem()) * 100).toFixed(1);
    const rt = await getRealtimeData();
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${NOTIF_PREFIX}</title>
<style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui;padding:24px}h1{color:#38bdf8}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.card{background:#1e293b;border-radius:12px;padding:20px;border-left:4px solid #38bdf8}.label{font-size:12px;color:#94a3b8;text-transform:uppercase}.value{font-size:24px;font-weight:bold;margin-top:8px}</style></head><body>
<h1>🛍️ ${NOTIF_PREFIX}</h1><div class="grid">
<div class="card"><div class="label">Token</div><div class="value">${tokenStatus === 'valid' ? '✅' : '❌'}</div></div>
<div class="card"><div class="label">RAM</div><div class="value">${ramPercent}%</div></div>
<div class="card"><div class="label">Hari Ini</div><div class="value">Rp ${rupiah(rt.today.total)}</div></div>
<div class="card"><div class="label">Bulan Ini</div><div class="value">Rp ${rupiah(rt.month.total)}</div></div>
</div><p style="text-align:center;margin-top:24px;color:#64748b">${wibNow()} WIB</p>
<script>setTimeout(()=>location.reload(),30000)</script></body></html>`);
  } catch (e) { res.status(500).send('Error: ' + e.message); }
});

app.all('*', async (req, res) => {
  try {
    const response = await axios({
      method: req.method, url: `${GATEWAY_URL}${req.originalUrl}`, data: req.body,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'X-API-Key': req.headers['x-api-key'] || '',
        'X-Shopee-Token': req.headers['x-shopee-token'] || '',
      },
      validateStatus: () => true, responseType: 'arraybuffer', maxRedirects: 0,
    });
    for (const [k, v] of Object.entries(response.headers)) {
      const lk = k.toLowerCase();
      if (lk !== 'content-encoding' && lk !== 'transfer-encoding') res.set(k, v);
    }
    const ct = response.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      const bodyStr = Buffer.from(response.data).toString('utf8');
      let body;
      try { body = JSON.parse(bodyStr); } catch { return res.status(response.status).send(bodyStr); }

      if (req.path === '/create-qris' && body?.success && body.data) {
        const txId = body.data.transactionId || body.data.id || '-';
        sendNotif(`🛒 <b>QRIS BARU</b>\n\n<blockquote>💰 Rp ${rupiah(body.data.amount)}\n🧾 <code>${txId}</code></blockquote>`);
      }
      if (req.path === '/check-payment' && body?.paid) {
        const tx = body.transaction || {};
        sendNotif(`✅ <b>PEMBAYARAN BERHASIL</b>\n\n<blockquote>💰 Rp ${rupiah(tx.amount || tx.total || 0)}\n💳 ${tx.issuer || 'QRIS'}\n🕐 ${wibNow()} WIB</blockquote>`);
      }
      return res.status(response.status).json(body);
    }
    res.status(response.status).send(Buffer.from(response.data));
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(WRAPPER_PORT, () => {
  console.log(chalk.bold.green(`[${NOTIF_PREFIX}] Proxy ${WRAPPER_PORT} ➡️ ${GATEWAY_PORT}`));
});

cron.schedule('59 16 * * *', async () => {
  try {
    const rt = await getRealtimeData();
    if (rt.today.count === 0 && rt.month.count === 0) return;
    const entries = Object.entries(rt.today.issuers).sort((a, b) => b[1].amount - a[1].amount);
    const rincian = entries.length ? entries.map(([n, d]) => `  • ${n}: Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") : '  • Belum ada transaksi';
    sendNotif(
      `📝 <b>[${NOTIF_PREFIX}] LAPORAN HARIAN</b>\n\n` +
      `<blockquote>📅 ${moment().tz('Asia/Jakarta').format('DD-MM-YYYY')}\n💰 Rp ${rupiah(rt.today.total)}\n📈 ${rt.today.count} transaksi</blockquote>\n` +
      `<blockquote>💳 Rincian:\n${rincian}</blockquote>\n\n` +
      `<i>📊 Bulan Ini: Rp ${rupiah(rt.month.total)} (${rt.month.count} tx)</i>`
    );
  } catch (err) { console.error("Cron:", err.message); }
});

cron.schedule('0 3 * * *', async () => {
  try {
    const { zipPath, zipName, size } = await createBackupZip();
    cleanOldBackups();
    const cap = `🌅 <b>AUTO-BACKUP HARIAN</b>\n\n<blockquote>📁 <code>${zipName}</code>\n📦 ${(size / 1024 / 1024).toFixed(2)} MB</blockquote>`;
    await bot.telegram.sendDocument(TELEGRAM_CHAT_ID, { source: fs.createReadStream(zipPath), filename: zipName }, { caption: cap, parse_mode: 'HTML' }).catch(() => {});
    try { fs.unlinkSync(zipPath); } catch {}
  } catch (e) { console.error('[AutoBackup]', e.message); }
});

cron.schedule('* * * * *', async () => {
  try {
    const schedules = readJson(DB_SCHEDULE_PATH, []);
    if (!schedules.length) return;
    const now = moment();
    const due = [], remaining = [];
    for (const s of schedules) {
      if (moment(s.time).isSameOrBefore(now)) due.push(s);
      else remaining.push(s);
    }
    for (const s of due) {
      try { await bot.telegram.sendMessage(s.chat_id, s.text, { parse_mode: 'HTML' }).catch(() => {}); } catch {}
    }
    if (due.length) writeJson(DB_SCHEDULE_PATH, remaining);
  } catch {}
});

setInterval(() => {
  const freeMem = os.freemem(), totalMem = os.totalmem();
  if ((freeMem / totalMem) * 100 < 15) {
    broadcastToAdmins(`⚠️ <b>RAM VPS KRITIS!</b>\n\n<blockquote>Sisa RAM: <b>${((freeMem / totalMem) * 100).toFixed(1)}%</b></blockquote>`);
  }
}, 60 * 60 * 1000);

function createBackupZip() {
  return new Promise((resolve, reject) => {
    const ts = moment().tz('Asia/Jakarta').format('YYYY-MM-DD-HH-mm-ss');
    const zipName = `backup-shopee2-${ts}.zip`;
    const zipPath = path.join(BACKUP_DIR, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve({ zipPath, zipName, size: archive.pointer() }));
    archive.on('error', reject);
    archive.pipe(output);
    if (fs.existsSync(ENV_PATH)) archive.file(ENV_PATH, { name: '.env' });
    if (fs.existsSync(DB_ADMIN_PATH)) archive.file(DB_ADMIN_PATH, { name: 'admin.json' });
    if (fs.existsSync(DB_USERS_PATH)) archive.file(DB_USERS_PATH, { name: 'users.json' });
    archive.glob('**/*', { cwd: __dirname, ignore: ['node_modules/**', 'backup/**', '.git/**', 'package-lock.json'] });
    archive.finalize();
  });
}

function cleanOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && (f.endsWith('.zip') || f.endsWith('.enc')))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    if (files.length > MAX_BACKUP_FILES) files.slice(MAX_BACKUP_FILES).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch {} });
  } catch {}
}

(async () => {
  console.log(chalk.bold.yellow(`[${NOTIF_PREFIX}] Booting...`));
  sendNotif(`🔄 <b>[${NOTIF_PREFIX}] STARTING</b>\n\n<blockquote>Memuat data...</blockquote>`);
  await new Promise(r => setTimeout(r, 5000));
  const status = await checkTokenStatus(true);
  const isValid = status === 'valid';
  let rt = null;
  if (isValid) {
    for (let i = 0; i < 3; i++) {
      rt = await getRealtimeData();
      if (rt && (rt.today.count > 0 || rt.month.count > 0)) break;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  let laporan = `🚀 <b>[${NOTIF_PREFIX}] READY</b>\n\n` +
    `<blockquote>🌐 Proxy: <code>${WRAPPER_PORT}</code>\n🔑 Token: ${isValid ? '✅ VALID' : '❌ INVALID'}\n🤖 Mode: <b>${getMode() === 'public' ? '🌐 Public' : '🔒 Private'}</b></blockquote>\n\n`;
  if (isValid && rt) {
    laporan += `📅 <b>Hari Ini</b>\n<blockquote>💰 Rp ${rupiah(rt.today.total)}\n📈 ${rt.today.count} transaksi</blockquote>\n\n` +
      `📊 <b>Bulan Ini</b>\n<blockquote>💰 Rp ${rupiah(rt.month.total)}\n📈 ${rt.month.count} transaksi</blockquote>\n\n`;
  }
  laporan += `💡 <i>"${quote}"</i>\n\n<i>🕐 ${wibNow()} WIB</i>`;
  sendNotif(laporan);
})();

setInterval(() => checkTokenStatus(false), 5 * 60 * 1000);

const menuCaption = (ctx) => {
  const name = ((ctx.from.first_name || '') + (ctx.from.last_name ? ' ' + ctx.from.last_name : '')).trim() || 'User';
  const mode = getMode() === 'public' ? '🌐 Public' : '🔒 Private';
  return `
<b>🛍️ ${NOTIF_PREFIX}</b>
<blockquote>⎨ Bot : ${NOTIF_PREFIX}
⎨ Mode : ${mode}
⎨ Status : Online 🟢</blockquote>

<b>👤 USER</b>
<blockquote>⎨ Name : ${name}
⎨ ID : <code>${ctx.from.id}</code>
⎨ Chat : ${ctx.chat.type === 'private' ? 'Private' : 'Group'}</blockquote>

<i>Silakan pilih menu di bawah 👇</i>
`;
};

const buildMainKeyboard = () => [
  [{ text: "📈 Laporan", callback_data: "sh_laporan", style: "primary" }, { text: "💳 Bikin QRIS", callback_data: "sh_qr_menu", style: "success" }],
  [{ text: "🔧 Update Token", callback_data: "sh_update_token_menu", style: "danger" }, { text: "🔄 Restart", callback_data: "sh_restart_menu", style: "danger" }],
  [{ text: "💻 Sysinfo", callback_data: "sh_sysinfo", style: "primary" }, { text: "📦 Backup", callback_data: "sh_backup", style: "success" }],
  [{ text: "🏓 Ping", callback_data: "sh_ping", style: "primary" }, { text: "🔑 Cek Token", callback_data: "sh_token", style: "primary" }],
  [{ text: "⚙️ Fitur Lainnya", callback_data: "sh_other_menu", style: "danger" }],
  [{ text: "👨‍💻 Developer", url: "https://t.me/rulzz2nd", style: "primary" }]
];

function checkAccess(ctx, ownerOnly = false) {
  if (ownerOnly && !isOwner(ctx.from.id)) {
    ctx.answerCbQuery("❌ Khusus Owner!", { show_alert: true }).catch(() => {});
    return false;
  }
  if (!ownerOnly && !isAdmin(ctx.from.id)) {
    ctx.answerCbQuery("❌ Bukan Admin!", { show_alert: true }).catch(() => {});
    return false;
  }
  return true;
}

bot.start((ctx) => ctx.reply(menuCaption(ctx), { parse_mode: "HTML", reply_markup: { inline_keyboard: buildMainKeyboard() } }));

bot.action("mainmenu", async (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  await safeEditOrReply(ctx, menuCaption(ctx), { parse_mode: "HTML", reply_markup: { inline_keyboard: buildMainKeyboard() } });
});

bot.action("sh_other_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText(`⚙️ <b>FITUR LAINNYA</b>\n\n<blockquote>Menu khusus Owner.</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "📜 Logs PM2", callback_data: "sh_logs", style: "danger" }, { text: "📤 Update File", callback_data: "sh_update_file_menu", style: "danger" }],
      [{ text: "🗑️ Kelola Backup", callback_data: "sh_manage_backup", style: "danger" }, { text: "📅 Jadwal Pesan", callback_data: "sh_schedule_menu", style: "primary" }],
      [{ text: "📢 Broadcast User", callback_data: "sh_broadcast_menu", style: "primary" }, { text: "📋 Audit Log", callback_data: "sh_audit_log", style: "primary" }],
      [{ text: "👑 Admin Menu", callback_data: "sh_admin_menu", style: "primary" }, { text: "🤖 Mode Bot", callback_data: "sh_mode_menu", style: "primary" }],
      [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]
    ] }
  }).catch(() => {});
});

bot.action("sh_mode_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const current = getMode();
  ctx.editMessageText(`🤖 <b>MODE BOT</b>\n\n<blockquote>Mode saat ini: <b>${current === 'public' ? '🌐 Public' : '🔒 Private'}</b>\n\n• <b>Public</b>: semua user bisa pakai\n• <b>Private</b>: hanya owner & admin</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "🌐 Public", callback_data: "set_mode_public", style: current === 'public' ? 'success' : 'primary' }],
      [{ text: "🔒 Private", callback_data: "set_mode_private", style: current === 'private' ? 'success' : 'primary' }],
      [{ text: "⬅️ Kembali", callback_data: "sh_other_menu", style: "primary" }]
    ] }
  }).catch(() => {});
});

bot.action("set_mode_public", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  setMode('public');
  auditLog('SET_MODE', ctx.from.id, 'public');
  ctx.answerCbQuery("✅ Mode Public aktif").catch(() => {});
  ctx.editMessageText(`✅ <b>Mode Bot: Public</b>\n\n<blockquote>Semua user bisa pakai bot.</blockquote>`, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_mode_menu", style: "primary" }]] }
  }).catch(() => {});
});

bot.action("set_mode_private", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  setMode('private');
  auditLog('SET_MODE', ctx.from.id, 'private');
  ctx.answerCbQuery("✅ Mode Private aktif").catch(() => {});
  ctx.editMessageText(`🔒 <b>Mode Bot: Private</b>\n\n<blockquote>Hanya owner & admin yang bisa pakai.</blockquote>`, {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_mode_menu", style: "primary" }]] }
  }).catch(() => {});
});

bot.action("sh_laporan", async (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  await safeEditOrReply(ctx, "📈 <b>MENU LAPORAN</b>\n\n<blockquote>Pilih laporan:</blockquote>", {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "📊 Laporan Lengkap", callback_data: "sh_all_reports", style: "primary" }],
      [{ text: "🧾 Transaksi Lengkap", callback_data: "sh_hist", style: "primary" }],
      [{ text: "🗓️ Rekap Bulanan", callback_data: "sh_rekap", style: "success" }],
      [{ text: "📈 Grafik 7 Hari", callback_data: "sh_chart_7d", style: "success" }],
      [{ text: "📥 Export CSV", callback_data: "sh_export_menu", style: "success" }],
      [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "danger" }]
    ] }
  });
});

bot.action("sh_all_reports", (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  ctx.reply("⏳ <i>Mengambil data...</i>", { parse_mode: "HTML" }).then(loading => {
    getRealtimeData().then(rt => {
      ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      const topToday = Object.entries(rt.today.issuers).sort((a, b) => b[1].amount - a[1].amount);
      const topMonth = Object.entries(rt.month.issuers).sort((a, b) => b[1].amount - a[1].amount);
      const fmtTop = (arr) => arr.length ? arr.map(([n, d], i) => `  ${i + 1}. <b>${n}</b>\n     Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") : "  Belum ada transaksi";
      const now = moment().tz('Asia/Jakarta');

      let out = `📊 <b>Statistik Merchant Shopee Kamu</b>\n\n`;
      out += `📅 <b>Hari Ini</b>\n<blockquote>💰 Total: <b>Rp ${rupiah(rt.today.total)}</b>\n📈 Transaksi: <b>${rt.today.count}</b></blockquote>\n\n`;
      out += `📆 <b>${namaBulan(now)} ${now.year()}</b>\n<blockquote>💰 Total: <b>Rp ${rupiah(rt.month.total)}</b>\n📈 Transaksi: <b>${rt.month.count}</b></blockquote>\n\n`;
      out += `💳 <b>Top Issuer Hari Ini</b>\n<blockquote>${fmtTop(topToday)}</blockquote>\n\n`;
      out += `💳 <b>Top Issuer ${namaBulan(now)}</b>\n<blockquote>${fmtTop(topMonth)}</blockquote>\n\n`;
      out += `<i>🕐 ${wibNow()} WIB</i>`;

      ctx.reply(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]] } });
    }).catch(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      ctx.reply("❌ Gagal.");
    });
  }).catch(() => {});
});

bot.action("sh_chart_7d", async (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery("⏳ Generate grafik...").catch(() => {});
  try {
    const startUnix = moment().tz('Asia/Jakarta').subtract(6, 'days').startOf('day').unix();
    const res = await axios.get(`${GATEWAY_URL}/transactions?startTime=${startUnix}&endTime=${nowUnix()}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } });
    const txs = res.data?.data?.transactions || [];
    const days = {};
    for (let i = 6; i >= 0; i--) days[moment().tz('Asia/Jakarta').subtract(i, 'days').format('YYYY-MM-DD')] = 0;
    txs.forEach(t => {
      const rawTime = t.time || t.created_at || t.transaction_time || t.date;
      if (!rawTime) return;
      const m = moment.tz(rawTime, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta');
      if (m.isValid()) {
        const d = m.format('YYYY-MM-DD');
        if (days[d] !== undefined) days[d] += Number(t.amount || t.total || 0);
      }
    });
    const labels = Object.keys(days).map(d => moment(d).format('DD/MM'));
    const values = Object.values(days);

    const chartConfig = {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Penjualan', data: values, backgroundColor: 'rgba(56,189,248,0.7)', borderColor: 'rgb(56,189,248)', borderWidth: 2 }]
      },
      options: {
        plugins: {
          title: { display: true, text: 'Penjualan 7 Hari Terakhir', font: { size: 18 } },
          datalabels: {
            display: true,
            align: 'top',
            anchor: 'end',
            formatter: "(v) => v >= 1000000 ? (v/1000000).toFixed(1) + 'jt' : v >= 1000 ? (v/1000).toFixed(0) + 'rb' : '' + v",
            color: '#1e293b',
            font: { size: 11, weight: 'bold' }
          }
        },
        scales: { y: { beginAtZero: true } }
      }
    };
    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=800&h=400&bkg=white`;
    const imgRes = await axios.get(chartUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const buf = Buffer.from(imgRes.data, 'binary');
    await ctx.deleteMessage().catch(() => {});
    await ctx.replyWithPhoto({ source: buf }, {
      caption: `📈 <b>GRAFIK 7 HARI TERAKHIR</b>\n\n<blockquote>Total: <b>Rp ${rupiah(values.reduce((a, b) => a + b, 0))}</b>\n🕐 ${wibNow()} WIB</blockquote>`,
      parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]] }
    });
  } catch (e) { ctx.editMessageText("❌ Gagal: " + e.message).catch(() => {}); }
});

bot.action("sh_rekap", (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  const now = moment().tz('Asia/Jakarta');
  const opts = [];
  for (let i = 0; i < 6; i++) {
    const m = now.clone().subtract(i, 'months');
    opts.push([{ text: `${namaBulan(m)} ${m.year()}`, callback_data: `rekap_${m.format('MM-YYYY')}`, style: "primary" }]);
  }
  opts.push([{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]);
  ctx.editMessageText("📅 <b>PILIH BULAN REKAP</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: opts } }).catch(() => {});
});

bot.action(/^rekap_(\d{2})-(\d{4})$/, (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  const month = parseInt(ctx.match[1]), year = ctx.match[2];
  ctx.deleteMessage().catch(() => {});
  ctx.reply("⏳ <i>Mengambil...</i>", { parse_mode: "HTML" }).then(loading => {
    const startUnix = moment(`${year}-${String(month).padStart(2, '0')}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').startOf('month').unix();
    const endUnix = moment(`${year}-${String(month).padStart(2, '0')}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').endOf('month').unix();
    axios.get(`${GATEWAY_URL}/transactions?startTime=${startUnix}&endTime=${endUnix}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } })
      .then(res => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        const txs = res.data?.data?.transactions || [];
        let total = 0; const issuers = {};
        txs.forEach(t => { const amt = Number(t.amount || t.total || 0); total += amt; const k = t.issuer || 'Unknown'; issuers[k] ??= { amount: 0, count: 0 }; issuers[k].amount += amt; issuers[k].count++; });
        const rB = Object.entries(issuers).sort((a, b) => b[1].amount - a[1].amount).map(([n, d]) => `  • ${n}: Rp ${rupiah(d.amount)} (${d.count} tx)`).join("\n") || "  • Belum ada";
        const out = `📅 <b>REKAP ${namaBulan(month).toUpperCase()} ${year}</b>\n\n<blockquote>💰 Total: <b>Rp ${rupiah(total)}</b>\n📈 Transaksi: ${txs.length}\n\n💳 Rincian:\n${rB}</blockquote>`;
        ctx.reply(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_rekap", style: "primary" }]] } });
      }).catch(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        ctx.reply("❌ Gagal.");
      });
  }).catch(() => {});
});

bot.action("sh_export_menu", (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  const now = moment().tz('Asia/Jakarta');
  const opts = [[{ text: "📚 Export Semua Data", callback_data: "export_ALL", style: "success" }]];
  for (let i = 0; i < 6; i++) {
    const m = now.clone().subtract(i, 'months');
    opts.push([{ text: `${namaBulan(m)} ${m.year()}`, callback_data: `export_${m.format('MM-YYYY')}`, style: "primary" }]);
  }
  opts.push([{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]);
  ctx.editMessageText("📥 <b>PILIH EXPORT CSV</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: opts } }).catch(() => {});
});

function buildCsv(txs) {
  let csv = "Tanggal,TrxID,Issuer,Nominal,Status\n";
  txs.forEach((t, i) => {
    const rawTgl = t.time || t.created_at || t.transaction_time || t.date || moment().format('YYYY-MM-DD HH:mm:ss');
    const m = moment.tz(rawTgl, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta');
    const tgl = m.isValid() ? m.format('DD-MM-YYYY HH:mm:ss') : moment(rawTgl).format('DD-MM-YYYY HH:mm:ss');
    const ym = m.isValid() ? m.format('YYYYMM') : moment().format('YYYYMM');
    const trxId = t.transactionId || t.trx_id || t.id || `TRX-${ym}-${i + 1}`;
    csv += `"${tgl}","${trxId}","${t.issuer || 'QRIS'}",${t.amount || t.total || 0},"Success"\n`;
  });
  return csv;
}

bot.action(/^export_(\d{2}-\d{4}|ALL)$/, (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery("⏳ Menyiapkan...").catch(() => {});
  const val = ctx.match[1];
  ctx.reply(`⏳ <i>Mengambil data...</i>`, { parse_mode: "HTML" }).then(loading => {
    let startUnix, endUnix, filename, label;
    if (val === 'ALL') {
      startUnix = moment().tz('Asia/Jakarta').subtract(12, 'months').startOf('month').unix();
      endUnix = nowUnix(); filename = `Rekap_Semua.csv`; label = 'SEMUA DATA';
    } else {
      const [mm, yy] = val.split('-');
      startUnix = moment(`${yy}-${mm}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').startOf('month').unix();
      endUnix = moment(`${yy}-${mm}-01`, "YYYY-MM-DD").tz('Asia/Jakarta').endOf('month').unix();
      filename = `Rekap_${namaBulan(parseInt(mm))}_${yy}.csv`;
      label = `${namaBulan(parseInt(mm))} ${yy}`;
    }
    axios.get(`${GATEWAY_URL}/transactions?startTime=${startUnix}&endTime=${endUnix}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } })
      .then(res => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        const txs = res.data?.data?.transactions || [];
        if (!txs.length) return ctx.reply(`Belum ada transaksi ${label}.`);
        const filePath = path.join(BACKUP_DIR, `export-${val}.csv`);
        fs.writeFileSync(filePath, buildCsv(txs));
        ctx.replyWithDocument({ source: fs.createReadStream(filePath), filename }, {
          caption: `📊 <b>EXPORT CSV ${label.toUpperCase()}</b>\n\n<blockquote>${txs.length} transaksi\n🕐 ${wibNow()} WIB</blockquote>`,
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_export_menu", style: "primary" }]] }
        }).catch(() => {});
        setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 10000);
      }).catch(e => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        ctx.reply("❌ " + e.message);
      });
  }).catch(() => {});
});

let allTxCache = [];
function renderHistoryPage(txs, page) {
  const perPage = 10;
  const slice = txs.slice(page * perPage, page * perPage + perPage);
  let out = `🧾 <b>TRANSAKSI LENGKAP</b>\n\n`;
  if (!slice.length) out += `<i>Kosong.</i>`;
  else slice.forEach((t, i) => {
    const idx = page * perPage + i + 1;
    const rawTime = t.time || t.created_at || t.transaction_time || t.date || '-';
    let tgl = '-', ym = moment().format('YYYYMM');
    if (rawTime !== '-') {
      const m = moment.tz(rawTime, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta');
      if (m.isValid()) { tgl = m.format('DD-MM-YYYY HH:mm:ss'); ym = m.format('YYYYMM'); }
    }
    const trxId = t.transactionId || t.trx_id || t.id || `TRX-${ym}-${idx}`;
    out += `<blockquote>${idx}. Rp ${rupiah(t.amount || t.total || 0)} | ${t.issuer || 'QRIS'}\n🕐 ${tgl}\n🧾 <code>${trxId}</code></blockquote>\n`;
  });
  out += `\n<i>Halaman ${page + 1} / ${Math.ceil(txs.length / perPage) || 1}</i>`;
  return out;
}
function buildHistoryKeyboard(page, totalPages) {
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️ Prev", callback_data: `hist_${page - 1}`, style: "primary" });
  if (page < totalPages - 1) nav.push({ text: "Next ➡️", callback_data: `hist_${page + 1}`, style: "primary" });
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "danger" }]);
  return rows;
}

bot.action("sh_hist", (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  ctx.reply("⏳ <i>Mengambil...</i>", { parse_mode: "HTML" }).then(loading => {
    axios.get(`${GATEWAY_URL}/transactions?startTime=${nowUnix() - 30 * 86400}&endTime=${nowUnix()}&pageSize=100`, { headers: { 'X-API-Key': API_KEY } })
      .then(res => {
        ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
        const txs = res.data?.data?.transactions || [];
        if (!txs.length) return ctx.reply("Belum ada transaksi.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_laporan", style: "primary" }]] } });
        allTxCache = txs;
        const totalPages = Math.ceil(txs.length / 10);
        ctx.reply(renderHistoryPage(txs, 0), { parse_mode: "HTML", reply_markup: { inline_keyboard: buildHistoryKeyboard(0, totalPages) } });
      }).catch(() => {});
  }).catch(() => {});
});

bot.action(/^hist_(\d+)$/, (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  const page = parseInt(ctx.match[1]);
  if (!allTxCache?.length) return ctx.answerCbQuery("⚠️ Sesi habis", { show_alert: true });
  const totalPages = Math.ceil(allTxCache.length / 10);
  ctx.editMessageText(renderHistoryPage(allTxCache, page), { parse_mode: "HTML", reply_markup: { inline_keyboard: buildHistoryKeyboard(page, totalPages) } }).catch(() => {});
});

bot.action("sh_token", async (ctx) => {
  if (!checkAccess(ctx)) return;
  ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText("⏳ <i>Cek token...</i>", { parse_mode: "HTML" }).catch(() => {});
  const status = await checkTokenStatus(false);
  const token = getCurrentTokenFromEnv();
  let out, kb;
  if (status === "valid") {
    out = `✅ <b>Token VALID</b>\n\n<blockquote>TOKEN:</blockquote>\n<tg-spoiler><code>${token}</code></tg-spoiler>`;
    kb = [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]];
  } else {
    out = `❌ <b>Token INVALID</b>\n\n<blockquote>TOKEN:</blockquote>\n<tg-spoiler><code>${token}</code></tg-spoiler>\n\n<i>Update segera.</i>`;
    kb = [[{ text: "🔧 Update", callback_data: "sh_update_token_menu", style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]];
  }
  ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } }).catch(() => {});
});

bot.action("sh_ping", async (ctx) => {
  const start = Date.now();
  await ctx.answerCbQuery().catch(() => {});
  const latency = Date.now() - start;
  let sec = Math.floor(process.uptime());
  const days = Math.floor(sec / 86400); sec %= 86400;
  const hrs = Math.floor(sec / 3600); sec %= 3600;
  const mins = Math.floor(sec / 60); sec %= 60;
  ctx.editMessageText(`🏓 <b>Pong!</b>\n\n<blockquote>⚡ Latency: <b>${latency} ms</b>\n⏱️ Runtime: ${days}h ${hrs}j ${mins}m ${sec}d\n🕐 ${wibNow()} WIB</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "🔄 Refresh", callback_data: "sh_ping", style: "success" }],
      [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]
    ] }
  }).catch(() => {});
});

bot.action("sh_sysinfo", (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const used = process.memoryUsage();
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const ram = (used.heapUsed / 1024 / 1024).toFixed(2);
  const percentFree = ((os.freemem() / os.totalmem()) * 100).toFixed(1);
  const cpus = os.cpus();
  const load = os.loadavg();

  let sec = Math.floor(process.uptime());
  const bDays = Math.floor(sec / 86400); sec %= 86400;
  const bHrs = Math.floor(sec / 3600); sec %= 3600;
  const bMins = Math.floor(sec / 60); sec %= 60;
  const botUptime = `${bDays}h ${bHrs}j ${bMins}m ${sec}d`;

  const osSec = os.uptime();
  const osDays = Math.floor(osSec / 86400); const osHrs = Math.floor((osSec % 86400) / 3600);
  const osMins = Math.floor((osSec % 3600) / 60);
  const osUptime = `${osDays}h ${osHrs}j ${osMins}m`;

  const usersCount = Object.keys(getUsers()).length;
  const adminCount = getAdmins().length;

  exec('df -h / | tail -1', (err, stdout) => {
    let disk = { free: "0", percent: "0" };
    if (!err) { const df = stdout.trim().split(/\s+/); disk = { free: df[3], percent: df[4] }; }
    exec('cat /proc/net/dev | tail -n +3', (err2, stdout2) => {
      let net = "N/A";
      if (!err2) {
        let rx = 0, tx = 0;
        stdout2.trim().split('\n').forEach(line => { const p = line.trim().split(/\s+/); rx += parseInt(p[1]) || 0; tx += parseInt(p[9]) || 0; });
        net = `📥 ${(rx / 1024 / 1024).toFixed(2)} MB | 📤 ${(tx / 1024 / 1024).toFixed(2)} MB`;
      }
      const out = `💻 <b>SYSINFO VPS</b>\n\n<blockquote>⏱️ <b>Uptime Bot</b>: ${botUptime}\n⏱️ <b>Uptime OS</b>: ${osUptime}\n🧠 <b>RAM VPS</b>: ${freeMem}/${totalMem} GB (sisa ${percentFree}%)\n🤖 <b>RAM Bot</b>: ${ram} MB\n⚙️ <b>CPU</b>: ${cpus[0].model}\n🔢 <b>Cores</b>: ${cpus.length}\n📊 <b>Load</b>: ${load[0].toFixed(2)} / ${load[1].toFixed(2)} / ${load[2].toFixed(2)}\n💽 <b>Disk</b>: ${disk.percent} (sisa ${disk.free})\n🌐 <b>Traffic</b>: ${net}\n🖥️ <b>OS</b>: ${os.type()} ${os.release()} (${os.arch()})\n📦 <b>Node</b>: ${process.version}\n👥 <b>Users</b>: ${usersCount}\n👑 <b>Admins</b>: ${adminCount + 1}\n🤖 <b>Mode</b>: ${getMode() === 'public' ? '🌐 Public' : '🔒 Private'}</blockquote>`;
      ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [
        [{ text: "🔄 Refresh", callback_data: "sh_sysinfo", style: "success" }],
        [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]
      ] } }).catch(() => {});
    });
  });
});

const qrSessions = new Map();
const qrTemp = new Map();
const waitingForQrAmount = new Set();
const qrPromptMsg = new Map();

function clearQrSession(userId) {
  const s = qrSessions.get(userId);
  if (s?.interval) clearInterval(s.interval);
  qrSessions.delete(userId);
}

bot.action("sh_qr_menu", (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>Ketik <code>/qr 5000</code> atau pilih nominal.</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "💰 Rp 1.000", callback_data: "qr_quick_1000" }, { text: "💰 Rp 5.000", callback_data: "qr_quick_5000" }],
      [{ text: "💰 Rp 10.000", callback_data: "qr_quick_10000" }, { text: "💰 Rp 20.000", callback_data: "qr_quick_20000" }],
      [{ text: "✍️ Nominal Bebas", callback_data: "qr_custom_amount", style: "success" }],
      [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]
    ] }
  }).catch(() => {});
});

bot.command("qr", async (ctx) => {
  const baseAmount = parseInt(ctx.message.text.split(" ")[1]);
  if (!baseAmount) return ctx.reply("❌ Format: /qr 5000");
  qrTemp.set(String(ctx.from.id), { baseAmount });
  await ctx.reply(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>💰 Rp ${rupiah(baseAmount)}</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [[
      { text: "✅ Tanpa Fee", callback_data: "qr_nofee", style: "success" },
      { text: "🎲 Pakai Fee", callback_data: "qr_fee", style: "primary" }
    ], [{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] }
  });
});

bot.action(/^qr_quick_(\d+)$/, (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const baseAmount = parseInt(ctx.match[1]);
  qrTemp.set(String(ctx.from.id), { baseAmount });
  ctx.editMessageText(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>💰 Rp ${rupiah(baseAmount)}</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [[
      { text: "✅ Tanpa Fee", callback_data: "qr_nofee", style: "success" },
      { text: "🎲 Pakai Fee", callback_data: "qr_fee", style: "primary" }
    ], [{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] }
  }).catch(() => {});
});

bot.action("qr_custom_amount", (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  waitingForQrAmount.add(userId);
  qrPromptMsg.set(userId, ctx.callbackQuery.message.message_id);
  ctx.editMessageText("✍️ <b>NOMINAL BEBAS</b>\n\n<blockquote>Ketik nominal (contoh: <code>15000</code>)\n\n/cancel untuk batal.</blockquote>", {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] }
  }).catch(() => {});
});

bot.action(/^qr_(nofee|fee|cancel)$/, async (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  const temp = qrTemp.get(userId);
  if (ctx.match[1] === "cancel") {
    qrTemp.delete(userId);
    return ctx.editMessageText("❌ Dibatalkan.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});
  }
  if (!temp) return ctx.editMessageText("⚠️ Sesi habis.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]] } }).catch(() => {});

  let finalAmount = temp.baseAmount, uniqueCode = 0;
  if (ctx.match[1] === "fee") { uniqueCode = Math.floor(Math.random() * 30) + 1; finalAmount += uniqueCode; }
  qrTemp.delete(userId);
  clearQrSession(userId);

  await ctx.editMessageText("⏳ <i>Membuat...</i>", { parse_mode: "HTML" }).catch(() => {});
  try {
    const res = await axiosRetry({ method: 'post', url: `${API_URL}/create-qris`, data: { amount: finalAmount }, headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" } });
    if (!res.data.success) return ctx.editMessageText("❌ " + res.data.error).catch(() => {});
    const qrId = res.data.data.qris_url.split("/").pop();
    const imgRes = await axios.get(`${GATEWAY_URL}/qr/${qrId}`, { responseType: "arraybuffer" });
    const imgBuffer = Buffer.from(imgRes.data, "binary");
    const expAt = moment.tz(res.data.data.expires_at, "YYYY-MM-DD HH:mm:ss", 'Asia/Jakarta');

    await ctx.deleteMessage().catch(() => {});
    const sentMsg = await ctx.replyWithPhoto({ source: imgBuffer }, {
      caption: `🛒 <b>QRIS BARU</b>\n\n<blockquote>💰 Nominal: Rp ${rupiah(temp.baseAmount)}\n${uniqueCode > 0 ? `🎲 Fee: +${uniqueCode}\n` : ''}💵 Total: <b>Rp ${rupiah(finalAmount)}</b>\n⏰ Exp: ${expAt.format('DD-MM-YYYY HH:mm:ss')} WIB</blockquote>`,
      parse_mode: "HTML", reply_markup: { inline_keyboard: [
        [{ text: "🔄 Cek Status", callback_data: `qr_cek_${finalAmount}`, style: "primary" }],
        [{ text: "❌ Batal", callback_data: `qr_cancel_${finalAmount}`, style: "danger" }]
      ] }
    });
    reactToMessage(ctx.chat.id, sentMsg.message_id, '⚡').catch(() => {});

    const session = { msgId: sentMsg.message_id, amount: finalAmount, expiry: expAt.valueOf(), chatId: ctx.chat.id, isProcessing: false };
    session.interval = setInterval(async () => {
      if (session.isProcessing) return;
      session.isProcessing = true;
      if (Date.now() > session.expiry) {
        try {
          const check = await axios.post(`${API_URL}/check-payment`, { amount: session.amount, startTime: nowUnix() - 3600 }, { headers: { "X-API-Key": API_KEY } });
          if (check.data.success && check.data.paid) {
            clearQrSession(userId);
            reactToMessage(session.chatId, session.msgId, '✅').catch(() => {});
            bot.telegram.editMessageCaption(session.chatId, session.msgId, undefined, `✅ <b>LUNAS</b>\n\n<blockquote>Rp ${rupiah(session.amount)}</blockquote>`, {
              parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] }
            }).catch(() => {});
            bot.telegram.sendMessage(session.chatId, `✅ <b>PEMBAYARAN BERHASIL</b>\n\n<blockquote>💰 Rp ${rupiah(session.amount)}\n💳 ${check.data.transaction?.issuer || 'QRIS'}\n🕐 ${wibNow()} WIB</blockquote>`, { parse_mode: "HTML" }).catch(() => {});
            return;
          }
        } catch {}
        clearQrSession(userId);
        reactToMessage(session.chatId, session.msgId, '⌛').catch(() => {});
        bot.telegram.editMessageCaption(session.chatId, session.msgId, undefined, `⌛ <b>EXPIRED</b>\n\n<blockquote>Rp ${rupiah(session.amount)}\nQRIS sudah kadaluarsa.</blockquote>`, {
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] }
        }).catch(() => {});
        return;
      }
      try {
        const check = await axios.post(`${API_URL}/check-payment`, { amount: session.amount, startTime: nowUnix() - 3600 }, { headers: { "X-API-Key": API_KEY } });
        if (check.data.success && check.data.paid) {
          clearQrSession(userId);
          reactToMessage(session.chatId, session.msgId, '✅').catch(() => {});
          bot.telegram.editMessageCaption(session.chatId, session.msgId, undefined, `✅ <b>LUNAS</b>\n\n<blockquote>Rp ${rupiah(session.amount)}</blockquote>`, {
            parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] }
          }).catch(() => {});
          bot.telegram.sendMessage(session.chatId, `✅ <b>PEMBAYARAN BERHASIL</b>\n\n<blockquote>💰 Rp ${rupiah(session.amount)}\n💳 ${check.data.transaction?.issuer || 'QRIS'}\n🕐 ${wibNow()} WIB</blockquote>`, { parse_mode: "HTML" }).catch(() => {});
        }
      } catch {}
      session.isProcessing = false;
    }, POLL_INTERVAL_MS);
    qrSessions.set(userId, session);
  } catch (e) { ctx.editMessageText("❌ " + e.message).catch(() => {}); }
});

bot.action(/^qr_cek_(\d+)$/, async (ctx) => {
  const amount = parseInt(ctx.match[1]);
  await ctx.answerCbQuery("⏳ Cek...").catch(() => {});
  try {
    const res = await axios.post(`${API_URL}/check-payment`, { amount, startTime: nowUnix() - 3600 }, { headers: { "X-API-Key": API_KEY } });
    if (res.data.success && res.data.paid) {
      clearQrSession(String(ctx.from.id));
      ctx.reply(`✅ <b>BERHASIL</b>\n\n<blockquote>Rp ${rupiah(amount)}</blockquote>`, { parse_mode: "HTML" });
    } else ctx.reply(`⏳ Masih menunggu...`, { parse_mode: "HTML" });
  } catch { ctx.reply("❌ Gagal."); }
});

bot.action(/^qr_cancel_(\d+)$/, (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  clearQrSession(String(ctx.from.id));
  ctx.deleteMessage().catch(() => {});
  ctx.reply(`❌ Dibatalkan.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] } });
});

bot.action("sh_admin_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const admins = getAdmins();
  let out = `👑 <b>MENU ADMIN</b>\n\n<blockquote><code>/addadmin [ID/Reply]</code>\n<code>/deladmin [ID/Reply]</code>\n<code>/listadmin</code></blockquote>\n\n<b>Admins:</b>\n`;
  if (!admins.length) out += `- Belum ada admin tambahan.\n`;
  else admins.forEach(a => out += `- <code>${a}</code>\n`);
  ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_other_menu", style: "primary" }]] } }).catch(() => {});
});

bot.command("addadmin", (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("❌ Khusus Owner.");
  let tid = ctx.message.reply_to_message?.from?.id || ctx.message.text.split(" ")[1];
  if (!tid) return ctx.reply("Format: /addadmin [ID] atau reply.");
  tid = String(tid).replace(/[^0-9]/g, '');
  const a = getAdmins();
  if (a.includes(tid)) return ctx.reply("⚠️ Sudah admin.");
  a.push(tid); saveAdmins(a); auditLog('ADD_ADMIN', ctx.from.id, tid);
  ctx.reply(`✅ <code>${tid}</code> ditambah.`, { parse_mode: "HTML" });
});

bot.command("deladmin", (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply("❌ Khusus Owner.");
  let tid = ctx.message.reply_to_message?.from?.id || ctx.message.text.split(" ")[1];
  if (!tid) return ctx.reply("Format: /deladmin [ID] atau reply.");
  tid = String(tid).replace(/[^0-9]/g, '');
  let a = getAdmins();
  if (!a.includes(tid)) return ctx.reply("⚠️ Bukan admin.");
  a = a.filter(id => id !== tid); saveAdmins(a); auditLog('DEL_ADMIN', ctx.from.id, tid);
  ctx.reply(`✅ <code>${tid}</code> dihapus.`, { parse_mode: "HTML" });
});

bot.command("listadmin", (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("❌ Akses Ditolak.");
  const a = getAdmins();
  let out = `👑 <b>LIST ADMIN</b>\n\n<b>Owner:</b>\n- <code>${TELEGRAM_CHAT_ID}</code>\n\n<b>Admins:</b>\n`;
  if (!a.length) out += `- Belum ada.\n`;
  else a.forEach(id => out += `- <code>${id}</code>\n`);
  ctx.reply(out, { parse_mode: "HTML" });
});

const pendingTokenUpdate = new Map();
const waitingForTokenChat = new Set();
const tokenPromptMsg = new Map();

bot.action("sh_update_token_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  waitingForTokenChat.add(userId);
  tokenPromptMsg.set(userId, ctx.callbackQuery.message.message_id);
  ctx.editMessageText(`🔧 <b>UPDATE TOKEN</b>\n\n<blockquote>Kirim token baru (diawali <code>B:</code>)\n\n/cancel untuk batal.</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel_update_token", style: "danger" }]] }
  }).catch(() => {});
});

bot.command("cancel", (ctx) => {
  const userId = String(ctx.from.id);
  pending2FA.delete(userId);
  if (waitingForTokenChat.has(userId)) { waitingForTokenChat.delete(userId); return ctx.reply("❌ Batal."); }
  if (waitingForQrAmount.has(userId)) { waitingForQrAmount.delete(userId); return ctx.reply("❌ Batal."); }
  if (pendingTokenUpdate.has(userId)) { pendingTokenUpdate.delete(userId); return ctx.reply("❌ Batal."); }
  if (waitingForFileUpdate.has(userId)) { waitingForFileUpdate.delete(userId); return ctx.reply("❌ Batal."); }
  ctx.reply("Tidak ada aksi yang bisa dibatalkan.");
});

bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  if (pending2FA.has(userId)) {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();
    const p = pending2FA.get(userId);
    if (text === TWO_FACTOR_CODE) {
      pending2FA.delete(userId);
      verified2FA.set(userId, Date.now());
      await ctx.reply("✅ Verifikasi berhasil. Melanjutkan...");
      if (p.type === 'restart_all') await execRestart(ctx, 'shopee-2 wrapper-shopee', 'SEMUA');
      if (p.type === 'restart_gateway') await execRestart(ctx, 'shopee-2', 'GATEWAY');
      if (p.type === 'restart_bot') await execRestart(ctx, 'wrapper-shopee', 'BOT');
      if (p.type === 'apply_token') await applyNewToken(ctx, p.payload);
      if (p.type === 'clear_backup') await doClearBackup(ctx);
    } else {
      ctx.reply("❌ Kode salah. Coba lagi atau /cancel.");
    }
    return;
  }
  return next();
});

bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  if (waitingForTokenChat.has(userId)) {
    if (!isOwner(ctx.from.id)) return;
    const newToken = ctx.message.text.trim();
    if (!newToken || newToken.startsWith('/')) return;
    if (!newToken.startsWith('B:')) return ctx.reply("❌ Token harus diawali <code>B:</code>", { parse_mode: "HTML" });
    waitingForTokenChat.delete(userId);
    pendingTokenUpdate.set(userId, newToken);
    if (tokenPromptMsg.has(userId)) { ctx.telegram.deleteMessage(ctx.chat.id, tokenPromptMsg.get(userId)).catch(() => {}); tokenPromptMsg.delete(userId); }
    await ctx.reply(`⚠️ <b>Konfirmasi</b>\n\n<blockquote><code>${newToken}</code></blockquote>`, {
      parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Ya", callback_data: "confirm_update_token", style: "success" }, { text: "❌ Batal", callback_data: "cancel_update_token", style: "danger" }]] }
    });
    return;
  }
  if (waitingForQrAmount.has(userId)) {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    const amount = parseInt(text);
    if (isNaN(amount) || amount < 100) return ctx.reply("❌ Minimal Rp 100.");
    waitingForQrAmount.delete(userId);
    if (qrPromptMsg.has(userId)) { ctx.telegram.deleteMessage(ctx.chat.id, qrPromptMsg.get(userId)).catch(() => {}); qrPromptMsg.delete(userId); }
    qrTemp.set(userId, { baseAmount: amount });
    await ctx.reply(`🛠️ <b>BUAT QRIS</b>\n\n<blockquote>💰 Rp ${rupiah(amount)}</blockquote>`, {
      parse_mode: "HTML", reply_markup: { inline_keyboard: [[
        { text: "✅ Tanpa Fee", callback_data: "qr_nofee", style: "success" },
        { text: "🎲 Pakai Fee", callback_data: "qr_fee", style: "primary" }
      ], [{ text: "❌ Batal", callback_data: "qr_cancel", style: "danger" }]] }
    });
    return;
  }
  return next();
});

bot.action("confirm_update_token", async (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  const newToken = pendingTokenUpdate.get(userId);
  if (!newToken) return ctx.reply("Token expired.");
  pendingTokenUpdate.delete(userId);
  if (TWO_FACTOR_CODE) {
    await ctx.deleteMessage().catch(() => {});
    return request2FA(ctx, 'apply_token', newToken);
  }
  await applyNewToken(ctx, newToken);
});

async function applyNewToken(ctx, newToken) {
  await ctx.editMessageText("⏳ <i>Update token...</i>", { parse_mode: "HTML" }).catch(() => {});
  try {
    const res = await axios.post(`${API_URL}/update-token`, { token: newToken }, { headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" } });
    if (!res.data.success) return ctx.editMessageText(`❌ ${res.data.error}`).catch(() => {});
    updateEnvToken(newToken);
    auditLog('UPDATE_TOKEN', ctx.from.id, 'ok');
    await ctx.editMessageText(`⏳ <b>Token di-update.</b>\n\n<blockquote>Restart & validasi...</blockquote>`, { parse_mode: "HTML" }).catch(() => {});
    exec("pm2 restart shopee-2 wrapper-shopee", () => {
      let attempts = 0;
      const loop = setInterval(async () => {
        attempts++;
        lastTokenStatus = null;
        const status = await checkTokenStatus(false);
        if (status === "valid") {
          clearInterval(loop);
          ctx.reply(`✅ <b>SIAP!</b>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] } }).catch(() => {});
        } else if (attempts >= 5) {
          clearInterval(loop);
          ctx.reply(`⚠️ Token invalid setelah 50 detik.`, { reply_markup: { inline_keyboard: [[{ text: "🔑 Cek", callback_data: "sh_token" }]] } }).catch(() => {});
        }
      }, 10000);
    });
  } catch (e) { ctx.editMessageText(`❌ ${e.message}`).catch(() => {}); }
}

bot.action("cancel_update_token", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  waitingForTokenChat.delete(userId);
  pendingTokenUpdate.delete(userId);
  ctx.deleteMessage().catch(() => {});
  ctx.reply("❌ Dibatalkan.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] } }).catch(() => {});
});

bot.action("sh_logs", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText("📜 <b>PILIH LOGS</b>", {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "🤖 Wrapper", callback_data: "log_wrapper", style: "primary" }],
      [{ text: "🌐 Gateway", callback_data: "log_gateway", style: "success" }],
      [{ text: "⬅️ Kembali", callback_data: "sh_other_menu", style: "primary" }]
    ] }
  }).catch(() => {});
});

function sendLogMessage(ctx, service, title) {
  const logPath = path.join(process.env.HOME || '/root', '.pm2', 'logs', `${service}-out.log`);
  fs.readFile(logPath, 'utf8', (err, data) => {
    if (err) {
      const errPath = path.join(process.env.HOME || '/root', '.pm2', 'logs', `${service}-error.log`);
      return fs.readFile(errPath, 'utf8', (err2, data2) => {
        if (err2) return ctx.editMessageText(`❌ <b>GAGAL BACA LOG ${title}</b>\n\n<blockquote>File log tidak ditemukan.\n\nKemungkinan:\n• PM2 tidak terinstall/berjalan\n• Service <code>${service}</code> belum pernah jalan\n\nDetail error:\n<code>${err.message}</code></blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_logs", style: "primary" }]] } }).catch(() => {});
        const clean = data2.replace(/\x1B\[[0-9;]*[mGK]/g, '') || "Tidak ada log error.";
        ctx.editMessageText(`<b>📜 LOGS ERROR ${title}</b>\n\n<blockquote expandable><code>${clean.slice(-3500)}</code></blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: `🗑️ Clear`, callback_data: `clear_${service}`, style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "sh_logs", style: "primary" }]] } }).catch(() => {});
      });
    }
    const clean = data.replace(/\x1B\[[0-9;]*[mGK]/g, '') || "Tidak ada log.";
    ctx.editMessageText(`<b>📜 LOGS ${title}</b>\n\n<blockquote expandable><code>${clean.slice(-3500)}</code></blockquote>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: `🗑️ Clear`, callback_data: `clear_${service}`, style: "danger" }], [{ text: "⬅️ Kembali", callback_data: "sh_logs", style: "primary" }]] } }).catch(() => {});
  });
}

bot.action("log_wrapper", (ctx) => { if (!checkAccess(ctx, true)) return; ctx.answerCbQuery("⏳...").catch(() => {}); sendLogMessage(ctx, "wrapper-shopee", "WRAPPER"); });
bot.action("log_gateway", (ctx) => { if (!checkAccess(ctx, true)) return; ctx.answerCbQuery("⏳...").catch(() => {}); sendLogMessage(ctx, "shopee-2", "GATEWAY"); });
bot.action(/^clear_(.+)$/, (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery("⏳...").catch(() => {});
  exec(`pm2 flush ${ctx.match[1]}`, (err) => {
    if (err) return ctx.editMessageText("❌ " + err.message).catch(() => {});
    ctx.editMessageText(`✅ Logs ${ctx.match[1].toUpperCase()} clear.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_logs", style: "primary" }]] } }).catch(() => {});
  });
});

bot.action("sh_restart_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText(`🔄 <b>RESTART SERVICE</b>\n\n<blockquote>Pilih mana yang mau kamu restart.\n\n⚠️ <i>Fitur ini hanya bekerja di PM2.</i></blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "🔌 Restart Gateway", callback_data: "do_restart_gateway", style: "success" }],
      [{ text: "🤖 Restart Bot", callback_data: "do_restart_bot", style: "primary" }],
      [{ text: "♻️ Restart Semua", callback_data: "do_restart_all", style: "danger" }],
      [{ text: "⬅️ Kembali", callback_data: "mainmenu", style: "primary" }]
    ] }
  }).catch(() => {});
});

async function execRestart(ctx, service, label) {
  await ctx.reply(`⏳ <i>Restart ${label}...</i>`, { parse_mode: "HTML" }).catch(() => {});
  exec(`pm2 restart ${service}`, (err) => {
    setTimeout(() => {
      if (err) return ctx.reply(`❌ Gagal restart: ${err.message}`).catch(() => {});
      auditLog('RESTART', ctx.from.id, label);
      ctx.reply(`✅ <b>${label} BERHASIL DI-RESTART!</b>`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] } }).catch(() => {});
    }, 500);
  });
}

bot.action("do_restart_gateway", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  if (TWO_FACTOR_CODE) return request2FA(ctx, 'restart_gateway');
  execRestart(ctx, 'shopee-2', 'GATEWAY');
});

bot.action("do_restart_bot", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  if (TWO_FACTOR_CODE) return request2FA(ctx, 'restart_bot');
  execRestart(ctx, 'wrapper-shopee', 'BOT');
});

bot.action("do_restart_all", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  if (TWO_FACTOR_CODE) return request2FA(ctx, 'restart_all');
  execRestart(ctx, 'shopee-2 wrapper-shopee', 'SEMUA');
});

function doBackup(ctx) {
  ctx.reply("⏳ <i>Backup...</i>", { parse_mode: "HTML" }).then(loadingMsg => {
    setTimeout(async () => {
      try {
        const { zipPath, zipName, size } = await createBackupZip();
        ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
        cleanOldBackups();
        let sendPath = zipPath, sendName = zipName, note = '';
        if (BACKUP_PASSWORD) {
          const buf = fs.readFileSync(zipPath);
          const enc = encryptBuffer(buf, BACKUP_PASSWORD);
          sendPath = zipPath + '.enc';
          sendName = zipName + '.enc';
          fs.writeFileSync(sendPath, enc);
          fs.unlinkSync(zipPath);
          note = `\n🔐 <b>Terenkripsi</b> (password di .env)`;
        }
        await ctx.replyWithDocument({ source: fs.createReadStream(sendPath), filename: sendName }, {
          caption: `📦 <b>BACKUP</b>\n\n<blockquote>📁 <code>${sendName}</code>\n📦 ${(size / 1024 / 1024).toFixed(2)} MB${note}\n🕐 ${wibNow()} WIB</blockquote>`,
          parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] }
        });
        try { fs.unlinkSync(sendPath); } catch {}
      } catch (e) {
        ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
        ctx.reply("❌ " + e.message);
      }
    }, 2000);
  }).catch(() => {});
}
bot.command("backup", (ctx) => { if (!checkAccess(ctx)) return; doBackup(ctx); });
bot.action("sh_backup", (ctx) => { if (!checkAccess(ctx)) return; ctx.answerCbQuery().catch(() => {}); doBackup(ctx); });

bot.action("sh_manage_backup", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const rootFiles = fs.readdirSync(__dirname).filter(f => f.includes('_backup_'));
  const backupDirFiles = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).map(f => path.join('backup', f)) : [];
  const allFiles = [...rootFiles.map(f => path.join(__dirname, f)), ...backupDirFiles.map(f => path.join(__dirname, f))];
  if (!allFiles.length) {
    return ctx.editMessageText("📂 <b>BACKUP</b>\n\n<blockquote>Belum ada file backup.</blockquote>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_other_menu", style: "primary" }]] } }).catch(() => {});
  }
  let totalSize = 0, listText = "";
  allFiles.forEach((f, i) => {
    try { const s = fs.statSync(f); totalSize += s.size; if (i < 10) listText += `  ${i + 1}. <code>${path.relative(__dirname, f)}</code> (${(s.size / 1024 / 1024).toFixed(2)} MB)\n`; } catch {}
  });
  if (allFiles.length > 10) listText += `  <i>... ${allFiles.length - 10} lainnya</i>\n`;
  ctx.editMessageText(`📂 <b>BACKUP</b>\n\n<blockquote>Total: <b>${allFiles.length}</b> (${(totalSize / 1024 / 1024).toFixed(2)} MB)\n\n${listText}</blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [
      [{ text: "🗑️ Hapus Semua", callback_data: "sh_clear_backup_yes", style: "danger" }],
      [{ text: "⬅️ Kembali", callback_data: "sh_other_menu", style: "primary" }]
    ] }
  }).catch(() => {});
});

bot.action("sh_clear_backup_yes", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  if (TWO_FACTOR_CODE) {
    ctx.deleteMessage().catch(() => {});
    return request2FA(ctx, 'clear_backup');
  }
  doClearBackup(ctx);
});

async function doClearBackup(ctx) {
  let count = 0;
  try {
    fs.readdirSync(__dirname).filter(f => f.includes('_backup_')).forEach(f => { try { fs.unlinkSync(path.join(__dirname, f)); count++; } catch {} });
    if (fs.existsSync(BACKUP_DIR)) fs.readdirSync(BACKUP_DIR).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); count++; } catch {} });
    auditLog('CLEAR_BACKUP', ctx.from.id, `deleted=${count}`);
    ctx.reply(`✅ ${count} file backup dihapus.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_other_menu" }]] } }).catch(() => {});
  } catch (e) { ctx.reply("❌ " + e.message).catch(() => {}); }
}

const waitingForFileUpdate = new Set();
const fileToServiceMap = { 'wrapper.js': 'wrapper-shopee', 'server.js': 'shopee-2' };
const fileUpdatePromptMsg = new Map();
const pendingUploadFile = new Map();
const pendingRenameFile = new Map();
const pendingOverwrite = new Map();

bot.action("sh_update_file_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  waitingForFileUpdate.add(String(ctx.from.id));
  fileUpdatePromptMsg.set(String(ctx.from.id), ctx.callbackQuery.message.message_id);
  ctx.editMessageText(`📤 <b>UPDATE FILE PROJECT</b>\n\n<blockquote>Kirim file <code>.js</code>, <code>.json</code>, <code>.html</code>, atau <code>.css</code>.\n\nFile akan disimpan ke folder pilihan.\n\n<i>Ketik /cancel untuk batal.</i></blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "cancel_update_file", style: "danger" }]] }
  }).catch(() => {});
});

bot.action("cancel_update_file", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  waitingForFileUpdate.delete(String(ctx.from.id));
  ctx.deleteMessage().catch(() => {});
  ctx.reply("❌ <b>UPDATE FILE DIBATALKAN</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] } }).catch(() => {});
});

bot.on('document', async (ctx) => {
  const userId = String(ctx.from.id);
  if (waitingForFileUpdate.has(userId)) {
    const doc = ctx.message.document;
    pendingUploadFile.set(userId, { file_id: doc.file_id, file_name: doc.file_name });
    waitingForFileUpdate.delete(userId);
    if (fileUpdatePromptMsg.has(userId)) {
      ctx.telegram.deleteMessage(ctx.chat.id, fileUpdatePromptMsg.get(userId)).catch(() => {});
      fileUpdatePromptMsg.delete(userId);
    }
    ctx.reply(`📁 <b>PILIH FOLDER TUJUAN</b>\n\n<blockquote>File: <code>${doc.file_name}</code></blockquote>`, {
      parse_mode: "HTML", reply_markup: { inline_keyboard: [
        [{ text: "🏠 Root", callback_data: "up_to_root", style: "primary" }],
        [{ text: "🌐 Public", callback_data: "up_to_public", style: "success" }, { text: "⚙️ Src", callback_data: "up_to_src", style: "primary" }],
        [{ text: "✍️ Custom", callback_data: "up_custom", style: "danger" }],
        [{ text: "❌ Batal", callback_data: "cancel_update_file", style: "danger" }]
      ] }
    });
  }
});

bot.action(/^up_to_(root|public|src)$/, async (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  const folder = ctx.match[1];
  const pending = pendingUploadFile.get(userId);
  if (!pending) return ctx.editMessageText("❌ Sesi habis.").catch(() => {});
  let targetDir = __dirname;
  if (folder === 'public') targetDir = path.join(__dirname, 'public');
  if (folder === 'src') targetDir = path.join(__dirname, 'src');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  await saveFileToDir(ctx, pending.file_id, pending.file_name, targetDir);
  pendingUploadFile.delete(userId);
});

bot.action("up_custom", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  const pending = pendingUploadFile.get(userId);
  if (!pending) return ctx.editMessageText("❌ Sesi habis.").catch(() => {});
  pendingRenameFile.set(userId, pending);
  pendingUploadFile.delete(userId);
  ctx.editMessageText(`✍️ <b>CUSTOM / RENAME</b>\n\n<blockquote>Ketik path tujuan.\nContoh: <code>public/index.html</code>\n\n/cancel untuk batal.</blockquote>`, { parse_mode: "HTML" }).catch(() => {});
});

bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  if (pendingRenameFile.has(userId)) {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();
    const pending = pendingRenameFile.get(userId);
    let targetDir = __dirname, targetFileName = text;
    if (text.includes('/') || text.includes('\\')) {
      const normalized = text.replace(/\\/g, '/');
      const parts = normalized.split('/');
      targetFileName = parts.pop();
      targetDir = path.join(__dirname, parts.join('/'));
    }
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    pendingRenameFile.delete(userId);
    await saveFileToDir(ctx, pending.file_id, targetFileName, targetDir);
    return;
  }
  return next();
});

async function saveFileToDir(ctx, fileId, fileName, targetDir) {
  const userId = String(ctx.from.id);
  const targetPath = path.join(targetDir, fileName);
  if (fs.existsSync(targetPath)) {
    pendingOverwrite.set(userId, { fileId, fileName, targetDir, targetPath });
    return ctx.reply(`⚠️ <b>FILE SUDAH ADA!</b>\n\n<blockquote>Timpa <code>${fileName}</code>?</blockquote>`, {
      parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "✅ Timpa", callback_data: "overwrite_yes", style: "danger" }], [{ text: "❌ Batal", callback_data: "overwrite_no", style: "primary" }]] }
    });
  }
  await doSaveFile(ctx, fileId, fileName, targetDir, targetPath);
}

bot.action("overwrite_yes", async (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  const pending = pendingOverwrite.get(userId);
  if (!pending) return ctx.editMessageText("❌ Sesi habis.").catch(() => {});
  pendingOverwrite.delete(userId);
  ctx.deleteMessage().catch(() => {});
  await doSaveFile(ctx, pending.fileId, pending.fileName, pending.targetDir, pending.targetPath);
});

bot.action("overwrite_no", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  pendingOverwrite.delete(String(ctx.from.id));
  ctx.deleteMessage().catch(() => {});
  ctx.reply("❌ Dibatalkan.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] } }).catch(() => {});
});

async function doSaveFile(ctx, fileId, fileName, targetDir, targetPath) {
  const loadingMsg = await ctx.reply(`⏳ <i>Menyimpan...</i>`, { parse_mode: "HTML" });
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const response = await axios({ url: fileLink.href, method: 'GET', responseType: 'stream' });
    if (fs.existsSync(targetPath)) fs.copyFileSync(targetPath, path.join(__dirname, `${path.basename(targetPath)}_backup_${Date.now()}`));
    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    let isRestart = false, targetService = '-';
    if (fileName.endsWith('.js')) { targetService = fileToServiceMap[fileName] || 'wrapper-shopee'; isRestart = true; }
    auditLog('UPDATE_FILE', ctx.from.id, `${fileName} -> ${targetDir}`);
    let msg = `✅ <b>FILE TERSIMPAN</b>\n\n<blockquote>📁 <code>${targetDir.replace(__dirname, '') || '/'}</code>\n`;
    msg += isRestart ? `🔄 Restart <code>${targetService}</code>...</blockquote>` : `File statis diganti.</blockquote>`;
    await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, null, msg, { parse_mode: "HTML" }).catch(() => {});
    if (isRestart) {
      await ctx.reply(`🚀 Service <code>${targetService}</code> restart.`, { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "mainmenu" }]] } }).catch(() => {});
      const { spawn } = require('child_process');
      spawn('pm2', ['restart', targetService], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (error) { ctx.reply(`❌ ${error.message}`); }
}

bot.action("sh_schedule_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const list = readJson(DB_SCHEDULE_PATH, []);
  let out = `📅 <b>JADWAL PESAN OTOMATIS</b>\n\n`;
  out += `<blockquote>Command:\n<code>/schedule DD-MM-YYYY HH:mm pesan</code>\nContoh: <code>/schedule 25-12-2026 18:30 Selamat Natal!</code>\n\n<code>/delschedule [nomor]</code></blockquote>\n\n`;

  if (!list.length) {
    out += `<i>Belum ada jadwal aktif.</i>`;
  } else {
    out += `<b>📋 Jadwal Aktif (${list.length})</b>\n\n`;
    list.forEach((s, i) => {
      const m = moment(s.time).tz('Asia/Jakarta');
      out += `<b>${i + 1}.</b> 📆 ${m.format('DD')} ${namaBulan(m)} ${m.format('YYYY')}, ${m.format('HH:mm')} WIB\n`;
      out += `   💬 <i>${s.text.slice(0, 60)}${s.text.length > 60 ? '...' : ''}</i>\n\n`;
    });
  }

  const btns = list.map((s, i) => ({ text: `🗑️ Hapus #${i + 1}`, callback_data: `delsch_${s.id}` }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  rows.push([{ text: "⬅️ Kembali", callback_data: "sh_other_menu", style: "primary" }]);

  ctx.editMessageText(out, { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } }).catch(() => {});
});

bot.command("schedule", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 4) return ctx.reply("❌ Format: /schedule DD-MM-YYYY HH:mm pesan\nContoh: /schedule 25-12-2026 18:30 Selamat Natal!");
  const dateStr = parts[1], timeStr = parts[2];
  const text = parts.slice(3).join(' ');
  const m = moment.tz(`${dateStr} ${timeStr}`, "DD-MM-YYYY HH:mm", 'Asia/Jakarta');
  if (!m.isValid()) return ctx.reply("❌ Format tanggal/jam salah.");
  if (m.isBefore(moment())) return ctx.reply("❌ Waktu sudah lewat.");
  const list = readJson(DB_SCHEDULE_PATH, []);
  const id = 'SCH' + Date.now();
  list.push({ id, chat_id: ctx.chat.id, time: m.toISOString(), text });
  writeJson(DB_SCHEDULE_PATH, list);
  auditLog('SCHEDULE_ADD', ctx.from.id, `${id} ${m.format('DD-MM-YYYY HH:mm')}`);
  ctx.reply(`✅ Jadwal ditambahkan:\n📆 ${m.format('DD')} ${namaBulan(m)} ${m.format('YYYY')}, ${m.format('HH:mm')} WIB\n💬 ${text}`, { parse_mode: "HTML" });
});

bot.action(/^delsch_(.+)$/, (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const id = ctx.match[1];
  const list = readJson(DB_SCHEDULE_PATH, []);
  const filtered = list.filter(s => s.id !== id);
  writeJson(DB_SCHEDULE_PATH, filtered);
  auditLog('SCHEDULE_DEL', ctx.from.id, id);
  ctx.editMessageText(filtered.length < list.length ? "✅ Jadwal dihapus." : "❌ ID tidak ditemukan.", {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_schedule_menu" }]] }
  }).catch(() => {});
});

bot.command("delschedule", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  const idx = parseInt(ctx.message.text.split(' ')[1]);
  if (!idx || idx < 1) return ctx.reply("Format: /delschedule [nomor]");
  const list = readJson(DB_SCHEDULE_PATH, []);
  if (idx > list.length) return ctx.reply("❌ Nomor tidak ada.");
  const removed = list.splice(idx - 1, 1)[0];
  writeJson(DB_SCHEDULE_PATH, list);
  ctx.reply(`✅ Jadwal #${idx} dihapus.`);
});

bot.action("sh_broadcast_menu", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  const count = Object.keys(getUsers()).length;
  ctx.editMessageText(`📢 <b>BROADCAST</b>\n\n<blockquote>Kirim pesan ke <b>${count}</b> user yang pernah pakai bot dan tercatat di database system.\n\nCommand:\n<code>/broadcast [pesan]</code>\n\n<i>Hati-hati spam!</i></blockquote>`, {
    parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_other_menu" }]] }
  }).catch(() => {});
});

bot.command("broadcast", async (ctx) => {
  if (!checkAccess(ctx, true)) return;
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return ctx.reply("Format: /broadcast pesan");
  const users = getUsers();
  const ids = Object.keys(users);
  if (!ids.length) return ctx.reply("Belum ada user terdaftar.");
  await ctx.reply(`📢 Mengirim broadcast ke ${ids.length} user...`);
  const broadcastMsg = `📢 <b>[PESAN BROADCAST]</b>\n\n${text}`;
  let ok = 0, fail = 0;
  for (const id of ids) {
    try { await bot.telegram.sendMessage(id, broadcastMsg, { parse_mode: 'HTML' }); ok++; }
    catch { fail++; }
    await new Promise(r => setTimeout(r, 50));
  }
  auditLog('BROADCAST', ctx.from.id, `ok=${ok} fail=${fail}`);
  ctx.reply(`✅ <b>Broadcast selesai.</b>\n\n<blockquote>✅ Berhasil: ${ok}\n❌ Gagal: ${fail}\n\n📢 Pesan telah dikirim dengan label broadcast.</blockquote>`, { parse_mode: "HTML" });
});

bot.action("sh_audit_log", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  try {
    const content = fs.existsSync(AUDIT_LOG_PATH) ? fs.readFileSync(AUDIT_LOG_PATH, 'utf8') : 'Belum ada audit log.';
    const tail = content.split('\n').slice(-50).join('\n');
    ctx.editMessageText(`📋 <b>AUDIT LOG (50 terakhir)</b>\n\n<blockquote expandable><code>${tail.slice(-3500)}</code></blockquote>`, {
      parse_mode: "HTML", reply_markup: { inline_keyboard: [
        [{ text: "🗑️ Clear", callback_data: "sh_audit_clear", style: "danger" }],
        [{ text: "⬅️ Kembali", callback_data: "sh_other_menu" }]
      ] }
    }).catch(() => {});
  } catch (e) { ctx.editMessageText("❌ " + e.message).catch(() => {}); }
});

bot.action("sh_audit_clear", (ctx) => {
  if (!checkAccess(ctx, true)) return;
  ctx.answerCbQuery().catch(() => {});
  try { fs.writeFileSync(AUDIT_LOG_PATH, ''); } catch {}
  ctx.editMessageText("✅ Audit log cleared.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "sh_other_menu" }]] } }).catch(() => {});
});

bot.command("decrypt", async (ctx) => {
  if (!checkAccess(ctx, true)) return;
  const fname = ctx.message.text.split(' ')[1];
  if (!fname) return ctx.reply("Format: /decrypt [nama_file]");
  const encPath = path.join(BACKUP_DIR, fname);
  if (!fs.existsSync(encPath)) return ctx.reply("File tidak ditemukan.");
  try {
    const buf = fs.readFileSync(encPath);
    const dec = decryptBuffer(buf, BACKUP_PASSWORD);
    const tmpPath = path.join(BACKUP_DIR, `decrypted-${Date.now()}.zip`);
    fs.writeFileSync(tmpPath, dec);
    await ctx.replyWithDocument({ source: fs.createReadStream(tmpPath), filename: fname.replace('.enc', '') });
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 30000);
  } catch (e) { ctx.reply("❌ Gagal decrypt: " + e.message); }
});

bot.catch((err) => console.error("Bot error:", err.message));
bot.launch().then(() => {
  console.log(chalk.bold.green(`\n✅ ${NOTIF_PREFIX} ONLINE — ${wibNowLog()} WIB\n`));
}).catch((e) => console.error("❌", e.message));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled:', reason);
  sendNotif(`⚠️ <b>ERROR</b>\n\n<blockquote>${reason?.message || reason}</blockquote>`);
});
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));