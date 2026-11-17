require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const {
  sb, db, selectAll, AppError, ALLOWED_EXT, MAX_SIZE, sanitizeName, todayStr, contentTypeOf,
  ensureBucket, saveCertificate, deleteCertificate, removeFiles, downloadFile
} = require('./core');
const { createBot } = require('./bot');

const PORT = process.env.PORT || 3000;

const ADMIN = {
  full_name: process.env.ADMIN_NAME || 'Xushnudbek Kozimov (Admin)',
  grade: 'Admin',
  email: (process.env.ADMIN_EMAIL || 'kozimovxushnudbek1@gmail.com').toLowerCase(),
  password: process.env.ADMIN_PASSWORD || 'kozimov1224.',
  role: 'admin'
};
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('OGOHLANTIRISH: SESSION_SECRET o‘rnatilmagan. Vaqtinchalik kalit ishlatilmoqda (qayta ishga tushsa hamma chiqib ketadi).');
}

/* ---------- Telegram webhook (JSON parserdan oldin) ---------- */
const BOT_TOKEN = process.env.BOT_TOKEN;
const HOOK_SECRET = BOT_TOKEN ? crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32) : '';
const HOOK_PATH = `/telegram/${HOOK_SECRET}`;
let botHandler = null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render proxy orqasida haqiqiy IP kerak
if (BOT_TOKEN) {
  app.post(HOOK_PATH, (req, res, next) => {
    if (req.get('x-telegram-bot-api-secret-token') !== HOOK_SECRET) return res.sendStatus(403);
    if (!botHandler) return res.sendStatus(503);
    botHandler(req, res, next);
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieSession({
    name: 'sid',
    keys: [SESSION_SECRET],
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true'
  })
);

const assetDirs = [
  path.join(__dirname, 'public', 'assets'),
  path.join(__dirname, 'public', 'asstes'),
  path.join(__dirname, 'assets'),
  path.join(__dirname, 'asstes')
];
['/assets', '/asstes'].forEach((route) => assetDirs.forEach((dir) => app.use(route, express.static(dir))));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Yordamchilar ---------- */
function sendErr(res, e) {
  if (e instanceof AppError) return res.status(e.status).json({ error: e.message });
  console.error(e);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
}
const h = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) { sendErr(res, e); }
};
const numId = (req) => {
  if (!/^\d+$/.test(req.params.id)) throw new AppError(404, 'Topilmadi.');
  return Number(req.params.id);
};
const validPassword = (p) => typeof p === 'string' && p.length >= 6;
const fixOriginalName = (name) => { try { return Buffer.from(name, 'latin1').toString('utf8'); } catch (e) { return name; } };

function rateLimit({ windowMs, max, message, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    hits.forEach((v, k) => v.reset < now && hits.delete(k));
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const k = key ? key(req) : req.ip;
    const e = hits.get(k);
    if (!e || e.reset < now) { hits.set(k, { count: 1, reset: now + windowMs }); return next(); }
    if (++e.count > max) return res.status(429).json({ error: message });
    next();
  };
}
// Maktabda hamma bir Wi-Fi (bir IP) dan kirishi mumkin, shuning uchun limitlar keng.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Bu email uchun urinishlar juda ko‘p. 15 daqiqadan keyin qayta urining.',
  key: (req) => `${req.ip}|${String((req.body && req.body.email) || '').trim().toLowerCase()}`
});
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 300, message: 'Ro‘yxatdan o‘tish urinishlari juda ko‘p. Keyinroq urinib ko‘ring.' });

const requireAuth = (req, res, next) =>
  req.session && req.session.user ? next() : res.status(401).json({ error: 'Avval tizimga kiring.' });
const requireAdmin = (req, res, next) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Avval tizimga kiring.' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Bu amal faqat admin uchun.' });
  next();
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(fixOriginalName(file.originalname)).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new Error('Faqat PDF, JPG, JPEG yoki PNG fayllarni yuklash mumkin.'));
    cb(null, true);
  }
});
const receiveFile = (req, res) =>
  new Promise((resolve, reject) => upload.single('file')(req, res, (e) => (e ? reject(e) : resolve())));

const sessionUser = (u) => ({ id: u.id, full_name: u.full_name, grade: u.grade, email: u.email, role: u.role });

/* ---------- Autentifikatsiya ---------- */
app.post('/api/register', registerLimiter, h(async (req, res) => {
  const full_name = String(req.body.full_name || '').trim();
  const grade = String(req.body.grade || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!full_name || !grade || !email || !password) throw new AppError(400, 'Barcha maydonlarni to‘ldiring.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Email manzili noto‘g‘ri.');
  if (!validPassword(password)) throw new AppError(400, 'Parol kamida 6 ta belgidan iborat bo‘lishi kerak.');
  if (db(await sb.from('users').select('id').eq('email', email).maybeSingle())) {
    throw new AppError(409, 'Bu email bilan allaqachon ro‘yxatdan o‘tilgan.');
  }
  const user = db(
    await sb.from('users').insert({ full_name, grade, email, password: await bcrypt.hash(password, 10), role: 'student' })
      .select('id,full_name,grade,email,role').single()
  );
  req.session.user = sessionUser(user);
  res.json({ user: req.session.user });
}));

