const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { TEACHER_CODE, ADMIN_PASSWORD, SECRET } = process.env;
if (!TEACHER_CODE || !ADMIN_PASSWORD || !SECRET) {
  console.error('Задайте переменные окружения TEACHER_CODE, ADMIN_PASSWORD, SECRET (см. .env.example)');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- БД (встроенный node:sqlite, без native-сборки) ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'attendance.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS classes(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  total INTEGER NOT NULL DEFAULT 0, meal_total INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS absences(
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL, student TEXT NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL CHECK(type IN ('sick','excused','unexcused')), added_by TEXT,
  UNIQUE(class_id, date, student));
CREATE TABLE IF NOT EXISTS marks(
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL, marked_by TEXT, marked_at TEXT,
  PRIMARY KEY(class_id, date));
CREATE TABLE IF NOT EXISTS meals(
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL, student TEXT NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL CHECK(type IN ('large_family','ovz','orphanage','svo','paid')), added_by TEXT,
  UNIQUE(class_id, date, student));
CREATE TABLE IF NOT EXISTS meal_marks(
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date TEXT NOT NULL, marked_by TEXT, marked_at TEXT, paid_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(class_id, date));
`);

// миграции: старые БД
try {
  const classCols = db.prepare('PRAGMA table_info(classes)').all().map((c) => c.name);
  if (!classCols.includes('meal_total')) {
    db.exec('ALTER TABLE classes ADD COLUMN meal_total INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE classes SET meal_total = total');
  }
  const markCols = db.prepare('PRAGMA table_info(marks)').all().map((c) => c.name);
  if (!markCols.includes('marked_at')) db.exec('ALTER TABLE marks ADD COLUMN marked_at TEXT');
  const cols = db.prepare('PRAGMA table_info(meal_marks)').all().map((c) => c.name);
  if (!cols.includes('paid_count')) db.exec('ALTER TABLE meal_marks ADD COLUMN paid_count INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('marked_at')) db.exec('ALTER TABLE meal_marks ADD COLUMN marked_at TEXT');
  // старый CHECK без 'paid' — пересоздаём таблицу meals
  const mealsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='meals'").get()?.sql || '';
  if (mealsSql && !mealsSql.includes("'paid'")) {
    db.exec(`
      CREATE TABLE meals_new(
        id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        date TEXT NOT NULL, student TEXT NOT NULL COLLATE NOCASE,
        type TEXT NOT NULL CHECK(type IN ('large_family','ovz','orphanage','svo','paid')), added_by TEXT,
        UNIQUE(class_id, date, student));
      INSERT INTO meals_new(id, class_id, date, student, type, added_by)
        SELECT id, class_id, date, student, type, added_by FROM meals;
      DROP TABLE meals;
      ALTER TABLE meals_new RENAME TO meals;
    `);
  }
  // старый CHECK без 'unexcused' — пересоздаём absences
  const absSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='absences'").get()?.sql || '';
  if (absSql && !absSql.includes("'unexcused'")) {
    db.exec(`
      CREATE TABLE absences_new(
        id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        date TEXT NOT NULL, student TEXT NOT NULL COLLATE NOCASE,
        type TEXT NOT NULL CHECK(type IN ('sick','excused','unexcused')), added_by TEXT,
        UNIQUE(class_id, date, student));
      INSERT INTO absences_new(id, class_id, date, student, type, added_by)
        SELECT id, class_id, date, student, type, added_by FROM absences;
      DROP TABLE absences;
      ALTER TABLE absences_new RENAME TO absences;
    `);
  }
} catch (e) {
  console.error('migration', e.message);
}

const ABSENCE_TYPES = ['sick', 'excused', 'unexcused'];
const MEAL_TYPES = ['large_family', 'ovz', 'orphanage', 'svo', 'paid'];

function withTx(fn) {
  db.exec('BEGIN');
  try { fn(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function nowSql() { return new Date().toISOString(); }

function touchMark(classId, date, who) {
  db.prepare(`INSERT INTO marks(class_id,date,marked_by,marked_at) VALUES(?,?,?,?)
    ON CONFLICT(class_id,date) DO UPDATE SET marked_by=excluded.marked_by, marked_at=excluded.marked_at`)
    .run(classId, date, who, nowSql());
}

function touchMealMark(classId, date, who) {
  db.prepare(`INSERT INTO meal_marks(class_id,date,marked_by,paid_count,marked_at) VALUES(?,?,?,0,?)
    ON CONFLICT(class_id,date) DO UPDATE SET marked_by=excluded.marked_by, marked_at=excluded.marked_at`)
    .run(classId, date, who, nowSql());
}

/** Число платников → «Платник 1»…«Платник N». Возвращает сколько записей добавлено. */
function migratePaidCounts() {
  const oldPaid = db.prepare(
    'SELECT class_id, date, paid_count, marked_by FROM meal_marks WHERE paid_count > 0'
  ).all();
  if (!oldPaid.length) return 0;
  const countPaid = db.prepare(
    'SELECT COUNT(*) AS n FROM meals WHERE class_id=? AND date=? AND type=?'
  );
  const insertPaid = db.prepare(
    'INSERT OR IGNORE INTO meals(class_id,date,student,type,added_by) VALUES(?,?,?,?,?)'
  );
  const clearCount = db.prepare(
    'UPDATE meal_marks SET paid_count=0 WHERE class_id=? AND date=?'
  );
  let added = 0;
  withTx(() => {
    for (const row of oldPaid) {
      const already = countPaid.get(row.class_id, row.date, 'paid').n;
      const need = Math.max(0, row.paid_count - already);
      const who = row.marked_by || 'миграция';
      for (let i = already + 1; i <= already + need; i++) {
        insertPaid.run(row.class_id, row.date, `Платник ${i}`, 'paid', who);
        added++;
      }
      clearCount.run(row.class_id, row.date);
    }
  });
  return added;
}

try {
  const added = migratePaidCounts();
  if (added) console.log(`миграция платников: добавлено записей: ${added}`);
} catch (e) {
  console.error('миграция платников', e.message);
}

// ---------- Авторизация (подписанный токен, без внешних библиотек) ----------
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = (p) => { const body = b64(JSON.stringify({ ...p, exp: Date.now() + 90 * 864e5 })); return body + '.' + sign(body); };
function readToken(t) {
  if (!t) return null;
  const [body, sig] = t.split('.');
  if (!body || !sig || sig !== sign(body)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const safeEq = (a, b) => {
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

const fails = new Map(); // ip -> {n, until}
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

app.post('/api/login', (req, res) => {
  const ip = req.ip, f = fails.get(ip);
  if (f && f.n >= 10 && f.until > Date.now()) return res.status(429).json({ error: 'Слишком много попыток, подождите 10 минут' });
  const { role, secret } = req.body || {};
  const name = clean(req.body?.name);
  let ok = false, who = name;
  if (role === 'admin') { ok = safeEq(secret, ADMIN_PASSWORD); who = 'Завуч'; }
  else if (role === 'teacher') { ok = name && safeEq(secret, TEACHER_CODE); }
  if (!ok) {
    fails.set(ip, { n: (f?.n || 0) + 1, until: Date.now() + 10 * 60e3 });
    const err = role === 'admin' ? 'НЕВЕРНЫЙ ПАРОЛЬ'
      : (!name ? 'Введите ФИО' : 'НЕВЕРНЫЙ КОД');
    return res.status(401).json({ error: err });
  }
  fails.delete(ip);
  res.json({ token: makeToken({ role, name: who }), role, name: who });
});

// Клиентские сбои связи (без авторизации: иначе офлайн-очередь не сбросить после восстановления)
const clientLogPath = path.join(DATA_DIR, 'client-errors.log');
const clientLogFails = new Map();
app.post('/api/client-log', (req, res) => {
  const ip = req.ip;
  const f = clientLogFails.get(ip);
  if (f && f.n >= 30 && f.until > Date.now()) return res.status(429).json({ error: 'Слишком много' });
  clientLogFails.set(ip, { n: (f?.n || 0) + 1, until: Date.now() + 10 * 60e3 });

  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [body];
  const lines = [];
  for (const ev of events) {
    lines.push(JSON.stringify({
      t: new Date().toISOString(),
      ip,
      url: String(ev.url || '').slice(0, 200),
      when: String(ev.when || '').slice(0, 40),
      name: String(ev.name || '').slice(0, 60),
      role: String(ev.role || '').slice(0, 20),
      msg: String(ev.msg || ev.message || 'network').slice(0, 200),
      ua: String(req.headers['user-agent'] || '').slice(0, 180),
      online: ev.online === false ? false : true,
    }));
  }
  try {
    fs.appendFileSync(clientLogPath, lines.join('\n') + '\n');
  } catch (e) {
    console.error('client-log write', e.message);
    return res.status(500).json({ error: 'log fail' });
  }
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  const u = readToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return res.status(401).json({ error: 'Нужно войти' });
  req.user = u; next();
});
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Только для завуча' });

// ---------- Вспомогательное ----------
function clean(s) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60); }
// «петров» / «ПЕТРОВ» -> «Петров» (NOCASE в SQLite не работает с кириллицей, поэтому приводим регистр сами)
const titleCase = (s) => clean(s).toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const natKey = (n) => { const m = /^(\d+)\s*(.*)$/.exec(n); return m ? [parseInt(m[1], 10), m[2]] : [999, n]; };
const natSort = (a, b) => { const x = natKey(a.name), y = natKey(b.name); return x[0] - y[0] || x[1].localeCompare(y[1], 'ru'); };
const getClass = (id) => db.prepare('SELECT * FROM classes WHERE id=?').get(id);

// ---------- Классы ----------
app.get('/api/classes', (req, res) => {
  try { migratePaidCounts(); } catch {}
  const date = validDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT c.id, c.name, c.total, c.meal_total,
      (SELECT COUNT(*) FROM absences a WHERE a.class_id=c.id AND a.date=@d AND a.type='sick') AS sick,
      (SELECT COUNT(*) FROM absences a WHERE a.class_id=c.id AND a.date=@d AND a.type='excused') AS excused,
      (SELECT COUNT(*) FROM absences a WHERE a.class_id=c.id AND a.date=@d AND a.type='unexcused') AS unexcused,
      (SELECT marked_by FROM marks m WHERE m.class_id=c.id AND m.date=@d) AS marked_by,
      (SELECT marked_at FROM marks m WHERE m.class_id=c.id AND m.date=@d) AS marked_at,
      (SELECT COUNT(*) FROM meals m WHERE m.class_id=c.id AND m.date=@d AND m.type='large_family') AS meal_lf,
      (SELECT COUNT(*) FROM meals m WHERE m.class_id=c.id AND m.date=@d AND m.type='ovz') AS meal_ovz,
      (SELECT COUNT(*) FROM meals m WHERE m.class_id=c.id AND m.date=@d AND m.type='orphanage') AS meal_orph,
      (SELECT COUNT(*) FROM meals m WHERE m.class_id=c.id AND m.date=@d AND m.type='svo') AS meal_svo,
      (SELECT COUNT(*) FROM meals m WHERE m.class_id=c.id AND m.date=@d AND m.type='paid') AS meal_paid,
      (SELECT marked_by FROM meal_marks mm WHERE mm.class_id=c.id AND mm.date=@d) AS meal_marked_by,
      (SELECT marked_at FROM meal_marks mm WHERE mm.class_id=c.id AND mm.date=@d) AS meal_marked_at
    FROM classes c`).all({ d: date });
  res.json(rows.sort(natSort));
});

