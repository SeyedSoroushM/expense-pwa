'use strict';

const DB_NAME = 'expense-pwa-db';
const DB_VERSION = 2;
const STORE_RECORDS = 'records';
const STORE_OPS = 'ops';
const STORE_SETTINGS = 'settings';
const STORE_PROJECTS = 'projects';

const PERSIAN_MONTHS = [
  'فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور',
  'مهر','آبان','آذر','دی','بهمن','اسفند'
];

const WEEKDAYS = ['ش','ی','د','س','چ','پ','ج'];

const state = {
  records: [],
  projects: [],
  pendingOps: [],
  today: '',
  syncing: false,
  filters: {
    projectId: '',
    fromDate: '',
    toDate: ''
  },
  settings: {
    apiUrl: '',
    apiToken: ''
  },
  installPrompt: null
};

let dbPromise = null;
let calYear = 1400;
let calMonth = 1;
let calendarTargetId = 'date';
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
  if ($('installBtn')) $('installBtn').hidden = false;
});

window.addEventListener('appinstalled', () => {
  state.installPrompt = null;
  if ($('installBtn')) $('installBtn').hidden = true;
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
    if (
      navigator.onLine &&
      !state.syncing &&
      state.settings.apiUrl &&
      state.settings.apiToken
    ) {
      syncNow({ silent: true });
    }
  }, 60000);
}

