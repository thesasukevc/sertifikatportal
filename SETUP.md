# Sertifikatlar Portali — o‘rnatish

## 1. Supabase
1. supabase.com da bepul loyiha oching.
2. **SQL Editor** → yangi so‘rov → `supabase.sql` ichidagini qo‘yib **Run** bosing.
3. **Project Settings → API** dan oling:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` kaliti → `SUPABASE_SERVICE_ROLE_KEY` (MAXFIY! Hech kimga bermang, GitHub'ga qo‘ymang)
4. Fayllar uchun `certificates` bucket'ini server o‘zi yaratadi.

## 2. Telegram bot
1. Telegram'da @BotFather → `/newbot` → nom va username bering.
2. Bergan tokenni `BOT_TOKEN` ga yozing.

## 3. Render
**Environment** bo‘limiga qo‘shing:
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BOT_TOKEN`, `SESSION_SECRET` (uzun tasodifiy satr),
`ADMIN_PASSWORD`, `COOKIE_SECURE=true`.
Build: `npm install` · Start: `npm start`.
(Render webhook manzilini `RENDER_EXTERNAL_URL` dan o‘zi oladi.)
`.env` faylini GitHub'ga YUKLAMANG.

## 4. Kompyuterda sinash
`.env` ni to‘ldiring, so‘ng: `npm install` va `npm start`. Lokal rejimda bot polling bilan ishlaydi.
