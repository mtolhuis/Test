'use strict';

// ============================================================
//  Opslag: alles staat lokaal op het toestel in IndexedDB.
//  - photos: metadata per foto ({ id, name, added, w, h })
//  - blobs:  beelddata, sleutel `${id}:full` en `${id}:thumb`
//  - meta:   portfolio's en de laatst geopende tab
// ============================================================

const DB_NAME = 'portfolio-app';
const DB_VERSION = 1;
const FULL_SIZE = 2048;
const THUMB_SIZE = 600;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('photos', { keyPath: 'id' });
        db.createObjectStore('blobs');
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Voert `fn` uit binnen één transactie. Geeft `fn` een request terug,
// dan wordt het resultaat daarvan teruggegeven zodra alles is opgeslagen.
async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req instanceof IDBRequest ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Opslaan afgebroken'));
  });
}

const store = {
  allPhotos: () => run(['photos'], 'readonly', (t) => t.objectStore('photos').getAll()),
  getMeta: (key) => run(['meta'], 'readonly', (t) => t.objectStore('meta').get(key)),
  setMeta: (key, value) => run(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(value, key); }),
  getBlob: (key) => run(['blobs'], 'readonly', (t) => t.objectStore('blobs').get(key)),
  addPhoto: (meta, full, thumb) => run(['photos', 'blobs'], 'readwrite', (t) => {
    t.objectStore('photos').put(meta);
    t.objectStore('blobs').put(full, `${meta.id}:full`);
    t.objectStore('blobs').put(thumb, `${meta.id}:thumb`);
  }),
  deletePhotos: (ids) => run(['photos', 'blobs'], 'readwrite', (t) => {
    for (const id of ids) {
      t.objectStore('photos').delete(id);
      t.objectStore('blobs').delete(`${id}:full`);
      t.objectStore('blobs').delete(`${id}:thumb`);
    }
  }),
};

// Object-URL's per foto, zodat elk beeld maar één keer wordt ingeladen.
const urlCache = new Map();

async function photoUrl(id, size) {
  const key = `${id}:${size}`;
  if (!urlCache.has(key)) {
    urlCache.set(key, store.getBlob(key).then((rec) =>
      rec ? URL.createObjectURL(new Blob([rec.data], { type: rec.type })) : ''));
  }
  return urlCache.get(key);
}

function forgetUrls(id) {
  for (const size of ['full', 'thumb']) {
    const key = `${id}:${size}`;
    const url = urlCache.get(key);
    if (url) url.then((u) => u && URL.revokeObjectURL(u));
    urlCache.delete(key);
  }
}

// ============================================================
//  Foto's importeren: verkleinen naar een handzaam formaat zodat
//  de opslag op de iPhone niet volloopt.
// ============================================================

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error(`Kan ${file.name} niet lezen`));
    };
    img.src = URL.createObjectURL(file);
  });
}

async function resize(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Verkleinen mislukt'))), 'image/jpeg', quality));
  canvas.width = canvas.height = 0; // geheugen direct vrijgeven (belangrijk op iOS)
  // Als ArrayBuffer bewaren: werkt betrouwbaarder in Safari dan losse Blobs.
  return { rec: { type: blob.type, data: await blob.arrayBuffer() }, w, h };
}

