const $app = document.getElementById('app');
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const fmtDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} в ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const shiftDate = (iso, days) => {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const titleCaseLocal = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  .replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

const S = { token: null, role: null, name: null, date: todayStr(), classes: [], classId: null, mode: 'att' };
try { Object.assign(S, JSON.parse(localStorage.getItem('att') || '{}')); } catch {}
S.date = todayStr();
if (S.mode !== 'meals') S.mode = 'att';
try {
  const savedMode = localStorage.getItem('attMode');
  if (savedMode === 'meals' || savedMode === 'att') S.mode = savedMode;
} catch {}

/** Сайт сейчас недоступен с этого устройства (сеть / VPS). */
let siteDown = false;
/** Последние данные открытого класса (для офлайн-правок и текста). */
let lastClassData = null;

function setMode(mode) {
  S.mode = mode === 'meals' ? 'meals' : 'att';
  try { localStorage.setItem('attMode', S.mode); } catch {}
}

function modeBar() {
  return `<div class="seg modebar" role="tablist" aria-label="Раздел">
    <button type="button" data-mode="att" class="${S.mode === 'att' ? 'on' : ''}">Посещаемость</button>
    <button type="button" data-mode="meals" class="${S.mode === 'meals' ? 'on' : ''}">Питание</button>
  </div>`;
}

function bindModeBar(onChange) {
  $app.querySelectorAll('.modebar button').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.mode === S.mode) return;
      setMode(b.dataset.mode);
      onChange();
    };
  });
}

const MEAL_CATS = [
  { type: 'large_family', title: 'Многодетные', cls: 'meal-lf' },
  { type: 'ovz', title: 'ОВЗ', cls: 'meal-ovz' },
  { type: 'orphanage', title: 'Детский дом', cls: 'meal-orph' },
  { type: 'svo', title: 'СВО', cls: 'meal-svo' },
  { type: 'paid', title: 'Платники', cls: 'meal-paid' },
];
const ATT_LABELS = { sick: 'По болезни', excused: 'Уважительная причина', unexcused: 'Без причины' };

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
}

const CLIENT_LOG_KEY = 'attClientErr';
const DRAFT_KEY = 'attDrafts';

function readClientLogQueue() {
  try { return JSON.parse(localStorage.getItem(CLIENT_LOG_KEY) || '[]'); } catch { return []; }
}
function writeClientLogQueue(arr) {
  try { localStorage.setItem(CLIENT_LOG_KEY, JSON.stringify(arr.slice(-40))); } catch {}
}
function enqueueClientError(url, msg) {
  const q = readClientLogQueue();
  q.push({
    when: new Date().toISOString(),
    url: String(url || '').slice(0, 200),
    msg: String(msg || 'network').slice(0, 200),
    name: S.name || '',
    role: S.role || '',
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  });
  writeClientLogQueue(q);
}
async function flushClientErrors() {
  const q = readClientLogQueue();
  if (!q.length) return;
  try {
    const r = await fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: q }),
      keepalive: true,
    });
    if (r.ok) writeClientLogQueue([]);
  } catch { /* останется в очереди */ }
}

function draftStoreKey(classId, date, kind) {
  return `${S.name || ''}|${kind}|${date}|${classId}`;
}
function readDraftMap() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}
function writeDraftMap(map) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(map)); } catch {}
}
function getDraft(classId, date, kind) {
  return readDraftMap()[draftStoreKey(classId, date, kind)] || null;
}
function saveDraft(draft) {
  const map = readDraftMap();
  map[draftStoreKey(draft.classId, draft.date, draft.kind)] = draft;
  writeDraftMap(map);
}
function removeDraft(classId, date, kind) {
  const map = readDraftMap();
  delete map[draftStoreKey(classId, date, kind)];
  writeDraftMap(map);
}
function pendingDraftCount() {
  if (!S.name) return 0;
  const prefix = `${S.name}|`;
  return Object.keys(readDraftMap()).filter((k) => k.startsWith(prefix)).length;
}

function emptyMealBuckets() {
  return { large_family: [], ovz: [], orphanage: [], svo: [], paid: [] };
}

function draftFromClassData(d, kind) {
  const classId = d.cls.id;
  const date = S.date;
  if (kind === 'meals') {
    const meals = emptyMealBuckets();
    for (const cat of MEAL_CATS) {
      meals[cat.type] = (d.meals?.[cat.type] || []).map((x) => x.student);
    }
    return {
      owner: S.name,
      classId,
      className: d.cls.name,
      date,
      kind: 'meals',
      meals,
      baseMarkedAt: d.meal_marked_at || null,
      updatedAt: new Date().toISOString(),
      pending: true,
    };
  }
  return {
    owner: S.name,
    classId,
    className: d.cls.name,
    date,
    kind: 'att',
    sick: (d.sick || []).map((x) => x.student),
    excused: (d.excused || []).map((x) => x.student),
    unexcused: (d.unexcused || []).map((x) => x.student),
    baseMarkedAt: d.marked_at || null,
    updatedAt: new Date().toISOString(),
    pending: true,
  };
}