app.post('/api/classes', adminOnly, (req, res) => {
  const name = clean(req.body?.name).toUpperCase().replace(/\s/g, '');
  const rawTotal = req.body?.total;
  const rawMeal = req.body?.meal_total;
  const total = parseInt(rawTotal, 10);
  const mealTotal = parseInt(rawMeal, 10);
  if (!name) return res.status(400).json({ error: 'Введите название класса' });
  if (rawTotal === undefined || rawTotal === null || String(rawTotal).trim() === '' || !Number.isFinite(total) || total < 1) {
    return res.status(400).json({ error: 'Укажите количество учеников' });
  }
  if (rawMeal === undefined || rawMeal === null || String(rawMeal).trim() === '' || !Number.isFinite(mealTotal) || mealTotal < 0) {
    return res.status(400).json({ error: 'Укажите количество питающихся' });
  }
  try {
    const r = db.prepare('INSERT INTO classes(name,total,meal_total,created_by) VALUES(?,?,?,?)')
      .run(name, total, mealTotal, req.user.name);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch { res.status(409).json({ error: 'Такой класс уже есть' }); }
});

app.get('/api/classes/:id', (req, res) => {
  const cls = getClass(req.params.id);
  if (!cls) return res.status(404).json({ error: 'Класс не найден' });
  try { migratePaidCounts(); } catch {}
  const date = validDate(req.query.date) ? req.query.date : '';
  const list = (t) => db.prepare('SELECT id, student FROM absences WHERE class_id=? AND date=? AND type=? ORDER BY student').all(cls.id, date, t);
  const mealList = (t) => db.prepare('SELECT id, student FROM meals WHERE class_id=? AND date=? AND type=? ORDER BY student COLLATE NOCASE').all(cls.id, date, t);
  const suggestions = db.prepare(`SELECT student FROM absences WHERE class_id=? GROUP BY student ORDER BY COUNT(*) DESC, student LIMIT 80`).all(cls.id).map((r) => r.student);
  const mealSuggestions = db.prepare(`SELECT student FROM meals WHERE class_id=? GROUP BY student ORDER BY COUNT(*) DESC, student LIMIT 80`).all(cls.id).map((r) => r.student);
  const mark = db.prepare('SELECT marked_by, marked_at FROM marks WHERE class_id=? AND date=?').get(cls.id, date);
  const mealMark = db.prepare('SELECT marked_by, marked_at FROM meal_marks WHERE class_id=? AND date=?').get(cls.id, date);
  res.json({
    cls,
    sick: list('sick'),
    excused: list('excused'),
    unexcused: list('unexcused'),
    suggestions,
    marked_by: mark?.marked_by || null,
    marked_at: mark?.marked_at || null,
    meals: {
      large_family: mealList('large_family'),
      ovz: mealList('ovz'),
      orphanage: mealList('orphanage'),
      svo: mealList('svo'),
      paid: mealList('paid'),
    },
    meal_suggestions: mealSuggestions,
    meal_marked_by: mealMark?.marked_by || null,
    meal_marked_at: mealMark?.marked_at || null,
  });
});

app.patch('/api/classes/:id', adminOnly, (req, res) => {
  const cls = getClass(req.params.id);
  if (!cls) return res.status(404).json({ error: 'Класс не найден' });
  let name = cls.name, total = cls.total, mealTotal = cls.meal_total ?? 0;
  if (req.body.total !== undefined) total = Math.max(0, parseInt(req.body.total, 10) || 0);
  if (req.body.meal_total !== undefined) mealTotal = Math.max(0, parseInt(req.body.meal_total, 10) || 0);
  if (req.body.name !== undefined) name = clean(req.body.name).toUpperCase().replace(/\s/g, '') || cls.name;
  try {
    db.prepare('UPDATE classes SET name=?, total=?, meal_total=? WHERE id=?').run(name, total, mealTotal, cls.id);
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'Такой класс уже есть' }); }
});

