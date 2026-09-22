'use strict';

const DB_NAME = 'expense-pwa-db';
const DB_VERSION = 1;
const STORE_RECORDS = 'records';
const STORE_OPS = 'ops';
const STORE_SETTINGS = 'settings';

const PERSIAN_MONTHS = [
  'فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور',
  'مهر','آبان','آذر','دی','بهمن','اسفند'
];

const WEEKDAYS = ['ش','ی','د','س','چ','پ','ج'];

const state = {
  records: [],
  pendingOps: [],
  today: '',
  syncing: false,
  settings: {
    apiUrl: '',
    apiToken: ''
  },
  installPrompt: null
};

let dbPromise = null;
let calYear = 1400;
let calMonth = 1;
let toastTimer = null;

const $ = id => document.getElementById(id);

window.addEventListener('DOMContentLoaded', bootstrap);
window.addEventListener('online', handleConnectivityChange);
window.addEventListener('offline', handleConnectivityChange);
window.addEventListener('resize', repositionCalendarIfOpen);
window.addEventListener('orientationchange', () => setTimeout(repositionCalendarIfOpen, 150));

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  state.installPrompt = event;
  $('installBtn').hidden = false;
});

window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  $('installBtn').hidden = true;
  toast('برنامه نصب شد.');
});

async function bootstrap() {
  wireEvents();
  await registerServiceWorker();
  await openDb();
  await loadSettings();
  state.today = getPersianTodayClient();
  await refreshLocalState();
  updateConnectivityUi();
  render();

  if (!state.settings.apiUrl || !state.settings.apiToken) {
    openSettings();
  } else if (navigator.onLine) {
    syncNow({ silent: true });
  }

  setInterval(() => {
    if (navigator.onLine && !state.syncing && state.settings.apiUrl && state.settings.apiToken) {
      syncNow({ silent: true });
    }
  }, 60000);
}