function ensureDraftFrom(d) {
  const kind = S.mode === 'meals' ? 'meals' : 'att';
  let draft = getDraft(d.cls.id, S.date, kind);
  if (!draft) {
    draft = draftFromClassData(d, kind);
    saveDraft(draft);
  }
  return draft;
}

function applyDraftToClassData(d, draft) {
  const out = {
    ...d,
    _localOnly: true,
    suggestions: d.suggestions || [],
    meal_suggestions: d.meal_suggestions || [],
  };
  if (draft.kind === 'meals') {
    const meals = emptyMealBuckets();
    for (const cat of MEAL_CATS) {
      meals[cat.type] = (draft.meals?.[cat.type] || []).map((student, i) => ({
        id: `local-${cat.type}-${i}`,
        student,
      }));
    }
    out.meals = meals;
    out.meal_marked_by = S.name;
    out.meal_marked_at = draft.updatedAt;
  } else {
    for (const type of ['sick', 'excused', 'unexcused']) {
      out[type] = (draft[type] || []).map((student, i) => ({ id: `local-${type}-${i}`, student }));
    }
    out.marked_by = S.name;
    out.marked_at = draft.updatedAt;
  }
  return out;
}

function draftStudentsPayload(draft) {
  if (draft.kind === 'meals') {
    const out = [];
    for (const cat of MEAL_CATS) {
      for (const student of draft.meals?.[cat.type] || []) out.push({ type: cat.type, student });
    }
    return out;
  }
  const out = [];
  for (const type of ['sick', 'excused', 'unexcused']) {
    for (const student of draft[type] || []) out.push({ type, student });
  }
  return out;
}

function moveStudentInDraft(draft, student, type) {
  const name = titleCaseLocal(student);
  if (!name) return draft;
  if (draft.kind === 'meals') {
    for (const cat of MEAL_CATS) {
      draft.meals[cat.type] = (draft.meals[cat.type] || []).filter((s) => s.toLowerCase() !== name.toLowerCase());
    }
    if (!draft.meals[type]) draft.meals[type] = [];
    draft.meals[type].push(name);
  } else {
    for (const t of ['sick', 'excused', 'unexcused']) {
      draft[t] = (draft[t] || []).filter((s) => s.toLowerCase() !== name.toLowerCase());
    }
    if (!draft[type]) draft[type] = [];
    draft[type].push(name);
  }
  draft.updatedAt = new Date().toISOString();
  draft.pending = true;
  saveDraft(draft);
  return draft;
}

function removeStudentFromDraft(draft, student) {
  const name = String(student || '');
  if (draft.kind === 'meals') {
    for (const cat of MEAL_CATS) {
      draft.meals[cat.type] = (draft.meals[cat.type] || []).filter((s) => s !== name);
    }
  } else {
    for (const t of ['sick', 'excused', 'unexcused']) {
      draft[t] = (draft[t] || []).filter((s) => s !== name);
    }
  }
  draft.updatedAt = new Date().toISOString();
  draft.pending = true;
  saveDraft(draft);
  return draft;
}

function markDraftEmpty(draft) {
  if (draft.kind === 'meals') draft.meals = emptyMealBuckets();
  else {
    draft.sick = [];
    draft.excused = [];
    draft.unexcused = [];
  }
  draft.updatedAt = new Date().toISOString();
  draft.pending = true;
  saveDraft(draft);
  return draft;
}

function statusBannerHtml() {
  const n = pendingDraftCount();
  if (siteDown) {
    return `<div class="banner warn" role="status">
      <strong>Сейчас сайт недоступен.</strong>
      Список сохраняется на этом устройстве.
      Когда сайт заработает — откройте приложение ещё раз, список уйдёт сам.
      Если заполняли с другого компьютера или телефона — там свой список, он сам не подтянется сюда.
      ${n ? `<span class="banner-n">Не на сайте: ${n}</span>` : ''}
    </div>`;
  }
  if (n) {
    return `<div class="banner info" role="status">
      На этом устройстве есть список, который ещё не на сайте (${n}). Сейчас отправим…
    </div>`;
  }
  return '';
}

function lastUpdateSummaryHtml(classes, mealsMode) {
  if (S.role !== 'admin' || !classes.length) return '';
  let latest = null;
  for (const c of classes) {
    const at = mealsMode ? c.meal_marked_at : c.marked_at;
    if (at && (!latest || at > latest)) latest = at;
  }
  const marked = classes.filter((c) => mealsMode ? c.meal_marked_by : c.marked_by).length;
  const when = latest ? fmtDateTime(latest) : null;
  return `<p class="mu summary">Заполнено классов: ${marked} из ${classes.length}${
    when ? `. Актуальные данные на сайте на ${esc(when)}` : ''
  }</p>
  <p class="mu summary-hint">Если кто-то заполнял без связи, его список мог ещё не попасть на сайт.</p>`;
}

