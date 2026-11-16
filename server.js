require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');
const multer = require('multer');
const archiver = require('archiver');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(__dirname, 'database.sqlite');
const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];
const MAX_SIZE = 15 * 1024 * 1024; // 15 MB

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
  console.warn('OGOHLANTIRISH: .env faylida SESSION_SECRET yo‘q. Vaqtinchalik kalit ishlatilmoqda.');
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ---------- Ma'lumotlar bazasi ---------- */
const db = new DatabaseSync(DB_FILE);
const run = async (sql, params = []) => {
  const r = db.prepare(sql).run(...params);
  return { lastID: Number(r.lastInsertRowid), changes: Number(r.changes) };
};
const get = async (sql, params = []) => db.prepare(sql).get(...params);
const all = async (sql, params = []) => db.prepare(sql).all(...params);

// Sessiyalar uchun oddiy SQLite saqlash joyi (qo'shimcha paket kerak emas)
class SqliteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)');
    setInterval(() => this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 10 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const r = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), exp);
      if (cb) cb(null);
    } catch (e) { if (cb) cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); if (cb) cb(null); }
    catch (e) { if (cb) cb(e); }
  }
}

async function initDb() {
  await run('PRAGMA foreign_keys = ON');
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    grade TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    score TEXT,
    issued_date TEXT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  // Eski bazalar uchun: file_hash ustunini qo'shish
  const cols = await all('PRAGMA table_info(certificates)');
  if (!cols.some((c) => c.name === 'file_hash')) await run('ALTER TABLE certificates ADD COLUMN file_hash TEXT');

  const exists = await get('SELECT id FROM users WHERE email = ?', [ADMIN.email]);
  if (!exists) {
    const hash = await bcrypt.hash(ADMIN.password, 10);
    await run('INSERT INTO users (full_name, grade, email, password, role) VALUES (?, ?, ?, ?, ?)', [
      ADMIN.full_name, ADMIN.grade, ADMIN.email, hash, ADMIN.role
    ]);
    console.log('Admin akkaunti yaratildi:', ADMIN.email);
  }
}

/* ---------- Yordamchi funksiyalar ---------- */
function sanitizeName(name, fallback = 'nomsiz') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 120) || fallback;
}
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function removeFileSafe(storedName) {
  fs.unlink(path.join(UPLOADS_DIR, path.basename(storedName)), () => {});
}
// Fayl ichki imzosini tekshirish (kengaytmani almashtirib aldashning oldini oladi)
function validSignature(filePath, ext) {
  const buf = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buf, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (ext === '.pdf') return buf.slice(0, 4).toString('latin1') === '%PDF';
  if (ext === '.png') return buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff; // jpg / jpeg
}
function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    hits.forEach((v, k) => v.reset < now && hits.delete(k));
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const e = hits.get(req.ip);
    if (!e || e.reset < now) { hits.set(req.ip, { count: 1, reset: now + windowMs }); return next(); }
    if (++e.count > max) return res.status(429).json({ error: message });
    next();
  };
}
function validPassword(p) { return typeof p === 'string' && p.length >= 6; }

/* ---------- Express sozlamalari ---------- */
const app = express();
app.disable('x-powered-by');
if (process.env.COOKIE_SECURE === 'true') app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new SqliteSessionStore(db),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 1000 * 60 * 60 * 8
    }
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

const requireAuth = (req, res, next) =>
  req.session.user ? next() : res.status(401).json({ error: 'Avval tizimga kiring.' });
const requireAdmin = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Avval tizimga kiring.' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Bu amal faqat admin uchun.' });
  next();
};
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Urinishlar juda ko‘p. 15 daqiqadan keyin qayta urining.' });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Ro‘yxatdan o‘tish urinishlari juda ko‘p. Keyinroq urinib ko‘ring.' });