async function importFile(file) {
  const img = await loadImage(file);
  try {
    const full = await resize(img, FULL_SIZE, 0.9);
    const thumb = await resize(img, THUMB_SIZE, 0.8);
    const meta = { id: uid(), name: file.name, added: Date.now(), w: full.w, h: full.h };
    await store.addPhoto(meta, full.rec, thumb.rec);
    return meta;
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

// ============================================================
//  Toestand van de app
// ============================================================

const LIBRARY = 'library';

const state = {
  photos: [],            // nieuwste eerst
  portfolios: [],        // [{ id, name, photoIds: [], layout: 'feed' | 'grid' }]
  active: null,          // id van een portfolio, of LIBRARY
  target: null,          // portfolio waarvoor je in "Foto's" selecteert
  deleteMode: false,     // in "Foto's": foto's aanwijzen om te verwijderen
  deleteSel: new Set(),
  editing: false,        // in een portfolio: volgorde aanpassen
};

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

function uid() {
  return (crypto.randomUUID && crypto.randomUUID())
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function portfolioById(id) {
  return state.portfolios.find((p) => p.id === id);
}

function photoById(id) {
  return state.photos.find((p) => p.id === id);
}

function savePortfolios() {
  return store.setMeta('portfolios', state.portfolios);
}

function saveUi() {
  return store.setMeta('ui', { active: state.active, target: state.target });
}

function setActive(id) {
  state.active = id;
  state.deleteMode = false;
  state.deleteSel.clear();
  state.editing = false;
  if (id !== LIBRARY) state.target = id;
  saveUi();
  render();
  view.scrollTop = 0;
}

// ============================================================
//  Iconen
// ============================================================

const ICONS = {
  portfolio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 2.5h12.5a2 2 0 0 1 2 2V17"/><path d="M3 15l4-4 3 3 2-2 5 5"/></svg>',
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
  photos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

function tabButton(icon, label, active, onClick) {
  const b = el('button', `tab${active ? ' active' : ''}`);
  b.type = 'button';
  b.innerHTML = icon;
  b.append(el('span', null, label));
  b.onclick = onClick;
  return b;
}

function iconButton(icon, label, onClick) {
  const b = el('button', 'btn btn-icon');
  b.type = 'button';
  b.innerHTML = icon;
  b.setAttribute('aria-label', label);
  b.onclick = onClick;
  return b;
}

function textButton(label, onClick, extra = '') {
  const b = el('button', `btn ${extra}`, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

// ============================================================
//  Weergave
// ============================================================

function render() {
  renderTabs();
  if (state.active === LIBRARY) renderLibrary();
  else renderPortfolio(portfolioById(state.active));
}

function renderTabs() {
  const scroll = $('#tabs-scroll');
  scroll.replaceChildren();
  for (const p of state.portfolios) {
    scroll.append(tabButton(ICONS.portfolio, p.name, state.active === p.id, () => setActive(p.id)));
  }
  scroll.append(tabButton(ICONS.add, 'Nieuw', false, createPortfolio));

  const lib = $('#tab-library');
  lib.className = `tab${state.active === LIBRARY ? ' active' : ''}`;
  lib.innerHTML = ICONS.photos;
  lib.append(el('span', null, "Foto's"));
  lib.onclick = () => setActive(LIBRARY);

  const activeTab = scroll.querySelector('.tab.active');
  if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function setHeader(title, buttons) {
  $('#title').textContent = title;
  $('#actions').replaceChildren(...buttons);
}

function emptyState(icon, title, text, buttonLabel, onClick) {
  const box = el('div', 'empty');
  box.innerHTML = icon;
  box.append(el('strong', null, title), el('p', null, text));
  if (buttonLabel) {
    const b = el('button', 'btn-primary', buttonLabel);
    b.type = 'button';
    b.onclick = onClick;
    box.append(b);
  }
  return box;
}

// Laadt een beeld pas in wanneer het (bijna) in beeld komt.
const lazyObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    lazyObserver.unobserve(img);
    photoUrl(img.dataset.id, img.dataset.size).then((url) => {
      if (!url) return;
      img.onload = () => img.classList.add('loaded');
      img.src = url;
    });
  }
}, { root: view, rootMargin: '600px 0px' });

function lazyImg(id, size) {
  const img = el('img');
  img.alt = '';
  img.decoding = 'async';
  img.dataset.id = id;
  img.dataset.size = size;
  lazyObserver.observe(img);
  return img;
}

// ---------- Portfolio-tab ----------

function renderPortfolio(p) {
  if (!p) return setActive(state.portfolios[0].id);

  const photos = p.photoIds.map(photoById).filter(Boolean);

  if (state.editing) {
    setHeader(p.name, [textButton('Klaar', () => { state.editing = false; render(); }, 'bold')]);
  } else {
    setHeader(p.name, [iconButton(ICONS.more, 'Opties', () => portfolioMenu(p))]);
  }

  if (!photos.length) {
    view.replaceChildren(emptyState(ICONS.portfolio, 'Nog leeg',
      "Kies in het tabblad Foto's welke foto's in dit portfolio komen.",
      "Foto's kiezen", () => { state.target = p.id; setActive(LIBRARY); }));
    return;
  }

  if (state.editing) {
    view.replaceChildren(el('p', 'hint', 'Verschuif foto’s met de pijltjes, of haal ze met ✕ uit dit portfolio.'),
      editGrid(p, photos));
    return;
  }

  if (p.layout === 'grid') {
    const grid = el('div', 'grid');
    photos.forEach((photo, i) => {
      const tile = el('button', 'tile');
      tile.type = 'button';
      tile.append(lazyImg(photo.id, 'thumb'));
      tile.onclick = () => openLightbox(photos, i);
      grid.append(tile);
    });
    view.replaceChildren(grid);
  } else {
    const feed = el('div', 'feed');
    photos.forEach((photo, i) => {
      const b = el('button');
      b.type = 'button';
      b.style.aspectRatio = `${photo.w} / ${photo.h}`;
      const img = lazyImg(photo.id, 'full');
      img.classList.add('loaded');
      b.append(img);
      b.onclick = () => openLightbox(photos, i);
      feed.append(b);
    });
    view.replaceChildren(feed);
  }
}

function editGrid(p, photos) {
  const grid = el('div', 'grid');
  photos.forEach((photo, i) => {
    const tile = el('div', 'tile');
    tile.append(lazyImg(photo.id, 'thumb'), el('div', 'edit-number', String(i + 1)));

    const controls = el('div', 'edit-controls');
    const left = el('button', null, '◀');
    const remove = el('button', 'remove', '✕');
    const right = el('button', null, '▶');
    left.disabled = i === 0;
    right.disabled = i === photos.length - 1;
    left.onclick = () => movePhoto(p, photo.id, -1);
    right.onclick = () => movePhoto(p, photo.id, 1);
    remove.onclick = () => {
      p.photoIds = p.photoIds.filter((id) => id !== photo.id);
      savePortfolios();
      render();
    };
    controls.append(left, remove, right);
    tile.append(controls);
    grid.append(tile);
  });
  return grid;
}

function movePhoto(p, id, delta) {
  const ids = p.photoIds.filter((x) => photoById(x));
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  p.photoIds = ids;
  savePortfolios();
  const scroll = view.scrollTop;
  render();
  view.scrollTop = scroll;
}

function portfolioMenu(p) {
  const items = [
    { label: 'Naam wijzigen', action: async () => {
      const name = await askText('Naam wijzigen', p.name, 'Bewaar');
      if (!name) return;
      p.name = name;
      savePortfolios();
      render();
    } },
    { label: p.layout === 'grid' ? 'Toon als lijst' : 'Toon als raster', action: () => {
      p.layout = p.layout === 'grid' ? 'feed' : 'grid';
      savePortfolios();
      render();
    } },
    { label: "Foto's kiezen", action: () => { state.target = p.id; setActive(LIBRARY); } },
  ];
  if (p.photoIds.length > 0) {
    items.push({ label: 'Volgorde aanpassen', action: () => { state.editing = true; render(); } });
  }
  if (state.portfolios.length > 1) {
    items.push({ label: 'Portfolio verwijderen', destructive: true, action: async () => {
      const ok = await confirmDialog(`“${p.name}” verwijderen?`,
        "De foto's zelf blijven bewaard in het tabblad Foto's.", 'Verwijder');
      if (!ok) return;
      const index = state.portfolios.indexOf(p);
      state.portfolios.splice(index, 1);
      savePortfolios();
      setActive(state.portfolios[Math.max(0, index - 1)].id);
    } });
  }
  actionSheet(p.name, items);
}

async function createPortfolio() {
  const name = await askText('Nieuw portfolio', '', 'Maak aan', `Portfolio ${state.portfolios.length + 1}`);
  if (!name) return;
  const p = { id: uid(), name, photoIds: [], layout: 'feed' };
  state.portfolios.push(p);
  await savePortfolios();
  setActive(p.id);
}

// ---------- Foto's-tab ----------

function renderLibrary() {
  if (!portfolioById(state.target)) state.target = state.portfolios[0].id;
  const target = portfolioById(state.target);

  const addButton = iconButton(ICONS.plus, "Foto's toevoegen", () => $('#file-input').click());

  if (state.deleteMode) {
    const n = state.deleteSel.size;
    const del = textButton(n ? `Verwijder (${n})` : 'Verwijder', deleteSelected, 'danger bold');
    del.disabled = n === 0;
    setHeader("Foto's", [textButton('Annuleer', () => {
      state.deleteMode = false;
      state.deleteSel.clear();
      render();
    }), del]);
  } else {
    setHeader("Foto's", [addButton, iconButton(ICONS.more, 'Opties', () => actionSheet("Foto's", [
      { label: "Foto's toevoegen", action: () => $('#file-input').click() },
      { label: "Foto's verwijderen", destructive: true, action: () => { state.deleteMode = true; render(); } },
    ]))]);
  }

  if (!state.photos.length) {
    view.replaceChildren(emptyState(ICONS.photos, "Nog geen foto's",
      "Voeg foto's toe vanuit je fotobibliotheek. Daarna kun je ze per portfolio selecteren.",
      "Foto's toevoegen", () => $('#file-input').click()));
    return;
  }

  const nodes = [];
  if (state.deleteMode) {
    nodes.push(el('p', 'hint', "Tik op de foto's die je uit de app wilt verwijderen."));
  } else {
    const bar = el('div', 'target-bar');
    bar.append(el('span', null, 'Voor:'));
    const select = el('select');
    for (const p of state.portfolios) {
      const opt = el('option', null, p.name);
      opt.value = p.id;
      opt.selected = p.id === target.id;
      select.append(opt);
    }
    select.onchange = () => { state.target = select.value; saveUi(); render(); };
    const count = el('span', 'count');
    bar.append(select, count);
    nodes.push(bar);
  }

  const grid = el('div', `grid${state.deleteMode ? ' delete-mode' : ''}`);
  for (const photo of state.photos) {
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.dataset.id = photo.id;
    tile.append(lazyImg(photo.id, 'thumb'), el('span', 'badge'));
    tile.onclick = () => toggleInLibrary(photo.id);
    grid.append(tile);
  }
  nodes.push(grid);
  view.replaceChildren(...nodes);
  updateLibraryBadges();
}

function updateLibraryBadges() {
  const target = portfolioById(state.target);
  for (const tile of view.querySelectorAll('.tile')) {
    const id = tile.dataset.id;
    const badge = tile.querySelector('.badge');
    let on;
    if (state.deleteMode) {
      on = state.deleteSel.has(id);
      badge.textContent = on ? '✓' : '';
    } else {
      const pos = target.photoIds.indexOf(id);
      on = pos >= 0;
      badge.textContent = on ? String(pos + 1) : '';
    }
    tile.classList.toggle('on', on);
  }
  const count = view.querySelector('.target-bar .count');
  if (count) count.textContent = `${target.photoIds.length} gekozen`;
}

function toggleInLibrary(id) {
  if (state.deleteMode) {
    if (state.deleteSel.has(id)) state.deleteSel.delete(id);
    else state.deleteSel.add(id);
    const n = state.deleteSel.size;
    const del = $('#actions .danger');
    del.textContent = n ? `Verwijder (${n})` : 'Verwijder';
    del.disabled = n === 0;
  } else {
    const p = portfolioById(state.target);
    // Opruimen van verwijzingen naar foto's die niet meer bestaan houdt de nummering kloppend.
    p.photoIds = p.photoIds.filter((x) => photoById(x));
    const pos = p.photoIds.indexOf(id);
    if (pos >= 0) p.photoIds.splice(pos, 1);
    else p.photoIds.push(id);
    savePortfolios();
  }
  updateLibraryBadges();
}

async function deleteSelected() {
  const ids = [...state.deleteSel];
  if (!ids.length) return;
  const ok = await confirmDialog(ids.length === 1 ? 'Foto verwijderen?' : `${ids.length} foto's verwijderen?`,
    "Ze verdwijnen ook uit alle portfolio's. De originelen in je iPhone-fotobibliotheek blijven bestaan.",
    'Verwijder');
  if (!ok) return;
  await store.deletePhotos(ids);
  const gone = new Set(ids);
  state.photos = state.photos.filter((p) => !gone.has(p.id));
  for (const p of state.portfolios) p.photoIds = p.photoIds.filter((id) => !gone.has(id));
  await savePortfolios();
  ids.forEach(forgetUrls);
  state.deleteMode = false;
  state.deleteSel.clear();
  render();
  toast(ids.length === 1 ? 'Foto verwijderd' : `${ids.length} foto's verwijderd`);
}

$('#file-input').addEventListener('change', async (event) => {
  const input = event.target;
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;

  let done = 0;
  let failed = 0;
  toast(`Importeren 0 / ${files.length}…`, 0);
  for (const file of files) {
    try {
      state.photos.unshift(await importFile(file));
      done++;
    } catch (err) {
      console.error(err);
      failed++;
    }
    toast(`Importeren ${done + failed} / ${files.length}…`, 0);
  }
  if (state.active !== LIBRARY) setActive(LIBRARY);
  else render();
  view.scrollTop = 0;
  toast(failed
    ? `${done} toegevoegd, ${failed} mislukt`
    : `${done} ${done === 1 ? 'foto' : "foto's"} toegevoegd`);
});

// ============================================================
//  Foto schermvullend bekijken (vegen voor volgende/vorige)
// ============================================================

const lightbox = $('#lightbox');
const slides = lightbox.querySelector('.lb-slides');
let lbPhotos = [];

function openLightbox(photos, index) {
  lbPhotos = photos;
  slides.replaceChildren(...photos.map((photo) => {
    const slide = el('div', 'lb-slide');
    const img = el('img');
    img.alt = '';
    img.dataset.id = photo.id;
    slide.append(img);
    return slide;
  }));
  lightbox.hidden = false;
  slides.scrollLeft = index * slides.clientWidth;
  updateLightbox(index);
}

function updateLightbox(index) {
  lightbox.querySelector('.lb-count').textContent = `${index + 1} / ${lbPhotos.length}`;
  for (const i of [index, index - 1, index + 1]) {
    const img = slides.children[i]?.querySelector('img');
    if (img && !img.src) photoUrl(img.dataset.id, 'full').then((url) => { img.src = url; });
  }
}

slides.addEventListener('scroll', () => {
  const index = Math.round(slides.scrollLeft / slides.clientWidth);
  if (index >= 0 && index < lbPhotos.length) updateLightbox(index);
}, { passive: true });

lightbox.querySelector('.lb-close').onclick = () => {
  lightbox.hidden = true;
  slides.replaceChildren();
};

// ============================================================
//  Menu's, dialogen en meldingen in iOS-stijl
// ============================================================

function actionSheet(title, items) {
  const overlay = el('div', 'overlay');
  const close = () => overlay.remove();
  const group = el('div', 'sheet-group');
  if (title) group.append(el('div', 'sheet-title', title));
  for (const item of items) {
    const b = el('button', `sheet-btn${item.destructive ? ' destructive' : ''}`, item.label);
    b.type = 'button';
    b.onclick = () => { close(); item.action(); };
    group.append(b);
  }
  const cancelGroup = el('div', 'sheet-group');
  const cancel = el('button', 'sheet-btn cancel', 'Annuleer');
  cancel.type = 'button';
  cancel.onclick = close;
  cancelGroup.append(cancel);
  overlay.append(group, cancelGroup);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.body.append(overlay);
}

function dialog({ title, text, input, okLabel, destructive }) {
  return new Promise((resolve) => {
    const overlay = el('div', 'overlay center');
    const box = el('div', 'dialog');
    box.append(el('h2', null, title));
    if (text) box.append(el('p', null, text));
    let field;
    if (input) {
      field = el('input');
      field.type = 'text';
      field.value = input.value;
      field.placeholder = input.placeholder || '';
      field.enterKeyHint = 'done';
      field.autocapitalize = 'sentences';
      box.append(field);
    }
    const buttons = el('div', 'dialog-buttons');
    const cancel = el('button', null, 'Annuleer');
    const ok = el('button', destructive ? 'destructive' : null, okLabel);
    cancel.type = ok.type = 'button';
    const finish = (value) => { overlay.remove(); resolve(value); };
    cancel.onclick = () => finish(null);
    ok.onclick = () => finish(field ? (field.value.trim() || field.placeholder.trim() || null) : true);
    if (field) field.onkeydown = (e) => { if (e.key === 'Enter') ok.click(); };
    buttons.append(cancel, ok);
    box.append(buttons);
    overlay.append(box);
    document.body.append(overlay);
    if (field) { field.focus(); field.select(); }
  });
}

function askText(title, value, okLabel, placeholder) {
  return dialog({ title, input: { value, placeholder }, okLabel });
}

function confirmDialog(title, text, okLabel) {
  return dialog({ title, text, okLabel, destructive: true }).then(Boolean);
}

let toastTimer;
function toast(message, duration = 2200) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (duration) toastTimer = setTimeout(() => { t.hidden = true; }, duration);
}

// ============================================================
//  Opstarten
// ============================================================

async function init() {
  try {
    const [photos, portfolios, ui] = await Promise.all([
      store.allPhotos(), store.getMeta('portfolios'), store.getMeta('ui'),
    ]);
    state.photos = photos.sort((a, b) => b.added - a.added);
    state.portfolios = portfolios && portfolios.length ? portfolios
      : [{ id: uid(), name: 'Portfolio', photoIds: [], layout: 'feed' }];
    if (!portfolios) await savePortfolios();
    const active = ui && ui.active;
    state.active = active === LIBRARY || portfolioById(active) ? active : state.portfolios[0].id;
    state.target = ui && portfolioById(ui.target) ? ui.target : state.portfolios[0].id;
  } catch (err) {
    console.error(err);
    state.portfolios = [{ id: uid(), name: 'Portfolio', photoIds: [], layout: 'feed' }];
    state.active = state.target = state.portfolios[0].id;
    toast('Opslag is niet beschikbaar op dit toestel', 5000);
  }
  render();

  // Vraag iOS om de opgeslagen foto's niet automatisch op te ruimen.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