function buildTextExport(d) {
  const mealsMode = S.mode === 'meals';
  const lines = [
    mealsMode ? 'Питание' : 'Посещаемость',
    `${fmtDate(S.date)}, ${d.cls.name}`,
    S.name ? `Заполнил(а): ${S.name}` : '',
    d._localOnly ? 'Пока только на этом устройстве (ещё не на сайте)' : '',
    '',
  ].filter((x, i, a) => x || a[i - 1] !== '');
  if (mealsMode) {
    for (const cat of MEAL_CATS) {
      const names = (d.meals?.[cat.type] || []).map((x) => x.student);
      lines.push(`${cat.title}: ${names.length ? names.join(', ') : '—'}`);
    }
  } else {
    for (const type of ['sick', 'excused', 'unexcused']) {
      const names = (d[type] || []).map((x) => x.student);
      lines.push(`${ATT_LABELS[type]}: ${names.length ? names.join(', ') : '—'}`);
    }
  }
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Список скопирован — можно вставить в сообщение');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Список скопирован — можно вставить в сообщение');
    } catch {
      toast('Не удалось скопировать');
    }
    ta.remove();
  }
}

async function api(url, opt = {}) {
  let r;
  try {
    r = await fetch(url, {
      method: opt.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
  } catch (e) {
    if (!String(url).includes('/client-log')) {
      siteDown = true;
      enqueueClientError(url, e && e.message ? e.message : 'Failed to fetch');
      flushClientErrors();
    }
    const err = new Error('Сейчас сайт недоступен');
    err.siteDown = true;
    throw err;
  }
  if (r.status === 401 && S.token && !url.includes('/login')) { logout(); throw new Error('Нужно войти заново'); }
  if (!r.ok) { let m = 'Ошибка'; try { m = (await r.json()).error; } catch {} throw new Error(m); }
  siteDown = false;
  flushClientErrors();
  return r;
}
const jget = async (u, o) => (await api(u, o)).json();
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

async function flushDrafts() {
  if (!S.token || !pendingDraftCount()) return { synced: 0, skipped: 0 };
  let synced = 0;
  let skipped = 0;
  const keys = Object.keys(readDraftMap()).filter((k) => k.startsWith(`${S.name}|`));
  for (const key of keys) {
    const draft = readDraftMap()[key];
    if (!draft) continue;
    try {
      const d = await jget(`/api/classes/${draft.classId}?date=${draft.date}`);
      const serverAt = draft.kind === 'meals' ? d.meal_marked_at : d.marked_at;
      if (serverAt && draft.baseMarkedAt && serverAt > draft.baseMarkedAt) {
        const ok = await confirmDialog({
          title: 'На сайте уже другой список',
          text: `Класс ${draft.className}: на сайте список обновляли позже — возможно, с другого устройства. Заменить тем, что сохранено здесь?`,
          okLabel: 'Заменить',
          danger: true,
        });
        if (!ok) {
          removeDraft(draft.classId, draft.date, draft.kind);
          skipped++;
          continue;
        }
      }
      await api(`/api/classes/${draft.classId}/sync-day`, {
        method: 'POST',
        body: { date: draft.date, kind: draft.kind, students: draftStudentsPayload(draft) },
      });
      removeDraft(draft.classId, draft.date, draft.kind);
      synced++;
    } catch (e) {
      if (e.siteDown) return { synced, skipped, down: true };
      // класс удалён и т.п. — убираем черновик
      removeDraft(draft.classId, draft.date, draft.kind);
      skipped++;
    }
  }
  return { synced, skipped };
}

async function trySyncPending(opts = {}) {
  const { quiet } = opts;
  if (!S.token) return;
  const before = pendingDraftCount();
  if (!before && !siteDown) {
    flushClientErrors();
    return;
  }
  // проверка связи
  try {
    await api('/api/classes?date=' + S.date);
    siteDown = false;
  } catch (e) {
    if (e.siteDown) {
      if (!quiet && $app.querySelector('.banner')) { /* уже показано */ }
      return;
    }
  }
  const r = await flushDrafts();
  if (r.synced && !quiet) toast(r.synced === 1 ? 'Список на сайте' : `На сайте: ${r.synced} списк.`);
  flushClientErrors();
}

function logout() {
  S.token = S.role = S.name = null; localStorage.removeItem('att'); renderLogin();
}

// Избранные классы — в localStorage на этом устройстве, привязаны к ФИО
function readFavMap() {
  try { return JSON.parse(localStorage.getItem('attFavs') || '{}'); } catch { return {}; }
}
function getFavIds() {
  if (!S.name) return new Set();
  return new Set(readFavMap()[S.name] || []);
}
function isFav(id) { return getFavIds().has(id); }
function toggleFav(id) {
  const map = readFavMap();
  const set = new Set(map[S.name] || []);
  if (set.has(id)) set.delete(id); else set.add(id);
  map[S.name] = [...set];
  localStorage.setItem('attFavs', JSON.stringify(map));
}
function sortedClasses(list) {
  const favs = getFavIds();
  if (!favs.size) return list;
  const fav = list.filter((c) => favs.has(c.id)).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  const rest = list.filter((c) => !favs.has(c.id));
  return [...fav, ...rest];
}

const ICO_WAIT = `<svg class="st-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICO_OK = `<svg class="st-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICO_STAR = (on) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.8 6.7 19.6l1-5.8-4.2-4.1 5.9-.9L12 3.5z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
const ICO_BACK = `<svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H6m0 0l5-5m-5 5l5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICO_CHEV_L = `<svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5l-6 7 6 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICO_CHEV_R = `<svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5l6 7-6 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICO_EMPTY = `<svg class="empty-ico" viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="14" width="44" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="3"/><path d="M10 24h44M22 14v-4h20v4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M26 36h12M26 44h8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
const ICO_EDIT = `<svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L18 9.5 14.5 6 4 16.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 7.5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICO_TRASH = `<svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const ICO_LOGOUT = `<svg class="btn-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7V5a2 2 0 0 1 2-2h7v18h-7a2 2 0 0 1-2-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 12H3m0 0l3-3m-3 3l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function dateBar(idPrefix = 'dt') {
  return `<div class="datebar">
    <button type="button" class="sec ico" id="${idPrefix}-prev" aria-label="Предыдущий день">${ICO_CHEV_L}</button>
    <button type="button" class="sec datebtn" id="${idPrefix}-pick">${esc(fmtDate(S.date))}</button>
    <button type="button" class="sec ico" id="${idPrefix}-next" aria-label="Следующий день">${ICO_CHEV_R}</button>
    <input type="date" id="${idPrefix}-hid" value="${S.date}" class="sr-only" tabindex="-1">
  </div>`;
}

function bindDateBar(idPrefix, onChange) {
  const hid = document.getElementById(idPrefix + '-hid');
  const pick = document.getElementById(idPrefix + '-pick');
  document.getElementById(idPrefix + '-prev').onclick = () => { S.date = shiftDate(S.date, -1); onChange(); };
  document.getElementById(idPrefix + '-next').onclick = () => { S.date = shiftDate(S.date, 1); onChange(); };
  pick.onclick = () => { try { hid.showPicker(); } catch { hid.click(); } };
  hid.onchange = () => { S.date = hid.value || todayStr(); onChange(); };
}

function confirmDialog({ title, text, okLabel = 'Удалить', danger = true }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm-dlg';
    dlg.innerHTML = `<form method="dialog">
      <h3>${esc(title)}</h3>
      ${text ? `<p class="dlg-text">${esc(text)}</p>` : ''}
      <div class="stack">
        <button value="ok" class="${danger ? 'danger' : ''}">${esc(okLabel)}</button>
        <button value="cancel" class="sec">Отмена</button>
      </div>
    </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(ok);
    });
    dlg.showModal();
  });
}