app.delete('/api/classes/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM classes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Отсутствующие ----------
app.post('/api/classes/:id/absences', (req, res) => {
  const cls = getClass(req.params.id);
  const { date, type } = req.body || {};
  const student = titleCase(req.body?.student);
  if (!cls) return res.status(404).json({ error: 'Класс не найден' });
  if (!validDate(date) || !ABSENCE_TYPES.includes(type) || !student) return res.status(400).json({ error: 'Неверные данные' });
  withTx(() => {
    // ученик может быть только в одном списке за день: повторное добавление переносит его
    db.prepare(`INSERT INTO absences(class_id,date,student,type,added_by) VALUES(?,?,?,?,?)
      ON CONFLICT(class_id,date,student) DO UPDATE SET type=excluded.type, added_by=excluded.added_by`)
      .run(cls.id, date, student, type, req.user.name);
    touchMark(cls.id, date, req.user.name);
  });
  res.json({ ok: true, marked_at: nowSql() });
});

app.delete('/api/absences/:id', (req, res) => {
  const row = db.prepare('SELECT class_id, date FROM absences WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Запись не найдена' });
  withTx(() => {
    db.prepare('DELETE FROM absences WHERE id=?').run(req.params.id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM absences WHERE class_id=? AND date=?').get(row.class_id, row.date).n;
    if (!left) db.prepare('DELETE FROM marks WHERE class_id=? AND date=?').run(row.class_id, row.date);
    else touchMark(row.class_id, row.date, req.user.name);
  });
  res.json({ ok: true });
});

app.post('/api/classes/:id/mark', (req, res) => {
  if (!getClass(req.params.id) || !validDate(req.body?.date)) return res.status(400).json({ error: 'Неверные данные' });
  touchMark(req.params.id, req.body.date, req.user.name);
  res.json({ ok: true, marked_at: nowSql() });
});

app.post('/api/classes/:id/clear', (req, res) => {
  const cls = getClass(req.params.id);
  const date = req.body?.date;
  if (!cls || !validDate(date)) return res.status(400).json({ error: 'Неверные данные' });
  withTx(() => {
    db.prepare('DELETE FROM absences WHERE class_id=? AND date=?').run(cls.id, date);
    db.prepare('DELETE FROM marks WHERE class_id=? AND date=?').run(cls.id, date);
  });
  res.json({ ok: true });
});

// ---------- Питание (льготные категории + платники) ----------
app.post('/api/classes/:id/meals', (req, res) => {
  const cls = getClass(req.params.id);
  const { date, type } = req.body || {};
  const student = titleCase(req.body?.student);
  if (!cls) return res.status(404).json({ error: 'Класс не найден' });
  if (!validDate(date) || !MEAL_TYPES.includes(type) || !student) return res.status(400).json({ error: 'Неверные данные' });
  try {
    withTx(() => {
      db.prepare(`INSERT INTO meals(class_id,date,student,type,added_by) VALUES(?,?,?,?,?)
        ON CONFLICT(class_id,date,student) DO UPDATE SET type=excluded.type, added_by=excluded.added_by`)
        .run(cls.id, date, student, type, req.user.name);
      touchMealMark(cls.id, date, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('meals insert', e);
    res.status(500).json({ error: 'Не удалось сохранить. Перезапустите сервер с новой версией.' });
  }
});

app.delete('/api/meals/:id', (req, res) => {
  const row = db.prepare('SELECT class_id, date FROM meals WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Запись не найдена' });
  withTx(() => {
    db.prepare('DELETE FROM meals WHERE id=?').run(req.params.id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM meals WHERE class_id=? AND date=?').get(row.class_id, row.date).n;
    if (!left) {
      db.prepare('DELETE FROM meal_marks WHERE class_id=? AND date=?').run(row.class_id, row.date);
    } else {
      touchMealMark(row.class_id, row.date, req.user.name);
    }
  });
  res.json({ ok: true });
});

app.post('/api/classes/:id/meal-mark', (req, res) => {
  if (!getClass(req.params.id) || !validDate(req.body?.date)) return res.status(400).json({ error: 'Неверные данные' });
  touchMealMark(req.params.id, req.body.date, req.user.name);
  res.json({ ok: true });
});

app.post('/api/classes/:id/meal-clear', (req, res) => {
  const cls = getClass(req.params.id);
  const date = req.body?.date;
  if (!cls || !validDate(date)) return res.status(400).json({ error: 'Неверные данные' });
  withTx(() => {
    db.prepare('DELETE FROM meals WHERE class_id=? AND date=?').run(cls.id, date);
    db.prepare('DELETE FROM meal_marks WHERE class_id=? AND date=?').run(cls.id, date);
  });
  res.json({ ok: true });
});

/** Полная замена дня с устройства (офлайн-черновик). kind: att | meals */
app.post('/api/classes/:id/sync-day', (req, res) => {
  const cls = getClass(req.params.id);
  const date = req.body?.date;
  const kind = req.body?.kind === 'meals' ? 'meals' : 'att';
  if (!cls || !validDate(date)) return res.status(400).json({ error: 'Неверные данные' });
  const who = req.user.name;
  try {
    if (kind === 'att') {
      const items = Array.isArray(req.body?.students) ? req.body.students : [];
      withTx(() => {
        db.prepare('DELETE FROM absences WHERE class_id=? AND date=?').run(cls.id, date);
        const ins = db.prepare(
          'INSERT INTO absences(class_id,date,student,type,added_by) VALUES(?,?,?,?,?)'
        );
        for (const it of items) {
          const type = it?.type;
          const student = titleCase(it?.student);
          if (!ABSENCE_TYPES.includes(type) || !student) continue;
          ins.run(cls.id, date, student, type, who);
        }
        touchMark(cls.id, date, who);
      });
    } else {
      const items = Array.isArray(req.body?.students) ? req.body.students : [];
      withTx(() => {
        db.prepare('DELETE FROM meals WHERE class_id=? AND date=?').run(cls.id, date);
        const ins = db.prepare(
          'INSERT INTO meals(class_id,date,student,type,added_by) VALUES(?,?,?,?,?)'
        );
        for (const it of items) {
          const type = it?.type;
          const student = titleCase(it?.student);
          if (!MEAL_TYPES.includes(type) || !student) continue;
          ins.run(cls.id, date, student, type, who);
        }
        touchMealMark(cls.id, date, who);
      });
    }
    res.json({ ok: true, marked_at: nowSql() });
  } catch (e) {
    console.error('sync-day', e);
    res.status(500).json({ error: 'Не удалось сохранить список' });
  }
});

// ---------- Выгрузка в Excel (формат образца) ----------
const excelThinBorder = {
  top: { style: 'thin' }, left: { style: 'thin' },
  bottom: { style: 'thin' }, right: { style: 'thin' },
};
/** Обводка всех ячеек строки 1..colCount (пустые тоже — иначе рамки рвутся). */
function excelBorderRow(row, colCount) {
  for (let i = 1; i <= colCount; i++) row.getCell(i).border = excelThinBorder;
}

function excelStyleTotalRow(row, colCount, fill) {
  row.font = { bold: true, name: 'Arial' };
  for (let i = 1; i <= colCount; i++) {
    const cell = row.getCell(i);
    cell.fill = fill;
    cell.alignment = i === 1
      ? { vertical: 'middle' }
      : { horizontal: 'center', vertical: 'middle' };
  }
  excelBorderRow(row, colCount);
}

/** Блоки параллелей: итог после 4-х, 9-х и 11-х классов */
const GRADE_BLOCKS = [
  { max: 4, label: 'Итого 1–4' },
  { max: 9, label: 'Итого 5–9' },
  { max: 11, label: 'Итого 10–11' },
];
function gradeBlockIndex(grade) {
  if (grade >= 1 && grade <= 4) return 0;
  if (grade >= 5 && grade <= 9) return 1;
  if (grade >= 10 && grade <= 11) return 2;
  return -1;
}

app.get('/api/export', adminOnly, async (req, res) => {
  const date = req.query.date;
  if (!validDate(date)) return res.status(400).json({ error: 'Неверная дата' });
  const classes = db.prepare('SELECT * FROM classes').all().sort(natSort);
  const abs = db.prepare('SELECT class_id, student, type FROM absences WHERE date=? ORDER BY student').all(date);
  const marked = new Set(db.prepare('SELECT class_id FROM marks WHERE date=?').all(date).map((r) => r.class_id));

  const wb = new ExcelJS.Workbook();
  const [y, m, d] = date.split('-');
  const ws = wb.addWorksheet(`${d}.${m}.${y}`);
  const COLS = 6;
  ws.columns = [{ width: 12 }, { width: 10 }, { width: 11 }, { width: 16 }, { width: 16 }, { width: 16 }];
  const numCols = new Set([2, 3]); // Всего, По факту
  const fillDone = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
  const fillTotal = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
  const fillBlock = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
  const head = ws.addRow(['', 'Всего', 'По факту', 'По болезни', 'Уважительная', 'Без причины']);
  head.font = { bold: true, name: 'Arial' };
  for (let i = 1; i <= COLS; i++) {
    head.getCell(i).alignment = numCols.has(i)
      ? { horizontal: 'center', vertical: 'middle', wrapText: true }
      : { vertical: 'middle', wrapText: true };
  }
  excelBorderRow(head, COLS);

  const emptyBlock = () => ({ total: 0, fact: 0, sick: 0, exc: 0, unex: 0, any: false });
  const blockSums = GRADE_BLOCKS.map(emptyBlock);
  let sumTotal = 0, sumFact = 0, sumSick = 0, sumExc = 0, sumUnex = 0;

  const flushBlock = (bi) => {
    if (bi < 0 || !blockSums[bi].any) return;
    const s = blockSums[bi];
    const tot = ws.addRow([GRADE_BLOCKS[bi].label, s.total, s.fact, s.sick, s.exc, s.unex]);
    excelStyleTotalRow(tot, COLS, fillBlock);
    blockSums[bi] = emptyBlock();
  };

  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    const grade = natKey(c.name)[0];
    const bi = gradeBlockIndex(grade);
    const sick = abs.filter((a) => a.class_id === c.id && a.type === 'sick').map((a) => a.student);
    const exc = abs.filter((a) => a.class_id === c.id && a.type === 'excused').map((a) => a.student);
    const unex = abs.filter((a) => a.class_id === c.id && a.type === 'unexcused').map((a) => a.student);
    const done = marked.has(c.id);
    const fact = done ? Math.max(0, c.total - sick.length - exc.length - unex.length) : null;
    sumTotal += c.total;
    if (fact != null) sumFact += fact;
    sumSick += sick.length;
    sumExc += exc.length;
    sumUnex += unex.length;
    if (bi >= 0) {
      blockSums[bi].any = true;
      blockSums[bi].total += c.total;
      if (fact != null) blockSums[bi].fact += fact;
      blockSums[bi].sick += sick.length;
      blockSums[bi].exc += exc.length;
      blockSums[bi].unex += unex.length;
    }
    const row = ws.addRow([
      c.name, c.total, fact,
      sick.join('\n') || null, exc.join('\n') || null, unex.join('\n') || null,
    ]);
    row.font = { name: 'Arial' };
    for (let col = 1; col <= COLS; col++) {
      const cell = row.getCell(col);
      cell.alignment = numCols.has(col)
        ? { horizontal: 'center', vertical: 'middle', wrapText: true }
        : { vertical: 'top', wrapText: true };
      if (done) cell.fill = fillDone;
    }
    excelBorderRow(row, COLS);

    const nextGrade = i + 1 < classes.length ? natKey(classes[i + 1].name)[0] : null;
    const nextBi = nextGrade == null ? -1 : gradeBlockIndex(nextGrade);
    if (bi >= 0 && bi !== nextBi) flushBlock(bi);
  }

  const tot = ws.addRow(['Итого', sumTotal, sumFact, sumSick, sumExc, sumUnex]);
  excelStyleTotalRow(tot, COLS, fillTotal);
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="attendance_${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
app.get('/api/export-meals', adminOnly, async (req, res) => {
  const date = req.query.date;
  if (!validDate(date)) return res.status(400).json({ error: 'Неверная дата' });
  const classes = db.prepare('SELECT * FROM classes').all().sort(natSort);
  const rows = db.prepare('SELECT class_id, student, type FROM meals WHERE date=? ORDER BY student').all(date);
  const marks = db.prepare('SELECT class_id FROM meal_marks WHERE date=?').all(date);
  const markSet = new Set(marks.map((r) => r.class_id));

  const wb = new ExcelJS.Workbook();
  const [y, m, d] = date.split('-');
  const ws = wb.addWorksheet(`${d}.${m}.${y}`);
  const COLS = 8;
  // Класс | Всего | По факту | списки фамилий (в т.ч. платники)
  ws.columns = [
    { width: 8 }, { width: 7 }, { width: 9 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 14 },
  ];
  const numCols = new Set([2, 3]); // Всего, По факту
  const fillDone = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
  const fillTotal = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
  const head = ws.addRow(['', 'Всего', 'По факту', 'Многодетные', 'ОВЗ', 'Детский дом', 'СВО', 'Платники']);
  head.font = { bold: true, name: 'Arial' };
  for (let i = 1; i <= COLS; i++) {
    const cell = head.getCell(i);
    cell.alignment = numCols.has(i)
      ? { horizontal: 'center', vertical: 'middle', wrapText: true }
      : { vertical: 'middle', wrapText: true };
  }
  excelBorderRow(head, COLS);
  let sumEaters = 0, sumFact = 0, sumLf = 0, sumOvz = 0, sumOrph = 0, sumSvo = 0, sumPaid = 0;
  for (const c of classes) {
    const byType = (t) => rows.filter((a) => a.class_id === c.id && a.type === t).map((a) => a.student);
    const lf = byType('large_family'), ovz = byType('ovz'), orph = byType('orphanage'), svo = byType('svo');
    const paid = byType('paid');
    const done = markSet.has(c.id);
    const eaters = c.meal_total || 0;
    const n = lf.length + ovz.length + orph.length + svo.length + paid.length;
    const fact = done ? Math.max(0, eaters - n) : null;
    sumEaters += eaters;
    if (fact != null) sumFact += fact;
    sumLf += lf.length;
    sumOvz += ovz.length;
    sumOrph += orph.length;
    sumSvo += svo.length;
    sumPaid += paid.length;
    const row = ws.addRow([
      c.name,
      eaters,
      fact,
      lf.join('\n') || null, ovz.join('\n') || null, orph.join('\n') || null, svo.join('\n') || null,
      paid.join('\n') || null,
    ]);
    row.font = { name: 'Arial' };
    for (let i = 1; i <= COLS; i++) {
      const cell = row.getCell(i);
      cell.alignment = numCols.has(i)
        ? { horizontal: 'center', vertical: 'middle', wrapText: true }
        : { vertical: 'top', wrapText: true };
      if (done) cell.fill = fillDone;
    }
    excelBorderRow(row, COLS);
  }
  const tot = ws.addRow(['Итого', sumEaters, sumFact, sumLf, sumOvz, sumOrph, sumSvo, sumPaid]);
  tot.font = { bold: true, name: 'Arial' };
  for (let i = 1; i <= COLS; i++) {
    const cell = tot.getCell(i);
    cell.fill = fillTotal;
    cell.alignment = i === 1
      ? { vertical: 'middle' }
      : { horizontal: 'center', vertical: 'middle' };
  }
  excelBorderRow(tot, COLS);
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="meals_${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---------- Статика (PWA) ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.listen(PORT, () => console.log('Посещаемость: http://localhost:' + PORT));
