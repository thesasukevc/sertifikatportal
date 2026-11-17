// Telegram bot: o'quvchi ro'yxatdan o'tadi va sertifikatlarini yuboradi
const { Telegraf, Markup } = require('telegraf');
const { sb, db, AppError, MAX_SIZE, todayStr, saveCertificate, deleteCertificate } = require('./core');

const BTN_UPLOAD = '➕ Sertifikat yuklash';
const BTN_MINE = '📄 Mening sertifikatlarim';
const BTN_CANCEL = '❌ Bekor qilish';
const BTN_SKIP = '⏭ O‘tkazib yuborish';
const BTN_TODAY = '📅 Bugun';

const MENU = Markup.keyboard([[BTN_UPLOAD], [BTN_MINE]]).resize();
const CANCEL = Markup.keyboard([[BTN_CANCEL]]).resize();

/* ---- Suhbat holati (Supabase'da saqlanadi, server qayta ishga tushsa ham yo'qolmaydi) ---- */
async function getState(tgId) {
  const r = db(await sb.from('bot_sessions').select('state').eq('telegram_id', tgId).maybeSingle());
  return r ? r.state : null;
}
async function setState(tgId, state) {
  db(await sb.from('bot_sessions').upsert({ telegram_id: tgId, state, updated_at: new Date().toISOString() }));
}
async function clearState(tgId) {
  db(await sb.from('bot_sessions').delete().eq('telegram_id', tgId));
}
async function findUser(tgId) {
  return db(await sb.from('users').select('id,full_name,grade').eq('telegram_id', tgId).maybeSingle());
}

function parseDate(txt) {
  const t = txt.trim().toLowerCase();
  if (t === BTN_TODAY.toLowerCase() || t === 'bugun') return todayStr();
  const m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 1990) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const fmtDate = (d) => (d ? String(d).split('-').reverse().join('.') : '—');

function createBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) return null;
  const bot = new Telegraf(token);

  bot.catch((err, ctx) => {
    console.error('Bot xatoligi:', err);
    ctx.reply('Kutilmagan xatolik yuz berdi. Birozdan keyin qayta urinib ko‘ring yoki /start ni bosing.').catch(() => {});
  });

  bot.telegram
    .setMyCommands([
      { command: 'start', description: 'Boshlash / ro‘yxatdan o‘tish' },
      { command: 'sertifikat', description: 'Yangi sertifikat yuklash' },
      { command: 'mening', description: 'Mening sertifikatlarim' },
      { command: 'bekor', description: 'Joriy amalni bekor qilish' }
    ])
    .catch(() => {});

  /* ---- Boshlash ---- */
  bot.start(async (ctx) => {
    const id = ctx.from.id;
    await clearState(id);
    const user = await findUser(id);
    if (user) {
      return ctx.reply(`Assalomu alaykum, ${user.full_name}! Quyidagi tugmalardan birini tanlang.`, MENU);
    }
    await setState(id, { step: 'reg_name' });
    return ctx.reply(
      'Assalomu alaykum! Sertifikatlar Portaliga xush kelibsiz.\n\nRo‘yxatdan o‘tish uchun F.I.Sh ni to‘liq yozing (masalan: Aliyev Vali Karimovich).\n\nShu nom sizning papkangiz nomi bo‘ladi, shuning uchun to‘g‘ri yozing.',
      Markup.removeKeyboard()
    );
  });

  async function cancel(ctx) {
    await clearState(ctx.from.id);
    const user = await findUser(ctx.from.id);
    return user
      ? ctx.reply('Bekor qilindi.', MENU)
      : ctx.reply('Bekor qilindi. Boshlash uchun /start ni bosing.', Markup.removeKeyboard());
  }
  bot.command('bekor', cancel);
  bot.hears(BTN_CANCEL, cancel);

  /* ---- Sertifikat yuklashni boshlash ---- */
  async function startUpload(ctx) {
    const user = await findUser(ctx.from.id);
    if (!user) return ctx.reply('Avval ro‘yxatdan o‘ting: /start ni bosing.');
    await setState(ctx.from.id, { step: 'cert_title', data: {} });
    return ctx.reply('Sertifikat nomini yozing (masalan: IELTS, CEFR, Matematika Milliy Sertifikat):', CANCEL);
  }
  bot.command('sertifikat', startUpload);
  bot.hears(BTN_UPLOAD, startUpload);

  /* ---- Mening sertifikatlarim ---- */
  async function listMine(ctx) {
    const user = await findUser(ctx.from.id);
    if (!user) return ctx.reply('Avval ro‘yxatdan o‘ting: /start ni bosing.');
    const certs = db(
      await sb.from('certificates').select('id,title,score,issued_date').eq('user_id', user.id).order('id', { ascending: false }).limit(20)
    );
    if (!certs.length) return ctx.reply('Hali sertifikat yuklanmagan. “➕ Sertifikat yuklash” tugmasini bosing.', MENU);
    await ctx.reply(`Sizning sertifikatlaringiz (${certs.length} ta, oxirgilari):`, MENU);
    for (const c of certs) {
      const line = `📄 ${c.title}${c.score ? ` — ${c.score}` : ''}\n📅 ${fmtDate(c.issued_date)}`;
      await ctx.reply(line, Markup.inlineKeyboard([Markup.button.callback('🗑 O‘chirish', `del:${c.id}`)]));
    }
  }
  bot.command('mening', listMine);
  bot.hears(BTN_MINE, listMine);

  bot.action(/^del:(\d+)$/, async (ctx) => {
    const user = await findUser(ctx.from.id);
    if (!user) return ctx.answerCbQuery('Avval ro‘yxatdan o‘ting.');
    const cert = db(await sb.from('certificates').select('*').eq('id', ctx.match[1]).eq('user_id', user.id).maybeSingle());
    if (!cert) return ctx.answerCbQuery('Sertifikat topilmadi.');
    await deleteCertificate(cert);
    await ctx.answerCbQuery('O‘chirildi');
    return ctx.editMessageText(`🗑 O‘chirildi: ${cert.title}`).catch(() => {});
  });

  /* ---- Bosqichma-bosqich suhbat ---- */
  bot.on('message', async (ctx) => {
    const id = ctx.from.id;
    const state = await getState(id);
    if (!state) {
      const user = await findUser(id);
      return user ? ctx.reply('Quyidagi tugmalardan birini tanlang.', MENU) : ctx.reply('Boshlash uchun /start ni bosing.');
    }
    const text = ctx.message.text ? ctx.message.text.trim() : null;
    const needText = () => ctx.reply('Iltimos, matn yozing.');

    switch (state.step) {
      case 'reg_name': {
        if (!text) return needText();
        if (text.length < 5 || text.length > 100 || text.split(/\s+/).length < 2) {
          return ctx.reply('Iltimos, F.I.Sh ni to‘liq yozing (kamida ism va familiya).');
        }
        await setState(id, { step: 'reg_grade', data: { full_name: text } });
        return ctx.reply('Sinfingizni yozing (masalan: 10-A):');
      }
      case 'reg_grade': {
        if (!text) return needText();
        if (text.length > 20) return ctx.reply('Sinf nomi juda uzun. Masalan: 10-A');
        const full_name = state.data.full_name;
        const exists = await findUser(id);
        if (!exists) db(await sb.from('users').insert({ full_name, grade: text, role: 'student', telegram_id: id }));
        await clearState(id);
        return ctx.reply(
          `✅ Ro‘yxatdan o‘tdingiz!\n\n👤 ${full_name}\n🏫 ${text}\n\nEndi “➕ Sertifikat yuklash” tugmasini bosing.`,
          MENU
        );
      }
      case 'cert_title': {
        if (!text) return needText();
        if (text.length < 2 || text.length > 150) return ctx.reply('Sertifikat nomi 2 dan 150 gacha belgidan iborat bo‘lsin.');
        await setState(id, { step: 'cert_score', data: { title: text } });
        return ctx.reply('Ball yoki darajasini yozing (masalan: C1 yoki 7.5). Bo‘lmasa, o‘tkazib yuboring.', Markup.keyboard([[BTN_SKIP], [BTN_CANCEL]]).resize());
      }
      case 'cert_score': {
        if (!text) return needText();
        const score = text === BTN_SKIP ? '' : text;
        if (score.length > 50) return ctx.reply('Juda uzun. Qisqaroq yozing (masalan: C1 / 7.5).');
        await setState(id, { step: 'cert_date', data: { ...state.data, score } });
        return ctx.reply('Sertifikat berilgan sanani yozing (kun.oy.yil, masalan: 15.09.2025) yoki “Bugun” tugmasini bosing.', Markup.keyboard([[BTN_TODAY], [BTN_CANCEL]]).resize());
      }
      case 'cert_date': {
        if (!text) return needText();
        const date = parseDate(text);
        if (!date) return ctx.reply('Sana noto‘g‘ri. Shunday yozing: 15.09.2025');
        await setState(id, { step: 'cert_file', data: { ...state.data, issued_date: date } });
        return ctx.reply(
          'Endi sertifikat faylini yuboring (PDF, JPG yoki PNG, 15 MB gacha).\n\n💡 Rasmni “Fayl” (File) ko‘rinishida yuborsangiz, sifati buzilmaydi.',
          CANCEL
        );
      }
      case 'cert_file': {
        let fileId, name, size;
        const m = ctx.message;
        if (m.document) {
          fileId = m.document.file_id;
          name = m.document.file_name || 'fayl';
          size = m.document.file_size;
        } else if (m.photo && m.photo.length) {
          const p = m.photo[m.photo.length - 1];
          fileId = p.file_id;
          name = `foto_${Date.now()}.jpg`;
          size = p.file_size;
        } else {
          return ctx.reply('Iltimos, sertifikat faylini (PDF, JPG yoki PNG) yuboring.');
        }
        if (size && size > MAX_SIZE) return ctx.reply('Fayl hajmi 15 MB dan oshmasligi kerak. Kichikroq fayl yuboring.');

        const user = await findUser(id);
        if (!user) {
          await clearState(id);
          return ctx.reply('Avval ro‘yxatdan o‘ting: /start ni bosing.');
        }
        await ctx.reply('⏳ Yuklanmoqda...');
        try {
          const link = await ctx.telegram.getFileLink(fileId);
          const resp = await fetch(link.href);
          if (!resp.ok) throw new Error(`Telegram fayl yuklash xatosi: ${resp.status}`);
          const buffer = Buffer.from(await resp.arrayBuffer());
          const d = state.data;
          await saveCertificate({
            user_id: user.id,
            title: d.title,
            score: d.score,
            issued_date: d.issued_date,
            originalName: name,
            buffer,
            source: 'telegram'
          });
          await clearState(id);
          return ctx.reply(
            `✅ Sertifikat saqlandi!\n\n📄 ${d.title}${d.score ? ` — ${d.score}` : ''}\n📅 ${fmtDate(d.issued_date)}\n\nYana sertifikatingiz bo‘lsa, “➕ Sertifikat yuklash” tugmasini bosing.`,
            MENU
          );
        } catch (err) {
          if (err instanceof AppError) return ctx.reply(`⚠️ ${err.message}\n\nBoshqa fayl yuboring yoki “❌ Bekor qilish” ni bosing.`);
          throw err;
        }
      }
      default:
        await clearState(id);
        return ctx.reply('Boshlash uchun /start ni bosing.');
    }
  });

  return bot;
}

module.exports = { createBot };