function editClassDialog({ name = '', total = 0, meal_total = 0 }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm-dlg';
    dlg.innerHTML = `<form id="edit-f">
      <h3>Редактировать класс</h3>
      <label class="lbl" for="edit-name">Класс</label>
      <input id="edit-name" value="${esc(name)}" placeholder="7Б" required>
      <label class="lbl" for="edit-total">Всего учеников</label>
      <input id="edit-total" type="number" min="1" inputmode="numeric" value="${esc(String(total))}" required>
      <label class="lbl" for="edit-meal">Питающихся</label>
      <input id="edit-meal" type="number" min="0" inputmode="numeric" value="${esc(String(meal_total))}" required>
      <div class="stack">
        <button type="submit">Сохранить</button>
        <button type="button" class="sec" id="edit-cancel">Отмена</button>
      </div>
    </form>`;
    document.body.appendChild(dlg);
    const nameIn = dlg.querySelector('#edit-name');
    const totIn = dlg.querySelector('#edit-total');
    const mealIn = dlg.querySelector('#edit-meal');
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('#edit-cancel').onclick = () => done(null);
    dlg.querySelector('#edit-f').onsubmit = (e) => {
      e.preventDefault();
      const n = nameIn.value.trim();
      const t = parseInt(totIn.value, 10);
      const m = parseInt(mealIn.value, 10);
      if (!n) { nameIn.focus(); return; }
      if (!Number.isFinite(t) || t < 1) { totIn.focus(); return; }
      if (!Number.isFinite(m) || m < 0) { mealIn.focus(); return; }
      done({ name: n, total: t, meal_total: m });
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dlg.showModal();
    nameIn.focus();
    nameIn.select();
  });
}