function wireEvents() {
  $('addBtn')?.addEventListener('click', openNewRecord);
  $('syncBtn')?.addEventListener('click', () => syncNow({ silent: false }));
  $('settingsBtn')?.addEventListener('click', openSettings);
  $('installBtn')?.addEventListener('click', installApp);
  $('exportExcelBtn')?.addEventListener('click', exportExcel);

  $('recordCloseBtn')?.addEventListener('click', closeRecordModal);
  $('recordCancelBtn')?.addEventListener('click', closeRecordModal);
  $('recordSaveBtn')?.addEventListener('click', saveRecordFromModal);
  $('recordOverlay')?.addEventListener('click', event => {
    if (event.target === $('recordOverlay')) closeRecordModal();
  });

  $('settingsCloseBtn')?.addEventListener('click', closeSettings);
  $('saveSettingsBtn')?.addEventListener('click', saveSettingsFromModal);
  $('testConnectionBtn')?.addEventListener('click', testConnection);
  $('settingsOverlay')?.addEventListener('click', event => {
    if (event.target === $('settingsOverlay')) closeSettings();
  });

  $('manageProjectsBtn')?.addEventListener('click', openProjectManager);
  $('projectCloseBtn')?.addEventListener('click', closeProjectManager);
  $('projectSaveBtn')?.addEventListener('click', saveProject);
  $('projectCancelEditBtn')?.addEventListener('click', cancelProjectEdit);
  $('projectOverlay')?.addEventListener('click', event => {
    if (event.target === $('projectOverlay')) closeProjectManager();
  });

  $('applyFilterBtn')?.addEventListener('click', applyFilters);
  $('resetFilterBtn')?.addEventListener('click', resetFilters);

  $('amount')?.addEventListener('input', event => formatAmountInput(event.target));

  $('date')?.addEventListener('click', () => openCalendarFor('date'));
  $('calendarTrigger')?.addEventListener('click', event => {
    event.stopPropagation();
    openCalendarFor('date');
  });

  $('filterFrom')?.addEventListener('click', () => openCalendarFor('filterFrom'));
  $('filterFromCalendarBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    openCalendarFor('filterFrom');
  });

  $('filterTo')?.addEventListener('click', () => openCalendarFor('filterTo'));
  $('filterToCalendarBtn')?.addEventListener('click', event => {
    event.stopPropagation();
    openCalendarFor('filterTo');
  });

  $('calPrevBtn')?.addEventListener('click', () => changeCalendarMonth(-1));
  $('calNextBtn')?.addEventListener('click', () => changeCalendarMonth(1));
  $('calTodayBtn')?.addEventListener('click', selectToday);
  $('calendarPopover')?.addEventListener('click', event => event.stopPropagation());

  document.addEventListener('click', event => {
    const popover = $('calendarPopover');
    if (!popover || !popover.classList.contains('show')) return;

    const input = $(calendarTargetId);
    const wrap = input ? input.closest('.date-wrap') : null;

    if (!popover.contains(event.target) && !(wrap && wrap.contains(event.target))) {
      closeCalendar();
    }
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    registration.update().catch(() => undefined);
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
  if ($('installBtn')) $('installBtn').hidden = true;
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

      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const store = db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
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
  const [records, projects, pendingOps] = await Promise.all([
    idbGetAll(STORE_RECORDS),
    idbGetAll(STORE_PROJECTS),
    idbGetAll(STORE_OPS)
  ]);

  state.records = records;
  state.projects = projects;
  state.pendingOps = pendingOps;
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

function activeProjects() {
  return [...state.projects]
    .filter(project => project && project.id && project.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fa'));
}

function getProjectById(id) {
  return state.projects.find(x => String(x.id) === String(id)) || null;
}

function resolveProjectName(record) {
  const project = getProjectById(record.projectId);
  if (project) return project.name;
  return String(record.projectName || '').trim() || 'بدون پروژه';
}

function renderProjectControls() {
  const recordSelect = $('projectId');
  const filterSelect = $('filterProject');
  const projects = activeProjects();

  if (recordSelect) {
    const previous = recordSelect.value;
    recordSelect.innerHTML = '<option value="">انتخاب پروژه...</option>';

    projects.forEach(project => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      recordSelect.appendChild(option);
    });

    if (projects.some(x => String(x.id) === String(previous))) {
      recordSelect.value = previous;
    }
  }

  if (filterSelect) {
    const wanted = state.filters.projectId;
    filterSelect.innerHTML = '<option value="">همه پروژه‌ها</option><option value="__NONE__">بدون پروژه</option>';

    projects.forEach(project => {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      filterSelect.appendChild(option);
    });

    filterSelect.value = wanted || '';
  }
}

function getFilteredRecords() {
  return [...state.records]
    .filter(record => {
      const projectFilter = state.filters.projectId;

      if (projectFilter === '__NONE__') {
        if (String(record.projectId || '').trim()) return false;
      } else if (projectFilter && String(record.projectId || '') !== String(projectFilter)) {
        return false;
      }

      const date = normalizePersianDate(record.date);
      if (state.filters.fromDate && (!date || date < state.filters.fromDate)) return false;
      if (state.filters.toDate && (!date || date > state.filters.toDate)) return false;

      return true;
    })
    .sort(compareRecordsDesc);
}

function render() {
  renderProjectControls();

  const records = getFilteredRecords()
    .map((record, index) => ({ ...record, rowNo: index + 1 }));

  const pendingRecordIds = new Set(
    state.pendingOps
      .filter(op => String(op.entity || 'record') === 'record')
      .map(op => String(op.id))
  );

  const tbody = $('tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  for (const item of records) {
    const tr = document.createElement('tr');
    const pending = pendingRecordIds.has(String(item.id));

    tr.innerHTML = `
      <td>${escapeHtml(String(item.rowNo))}</td>
      <td class="amount">${money(item.amount)}</td>
      <td class="reason">${escapeHtml(item.reason)}</td>
      <td class="payee">${escapeHtml(item.payee || '—')}</td>
      <td class="project">${escapeHtml(resolveProjectName(item))}</td>
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

  if ($('emptyState')) $('emptyState').hidden = records.length !== 0;
  if ($('totalValue')) {
    $('totalValue').textContent = money(records.reduce((sum, x) => sum + Number(x.amount || 0), 0));
  }
  if ($('countValue')) $('countValue').textContent = records.length.toLocaleString('fa-IR');
  if ($('pendingValue')) $('pendingValue').textContent = state.pendingOps.length.toLocaleString('fa-IR');

  updateConnectivityUi();
}

function compareRecordsDesc(a, b) {
  const dateCompare = String(b.date || '').localeCompare(String(a.date || ''), 'en');
  if (dateCompare !== 0) return dateCompare;
  return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
}

function applyFilters() {
  const projectId = $('filterProject') ? $('filterProject').value : '';
  const fromValue = $('filterFrom') ? $('filterFrom').value.trim() : '';
  const toValue = $('filterTo') ? $('filterTo').value.trim() : '';

  const fromDate = fromValue ? normalizePersianDate(fromValue) : '';
  const toDate = toValue ? normalizePersianDate(toValue) : '';

  if (fromValue && !fromDate) {
    toast('تاریخ شروع نامعتبر است.');
    return;
  }

  if (toValue && !toDate) {
    toast('تاریخ پایان نامعتبر است.');
    return;
  }

  if (fromDate && toDate && fromDate > toDate) {
    toast('تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.');
    return;
  }

  state.filters = { projectId, fromDate, toDate };
  render();
}

function resetFilters() {
  state.filters = { projectId: '', fromDate: '', toDate: '' };

  if ($('filterProject')) $('filterProject').value = '';
  if ($('filterFrom')) $('filterFrom').value = '';
  if ($('filterTo')) $('filterTo').value = '';

  render();
}

function openNewRecord() {
  renderProjectControls();

  $('modalTitle').textContent = 'ایجاد ردیف جدید';
  $('recordId').value = '';
  $('amount').value = '';
  $('reason').value = '';
  $('payee').value = '';
  if ($('projectId')) $('projectId').value = '';

  state.today = getPersianTodayClient() || state.today;
  $('date').value = state.today || '';

  closeCalendar();
  showOverlay($('recordOverlay'));
  setTimeout(() => $('amount').focus(), 80);
}

function editRecord(id) {
  const item = state.records.find(x => String(x.id) === String(id));
  if (!item) return;

  renderProjectControls();

  $('modalTitle').textContent = 'ویرایش ردیف';
  $('recordId').value = item.id;
  $('amount').value = money(item.amount);
  $('reason').value = item.reason;
  $('payee').value = item.payee || '';
  if ($('projectId')) $('projectId').value = item.projectId || '';
  $('date').value = item.date;

  closeCalendar();
  showOverlay($('recordOverlay'));
}

async function saveRecordFromModal() {
  const id = $('recordId').value || createUuid();
  const amount = normalizeAmount($('amount').value);
  const reason = String($('reason').value || '').trim();
  const payee = String($('payee').value || '').trim();
  const projectId = String($('projectId')?.value || '').trim();
  const date = normalizePersianDate($('date').value || state.today);

  if (!(amount > 0)) {
    toast('مبلغ باید بیشتر از صفر باشد.');
    return;
  }

  if (!reason) {
    toast('لطفاً بابت را وارد کنید.');
    return;
  }

  if (!projectId) {
    toast('لطفاً پروژه را انتخاب کنید.');
    return;
  }

  const project = getProjectById(projectId);
  if (!project) {
    toast('پروژه انتخاب‌شده معتبر نیست.');
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
    projectId,
    projectName: project.name,
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
    entity: 'record',
    type: 'upsert',
    id: record.id,
    updatedAt: record.updatedAt,
    record
  };

  await idbPut(STORE_RECORDS, record);
  await replacePendingOpsForEntityId('record', record.id, op);
}

async function deleteRecord(id) {
  const item = state.records.find(x => String(x.id) === String(id));
  if (!item) return;

  if (!confirm(`ردیف با تاریخ ${item.date} حذف شود؟`)) return;

  const updatedAt = Date.now();
  const op = {
    opId: createUuid(),
    entity: 'record',
    type: 'delete',
    id,
    updatedAt,
    record: null
  };

  await idbDelete(STORE_RECORDS, id);
  await replacePendingOpsForEntityId('record', id, op);
  await refreshLocalState();
  render();

  toast(navigator.onLine ? 'حذف شد؛ در حال همگام‌سازی...' : 'آفلاین حذف شد؛ بعداً همگام می‌شود.');

  if (navigator.onLine && state.settings.apiUrl && state.settings.apiToken) {
    syncNow({ silent: true });
  }
}

function openProjectManager() {
  cancelProjectEdit();
  renderProjectManager();
  showOverlay($('projectOverlay'));
  setTimeout(() => $('projectName')?.focus(), 80);
}

function closeProjectManager() {
  cancelProjectEdit();
  hideOverlay($('projectOverlay'));
}

function renderProjectManager() {
  const container = $('projectList');
  if (!container) return;

  container.innerHTML = '';
  const projects = activeProjects();

  if (!projects.length) {
    container.innerHTML = '<div class="project-empty">هنوز پروژه‌ای تعریف نشده است.</div>';
    return;
  }

  projects.forEach(project => {
    const row = document.createElement('div');
    row.className = 'project-row';
    row.innerHTML = `
      <div class="project-row-name">${escapeHtml(project.name)}</div>
      <div class="project-row-actions">
        <button type="button" class="project-small-btn project-edit-btn" data-id="${escapeHtmlAttr(project.id)}">ویرایش</button>
        <button type="button" class="project-small-btn delete project-delete-btn" data-id="${escapeHtmlAttr(project.id)}">حذف</button>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.project-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => beginEditProject(btn.dataset.id));
  });

  container.querySelectorAll('.project-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteProject(btn.dataset.id));
  });
}