/* ---------- Fayl yuklash (multer) ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EXT.includes(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('Faqat PDF, JPG, JPEG yoki PNG fayllarni yuklash mumkin.'));
    }
    cb(null, true);
  }
});
const fixOriginalName = (name) => { try { return Buffer.from(name, 'latin1').toString('utf8'); } catch (e) { return name; } };

/* ---------- Autentifikatsiya ---------- */
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const full_name = String(req.body.full_name || '').trim();
    const grade = String(req.body.grade || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!full_name || !grade || !email || !password) return res.status(400).json({ error: 'Barcha maydonlarni to‘ldiring.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email manzili noto‘g‘ri.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'Parol kamida 6 ta belgidan iborat bo‘lishi kerak.' });
    if (await get('SELECT id FROM users WHERE email = ?', [email])) {
      return res.status(409).json({ error: 'Bu email bilan allaqachon ro‘yxatdan o‘tilgan.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await run('INSERT INTO users (full_name, grade, email, password, role) VALUES (?, ?, ?, ?, ?)', [
      full_name, grade, email, hash, 'student'
    ]);
    req.session.user = { id: result.lastID, full_name, grade, email, role: 'student' };
    res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email va parolni kiriting.' });
    const user = await get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Email yoki parol noto‘g‘ri.' });
    }
    req.session.user = { id: user.id, full_name: user.full_name, grade: user.grade, email: user.email, role: user.role };
    res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!validPassword(new_password)) return res.status(400).json({ error: 'Yangi parol kamida 6 ta belgidan iborat bo‘lishi kerak.' });
    const user = await get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    if (!user || !(await bcrypt.compare(String(current_password || ''), user.password))) {
      return res.status(400).json({ error: 'Joriy parol noto‘g‘ri.' });
    }
    await run('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(new_password, 10), user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

/* ---------- Sertifikatlar ---------- */
app.post('/api/certificates', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({
        error: err.code === 'LIMIT_FILE_SIZE' ? 'Fayl hajmi 15 MB dan oshmasligi kerak.' : err.message || 'Fayl yuklashda xatolik.'
      });
    }
    const file = req.file;
    const fail = (code, msg) => { if (file) removeFileSafe(file.filename); return res.status(code).json({ error: msg }); };
    try {
      const title = String(req.body.title || '').trim();
      const score = String(req.body.score || '').trim();
      const issued_date = String(req.body.issued_date || '').trim() || todayStr();
      if (!file) return fail(400, 'Sertifikat faylini tanlang.');
      if (!title) return fail(400, 'Sertifikat nomini kiriting.');
      if (!validSignature(file.path, path.extname(file.filename))) {
        return fail(400, 'Fayl mazmuni uning turiga mos kelmaydi. Haqiqiy PDF, JPG yoki PNG yuklang.');
      }
      const hash = fileHash(file.path);
      if (await get('SELECT id FROM certificates WHERE user_id = ? AND file_hash = ?', [req.session.user.id, hash])) {
        return fail(409, 'Bu fayl avval yuklangan.');
      }
      await run(
        'INSERT INTO certificates (user_id, title, score, issued_date, original_name, stored_name, file_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.session.user.id, title, score, issued_date, fixOriginalName(file.originalname), file.filename, hash]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      fail(500, 'Serverda xatolik yuz berdi.');
    }
  });
});