app.post('/api/login', loginLimiter, h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw new AppError(400, 'Email va parolni kiriting.');
  const user = db(await sb.from('users').select('*').eq('email', email).maybeSingle());
  if (!user || !user.password || !(await bcrypt.compare(password, user.password))) {
    throw new AppError(401, 'Email yoki parol noto‘g‘ri.');
  }
  req.session.user = sessionUser(user);
  res.json({ user: req.session.user });
}));

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ user: (req.session && req.session.user) || null }));

app.post('/api/change-password', requireAuth, h(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!validPassword(new_password)) throw new AppError(400, 'Yangi parol kamida 6 ta belgidan iborat bo‘lishi kerak.');
  const user = db(await sb.from('users').select('id,password').eq('id', req.session.user.id).maybeSingle());
  if (!user || !user.password || !(await bcrypt.compare(String(current_password || ''), user.password))) {
    throw new AppError(400, 'Joriy parol noto‘g‘ri.');
  }
  db(await sb.from('users').update({ password: await bcrypt.hash(new_password, 10) }).eq('id', user.id));
  res.json({ ok: true });
}));

/* ---------- Sertifikatlar ---------- */
app.post('/api/certificates', requireAuth, h(async (req, res) => {
  try { await receiveFile(req, res); }
  catch (e) { throw new AppError(400, e.code === 'LIMIT_FILE_SIZE' ? 'Fayl hajmi 15 MB dan oshmasligi kerak.' : e.message || 'Fayl yuklashda xatolik.'); }
  const title = String(req.body.title || '').trim();
  if (!req.file) throw new AppError(400, 'Sertifikat faylini tanlang.');
  if (!title) throw new AppError(400, 'Sertifikat nomini kiriting.');
  await saveCertificate({
    user_id: req.session.user.id,
    title,
    score: String(req.body.score || '').trim(),
    issued_date: String(req.body.issued_date || '').trim() || todayStr(),
    originalName: fixOriginalName(req.file.originalname),
    buffer: req.file.buffer,
    source: 'web'
  });
  res.json({ ok: true });
}));

app.get('/api/my-certificates', requireAuth, h(async (req, res) => {
  const rows = db(
    await sb.from('certificates').select('id,title,score,issued_date,original_name').eq('user_id', req.session.user.id)
      .order('id', { ascending: false })
  );
  res.json({ certificates: rows });
}));

async function ownCert(req) {
  const cert = db(await sb.from('certificates').select('*').eq('id', numId(req)).maybeSingle());
  if (!cert) throw new AppError(404, 'Sertifikat topilmadi.');
  if (req.session.user.role !== 'admin' && cert.user_id !== req.session.user.id) {
    throw new AppError(403, 'Bu sertifikatga ruxsatingiz yo‘q.');
  }
  return cert;
}

app.put('/api/certificates/:id', requireAuth, h(async (req, res) => {
  const cert = await ownCert(req);
  const title = String(req.body.title || '').trim();
  if (!title) throw new AppError(400, 'Sertifikat nomini kiriting.');
  db(await sb.from('certificates').update({
    title,
    score: String(req.body.score || '').trim(),
    issued_date: String(req.body.issued_date || '').trim() || cert.issued_date
  }).eq('id', cert.id));
  res.json({ ok: true });
}));

app.delete('/api/certificates/:id', requireAuth, h(async (req, res) => {
  await deleteCertificate(await ownCert(req));
  res.json({ ok: true });
}));

