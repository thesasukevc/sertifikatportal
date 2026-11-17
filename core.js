// Umumiy qism: Supabase ulanishi va sertifikatlar bilan ishlash (sayt ham, bot ham shuni ishlatadi)
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('XATO: SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY o‘rnatilmagan (.env fayli yoki Render Environment).');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = process.env.STORAGE_BUCKET || 'certificates';
const ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];
const MAX_SIZE = 15 * 1024 * 1024; // 15 MB
const CONTENT_TYPES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Supabase javobini tekshirish: xato bo'lsa tashlaydi, aks holda data ni qaytaradi
function db(res) {
  if (res.error) throw res.error;
  return res.data;
}

// 1000 tadan ko'p qatorni sahifalab olish
async function selectAll(table, columns, filter) {
  let from = 0;
  let out = [];
  for (;;) {
    let q = sb.from(table).select(columns).order('id').range(from, from + 999);
    if (filter) q = filter(q);
    const rows = db(await q);
    out = out.concat(rows);
    if (rows.length < 1000) break;
    from += 1000;
  }
  return out;
}

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

// Fayl ichki imzosini tekshirish (kengaytmani almashtirib aldashning oldini oladi)
function validSignature(buf, ext) {
  if (ext === '.pdf') return buf.slice(0, 4).toString('latin1') === '%PDF';
  if (ext === '.png') return buf.length > 4 && buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff; // jpg / jpeg
}

const contentTypeOf = (ext) => CONTENT_TYPES[ext] || 'application/octet-stream';

async function ensureBucket() {
  const { error } = await sb.storage.getBucket(BUCKET);
  if (error) {
    const created = await sb.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_SIZE });
    if (created.error) throw created.error;
    console.log(`Storage bucket yaratildi: ${BUCKET}`);
  }
}

// Sertifikatni tekshirib, Storage'ga yuklab, bazaga yozadi
async function saveCertificate({ user_id, title, score, issued_date, originalName, buffer, source }) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new AppError(400, 'Faqat PDF, JPG, JPEG yoki PNG fayllarni yuklash mumkin.');
  if (buffer.length > MAX_SIZE) throw new AppError(400, 'Fayl hajmi 15 MB dan oshmasligi kerak.');
  if (!validSignature(buffer, ext)) {
    throw new AppError(400, 'Fayl mazmuni uning turiga mos kelmaydi. Haqiqiy PDF, JPG yoki PNG yuklang.');
  }
  const file_hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const dup = db(await sb.from('certificates').select('id').eq('user_id', user_id).eq('file_hash', file_hash).limit(1));
  if (dup.length) throw new AppError(409, 'Bu fayl avval yuklangan.');

  const storage_path = `${user_id}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const up = await sb.storage.from(BUCKET).upload(storage_path, buffer, { contentType: contentTypeOf(ext), upsert: false });
  if (up.error) throw up.error;

  const ins = await sb
    .from('certificates')
    .insert({
      user_id,
      title,
      score: score || '',
      issued_date: issued_date || todayStr(),
      original_name: originalName,
      storage_path,
      file_hash,
      source: source || 'web'
    })
    .select('id')
    .single();
  if (ins.error) {
    await sb.storage.from(BUCKET).remove([storage_path]);
    throw ins.error;
  }
  return ins.data;
}

async function removeFiles(paths) {
  const list = paths.filter(Boolean);
  if (list.length) await sb.storage.from(BUCKET).remove(list);
}

async function downloadFile(storagePath) {
  const { data, error } = await sb.storage.from(BUCKET).download(storagePath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function deleteCertificate(cert) {
  db(await sb.from('certificates').delete().eq('id', cert.id));
  await removeFiles([cert.storage_path]);
}

module.exports = {
  sb, db, selectAll, AppError, BUCKET, ALLOWED_EXT, MAX_SIZE,
  sanitizeName, todayStr, contentTypeOf, ensureBucket,
  saveCertificate, deleteCertificate, removeFiles, downloadFile
};