function wireEvents() {
  $('addBtn').addEventListener('click', openNewRecord);
  $('syncBtn').addEventListener('click', () => syncNow({ silent: false }));
  $('settingsBtn').addEventListener('click', openSettings);
  $('installBtn').addEventListener('click', installApp);

  $('recordCloseBtn').addEventListener('click', closeRecordModal);
  $('recordCancelBtn').addEventListener('click', closeRecordModal);
  $('recordSaveBtn').addEventListener('click', saveRecordFromModal);
  $('recordOverlay').addEventListener('click', event => {
    if (event.target === $('recordOverlay')) closeRecordModal();
  });

  $('settingsCloseBtn').addEventListener('click', closeSettings);
  $('saveSettingsBtn').addEventListener('click', saveSettingsFromModal);
  $('testConnectionBtn').addEventListener('click', testConnection);
  $('settingsOverlay').addEventListener('click', event => {
    if (event.target === $('settingsOverlay')) closeSettings();
  });

  $('amount').addEventListener('input', event => formatAmountInput(event.target));
  $('date').addEventListener('click', openCalendar);
  $('calendarTrigger').addEventListener('click', event => {
    event.stopPropagation();
    openCalendar();
  });
  $('calPrevBtn').addEventListener('click', () => changeCalendarMonth(-1));
  $('calNextBtn').addEventListener('click', () => changeCalendarMonth(1));
  $('calTodayBtn').addEventListener('click', selectToday);
  $('calendarPopover').addEventListener('click', event => event.stopPropagation());

  document.addEventListener('click', event => {
    const popover = $('calendarPopover');
    const field = $('dateField');

    if (popover.classList.contains('show') && !field.contains(event.target)) {
      closeCalendar();
    }
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

async function installApp() {
  if (!state.installPrompt) {
    toast('از منوی مرورگر گزینه Add to Home Screen / Install App را انتخاب کنید.');
    return;
  }

  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  $('installBtn').hidden = true;
}

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = event => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_OPS)) {
        const store = db.createObjectStore(STORE_OPS, { keyPath: 'opId' });
        store.createIndex('id', 'id', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

async function idbGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbBulkApply({ puts = [], deletes = [], storeName }) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    puts.forEach(item => store.put(item));
    deletes.forEach(key => store.delete(key));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function refreshLocalState() {
  state.records = await idbGetAll(STORE_RECORDS);
  state.pendingOps = await idbGetAll(STORE_OPS);
}

async function loadSettings() {
  const apiUrl = await idbGet(STORE_SETTINGS, 'apiUrl');
  const apiToken = await idbGet(STORE_SETTINGS, 'apiToken');

  state.settings.apiUrl = apiUrl ? String(apiUrl.value || '') : '';
  state.settings.apiToken = apiToken ? String(apiToken.value || '') : '';
}

async function saveSettings(apiUrl, apiToken) {
  const normalizedUrl = String(apiUrl || '').trim().replace(/\/$/, '');
  const normalizedToken = String(apiToken || '').trim();

  await Promise.all([
    idbPut(STORE_SETTINGS, { key: 'apiUrl', value: normalizedUrl }),
    idbPut(STORE_SETTINGS, { key: 'apiToken', value: normalizedToken })
  ]);

  state.settings.apiUrl = normalizedUrl;
  state.settings.apiToken = normalizedToken;
}

function render() {
  const records = [...state.records]
    .sort(compareRecordsDesc)
    .map((record, index) => ({ ...record, rowNo: index + 1 }));

  const pendingIds = new Set(state.pendingOps.map(op => op.id));
  const tbody = $('tbody');
  tbody.innerHTML = '';

  for (const item of records) {
    const tr = document.createElement('tr');
    const pending = pendingIds.has(item.id);

    tr.innerHTML = `
      <td>${escapeHtml(String(item.rowNo))}</td>
      <td class="amount">${money(item.amount)}</td>
      <td class="reason">${escapeHtml(item.reason)}</td>
      <td class="payee">${escapeHtml(item.payee || '—')}</td>
      <td>${escapeHtml(item.date)}</td>
      <td>
        <span class="sync-badge ${pending ? 'pending' : ''}">
          ${pending ? 'در انتظار' : 'همگام'}
        </span>
      </td>
      <td>
        <div class="actions">
          <button class="icon-btn edit-btn" type="button" data-id="${escapeHtmlAttr(item.id)}">ویرایش</button>
          <button class="icon-btn delete delete-btn" type="button" data-id="${escapeHtmlAttr(item.id)}">حذف</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => editRecord(btn.dataset.id));
  });

  tbody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteRecord(btn.dataset.id));
  });

  $('emptyState').hidden = records.length !== 0;
  $('totalValue').textContent = money(records.reduce((sum, x) => sum + Number(x.amount || 0), 0));
  $('countValue').textContent = records.length.toLocaleString('fa-IR');
  $('pendingValue').textContent = state.pendingOps.length.toLocaleString('fa-IR');

  updateConnectivityUi();
}

function compareRecordsDesc(a, b) {
  const dateCompare = String(b.date || '').localeCompare(String(a.date || ''), 'en');
  if (dateCompare !== 0) return dateCompare;
  return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
}

function openNewRecord() {
  $('modalTitle').textContent = 'ایجاد ردیف جدید';
  $('recordId').value = '';
  $('amount').value = '';
  $('reason').value = '';
  $('payee').value = '';
  state.today = getPersianTodayClient() || state.today;
  $('date').value = state.today || '';
  closeCalendar();
  showOverlay($('recordOverlay'));
  setTimeout(() => $('amount').focus(), 80);
}

function editRecord(id) {
  const item = state.records.find(x => x.id === id);
  if (!item) return;

  $('modalTitle').textContent = 'ویرایش ردیف';
  $('recordId').value = item.id;
  $('amount').value = money(item.amount);
  $('reason').value = item.reason;
  $('payee').value = item.payee || '';
  $('date').value = item.date;
  closeCalendar();
  showOverlay($('recordOverlay'));
}

async function saveRecordFromModal() {
  const id = $('recordId').value || createUuid();
  const amount = normalizeAmount($('amount').value);
  const reason = String($('reason').value || '').trim();
  const payee = String($('payee').value || '').trim();
  const date = normalizePersianDate($('date').value || state.today);

  if (!(amount > 0)) {
    toast('مبلغ باید بیشتر از صفر باشد.');
    return;
  }

  if (!reason) {
    toast('لطفاً بابت را وارد کنید.');
    return;
  }

  if (!date) {
    toast('لطفاً تاریخ شمسی را انتخاب کنید.');
    return;
  }

  const record = {
    id,
    amount,
    reason,
    payee,
    date,
    updatedAt: Date.now()
  };

  await saveRecordOffline(record);
  closeRecordModal();
  await refreshLocalState();
  render();

  toast(navigator.onLine ? 'ذخیره شد؛ در حال همگام‌سازی...' : 'آفلاین ذخیره شد؛ بعداً همگام می‌شود.');

  if (navigator.onLine && state.settings.apiUrl && state.settings.apiToken) {
    syncNow({ silent: true });
  }
}

async function saveRecordOffline(record) {
  const op = {
    opId: createUuid(),
    type: 'upsert',
    id: record.id,
    updatedAt: record.updatedAt,
    record
  };

  await idbPut(STORE_RECORDS, record);
  await replacePendingOpsForId(record.id, op);
}

async function deleteRecord(id) {
  const item = state.records.find(x => x.id === id);
  if (!item) return;

  if (!confirm(`ردیف با تاریخ ${item.date} حذف شود؟`)) return;

  const updatedAt = Date.now();
  const op = {
    opId: createUuid(),
    type: 'delete',
    id,
    updatedAt,
    record: null
  };

  await idbDelete(STORE_RECORDS, id);
  await replacePendingOpsForId(id, op);
  await refreshLocalState();
  render();

  toast(navigator.onLine ? 'حذف شد؛ در حال همگام‌سازی...' : 'آفلاین حذف شد؛ بعداً همگام می‌شود.');

  if (navigator.onLine && state.settings.apiUrl && state.settings.apiToken) {
    syncNow({ silent: true });
  }
}

async function replacePendingOpsForId(id, newOp) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_OPS, 'readwrite');
    const store = tx.objectStore(STORE_OPS);
    const index = store.index('id');
    const req = index.openCursor(IDBKeyRange.only(id));

    req.onsuccess = event => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }
      store.put(newOp);
    };

    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function syncNow({ silent = false } = {}) {
  if (state.syncing) return;

  if (!navigator.onLine) {
    updateConnectivityUi();
    if (!silent) toast('اینترنت در دسترس نیست؛ تغییرات روی دستگاه محفوظ است.');
    return;
  }

  if (!state.settings.apiUrl || !state.settings.apiToken) {
    if (!silent) {
      toast('ابتدا تنظیمات همگام‌سازی را وارد کنید.');
      openSettings();
    }
    return;
  }

  state.syncing = true;
  updateConnectivityUi('syncing');

  try {
    await refreshLocalState();

    if (state.pendingOps.length) {
      const ops = coalesceOps(state.pendingOps);
      let snapshot = null;

      try {
        snapshot = await postOpsFetch(ops);
      } catch (error) {
        console.warn('POST fetch failed; using form fallback:', error);
        await postOpsFormFallback(ops);
      }

      if (snapshot && snapshot.ok) {
        await mergeSnapshot(snapshot);
      }
    }

    const fresh = await pullSnapshot();
    if (!fresh || !fresh.ok) {
      throw new Error(fresh && fresh.error ? fresh.error : 'پاسخ همگام‌سازی نامعتبر است.');
    }

    state.today = fresh.today || state.today;
    await mergeSnapshot(fresh);
    await refreshLocalState();
    render();

    if (!silent) toast('همگام‌سازی با Google Sheets انجام شد.');

  } catch (error) {
    console.error(error);
    updateConnectivityUi('error');
    if (!silent) toast(error && error.message ? error.message : 'همگام‌سازی ناموفق بود.');
  } finally {
    state.syncing = false;
    await refreshLocalState();
    render();
  }
}

function coalesceOps(ops) {
  const map = new Map();

  [...ops]
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
    .forEach(op => map.set(op.id, op));

  return [...map.values()];
}

async function postOpsFetch(ops) {
  const response = await fetch(state.settings.apiUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify({
      token: state.settings.apiToken,
      ops
    }),
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`خطای HTTP ${response.status}`);
  }

  const text = await response.text();
  const data = JSON.parse(text);

  if (!data.ok) {
    throw new Error(data.error || 'خطا در ثبت اطلاعات روی Google Sheets.');
  }

  return data;
}

async function postOpsFormFallback(ops) {
  const iframe = $('syncFrame');
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = state.settings.apiUrl;
  form.target = iframe.name;
  form.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'payload';
  input.value = JSON.stringify({
    token: state.settings.apiToken,
    ops
  });

  form.appendChild(input);
  document.body.appendChild(form);

  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    iframe.onload = () => setTimeout(finish, 300);
    setTimeout(finish, 4500);
    form.submit();
  });

  form.remove();
}

async function pullSnapshot() {
  const url = new URL(state.settings.apiUrl);
  url.searchParams.set('action', 'pull');
  url.searchParams.set('token', state.settings.apiToken);
  url.searchParams.set('_', String(Date.now()));

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`خطای HTTP ${response.status}`);
    }

    return await response.json();

  } catch (error) {
    console.warn('GET fetch failed; using JSONP fallback:', error);
    return pullSnapshotJsonp(url);
  }
}

function pullSnapshotJsonp(baseUrl) {
  return new Promise((resolve, reject) => {
    const callbackName = `__expenseJsonp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement('script');
    const url = new URL(baseUrl.toString());
    url.searchParams.set('callback', callbackName);

    const cleanup = () => {
      try { delete window[callbackName]; } catch (e) { window[callbackName] = undefined; }
      script.remove();
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('زمان دریافت اطلاعات از Google Sheets به پایان رسید.'));
    }, 15000);

    window[callbackName] = data => {
      clearTimeout(timer);
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('اتصال JSONP به Apps Script برقرار نشد.'));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

async function mergeSnapshot(snapshot) {
  const remoteRecords = Array.isArray(snapshot.records) ? snapshot.records : [];
  const remoteDeletions = Array.isArray(snapshot.deletions) ? snapshot.deletions : [];
  const pendingOps = await idbGetAll(STORE_OPS);
  const latestPending = new Map(coalesceOps(pendingOps).map(op => [op.id, op]));
  const localRecords = await idbGetAll(STORE_RECORDS);
  const localMap = new Map(localRecords.map(r => [r.id, r]));
  const remoteIds = new Set(remoteRecords.map(r => String(r.id || '')).filter(Boolean));

  const puts = [];
  const deletes = [];

  // اگر رکوردی قبلاً همگام بوده، Pending ندارد و دیگر در Snapshot سرور نیست،
  // حذف مستقیم آن از Google Sheet را نیز روی دستگاه منعکس می‌کنیم.
  for (const local of localRecords) {
    if (!remoteIds.has(local.id) && !latestPending.has(local.id)) {
      deletes.push(local.id);
      localMap.delete(local.id);
    }
  }

  for (const tombstone of remoteDeletions) {
    const id = String(tombstone.id || '');
    const deletedAt = Number(tombstone.deletedAt || 0);
    if (!id || !deletedAt) continue;

    const pending = latestPending.get(id);
    const local = localMap.get(id);

    if (pending && Number(pending.updatedAt || 0) > deletedAt) {
      continue;
    }

    if (!local || deletedAt >= Number(local.updatedAt || 0)) {
      deletes.push(id);
      localMap.delete(id);
    }
  }

  for (const remote of remoteRecords) {
    const normalized = normalizeRemoteRecord(remote);
    if (!normalized) continue;

    const pending = latestPending.get(normalized.id);
    const local = localMap.get(normalized.id);

    if (pending && Number(pending.updatedAt || 0) > normalized.updatedAt) {
      continue;
    }

    if (!local || normalized.updatedAt >= Number(local.updatedAt || 0)) {
      puts.push(normalized);
      localMap.set(normalized.id, normalized);
    }
  }

  await idbBulkApply({ storeName: STORE_RECORDS, puts, deletes });
  await confirmPendingOps(snapshot, pendingOps);
}

function normalizeRemoteRecord(remote) {
  if (!remote || !remote.id) return null;

  return {
    id: String(remote.id),
    amount: Number(remote.amount) || 0,
    reason: String(remote.reason || ''),
    payee: String(remote.payee || ''),
    date: normalizePersianDate(remote.date) || String(remote.date || ''),
    updatedAt: Number(remote.updatedAt) || 0
  };
}

async function confirmPendingOps(snapshot, pendingOps) {
  const recordMap = new Map((snapshot.records || []).map(r => [String(r.id), Number(r.updatedAt || 0)]));
  const deletionMap = new Map((snapshot.deletions || []).map(d => [String(d.id), Number(d.deletedAt || 0)]));
  const confirmed = [];

  for (const op of pendingOps) {
    const opAt = Number(op.updatedAt || 0);

    if (op.type === 'delete') {
      const serverAt = Number(deletionMap.get(op.id) || 0);
      if (serverAt >= opAt) confirmed.push(op.opId);
      continue;
    }

    const serverAt = Number(recordMap.get(op.id) || 0);
    if (serverAt >= opAt) confirmed.push(op.opId);
  }

  if (confirmed.length) {
    await idbBulkApply({ storeName: STORE_OPS, deletes: confirmed });
  }
}

async function handleConnectivityChange() {
  updateConnectivityUi();

  if (navigator.onLine && state.settings.apiUrl && state.settings.apiToken) {
    toast('اتصال اینترنت برقرار شد؛ همگام‌سازی شروع می‌شود.');
    await syncNow({ silent: true });
  }
}

function updateConnectivityUi(forcedState) {
  const dot = $('statusDot');
  const text = $('statusText');
  const strip = $('offlineStrip');

  dot.className = 'status-dot';

  if (forcedState === 'error') {
    dot.classList.add('error');
    text.textContent = 'خطا در همگام‌سازی؛ اطلاعات آفلاین محفوظ است';
    strip.hidden = navigator.onLine;
    return;
  }

  if (state.syncing || forcedState === 'syncing') {
    dot.classList.add('online');
    text.textContent = 'در حال همگام‌سازی با Google Sheets...';
    strip.hidden = true;
    return;
  }

  if (!navigator.onLine) {
    dot.classList.add('offline');
    text.textContent = 'آفلاین';
    strip.hidden = false;
    return;
  }

  dot.classList.add('online');
  strip.hidden = true;

  if (!state.settings.apiUrl || !state.settings.apiToken) {
    text.textContent = 'آنلاین؛ همگام‌سازی هنوز تنظیم نشده است';
  } else if (state.pendingOps.length) {
    text.textContent = `${state.pendingOps.length.toLocaleString('fa-IR')} تغییر در انتظار همگام‌سازی`;
  } else {
    text.textContent = 'آنلاین و همگام';
  }
}

function openSettings() {
  $('apiUrl').value = state.settings.apiUrl || '';
  $('apiToken').value = state.settings.apiToken || '';
  $('settingsStatus').textContent = '';
  $('settingsStatus').className = 'settings-status';
  showOverlay($('settingsOverlay'));
}

function closeSettings() {
  hideOverlay($('settingsOverlay'));
}

async function saveSettingsFromModal() {
  const apiUrl = $('apiUrl').value.trim();
  const apiToken = $('apiToken').value.trim();

  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/i.test(apiUrl)) {
    setSettingsStatus('URL باید آدرس Deploy شده Apps Script باشد و به /exec ختم شود.', false);
    return;
  }

  if (apiToken.length < 16) {
    setSettingsStatus('برای امنیت، Token حداقل 16 کاراکتر باشد.', false);
    return;
  }

  await saveSettings(apiUrl, apiToken);
  setSettingsStatus('تنظیمات ذخیره شد.', true);
  updateConnectivityUi();

  if (navigator.onLine) {
    try {
      await testConnection();
      setTimeout(closeSettings, 500);
    } catch (e) {}
  } else {
    setTimeout(closeSettings, 500);
  }
}

async function testConnection() {
  const apiUrl = $('apiUrl').value.trim() || state.settings.apiUrl;
  const apiToken = $('apiToken').value.trim() || state.settings.apiToken;

  if (!apiUrl || !apiToken) {
    setSettingsStatus('ابتدا URL و Token را وارد کنید.', false);
    return false;
  }

  if (!navigator.onLine) {
    setSettingsStatus('برای تست اتصال باید اینترنت برقرار باشد.', false);
    return false;
  }

  const old = { ...state.settings };
  state.settings = { apiUrl, apiToken };

  try {
    const data = await pullSnapshot();
    if (!data || !data.ok) throw new Error(data && data.error ? data.error : 'پاسخ نامعتبر');
    setSettingsStatus('اتصال موفق است و Google Sheet در دسترس است.', true);
    return true;
  } catch (error) {
    setSettingsStatus(error && error.message ? error.message : 'اتصال ناموفق بود.', false);
    return false;
  } finally {
    state.settings = old;
  }
}

function setSettingsStatus(message, ok) {
  const el = $('settingsStatus');
  el.textContent = message;
  el.className = `settings-status ${ok ? 'ok' : 'error'}`;
}

function showOverlay(el) {
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function hideOverlay(el) {
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');

  if (!$('recordOverlay').classList.contains('show') && !$('settingsOverlay').classList.contains('show')) {
    document.body.style.overflow = '';
  }
}

function closeRecordModal() {
  closeCalendar();
  hideOverlay($('recordOverlay'));
}

function setLoading(show, text = 'در حال پردازش...') {
  $('loadingText').textContent = text;
  $('loading').hidden = !show;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString('en-US');
}

function normalizeAmount(value) {
  const s = toLatinDigits(String(value == null ? '' : value))
    .replace(/[,\u066C\s]/g, '')
    .replace(/[^\d.-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function formatAmountInput(el) {
  const digits = toLatinDigits(el.value).replace(/[^\d]/g, '');
  el.value = digits ? Number(digits).toLocaleString('en-US') : '';
}

function toLatinDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function normalizePersianDate(value) {
  const s = toLatinDigits(String(value || '').trim())
    .replace(/[-.]/g, '/')
    .replace(/\s/g, '');

  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return '';

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  if (mo < 1 || mo > 12) return '';
  if (d < 1 || d > jalaliMonthLength(y, mo)) return '';

  return `${String(y).padStart(4, '0')}/${String(mo).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

function getPersianTodayClient() {
  try {
    const fmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    const parts = fmt.formatToParts(new Date());
    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return `${map.year}/${map.month}/${map.day}`;
  } catch (e) {
    return '';
  }
}

function createUuid() {
  if (crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[c]));
}

function escapeHtmlAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#096;');
}

function repositionCalendarIfOpen() {
  const popover = $('calendarPopover');
  if (popover && popover.classList.contains('show')) {
    positionCalendar();
  }
}

function parsePersianDate(value) {
  const normalized = normalizePersianDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('/').map(Number);
  return { year, month, day };
}

function openCalendar() {
  const parsed = parsePersianDate($('date').value) || parsePersianDate(state.today);

  if (parsed) {
    calYear = parsed.year;
    calMonth = parsed.month;
  }

  renderCalendar();
  $('calendarPopover').classList.add('show');
  requestAnimationFrame(positionCalendar);
}

function closeCalendar() {
  $('calendarPopover').classList.remove('show');
}

function changeCalendarMonth(delta) {
  calMonth += delta;

  if (calMonth < 1) {
    calMonth = 12;
    calYear--;
  }

  if (calMonth > 12) {
    calMonth = 1;
    calYear++;
  }

  renderCalendar();
  requestAnimationFrame(positionCalendar);
}

function selectToday() {
  const today = getPersianTodayClient() || state.today;
  if (!today) return;

  state.today = today;
  $('date').value = today;
  const parsed = parsePersianDate(today);

  if (parsed) {
    calYear = parsed.year;
    calMonth = parsed.month;
  }

  closeCalendar();
}

function renderCalendar() {
  $('calendarTitle').textContent = `${PERSIAN_MONTHS[calMonth - 1]} ${calYear}`;
  $('calendarWeekdays').innerHTML = WEEKDAYS.map(x => `<div>${x}</div>`).join('');

  const container = $('calendarDays');
  container.innerHTML = '';

  const firstGregorian = jalaliToGregorian(calYear, calMonth, 1);
  const jsWeekday = new Date(Date.UTC(
    firstGregorian.gy,
    firstGregorian.gm - 1,
    firstGregorian.gd
  )).getUTCDay();

  const offset = (jsWeekday + 1) % 7;

  for (let i = 0; i < offset; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-empty';
    container.appendChild(empty);
  }

  const selected = parsePersianDate($('date').value);
  const today = parsePersianDate(state.today || getPersianTodayClient());
  const count = jalaliMonthLength(calYear, calMonth);

  for (let day = 1; day <= count; day++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.textContent = day.toLocaleString('fa-IR');

    if (
      today &&
      today.year === calYear &&
      today.month === calMonth &&
      today.day === day
    ) {
      btn.classList.add('today');
    }

    if (
      selected &&
      selected.year === calYear &&
      selected.month === calMonth &&
      selected.day === day
    ) {
      btn.classList.add('selected');
    }

    btn.addEventListener('click', () => {
      $('date').value = `${calYear}/${String(calMonth).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
      closeCalendar();
    });

    container.appendChild(btn);
  }
}

function positionCalendar() {
  const input = $('date');
  const popover = $('calendarPopover');
  if (!popover.classList.contains('show')) return;

  const rect = input.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const margin = 12;
  const gap = 8;
  const width = Math.min(360, viewportWidth - margin * 2);

  popover.style.width = `${width}px`;

  let left = rect.right - width;
  left = Math.max(margin, Math.min(left, viewportWidth - width - margin));

  const calendarHeight = popover.offsetHeight;
  const spaceBelow = viewportHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  let top;

  if (spaceBelow >= calendarHeight) {
    top = rect.bottom + gap;
  } else if (spaceAbove >= calendarHeight) {
    top = rect.top - calendarHeight - gap;
  } else if (spaceAbove > spaceBelow) {
    top = margin;
  } else {
    top = Math.max(margin, viewportHeight - calendarHeight - margin);
  }

  top = Math.max(margin, Math.min(top, viewportHeight - calendarHeight - margin));

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.right = 'auto';
}

function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalaliYear(jy) ? 30 : 29;
}

function isLeapJalaliYear(jy) {
  return jalCal(jy).leap === 0;
}

function div(a, b) {
  return Math.trunc(a / b);
}

function mod(a, b) {
  return a - Math.trunc(a / b) * b;
}

function jalCal(jy) {
  const breaks = [
    -61,9,38,199,426,686,756,818,1111,1181,
    1210,1635,2060,2097,2192,2262,2324,2394,2456,3178
  ];

  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0];
  let jm;
  let jump = 0;
  let leap;
  let leapG;
  let march;
  let n;

  if (jy < jp || jy >= breaks[bl - 1]) {
    throw new Error('سال شمسی نامعتبر است.');
  }

  for (let i = 1; i < bl; i++) {
    jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }

  n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);

  if (mod(jump, 33) === 4 && jump - n === 4) {
    leapJ += 1;
  }

  leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  march = 20 + leapJ - leapG;

  if (jump - n < 6) {
    n = n - jump + div(jump + 4, 33) * 33;
  }

  leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4)
    + div(153 * mod(gm + 9, 12) + 2, 5)
    + gd - 34840408;

  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;

  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);

  return { gy, gm, gd };
}

function j2d(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march)
    + (jm - 1) * 31
    - div(jm, 7) * (jm - 7)
    + jd - 1;
}

function jalaliToGregorian(jy, jm, jd) {
  return d2g(j2d(jy, jm, jd));
}
