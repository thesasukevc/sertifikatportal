// Zaxira nusxa: npm run backup
const fs = require('fs');
const path = require('path');

const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
const target = path.join(__dirname, 'backups', stamp);
fs.mkdirSync(path.join(target, 'uploads'), { recursive: true });

const db = path.join(__dirname, 'database.sqlite');
if (fs.existsSync(db)) fs.copyFileSync(db, path.join(target, 'database.sqlite'));

const up = path.join(__dirname, 'uploads');
let n = 0;
fs.readdirSync(up).forEach((f) => {
  if (f === '.gitkeep') return;
  fs.copyFileSync(path.join(up, f), path.join(target, 'uploads', f));
  n++;
});
console.log(`Zaxira nusxa tayyor: backups/${stamp} (baza + ${n} ta fayl)`);