function beginEditProject(id) {
  const project = getProjectById(id);
  if (!project) return;

  $('projectEditId').value = project.id;
  $('projectName').value = project.name;
  $('projectSaveBtn').textContent = 'ذخیره تغییرات';
  $('projectCancelEditBtn').hidden = false;
  $('projectName').focus();
}

function cancelProjectEdit() {
  if ($('projectEditId')) $('projectEditId').value = '';
  if ($('projectName')) $('projectName').value = '';
  if ($('projectSaveBtn')) $('projectSaveBtn').textContent = 'افزودن پروژه';
  if ($('projectCancelEditBtn')) $('projectCancelEditBtn').hidden = true;
}

async function saveProject() {
  const name = String($('projectName')?.value || '').trim();
  if (!name) {
    toast('نام پروژه را وارد کنید.');
    return;
  }

  const editingId = String($('projectEditId')?.value || '');
  const normalizedName = name.toLocaleLowerCase('fa');
  const duplicate = state.projects.find(project =>
    String(project.id) !== editingId &&
    String(project.name || '').trim().toLocaleLowerCase('fa') === normalizedName
  );

  if (duplicate) {
    toast('پروژه‌ای با این نام قبلاً وجود دارد.');
    return;
  }

  const id = editingId || `project-${createUuid()}`;
  const updatedAt = Date.now();
  const project = { id, name, updatedAt };

  await idbPut(STORE_PROJECTS, project);

  const op = {
    opId: createUuid(),
    entity: 'project',
    type: 'upsert',
    id,
    updatedAt,
    project
  };

  await replacePendingOpsForEntityId('project', id, op);
  await refreshLocalState();

  render();
  renderProjectManager();
  cancelProjectEdit();

  toast(editingId ? 'پروژه ویرایش شد.' : 'پروژه اضافه شد.');

  if (navigator.onLine && state.settings.apiUrl && state.settings.apiToken) {
    syncNow({ silent: true });
  }
}