// ---------- Вход ----------
function renderLogin(role = 'teacher', opts = {}) {
  const { err = '', name = '', secret = '' } = opts;
  $app.innerHTML = `<div class="wrap login">
    <h1>Посещаемость</h1>
    <div class="seg"><button type="button" data-r="teacher" class="${role === 'teacher' ? 'on' : ''}">Учитель</button><button type="button" data-r="admin" class="${role === 'admin' ? 'on' : ''}">Завуч</button></div>
    <form id="lf">
      ${role === 'teacher' ? `<label class="lbl" for="nm">ФИО</label><input id="nm" placeholder="Иванова Анна Сергеевна" autocomplete="name" value="${esc(name)}">` : ''}
      <label class="lbl" for="sc">${role === 'teacher' ? 'Код доступа' : 'Пароль'}</label>
      <input id="sc" type="text" class="${err ? 'invalid' : ''}" placeholder="${role === 'teacher' ? 'Введите код' : 'Введите пароль'}" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(secret)}">
      <button style="width:100%">Войти</button>
      ${err ? `<p class="err" role="alert"><span class="err-ico" aria-hidden="true">!</span><span>${esc(err)}</span></p>` : ''}
    </form></div>`;
  $app.querySelectorAll('.seg button').forEach((b) => b.onclick = () => renderLogin(b.dataset.r));
  const sc = document.getElementById('sc');
  sc.oninput = () => sc.classList.remove('invalid');
  document.getElementById('lf').onsubmit = async (e) => {
    e.preventDefault();
    const nameVal = document.getElementById('nm')?.value || '';
    const secretVal = sc.value;
    try {
      const d = await jget('/api/login', { method: 'POST', body: { role, name: nameVal, secret: secretVal } });
      Object.assign(S, { token: d.token, role: d.role, name: d.name });
      localStorage.setItem('att', JSON.stringify({ token: S.token, role: S.role, name: S.name }));
      showList();
    } catch (ex) {
      renderLogin(role, { err: String(ex.message || 'Ошибка').toUpperCase(), name: nameVal, secret: secretVal });
      document.getElementById('sc').focus();
    }
  };
}

// ---------- Список классов ----------
const showList = guard(async () => {
  S.classId = null;
  lastClassData = null;
  await trySyncPending({ quiet: true });
  try {
    S.classes = await jget('/api/classes?date=' + S.date);
  } catch (e) {
    if (e.siteDown && S.classes?.length) {
      toast('Сейчас сайт недоступен. Показан последний загруженный список классов.');
    } else {
      throw e;
    }
  }
  renderList();
});

function classHasLocalDraft(c) {
  const kind = S.mode === 'meals' ? 'meals' : 'att';
  return !!getDraft(c.id, S.date, kind);
}

function classCardHtml(c) {
  const fav = isFav(c.id) ? ' fav' : '';
  const local = classHasLocalDraft(c);
  const countLabel = S.mode === 'meals'
    ? `${c.meal_total ?? 0} пит.`
    : `${c.total} уч.`;
  const left = `<span class="cls-main"><b>${esc(c.name)}</b><small>${countLabel}${local ? ' · на устройстве' : ''}</small></span>`;
  if (S.mode === 'meals') {
    if (!c.meal_marked_by && !local) {
      return `<button type="button" class="cls todo${fav}" data-id="${c.id}" aria-label="${esc(c.name)}, не заполнен">${left}<span class="cls-side st" title="Не заполнен">${ICO_WAIT}</span></button>`;
    }
    const paid = c.meal_paid || 0;
    const lines = [];
    if (c.meal_lf) lines.push(`М ${c.meal_lf}`);
    if (c.meal_ovz) lines.push(`ОВЗ ${c.meal_ovz}`);
    if (c.meal_orph) lines.push(`ДД ${c.meal_orph}`);
    if (c.meal_svo) lines.push(`СВО ${c.meal_svo}`);
    if (paid) lines.push(`Пл ${paid}`);
    if (local) lines.push('локально');
    if (!lines.length) {
      return `<button type="button" class="cls done${fav}" data-id="${c.id}" aria-label="${esc(c.name)}, питаются все">${left}<span class="cls-side st" title="Питаются все">${ICO_OK}</span></button>`;
    }
    return `<button type="button" class="cls done${fav}${local ? ' local' : ''}" data-id="${c.id}">${left}<span class="cls-side counts">${lines.map((t) => `<span>${t}</span>`).join('')}</span></button>`;
  }
  if (!c.marked_by && !local) {
    return `<button type="button" class="cls todo${fav}" data-id="${c.id}" aria-label="${esc(c.name)}, не заполнен">${left}<span class="cls-side st" title="Не заполнен">${ICO_WAIT}</span></button>`;
  }
  if (!local && (c.sick || 0) + (c.excused || 0) + (c.unexcused || 0) === 0) {
    return `<button type="button" class="cls done${fav}" data-id="${c.id}" aria-label="${esc(c.name)}, все на месте">${left}<span class="cls-side st" title="Все на месте">${ICO_OK}</span></button>`;
  }
  const lines = [];
  if (c.sick) lines.push(`Б ${c.sick}`);
  if (c.excused) lines.push(`У ${c.excused}`);
  if (c.unexcused) lines.push(`Бп ${c.unexcused}`);
  if (local) lines.push('локально');
  return `<button type="button" class="cls done${fav}${local ? ' local' : ''}" data-id="${c.id}">${left}<span class="cls-side counts">${lines.map((t) => `<span>${t}</span>`).join('')}</span></button>`;
}

