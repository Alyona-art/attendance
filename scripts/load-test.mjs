#!/usr/bin/env node
/**
 * Нагрузочный тест сценария учителя: login → список классов → экран класса.
 * По умолчанию только чтение. Запись: --write (не гонять на проде с боевыми данными).
 *
 *   BASE_URL=http://localhost:3000 TEACHER_CODE=... node scripts/load-test.mjs -c 30 -d 20
 *   ... node scripts/load-test.mjs -c 10 -d 10 --write
 */

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CODE = process.env.TEACHER_CODE || '';

function parseArgs(argv) {
  let concurrency = 30;
  let durationSec = 20;
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-c' || a === '--concurrency') concurrency = Math.max(1, parseInt(argv[++i], 10) || 30);
    else if (a === '-d' || a === '--duration') durationSec = Math.max(1, parseInt(argv[++i], 10) || 20);
    else if (a === '--write') write = true;
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: BASE_URL=... TEACHER_CODE=... node scripts/load-test.mjs [-c 30] [-d 20] [--write]
  -c, --concurrency   параллельных «учителей» (default 30)
  -d, --duration      длительность в секундах (default 20)
  --write             иногда POST фамилию (только локально / копия БД)`);
      process.exit(0);
    }
  }
  return { concurrency, durationSec, write };
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function summarize(latencies) {
  const s = [...latencies].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] || 0,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] || 0,
  };
}

async function timed(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}

async function login(name) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'teacher', name, secret: CODE }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: ${await r.text()}`);
  return (await r.json()).token;
}

async function worker(id, stopAt, opts, buckets) {
  const name = `Нагрузка${id}`;
  let token;
  try {
    const { ms, result } = await timed(() => login(name));
    token = result;
    buckets.login.push(ms);
    buckets.ok++;
  } catch (e) {
    buckets.errors++;
    buckets.errorSamples.push(String(e.message || e).slice(0, 120));
    return;
  }

  const auth = { Authorization: `Bearer ${token}` };
  const date = today();
  let classId = null;

  while (Date.now() < stopAt) {
    try {
      const list = await timed(async () => {
        const r = await fetch(`${BASE}/api/classes?date=${date}`, { headers: auth });
        if (!r.ok) throw new Error(`classes ${r.status}`);
        return r.json();
      });
      buckets.list.push(list.ms);
      buckets.ok++;
      if (list.result.length && classId == null) classId = list.result[0].id;

      if (classId != null) {
        const one = await timed(async () => {
          const r = await fetch(`${BASE}/api/classes/${classId}?date=${date}`, { headers: auth });
          if (!r.ok) throw new Error(`class ${r.status}`);
          return r.json();
        });
        buckets.classDetail.push(one.ms);
        buckets.ok++;

        if (opts.write && Math.random() < 0.15) {
          const w = await timed(async () => {
            const r = await fetch(`${BASE}/api/classes/${classId}/absences`, {
              method: 'POST',
              headers: { ...auth, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                date,
                type: 'sick',
                student: `Тест${id}-${Date.now() % 100000}`,
              }),
            });
            if (!r.ok) throw new Error(`absence ${r.status}`);
          });
          buckets.write.push(w.ms);
          buckets.ok++;
        }
      }
    } catch (e) {
      buckets.errors++;
      if (buckets.errorSamples.length < 8) buckets.errorSamples.push(String(e.message || e).slice(0, 120));
    }
  }
}

function fmt(ms) {
  return `${ms.toFixed(0)} ms`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!CODE) {
    console.error('Задайте TEACHER_CODE (код учителя из .env)');
    process.exit(1);
  }

  console.log(`BASE_URL=${BASE}`);
  console.log(`concurrency=${opts.concurrency}  duration=${opts.durationSec}s  write=${opts.write}`);
  if (opts.write) console.log('⚠ --write включён: будут POST в БД');

  // быстрая проверка связи
  try {
    await login('ПробаСвязи');
  } catch (e) {
    console.error('Не удалось войти:', e.message || e);
    process.exit(1);
  }

  const buckets = {
    login: [],
    list: [],
    classDetail: [],
    write: [],
    ok: 0,
    errors: 0,
    errorSamples: [],
  };

  const stopAt = Date.now() + opts.durationSec * 1000;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: opts.concurrency }, (_, i) => worker(i + 1, stopAt, opts, buckets)),
  );
  const wallMs = performance.now() - t0;
  const totalReq = buckets.ok + buckets.errors;
  const rps = totalReq / (wallMs / 1000);

  const print = (label, arr) => {
    if (!arr.length) {
      console.log(`  ${label}: (нет данных)`);
      return;
    }
    const s = summarize(arr);
    console.log(
      `  ${label}: n=${s.n}  min=${fmt(s.min)}  p50=${fmt(s.p50)}  p95=${fmt(s.p95)}  p99=${fmt(s.p99)}  max=${fmt(s.max)}`,
    );
  };

  console.log('\n--- Результат ---');
  console.log(`  запросов: ${totalReq}  ok=${buckets.ok}  err=${buckets.errors} (${((buckets.errors / Math.max(1, totalReq)) * 100).toFixed(1)}%)`);
  console.log(`  RPS ≈ ${rps.toFixed(1)}  wall=${(wallMs / 1000).toFixed(1)}s`);
  print('login', buckets.login);
  print('GET /classes', buckets.list);
  print('GET /classes/:id', buckets.classDetail);
  if (opts.write) print('POST absences', buckets.write);
  if (buckets.errorSamples.length) {
    console.log('  примеры ошибок:');
    for (const s of buckets.errorSamples) console.log(`    - ${s}`);
  }
  console.log(`
Ориентир для школы (~30 учителей):
  p95 списка < 500 ms — запас есть
  p95 1–3 s — терпимо на перемене
  таймауты / много err — мало CPU или блокировки SQLite`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