async function deleteProject(id) {
  const project = getProjectById(id);
  if (!project) return;

  const used = state.records.some(record => String(record.projectId || '') === String(id));
  if (used) {
    toast('این پروژه در رکوردها استفاده شده است؛ ابتدا پروژه رکوردهای مربوطه را تغییر دهید.');
    return;
  }

  if (!confirm(`پروژه «${project.name}» حذف شود؟`)) return;

  const updatedAt = Date.now();
  await idbDelete(STORE_PROJECTS, id);

  const op = {
    opId: createUuid(),
    entity: 'project',
    type: 'delete',
    id,
    updatedAt,
    project: null
  };

  await replacePendingOpsForEntityId('project', id, op);
  await refreshLocalState();

  render();
  renderProjectManager();

  if (navigator.onLine && state.settings.apiUrl && state.settings.apiToken) {
    syncNow({ silent: true });
  }
}

async function replacePendingOpsForEntityId(entity, id, newOp) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_OPS, 'readwrite');
    const store = tx.objectStore(STORE_OPS);
    const index = store.index('id');
    const req = index.openCursor(IDBKeyRange.only(id));

    req.onsuccess = event => {
      const cursor = event.target.result;
      if (cursor) {
        const oldEntity = String(cursor.value.entity || 'record');
        if (oldEntity === entity) cursor.delete();
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
    .forEach(op => {
      const entity = String(op.entity || 'record');
      map.set(`${entity}:${op.id}`, { ...op, entity });
    });

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

  if (!response.ok) throw new Error(`خطای HTTP ${response.status}`);

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
  input.value = JSON.stringify({ token: state.settings.apiToken, ops });

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

    if (!response.ok) throw new Error(`خطای HTTP ${response.status}`);
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
  const pendingOps = await idbGetAll(STORE_OPS);

  await mergeProjectsSnapshot(snapshot, pendingOps);

  const remoteRecords = Array.isArray(snapshot.records) ? snapshot.records : [];
  const remoteDeletions = Array.isArray(snapshot.deletions) ? snapshot.deletions : [];
  const latestPending = new Map(
    coalesceOps(pendingOps)
      .filter(op => String(op.entity || 'record') === 'record')
      .map(op => [String(op.id), op])
  );

  const localRecords = await idbGetAll(STORE_RECORDS);
  const localMap = new Map(localRecords.map(r => [String(r.id), r]));
  const remoteIds = new Set(remoteRecords.map(r => String(r.id || '')).filter(Boolean));

  const puts = [];
  const deletes = [];

  for (const local of localRecords) {
    const id = String(local.id);
    if (!remoteIds.has(id) && !latestPending.has(id)) {
      deletes.push(id);
      localMap.delete(id);
    }
  }

  for (const tombstone of remoteDeletions) {
    const id = String(tombstone.id || '');
    const deletedAt = Number(tombstone.deletedAt || 0);
    if (!id || !deletedAt) continue;

    const pending = latestPending.get(id);
    const local = localMap.get(id);

    if (pending && Number(pending.updatedAt || 0) > deletedAt) continue;

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

    if (pending && Number(pending.updatedAt || 0) > normalized.updatedAt) continue;

    if (!local || normalized.updatedAt >= Number(local.updatedAt || 0)) {
      puts.push(normalized);
      localMap.set(normalized.id, normalized);
    }
  }

  await idbBulkApply({ storeName: STORE_RECORDS, puts, deletes: [...new Set(deletes)] });
  await confirmPendingOps(snapshot, pendingOps);
}

async function mergeProjectsSnapshot(snapshot, pendingOps) {
  const remoteProjects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  const projectPending = new Map(
    coalesceOps(pendingOps)
      .filter(op => String(op.entity || 'record') === 'project')
      .map(op => [String(op.id), op])
  );

  const localProjects = await idbGetAll(STORE_PROJECTS);
  const localMap = new Map(localProjects.map(p => [String(p.id), p]));
  const remoteIds = new Set(remoteProjects.map(p => String(p.id || '')).filter(Boolean));

  const puts = [];
  const deletes = [];

  for (const local of localProjects) {
    const id = String(local.id);
    if (!remoteIds.has(id) && !projectPending.has(id)) {
      deletes.push(id);
      localMap.delete(id);
    }
  }

  for (const remote of remoteProjects) {
    const id = String(remote.id || '');
    if (!id) continue;

    const updatedAt = Number(remote.updatedAt || 0);
    const deletedAt = Number(remote.deletedAt || 0);
    const pending = projectPending.get(id);
    const local = localMap.get(id);
    const serverLatest = Math.max(updatedAt, deletedAt);

    if (pending && Number(pending.updatedAt || 0) > serverLatest) continue;

    if (deletedAt > 0 && deletedAt >= updatedAt) {
      deletes.push(id);
      localMap.delete(id);
      continue;
    }

    const normalized = {
      id,
      name: String(remote.name || '').trim(),
      updatedAt
    };

    if (!normalized.name) continue;

    if (!local || updatedAt >= Number(local.updatedAt || 0)) {
      puts.push(normalized);
      localMap.set(id, normalized);
    }
  }

  await idbBulkApply({ storeName: STORE_PROJECTS, puts, deletes: [...new Set(deletes)] });
}

function normalizeRemoteRecord(remote) {
  if (!remote || !remote.id) return null;

  return {
    id: String(remote.id),
    amount: Number(remote.amount) || 0,
    reason: String(remote.reason || ''),
    payee: String(remote.payee || ''),
    projectId: String(remote.projectId || ''),
    projectName: String(remote.projectName || ''),
    date: normalizePersianDate(remote.date) || String(remote.date || ''),
    updatedAt: Number(remote.updatedAt) || 0
  };
}

async function confirmPendingOps(snapshot, pendingOps) {
  const recordMap = new Map(
    (snapshot.records || []).map(r => [String(r.id), Number(r.updatedAt || 0)])
  );

  const deletionMap = new Map(
    (snapshot.deletions || []).map(d => [String(d.id), Number(d.deletedAt || 0)])
  );

  const projectMap = new Map(
    (snapshot.projects || []).map(project => [
      String(project.id),
      {
        updatedAt: Number(project.updatedAt || 0),
        deletedAt: Number(project.deletedAt || 0)
      }
    ])
  );

  const confirmed = [];

  for (const op of pendingOps) {
    const opAt = Number(op.updatedAt || 0);
    const entity = String(op.entity || 'record');

    if (entity === 'project') {
      const server = projectMap.get(String(op.id)) || { updatedAt: 0, deletedAt: 0 };

      if (op.type === 'delete') {
        if (server.deletedAt >= opAt) confirmed.push(op.opId);
      } else if (server.updatedAt >= opAt && server.updatedAt >= server.deletedAt) {
        confirmed.push(op.opId);
      }

      continue;
    }

    if (op.type === 'delete') {
      const serverAt = Number(deletionMap.get(String(op.id)) || 0);
      if (serverAt >= opAt) confirmed.push(op.opId);
      continue;
    }

    const serverAt = Number(recordMap.get(String(op.id)) || 0);
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
  if (!dot || !text || !strip) return;

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
  if (!el) return;
  el.textContent = message;
  el.className = `settings-status ${ok ? 'ok' : 'error'}`;
}

function showOverlay(el) {
  if (!el) return;
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function hideOverlay(el) {
  if (!el) return;
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');

  const anyOpen = ['recordOverlay', 'settingsOverlay', 'projectOverlay']
    .map(id => $(id))
    .some(item => item && item.classList.contains('show'));

  if (!anyOpen) document.body.style.overflow = '';
}

function closeRecordModal() {
  closeCalendar();
  hideOverlay($('recordOverlay'));
}

function setLoading(show, text = 'در حال پردازش...') {
  if (!$('loading') || !$('loadingText')) return;
  $('loadingText').textContent = text;
  $('loading').hidden = !show;
}

function toast(message) {
  const el = $('toast');
  if (!el) return;
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
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
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
  if (popover && popover.classList.contains('show')) positionCalendar();
}

function parsePersianDate(value) {
  const normalized = normalizePersianDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('/').map(Number);
  return { year, month, day };
}

function openCalendarFor(inputId) {
  const input = $(inputId);
  if (!input) return;

  calendarTargetId = inputId;
  const parsed = parsePersianDate(input.value) || parsePersianDate(state.today || getPersianTodayClient());

  if (parsed) {
    calYear = parsed.year;
    calMonth = parsed.month;
  }

  renderCalendar();
  $('calendarPopover').classList.add('show');
  requestAnimationFrame(positionCalendar);
}

function closeCalendar() {
  $('calendarPopover')?.classList.remove('show');
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
  const input = $(calendarTargetId);
  if (!today || !input) return;

  state.today = today;
  input.value = today;

  const parsed = parsePersianDate(today);
  if (parsed) {
    calYear = parsed.year;
    calMonth = parsed.month;
  }

  closeCalendar();
}

function renderCalendar() {
  if (!$('calendarTitle') || !$('calendarWeekdays') || !$('calendarDays')) return;

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

  const selected = parsePersianDate($(calendarTargetId)?.value);
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
      const input = $(calendarTargetId);
      if (input) {
        input.value = `${calYear}/${String(calMonth).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
      }
      closeCalendar();
    });

    container.appendChild(btn);
  }
}

function positionCalendar() {
  const input = $(calendarTargetId);
  const popover = $('calendarPopover');
  if (!input || !popover || !popover.classList.contains('show')) return;

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

async function exportExcel() {
  const records = getFilteredRecords();

  if (!records.length) {
    toast('رکوردی برای خروجی وجود ندارد.');
    return;
  }

  const pendingIds = new Set(
    state.pendingOps
      .filter(op => String(op.entity || 'record') === 'record')
      .map(op => String(op.id))
  );

  const rows = [[
    'ردیف',
    'پروژه',
    'مبلغ',
    'بابت',
    'به نام',
    'تاریخ شمسی',
    'وضعیت'
  ]];

  records.forEach((record, index) => {
    rows.push([
      index + 1,
      resolveProjectName(record),
      Number(record.amount || 0),
      record.reason || '',
      record.payee || '',
      record.date || '',
      pendingIds.has(String(record.id)) ? 'در انتظار همگام‌سازی' : 'همگام'
    ]);
  });

  const total = records.reduce((sum, record) => sum + Number(record.amount || 0), 0);
  rows.push(['', 'جمع کل', total, '', '', '', '']);

  try {
    const bytes = buildXlsx(rows);
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const today = state.today || getPersianTodayClient() || 'report';

    a.href = url;
    a.download = `گزارش-ثبت-مبالغ-${today.replaceAll('/', '-')}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('فایل Excel آماده شد.');
  } catch (error) {
    console.error(error);
    toast('ساخت فایل Excel ناموفق بود.');
  }
}

function buildXlsx(rows) {
  const now = new Date().toISOString();
  const lastRow = rows.length;

  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex + 1)}${rowIndex + 1}`;
      const isHeader = rowIndex === 0;
      const isTotal = rowIndex === rows.length - 1;
      const isAmount = colIndex === 2 && rowIndex > 0;

      let style = '';
      if (isHeader) style = ' s="1"';
      else if (isTotal && (colIndex === 1 || colIndex === 2)) style = colIndex === 2 ? ' s="3"' : ' s="4"';
      else if (isAmount) style = ' s="2"';

      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"${style}><v>${value}</v></c>`;
      }

      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join('');

    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');

  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>
    <col min="1" max="1" width="9" customWidth="1"/>
    <col min="2" max="2" width="24" customWidth="1"/>
    <col min="3" max="3" width="18" customWidth="1"/>
    <col min="4" max="4" width="42" customWidth="1"/>
    <col min="5" max="5" width="28" customWidth="1"/>
    <col min="6" max="6" width="16" customWidth="1"/>
    <col min="7" max="7" width="23" customWidth="1"/>
  </cols>
  <sheetData>${sheetRows}</sheetData>
  <autoFilter ref="A1:G${Math.max(1, lastRow - 1)}"/>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="Arial"/></font>
    <font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font>
    <font><b/><sz val="11"/><name val="Arial"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>گزارش ثبت مبالغ</dc:title>
  <dc:creator>Expense PWA</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`],
    ['docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Expense PWA</Application>
</Properties>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="گزارش" sheetId="1" r:id="rId1"/></sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', worksheet]
  ];

  return createStoredZip(files);
}

function columnName(index) {
  let n = index;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createStoredZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((Math.floor(now.getSeconds() / 2)) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

  files.forEach(([name, content]) => {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += localHeader.length + data.length;
  });

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  return concatUint8Arrays([...localParts, ...centralParts, end]);
}

function concatUint8Arrays(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

let CRC32_TABLE = null;

function crc32(bytes) {
  if (!CRC32_TABLE) {
    CRC32_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      CRC32_TABLE[n] = c >>> 0;
    }
  }

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
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

  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

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