function renderList() {
  const isAdmin = S.role === 'admin';
  const mealsMode = S.mode === 'meals';
  const empty = !S.classes.length;
  $app.innerHTML = `<div class="wrap">
    <header class="top">${modeBar()}<button type="button" class="sec ico" id="lo" aria-label="Выйти">${ICO_LOGOUT}</button></header>
    ${statusBannerHtml()}
    <p class="mu user-line">${esc(S.name)}</p>
    ${dateBar('ls')}
    ${lastUpdateSummaryHtml(S.classes, mealsMode)}
    ${isAdmin ? `<div class="admin-actions">
      <button type="button" id="ex" style="width:100%">${mealsMode ? 'Выгрузить питание' : 'Выгрузить посещаемость'}</button>
      <button type="button" class="sec" id="addc" style="width:100%">+ Добавить класс</button>
    </div>` : ''}
    ${empty
      ? `<div class="empty-state">${ICO_EMPTY}<p>Классов пока нет. Добавьте первый класс, чтобы начать работу.</p></div>`
      : `<div class="grid">${sortedClasses(S.classes).map(classCardHtml).join('')}</div>`}
    ${isAdmin ? `<dialog id="dlg"><form id="df"><h3 style="margin-top:0">Новый класс</h3>
      <label class="lbl" for="dn">Класс</label><input id="dn" placeholder="7Б">
      <label class="lbl" for="dtt">Всего учеников</label><input id="dtt" type="number" min="1" inputmode="numeric" placeholder="22">
      <label class="lbl" for="dmt">Питающихся</label><input id="dmt" type="number" min="0" inputmode="numeric" placeholder="18">
      <div class="row"><button type="button" class="sec" id="dc">Отмена</button><button id="dadd" disabled>Добавить</button></div></form></dialog>` : ''}
  </div>`;

  document.getElementById('lo').onclick = logout;
  bindModeBar(showList);
  bindDateBar('ls', showList);

  if (isAdmin) {
    const dlg = document.getElementById('dlg');
    const dn = document.getElementById('dn');
    const dtt = document.getElementById('dtt');
    const dmt = document.getElementById('dmt');
    const dadd = document.getElementById('dadd');
    const syncAdd = () => {
      const ok = dn.value.trim()
        && dtt.value.trim() && parseInt(dtt.value, 10) >= 1
        && dmt.value.trim() !== '' && parseInt(dmt.value, 10) >= 0;
      dadd.disabled = !ok;
    };
    dn.oninput = dtt.oninput = dmt.oninput = syncAdd;
    document.getElementById('addc').onclick = () => {
      dlg.showModal(); dn.value = ''; dtt.value = ''; dmt.value = ''; syncAdd(); dn.focus();
    };
    document.getElementById('dc').onclick = () => dlg.close();
    document.getElementById('df').onsubmit = guard(async (e) => {
      e.preventDefault();
      if (dadd.disabled) return;
      await jget('/api/classes', {
        method: 'POST',
        body: { name: dn.value.trim(), total: dtt.value.trim(), meal_total: dmt.value.trim() },
      });
      dlg.close();
      showList();
    });
    document.getElementById('ex').onclick = guard(async () => {
      const url = mealsMode ? '/api/export-meals?date=' + S.date : '/api/export?date=' + S.date;
      let latest = null;
      for (const c of S.classes) {
        const at = mealsMode ? c.meal_marked_at : c.marked_at;
        if (at && (!latest || at > latest)) latest = at;
      }
      const stamp = latest ? `_${fmtDateTime(latest).replace(/\s+в\s+/, '_').replace(':', '-')}` : '';
      const name = mealsMode ? `Питание_${S.date}${stamp}.xlsx` : `Посещаемость_${S.date}${stamp}.xlsx`;
      const blob = await (await api(url)).blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }
  $app.querySelectorAll('.cls').forEach((b) => b.onclick = () => openClass(+b.dataset.id));
}

// ---------- Класс ----------
function openClass(id) { history.pushState({ c: id }, ''); S.classId = id; guard(loadClass)(); }
window.addEventListener('popstate', () => { if (S.token) showList(); });

async function loadClass() {
  const kind = S.mode === 'meals' ? 'meals' : 'att';
  const local = getDraft(S.classId, S.date, kind);
  try {
    const d = await jget(`/api/classes/${S.classId}?date=${S.date}`);
    if (local?.pending) {
      renderClass(applyDraftToClassData(d, local));
    } else {
      lastClassData = d;
      renderClass(d);
    }
  } catch (e) {
    if (e.siteDown && local) {
      const base = lastClassData && lastClassData.cls?.id === S.classId
        ? lastClassData
        : { cls: { id: S.classId, name: local.className, total: '?', meal_total: '?' }, sick: [], excused: [], unexcused: [], meals: emptyMealBuckets(), suggestions: [], meal_suggestions: [] };
      renderClass(applyDraftToClassData(base, local));
      return;
    }
    if (e.siteDown && lastClassData && lastClassData.cls?.id === S.classId) {
      renderClass({ ...lastClassData, _localOnly: true });
      return;
    }
    throw e;
  }
}

function renderClass(d) {
  lastClassData = d;
  const isAdmin = S.role === 'admin';
  const mealsMode = S.mode === 'meals';
  const kind = mealsMode ? 'meals' : 'att';
  const localDraft = getDraft(d.cls.id, S.date, kind);
  const marked = mealsMode ? !!d.meal_marked_by : !!d.marked_by;
  const meals = d.meals || emptyMealBuckets();
  const updatedAt = mealsMode ? d.meal_marked_at : d.marked_at;

  const list = (type, title, cls, items, listKind) => {
    const chips = items.map((a) =>
      `<span class="chip">${esc(a.student)}<button type="button" data-del="${esc(String(a.id))}" data-student="${esc(a.student)}" data-kind="${listKind}" aria-label="Удалить">×</button></span>`
    ).join('') || '<span class="empty">Никого</span>';
    return `<div class="card ${cls}">
      <div class="sec-h"><h2>${title}</h2><span class="mu">${items.length}</span></div>
      <form class="add" data-type="${type}" data-kind="${listKind}"><input list="dl" placeholder="Фамилия" autocomplete="off" enterkeyhint="done"><button type="submit">Добавить</button></form>
      <div class="chips">${chips}</div></div>`;
  };

  const body = !mealsMode
    ? `${list('sick', 'По болезни', 'sick', d.sick, 'att')}
      ${list('excused', 'Уважительная причина', 'exc', d.excused, 'att')}
      ${list('unexcused', 'Без причины', 'unex', d.unexcused || [], 'att')}
      <datalist id="dl">${(d.suggestions || []).map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      ${!marked ? '<button type="button" id="none" style="width:100%">Отсутствующих нет</button>' : ''}
      ${marked ? '<button type="button" class="sec linkish" id="clr">Очистить текущий день</button>' : ''}`
    : `${MEAL_CATS.map((c) => list(c.type, c.title, c.cls, meals[c.type] || [], 'meals')).join('')}
      <datalist id="dl">${(d.meal_suggestions || []).map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      ${!marked ? '<button type="button" id="none" style="width:100%">Питаются все</button>' : ''}
      ${marked ? '<button type="button" class="sec linkish" id="clr">Очистить питание за день</button>' : ''}`;

  const fav = isFav(d.cls.id);
  const localNote = localDraft?.pending
    ? `<p class="mu local-note">Список на этом устройстве, на сайте его ещё нет. Можно скопировать текстом и отправить завучу.</p>`
    : '';
  const whenNote = updatedAt && S.role === 'admin' && !localDraft?.pending
    ? `<p class="mu local-note">На сайте обновлено: ${esc(fmtDateTime(updatedAt))}</p>`
    : '';

  $app.innerHTML = `<div class="wrap">
    <header class="top">
      <button type="button" class="sec ico" id="bk" aria-label="Назад">${ICO_BACK}</button>
      ${modeBar()}
      <button type="button" class="sec ico fav-btn${fav ? ' on' : ''}" id="fav" aria-label="${fav ? 'Убрать из избранного' : 'В избранное'}" aria-pressed="${fav}">${ICO_STAR(fav)}</button>
    </header>
    ${statusBannerHtml()}
    <div class="class-title-row">
      <h1 class="class-title">${esc(d.cls.name)}</h1>
      <span class="mu class-count">${mealsMode
        ? `${d.cls.meal_total ?? 0} питающихся`
        : `${d.cls.total} учеников`}</span>
      ${isAdmin ? `<button type="button" class="sec ico" id="ren" aria-label="Редактировать">${ICO_EDIT}</button>
      <button type="button" class="sec ico danger-ico" id="del" aria-label="Удалить класс">${ICO_TRASH}</button>` : ''}
    </div>
    ${dateBar('cl')}
    ${localNote}${whenNote}
    <button type="button" class="sec" id="copy-list" style="width:100%;margin-bottom:12px">Скопировать список текстом</button>
    ${body}
  </div>`;

  const back = () => (history.state?.c ? history.back() : showList());
  document.getElementById('bk').onclick = back;
  bindModeBar(() => guard(loadClass)());
  bindDateBar('cl', () => guard(loadClass)());
  document.getElementById('copy-list').onclick = () => copyText(buildTextExport(d));

  const favBtn = document.getElementById('fav');
  if (favBtn) favBtn.onclick = () => {
    toggleFav(d.cls.id);
    const on = isFav(d.cls.id);
    favBtn.classList.toggle('on', on);
    favBtn.setAttribute('aria-pressed', on);
    favBtn.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
    favBtn.innerHTML = ICO_STAR(on);
  };

  const rerenderFromDraft = (draft) => {
    renderClass(applyDraftToClassData(d._localOnly ? { ...d, cls: d.cls } : { ...d, _server: true }, draft));
  };

  $app.querySelectorAll('form.add').forEach((f) => {
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      const input = f.querySelector('input');
      const btn = f.querySelector('button');
      const v = input.value.trim(); if (!v) return;
      const listKind = f.dataset.kind;
      const url = listKind === 'meals'
        ? `/api/classes/${S.classId}/meals`
        : `/api/classes/${S.classId}/absences`;
      btn.disabled = true;
      btn.classList.add('loading');
      btn.textContent = '…';
      try {
        // Пока есть черновик на устройстве — копим здесь, чтобы не смешать с частичной записью на сайте
        if (siteDown || getDraft(S.classId, S.date, listKind === 'meals' ? 'meals' : 'att')?.pending) {
          throw Object.assign(new Error('Сейчас сайт недоступен'), { siteDown: true });
        }
        await api(url, { method: 'POST', body: { date: S.date, type: f.dataset.type, student: v } });
        await loadClass();
        const again = document.querySelector(`form.add[data-type="${f.dataset.type}"][data-kind="${listKind}"] input`);
        if (again) again.focus();
      } catch (err) {
        if (err.siteDown) {
          const base = lastClassData && lastClassData.cls?.id === d.cls.id ? lastClassData : d;
          const draft = ensureDraftFrom({ ...base, _localOnly: false });
          moveStudentInDraft(draft, v, f.dataset.type);
          toast('Сохранено на этом устройстве');
          renderClass(applyDraftToClassData(base, draft));
          return;
        }
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.textContent = 'Добавить';
        throw err;
      }
    });
  });

  $app.querySelectorAll('[data-del]').forEach((b) => b.onclick = guard(async () => {
    const id = b.dataset.del;
    const student = b.dataset.student;
    const listKind = b.dataset.kind;
    if (String(id).startsWith('local-') || siteDown || getDraft(S.classId, S.date, listKind === 'meals' ? 'meals' : 'att')?.pending) {
      const draft = ensureDraftFrom(d);
      removeStudentFromDraft(draft, student);
      toast('Сохранено на этом устройстве');
      rerenderFromDraft(draft);
      return;
    }
    const url = listKind === 'meals' ? '/api/meals/' + id : '/api/absences/' + id;
    try {
      await api(url, { method: 'DELETE' });
      await loadClass();
    } catch (err) {
      if (err.siteDown) {
        const draft = ensureDraftFrom(d);
        removeStudentFromDraft(draft, student);
        toast('Сохранено на этом устройстве');
        rerenderFromDraft(draft);
        return;
      }
      throw err;
    }
  }));

  const none = document.getElementById('none');
  if (none) none.onclick = guard(async () => {
    const url = mealsMode
      ? `/api/classes/${S.classId}/meal-mark`
      : `/api/classes/${S.classId}/mark`;
    try {
      if (siteDown) throw Object.assign(new Error('Сейчас сайт недоступен'), { siteDown: true });
      await api(url, { method: 'POST', body: { date: S.date } });
      toast('Сохранено');
      await loadClass();
    } catch (err) {
      if (err.siteDown) {
        const draft = ensureDraftFrom(d);
        markDraftEmpty(draft);
        toast('Сохранено на этом устройстве');
        rerenderFromDraft(draft);
        return;
      }
      throw err;
    }
  });

  const clr = document.getElementById('clr');
  if (clr) clr.onclick = guard(async () => {
    const ok = await confirmDialog({
      title: mealsMode ? 'Очистить питание?' : 'Очистить день?',
      text: mealsMode ? 'Списки питания за этот день будут сброшены.' : 'Списки за этот день будут сброшены.',
      okLabel: 'Очистить',
      danger: true,
    });
    if (!ok) return;
    const url = mealsMode
      ? `/api/classes/${S.classId}/meal-clear`
      : `/api/classes/${S.classId}/clear`;
    try {
      if (siteDown || localDraft?.pending) throw Object.assign(new Error('Сейчас сайт недоступен'), { siteDown: true });
      await api(url, { method: 'POST', body: { date: S.date } });
      removeDraft(S.classId, S.date, kind);
      toast('Сохранено');
      await loadClass();
    } catch (err) {
      if (err.siteDown) {
        const draft = ensureDraftFrom(d);
        markDraftEmpty(draft);
        toast('Сохранено на этом устройстве');
        rerenderFromDraft(draft);
        return;
      }
      throw err;
    }
  });

  if (isAdmin) {
    document.getElementById('ren').onclick = guard(async () => {
      const v = await editClassDialog({
        name: d.cls.name,
        total: d.cls.total,
        meal_total: d.cls.meal_total ?? 0,
      });
      if (!v) return;
      if (v.name === d.cls.name && v.total === d.cls.total && v.meal_total === (d.cls.meal_total ?? 0)) return;
      await api('/api/classes/' + S.classId, {
        method: 'PATCH',
        body: { name: v.name, total: v.total, meal_total: v.meal_total },
      });
      toast('Сохранено');
      await loadClass();
    });
    document.getElementById('del').onclick = guard(async () => {
      const ok = await confirmDialog({
        title: 'Удалить класс?',
        text: `Удалить класс ${d.cls.name} вместе со всей историей?`,
        okLabel: 'Удалить',
        danger: true,
      });
      if (!ok) return;
      await api('/api/classes/' + S.classId, { method: 'DELETE' });
      back();
    });
  }
}

// ---------- Запуск ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    trySyncPending().then(() => {
      if (S.token && !S.classId) showList();
      else if (S.token && S.classId) guard(loadClass)();
    });
  }
});
window.addEventListener('online', () => { trySyncPending(); });
flushClientErrors();
if (S.token) {
  trySyncPending({ quiet: true }).finally(() => showList());
} else {
  renderLogin();
}