app.get('/api/my-certificates', requireAuth, async (req, res) => {
  try {
    res.json({
      certificates: await all('SELECT * FROM certificates WHERE user_id = ? ORDER BY created_at DESC, id DESC', [req.session.user.id])
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

async function ownCert(req, res) {
  const cert = await get('SELECT * FROM certificates WHERE id = ?', [req.params.id]);
  if (!cert) { res.status(404).json({ error: 'Sertifikat topilmadi.' }); return null; }
  if (req.session.user.role !== 'admin' && cert.user_id !== req.session.user.id) {
    res.status(403).json({ error: 'Bu sertifikatga ruxsatingiz yo‘q.' });
    return null;
  }
  return cert;
}

app.put('/api/certificates/:id', requireAuth, async (req, res) => {
  try {
    const cert = await ownCert(req, res);
    if (!cert) return;
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Sertifikat nomini kiriting.' });
    await run('UPDATE certificates SET title = ?, score = ?, issued_date = ? WHERE id = ?', [
      title, String(req.body.score || '').trim(), String(req.body.issued_date || '').trim() || cert.issued_date, cert.id
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

app.delete('/api/certificates/:id', requireAuth, async (req, res) => {
  try {
    const cert = await ownCert(req, res);
    if (!cert) return;
    await run('DELETE FROM certificates WHERE id = ?', [cert.id]);
    removeFileSafe(cert.stored_name);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

// Yuklangan fayllar: faqat egasi yoki admin ko'ra oladi
app.get('/uploads/:name', requireAuth, async (req, res) => {
  try {
    const name = path.basename(req.params.name);
    const cert = await get('SELECT user_id FROM certificates WHERE stored_name = ?', [name]);
    if (!cert) return res.status(404).send('Fayl topilmadi.');
    if (req.session.user.role !== 'admin' && cert.user_id !== req.session.user.id) return res.status(403).send('Ruxsat yo‘q.');
    const file = path.join(UPLOADS_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).send('Fayl serverda topilmadi.');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  } catch (err) {
    console.error(err);
    res.status(500).send('Serverda xatolik yuz berdi.');
  }
});

/* ---------- Admin ---------- */
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const students = await all(
      `SELECT u.id, u.full_name, u.grade, u.email, COUNT(c.id) AS cert_count
       FROM users u LEFT JOIN certificates c ON c.user_id = u.id
       WHERE u.role = 'student' GROUP BY u.id ORDER BY u.full_name COLLATE NOCASE`
    );
    const certificates = await all(
      `SELECT c.id, c.user_id, c.title, c.score, c.issued_date, c.original_name, c.stored_name, u.full_name, u.grade
       FROM certificates c JOIN users u ON u.id = c.user_id
       WHERE u.role = 'student' ORDER BY u.full_name COLLATE NOCASE, c.created_at DESC`
    );
    certificates.forEach((c) => { c.missing = !fs.existsSync(path.join(UPLOADS_DIR, path.basename(c.stored_name))); });
    res.json({ total_students: students.length, students, certificates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

async function studentById(req, res) {
  const u = await get("SELECT * FROM users WHERE id = ? AND role = 'student'", [req.params.id]);
  if (!u) res.status(404).json({ error: 'O‘quvchi topilmadi.' });
  return u;
}

app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  try {
    const u = await studentById(req, res);
    if (!u) return;
    const certs = await all('SELECT stored_name FROM certificates WHERE user_id = ?', [u.id]);
    await run('DELETE FROM certificates WHERE user_id = ?', [u.id]);
    await run('DELETE FROM users WHERE id = ?', [u.id]);
    certs.forEach((c) => removeFileSafe(c.stored_name));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

app.post('/api/admin/students/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const u = await studentById(req, res);
    if (!u) return;
    const temp = crypto.randomBytes(5).toString('hex'); // 10 belgi
    await run('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(temp, 10), u.id]);
    res.json({ password: temp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Serverda xatolik yuz berdi.' });
  }
});

app.get('/api/admin/download-zip', requireAdmin, async (req, res) => {
  try {
    const rows = await all(
      `SELECT c.*, u.full_name, u.grade FROM certificates c JOIN users u ON u.id = c.user_id
       ORDER BY u.full_name COLLATE NOCASE, u.id, c.created_at, c.id`
    );
    if (!rows.length) return res.status(404).json({ error: 'Yuklab olish uchun sertifikatlar yo‘q.' });

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
      const filePath = path.join(UPLOADS_DIR, path.basename(row.stored_name));
      if (!fs.existsSync(filePath)) { missing.push(`${folder} / ${row.title}`); continue; }

      const ext = path.extname(row.stored_name).toLowerCase();
      const base = sanitizeName(row.score ? `${row.title} - ${row.score}` : row.title, 'Sertifikat');
      let fileName = `${base}${ext}`;
      let counter = 1;
      while (usedPaths.has(`${folder}/${fileName}`.toLowerCase())) fileName = `${base}_${counter++}${ext}`;
      usedPaths.add(`${folder}/${fileName}`.toLowerCase());
      archive.file(filePath, { name: `${folder}/${fileName}` });
    }
    if (missing.length) {
      archive.append('Quyidagi sertifikat fayllari serverda topilmadi:\r\n\r\n' + missing.join('\r\n'), { name: 'TOPILMAGAN_FAYLLAR.txt' });
    }
    await archive.finalize();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'ZIP yaratishda xatolik yuz berdi.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Manzil topilmadi.' }));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Sertifikatlar Portali ishga tushdi: http://localhost:${PORT}`)))
  .catch((err) => { console.error('Ma‘lumotlar bazasini tayyorlashda xatolik:', err); process.exit(1); });