// Fayllar: faqat egasi yoki admin ko'ra oladi
app.get('/files/:id', requireAuth, h(async (req, res) => {
  const cert = await ownCert(req);
  const buf = await downloadFile(cert.storage_path);
  if (!buf) throw new AppError(404, 'Fayl topilmadi.');
  const ext = path.extname(cert.storage_path).toLowerCase();
  res.setHeader('Content-Type', contentTypeOf(ext));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(cert.original_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(buf);
}));

/* ---------- Admin ---------- */
app.get('/api/admin/overview', requireAdmin, h(async (req, res) => {
  const users = await selectAll('users', 'id,full_name,grade,email', (q) => q.eq('role', 'student'));
  const certs = await selectAll('certificates', 'id,user_id,title,score,issued_date,original_name,created_at');
  const umap = new Map(users.map((u) => [u.id, u]));
  const counts = new Map();
  const certificates = [];
  certs.forEach((c) => {
    const u = umap.get(c.user_id);
    if (!u) return;
    counts.set(u.id, (counts.get(u.id) || 0) + 1);
    certificates.push({ ...c, full_name: u.full_name, grade: u.grade });
  });
  certificates.sort((a, b) => a.full_name.localeCompare(b.full_name) || b.id - a.id);
  const students = users
    .map((u) => ({ ...u, cert_count: counts.get(u.id) || 0 }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  res.json({ total_students: students.length, students, certificates });
}));

async function studentById(req) {
  const u = db(await sb.from('users').select('*').eq('id', numId(req)).eq('role', 'student').maybeSingle());
  if (!u) throw new AppError(404, 'O‘quvchi topilmadi.');
  return u;
}

app.delete('/api/admin/students/:id', requireAdmin, h(async (req, res) => {
  const u = await studentById(req);
  const certs = db(await sb.from('certificates').select('storage_path').eq('user_id', u.id));
  db(await sb.from('users').delete().eq('id', u.id)); // sertifikat qatorlari ham o'chadi (cascade)
  await removeFiles(certs.map((c) => c.storage_path));
  res.json({ ok: true });
}));

app.post('/api/admin/students/:id/reset-password', requireAdmin, h(async (req, res) => {
  const u = await studentById(req);
  const temp = crypto.randomBytes(5).toString('hex');
  db(await sb.from('users').update({ password: await bcrypt.hash(temp, 10) }).eq('id', u.id));
  res.json({ password: temp });
}));

app.get('/api/admin/download-zip', requireAdmin, h(async (req, res) => {
  const users = await selectAll('users', 'id,full_name,grade');
  const rows = await selectAll('certificates', 'id,user_id,title,score,storage_path');
  if (!rows.length) throw new AppError(404, 'Yuklab olish uchun sertifikatlar yo‘q.');
  const umap = new Map(users.map((u) => [u.id, u]));
  rows.forEach((r) => {
    const u = umap.get(r.user_id) || { full_name: 'Nomalum', grade: '' };
    r.full_name = u.full_name;
    r.grade = u.grade;
  });
  rows.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.user_id - b.user_id || a.id - b.id);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Oquvchilar_Sertifikatlari_${todayStr()}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (w) => console.warn('ZIP ogohlantirish:', w.message));
  archive.on('error', (e) => { console.error('ZIP xatolik:', e); res.destroy(e); });
  res.on('close', () => { if (!res.writableFinished) archive.abort(); });
  archive.pipe(res);

  const folderByUser = new Map();
  const usedFolders = new Set();
  const usedPaths = new Set();
  const missing = [];

  for (const row of rows) {
    let folder = folderByUser.get(row.user_id);
    if (!folder) {
      const base = sanitizeName(`${row.full_name} (${row.grade})`);
      folder = base;
      let n = 2;
      while (usedFolders.has(folder.toLowerCase())) folder = `${base} ${n++}`;
      usedFolders.add(folder.toLowerCase());
      folderByUser.set(row.user_id, folder);
    }
    const buf = await downloadFile(row.storage_path);
    if (!buf) { missing.push(`${folder} / ${row.title}`); continue; }

    const ext = path.extname(row.storage_path).toLowerCase();
    const base = sanitizeName(row.score ? `${row.title} - ${row.score}` : row.title, 'Sertifikat');
    let fileName = `${base}${ext}`;
    let counter = 1;
    while (usedPaths.has(`${folder}/${fileName}`.toLowerCase())) fileName = `${base}_${counter++}${ext}`;
    usedPaths.add(`${folder}/${fileName}`.toLowerCase());
    archive.append(buf, { name: `${folder}/${fileName}` });
  }
  if (missing.length) {
    archive.append('Quyidagi sertifikat fayllarini yuklab bo‘lmadi:\r\n\r\n' + missing.join('\r\n'), { name: 'TOPILMAGAN_FAYLLAR.txt' });
  }
  await archive.finalize();
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Manzil topilmadi.' }));

/* ---------- Ishga tushirish ---------- */
async function initAdmin() {
  const exists = db(await sb.from('users').select('id').eq('email', ADMIN.email).maybeSingle());
  if (!exists) {
    db(await sb.from('users').insert({
      full_name: ADMIN.full_name, grade: ADMIN.grade, email: ADMIN.email,
      password: await bcrypt.hash(ADMIN.password, 10), role: 'admin'
    }));
    console.log('Admin akkaunti yaratildi:', ADMIN.email);
  }
}

async function startBot() {
  const bot = createBot();
  if (!bot) return console.log('BOT_TOKEN yo‘q: Telegram bot ishga tushirilmadi.');
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (base) {
    await bot.telegram.setWebhook(base.replace(/\/$/, '') + HOOK_PATH, { secret_token: HOOK_SECRET });
    botHandler = bot.webhookCallback(HOOK_PATH);
    console.log('Telegram bot webhook rejimida ishlamoqda.');
  } else {
    await bot.telegram.deleteWebhook();
    bot.launch().catch((e) => console.error('Bot xatosi:', e));
    console.log('Telegram bot polling rejimida ishlamoqda (lokal).');
  }
}

(async () => {
  try {
    await ensureBucket();
    await initAdmin();
  } catch (e) {
    console.error('Supabase bilan ishlashda xatolik. supabase.sql ni SQL Editor’da ishga tushirdingizmi va kalitlar to‘g‘rimi?\n', e);
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Sertifikatlar Portali ishga tushdi: http://localhost:${PORT}`));
  startBot().catch((e) => console.error('Botni ishga tushirishda xatolik:', e));
})();
