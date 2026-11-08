'use strict';

/* ============================================================
   Mes miniatures de parfums — application 100 % locale (PWA)
   Données : IndexedDB (photos incluses). Aucun serveur.
   ============================================================ */

const DB_NAME = 'miniatures-parfums';
const STORE = 'parfums';
const CASES = 'cases';

const CONCENTRATIONS = ['', 'Extrait de parfum', 'Parfum', 'Eau de parfum', 'Eau de toilette', 'Eau de cologne', 'Eau fraîche', 'T', 'Autre'];
const FAMILIES = ['', 'Floral', 'Fruité', 'Boisé', 'Oriental / Ambré', 'Frais / Hespéridé', 'Chypré', 'Fougère', 'Gourmand', 'Cuiré', 'Aquatique', 'Poudré', 'Musqué', 'Autre'];
const STATES = ['Neuve / scellée', 'Ouverte', 'Entamée', 'Vide'];

// Champs de la fiche de présentoir : [valeur enregistrée, libellé]
const LABELED = {
  cible: [['', '—'], ['F', 'F – Féminin'], ['M', 'M – Masculin'], ['U', 'Mixte']],
  niveau: [['', '—'], ['P', 'P – Plein'], ['¾', '¾'], ['½', '½'], ['¼', '¼'], ['V', 'V – Vide']],
  boite: [['', '—'], ['oui', 'Oui'], ['non', 'Non']],
  rare: [['', '—'], ['X', 'X – Rare'], ['XX', 'XX – Très rare']],
};

const MAX_SIDE = 1280;      // taille maximale des photos enregistrées
const JPEG_QUALITY = 0.82;

const $ = (sel, root = document) => root.querySelector(sel);

let db;
let items = [];
let cases = [];             // présentoirs définis : { number, name, rows, slots }
let thumbUrls = [];         // URLs d'objets à libérer à chaque rendu
let editingId = null;
let formPhotos = [];        // [{ blob, url }]
let deferredInstall = null;

/* ---------------- Utilitaires ---------------- */

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- Base de données ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(CASES)) d.createObjectStore(CASES, { keyPath: 'number' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn, store = STORE) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const request = fn(t.objectStore(store));
    t.oncomplete = () => resolve(request ? request.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const dbGetAll = () => run('readonly', (s) => s.getAll());
const dbPut = (o) => run('readwrite', (s) => s.put(o));
const dbDelete = (id) => run('readwrite', (s) => s.delete(id));
const dbGetCases = () => run('readonly', (s) => s.getAll(), CASES);
const dbPutCase = (o) => run('readwrite', (s) => s.put(o), CASES);
const dbDeleteCase = (n) => run('readwrite', (s) => s.delete(n), CASES);

async function reload() {
  items = await dbGetAll();
  cases = await dbGetCases();
  await migrate();
  render();
}

/* ---------------- Emplacements (présentoir - ligne - emplacement) ---------------- */

// Numéro d'emplacement : P(résentoir) - L(igne) - C(olonne) - numéro d'emplacement, ex. P14-L2-C3-1
const hasLoc = (it) => Number.isInteger(it.caseNo) && Number.isInteger(it.row) && Number.isInteger(it.col) && Number.isInteger(it.slot);
const codeOf = (c, r, col, s) => `P${c}-L${r}-C${col}-${s}`;
const locCode = (it) => (hasLoc(it) ? codeOf(it.caseNo, it.row, it.col, it.slot) : '');
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : ''; };
const locKey = (it) => (hasLoc(it) ? it.caseNo * 1e9 + it.row * 1e6 + it.col * 1e3 + it.slot : Infinity);
const sameLoc = (a, b) => hasLoc(a) && a.caseNo === b.caseNo && a.row === b.row && a.col === b.col && a.slot === b.slot;

// Anciennes données (présentoir-ligne-emplacement) : l'ancien « emplacement » devient la colonne
async function migrate() {
  for (const it of items) {
    if (!('col' in it)) {
      const o = { ...it, col: '' };
      if (Number.isInteger(it.caseNo) && Number.isInteger(it.row) && Number.isInteger(it.slot)) { o.col = it.slot; o.slot = 1; }
      Object.assign(it, o);
      await dbPut(it);
    }
  }
  for (const c of cases) {
    if (!('cols' in c)) { c.cols = c.slots || 1; c.depth = 1; delete c.slots; await dbPutCase(c); }
  }
}

/* ---------------- Photos ---------------- */

async function shrinkImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width || bitmap.naturalWidth;
  const hgt = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', JPEG_QUALITY);
  });
}

async function addPhotos(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  for (const f of files) {
    try {
      const blob = await shrinkImage(f);
      formPhotos.push({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      console.error(e);
      toast('Impossible de lire une photo (format non pris en charge).');
    }
  }
  renderPhotoStrip();
}

function renderPhotoStrip() {
  const strip = $('#photoStrip');
  strip.replaceChildren();
  formPhotos.forEach((p, i) => {
    strip.append(
      h('div', { class: 'pthumb' },
        h('img', { src: p.url, alt: 'Photo ' + (i + 1) }),
        h('button', {
          type: 'button', class: 'star' + (i === 0 ? ' on' : ''),
          title: 'Photo principale', 'aria-label': 'Définir comme photo principale',
          onclick: () => { const [x] = formPhotos.splice(i, 1); formPhotos.unshift(x); renderPhotoStrip(); },
        }, '★'),
        h('button', {
          type: 'button', class: 'x', title: 'Retirer', 'aria-label': 'Retirer la photo',
          onclick: () => { URL.revokeObjectURL(p.url); formPhotos.splice(i, 1); renderPhotoStrip(); },
        }, '✕'),
      ),
    );
  });
}

function releaseFormPhotos() {
  formPhotos.forEach((p) => URL.revokeObjectURL(p.url));
  formPhotos = [];
}

/* ---------------- Filtres & rendu ---------------- */

function facet(field) {
  const map = new Map();
  for (const it of items) {
    const label = (it[field] || '').trim();
    if (!label) continue;
    const key = norm(label);
    const cur = map.get(key);
    if (cur) cur.count++;
    else map.set(key, { label, count: 1 });
  }
  return [...map.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label, 'fr', { sensitivity: 'base' }));
}

function fillSelect(sel, placeholder, entries) {
  const current = sel.value;
  sel.replaceChildren(h('option', { value: '' }, placeholder));
  for (const [key, { label, count }] of entries) {
    sel.append(h('option', { value: key }, `${label} (${count})`));
  }
  sel.value = entries.some(([k]) => k === current) ? current : '';
}

function fillDatalist(id, entries) {
  const dl = $(id);
  dl.replaceChildren(...entries.map(([, { label }]) => h('option', { value: label })));
}

function currentFilters() {
  return {
    q: norm($('#q').value),
    cs: $('#fCase').value,
    brand: $('#fBrand').value,
    creator: $('#fCreator').value,
    family: $('#fFamily').value,
    sort: $('#sort').value,
  };
}

function filtered() {
  const f = currentFilters();
  const terms = f.q.split(/\s+/).filter(Boolean);
  // Recherche par numéro : « P14-L2-C3-1 », « 14-2-3-1 », « 14/2/3 » (numéro partiel = tout ce qui commence ainsi)
  const m = f.q.match(/^(?=.*[-./])p?(\d+)(?:\s*[-./]\s*l?(\d+)(?:\s*[-./]\s*c?(\d+)(?:\s*[-./]\s*e?(\d+))?)?)?$/);
  const wanted = m ? [m[1], m[2], m[3], m[4]].filter((x) => x !== undefined).map(Number) : null;
  const list = items.filter((it) => {
    if (wanted) {
      if (!hasLoc(it)) return false;
      const parts = [it.caseNo, it.row, it.col, it.slot];
      return wanted.every((w, i) => parts[i] === w);
    }
    if (f.cs === '__none') { if (hasLoc(it)) return false; }
    else if (f.cs && String(it.caseNo) !== f.cs) return false;
    if (f.brand && norm(it.brand) !== f.brand) return false;
    if (f.creator && norm(it.creator) !== f.creator) return false;
    if (f.family && norm(it.family) !== f.family) return false;
    if (!terms.length) return true;
    const hay = norm([it.name, it.brand, it.creator, it.family, it.concentration, it.year, it.notes, it.comment, it.state, locCode(it)].join(' '));
    return terms.every((t) => hay.includes(t));
  });
  const cmp = (a, b, k) => String(a[k] || '').localeCompare(String(b[k] || ''), 'fr', { sensitivity: 'base' });
  list.sort((a, b) => {
    switch (f.sort) {
      case 'name': return cmp(a, b, 'name');
      case 'creator': return cmp(a, b, 'creator') || cmp(a, b, 'brand') || cmp(a, b, 'name');
      case 'recent': return (b.created || 0) - (a.created || 0);
      case 'place': {
        const ka = locKey(a), kb = locKey(b);
        if (ka === kb) return cmp(a, b, 'brand') || cmp(a, b, 'name');
        return ka < kb ? -1 : 1;
      }
      default: return cmp(a, b, 'brand') || cmp(a, b, 'name');
    }
  });
  return list;
}

function render() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];

  // Liste des présentoirs pour le filtre
  const caseNos = [...new Set([...cases.map((c) => c.number), ...items.filter(hasLoc).map((i) => i.caseNo)])].sort((a, b) => a - b);
  const csSel = $('#fCase');
  const csPrev = csSel.value;
  csSel.replaceChildren(h('option', { value: '' }, 'Tous les présentoirs'));
  for (const n of caseNos) {
    const c = cases.find((x) => x.number === n);
    const cnt = items.filter((i) => hasLoc(i) && i.caseNo === n).length;
    csSel.append(h('option', { value: String(n) }, `Présentoir ${n}${c && c.name ? ' · ' + c.name : ''} (${cnt})`));
  }
  const unplaced = items.filter((i) => !hasLoc(i)).length;
  if (unplaced) csSel.append(h('option', { value: '__none' }, `Non rangées (${unplaced})`));
  csSel.value = [...csSel.options].some((o) => o.value === csPrev) ? csPrev : '';

  if (window.onRendered) window.onRendered();

  const brands = facet('brand');
  const creators = facet('creator');
  const families = facet('family');
  fillSelect($('#fBrand'), 'Toutes les marques', brands);
  fillSelect($('#fCreator'), 'Tous les créateurs', creators);
  fillSelect($('#fFamily'), 'Toutes les familles', families);
  fillDatalist('#brandList', brands);
  fillDatalist('#creatorList', creators);

  const list = filtered();
  const f = currentFilters();
  const hasFilter = !!(f.q || f.cs || f.brand || f.creator || f.family);
  $('#clearFilters').hidden = !hasFilter;

  const total = items.length;
  $('#stats').textContent = total
    ? `${total} miniature${total > 1 ? 's' : ''} · ${brands.length} marque${brands.length > 1 ? 's' : ''}` +
      (hasFilter ? ` · ${list.length} résultat${list.length > 1 ? 's' : ''}` : '')
    : ' ';

  const grid = $('#grid');
  grid.replaceChildren();

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    $('#emptyTitle').textContent = total ? 'Aucun résultat' : 'Votre collection est vide';
    $('#emptyText').replaceChildren(...(total
      ? ['Essayez un autre mot-clé ou effacez les filtres.']
      : ['Touchez le bouton ', h('strong', {}, '+'), ' pour ajouter votre première miniature.']));
    return;
  }

  for (const it of list) {
    let thumbInner;
    if (it.photos && it.photos[0]) {
      const url = URL.createObjectURL(it.photos[0]);
      thumbUrls.push(url);
      thumbInner = h('img', { src: url, alt: it.name, loading: 'lazy' });
    } else {
      thumbInner = h('span', { class: 'ph', 'aria-hidden': 'true' }, '🧴');
    }
    const nPhotos = (it.photos || []).length;
    const meta = [it.creator, it.size ? `${it.size} ml` : ''].filter(Boolean).join(' · ');
    grid.append(
      h('button', { class: 'card', type: 'button', onclick: () => openDetail(it.id) },
        h('div', { class: 'thumb' }, thumbInner,
          hasLoc(it) ? h('span', { class: 'loc' }, locCode(it)) : null,
          nPhotos > 1 ? h('span', { class: 'badge' }, `📷 ${nPhotos}`) : null),
        h('div', { class: 'card-body' },
          h('div', { class: 'card-brand' }, it.brand),
          h('div', { class: 'card-name' }, it.name),
          meta ? h('div', { class: 'card-meta' }, meta) : null,
        ),
      ),
    );
  }
}

/* ---------------- Fiche détail ---------------- */

let detailUrls = [];
let detailId = null;

function openDetail(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  detailId = id;
  detailUrls.forEach((u) => URL.revokeObjectURL(u));
  detailUrls = [];

  const body = $('#detailBody');
  body.replaceChildren();

  if (it.photos && it.photos.length) {
    const car = h('div', { class: 'carousel' });
    it.photos.forEach((b, i) => {
      const url = URL.createObjectURL(b);
      detailUrls.push(url);
      car.append(h('img', { src: url, alt: `${it.name} – photo ${i + 1}`, onclick: () => openLightbox(url) }));
    });
    body.append(car);
  } else {
    body.append(h('div', { class: 'carousel empty-ph', 'aria-hidden': 'true' }, '🧴'));
  }

  const filterBtn = (label, selectId, value) =>
    h('button', {
      type: 'button',
      onclick: () => {
        resetFilters(false);
        $(selectId).value = norm(value);
        $('#detail').close();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    }, label);

  const facts = h('dl', { class: 'facts' });
  const row = (dt, dd) => { if (dd) facts.append(h('dt', {}, dt), h('dd', {}, dd)); };
  row('Marque', filterBtn(it.brand, '#fBrand', it.brand));
  row('Créateur', it.creator ? filterBtn(it.creator, '#fCreator', it.creator) : null);
  row('Année', it.year);
  row('Concentration', it.concentration);
  row('Famille', it.family ? filterBtn(it.family, '#fFamily', it.family) : null);
  row('Contenance', it.size ? `${it.size} ml` : null);
  row('Cible', ({ F: 'Féminin', M: 'Masculin', U: 'Mixte' })[it.cible]);
  row('Niveau', it.niveau ? (it.niveau === 'P' ? 'Plein' : it.niveau === 'V' ? 'Vide' : it.niveau) : null);
  row('Boîte', it.boite === 'oui' ? 'Oui' : it.boite === 'non' ? 'Non' : null);
  row('Rare', it.rare === 'XX' ? 'Très rare (XX)' : it.rare === 'X' ? 'Rare (X)' : null);
  row('Cote', it.cote !== '' && it.cote !== undefined ? `${String(it.cote).replace('.', ',')} €` : null);
  row('État', it.state);
  if (hasLoc(it)) {
    const cdef = cases.find((c) => c.number === it.caseNo);
    row('Emplacement', h('span', {},
      h('strong', {}, locCode(it)),
      ` — présentoir ${it.caseNo}${cdef && cdef.name ? ' (' + cdef.name + ')' : ''}, ligne ${it.row}, colonne ${it.col}, emplacement ${it.slot} `,
      h('button', {
        type: 'button',
        onclick: () => { $('#detail').close(); if (window.showCase) window.showCase(it.caseNo); },
      }, 'Voir dans le présentoir')));
  } else {
    row('Emplacement', 'Non rangée');
  }

  body.append(h('div', { class: 'd-brand' }, it.brand), h('h2', { class: 'd-name' }, it.name), facts);
  if (it.notes) body.append(h('div', { class: 'd-text' }, h('h3', {}, 'Notes olfactives'), it.notes));
  if (it.comment) body.append(h('div', { class: 'd-text' }, h('h3', {}, 'Observations'), it.comment));

  $('#detail').showModal();
}

function openLightbox(url) {
  $('#lightboxImg').src = url;
  $('#lightbox').showModal();
}

/* ---------------- Formulaire ---------------- */

function fillSelectOptions(sel, values) {
  sel.replaceChildren(...values.map((v) => h('option', { value: v }, v || '—')));
}

function updateLocPreview() {
  const f = $('#f');
  const c = toInt(f.elements.caseNo.value), r = toInt(f.elements.row.value), k = toInt(f.elements.col.value), s = toInt(f.elements.slot.value);
  const p = $('#locPreview');
  p.classList.remove('warn');
  if (!c && !r && !k && !s) { p.textContent = 'Laissez vide si non rangée.'; return; }
  if (!c || !r || !k || !s) { p.textContent = 'Renseignez les quatre numéros (présentoir, ligne, colonne, emplacement).'; p.classList.add('warn'); return; }
  const other = items.find((x) => x.id !== editingId && sameLoc(x, { caseNo: c, row: r, col: k, slot: s }));
  p.textContent = `N° ${codeOf(c, r, k, s)}` + (other ? ` — déjà occupé par « ${other.name} »` : '');
  if (other) p.classList.add('warn');
}

function openForm(id = null, prefill = null) {
  editingId = id;
  releaseFormPhotos();
  const f = $('#f');
  f.reset();
  const it = id ? items.find((x) => x.id === id) : null;

  $('#formTitle').textContent = it ? 'Modifier' : 'Nouvelle miniature';
  $('#deleteBtn').hidden = !it;

  for (const name of ['name', 'brand', 'creator', 'year', 'size', 'concentration', 'family', 'state', 'notes', 'comment', 'caseNo', 'row', 'col', 'slot', 'cible', 'niveau', 'boite', 'rare', 'cote']) {
    f.elements[name].value = it ? (it[name] ?? '') : (name === 'state' ? STATES[0] : '');
  }
  if (!it && prefill) {
    f.elements.caseNo.value = prefill.caseNo ?? '';
    f.elements.row.value = prefill.row ?? '';
    f.elements.col.value = prefill.col ?? '';
    f.elements.slot.value = prefill.slot ?? '';
  }
  updateLocPreview();
  if (it && it.photos) {
    formPhotos = it.photos.map((blob) => ({ blob, url: URL.createObjectURL(blob) }));
  }
  renderPhotoStrip();
  $('#form').showModal();
  $('.sheet-body', $('#form')).scrollTop = 0;
}

async function saveForm(e) {
  e.preventDefault();
  const f = $('#f');
  const val = (n) => f.elements[n].value.trim();

  if (!val('name') || !val('brand')) {
    toast('Le nom et la marque sont obligatoires.');
    return;
  }
  const caseNo = toInt(f.elements.caseNo.value), row = toInt(f.elements.row.value), col = toInt(f.elements.col.value), slot = toInt(f.elements.slot.value);
  const nbLoc = [caseNo, row, col, slot].filter(Boolean).length;
  if (nbLoc > 0 && nbLoc < 4) {
    toast('Emplacement incomplet : renseignez présentoir, ligne, colonne et emplacement (ou laissez les quatre vides).');
    return;
  }
  const existing = editingId ? items.find((x) => x.id === editingId) : null;
  if (nbLoc === 4) {
    const other = items.find((x) => x.id !== (existing && existing.id) && sameLoc(x, { caseNo, row, col, slot }));
    if (other && !confirm(`L’emplacement ${codeOf(caseNo, row, col, slot)} est déjà occupé par « ${other.name} ». Enregistrer quand même ?`)) return;
  }
  const now = Date.now();
  const record = {
    id: existing ? existing.id : uid(),
    name: val('name'),
    brand: val('brand'),
    creator: val('creator'),
    year: val('year'),
    size: val('size').replace(',', '.'),
    concentration: val('concentration'),
    family: val('family'),
    state: val('state'),
    notes: val('notes'),
    comment: val('comment'),
    caseNo: nbLoc === 4 ? caseNo : '',
    row: nbLoc === 4 ? row : '',
    col: nbLoc === 4 ? col : '',
    slot: nbLoc === 4 ? slot : '',
    cible: val('cible'),
    niveau: val('niveau'),
    boite: val('boite'),
    rare: val('rare'),
    cote: val('cote').replace(',', '.'),
    photos: formPhotos.map((p) => p.blob),
    created: existing ? existing.created : now,
    updated: now,
  };
  try {
    await dbPut(record);
  } catch (err) {
    console.error(err);
    toast('Échec de l’enregistrement (espace de stockage plein ?).');
    return;
  }
  $('#form').close();
  releaseFormPhotos();
  await reload();
  toast(existing ? 'Modifications enregistrées' : 'Miniature ajoutée');
}

async function deleteCurrent() {
  if (!editingId) return;
  const it = items.find((x) => x.id === editingId);
  if (!confirm(`Supprimer « ${it ? it.name : 'cette miniature'} » ? Cette action est définitive.`)) return;
  await dbDelete(editingId);
  $('#form').close();
  $('#detail').close();
  releaseFormPhotos();
  await reload();
  toast('Miniature supprimée');
}

/* ---------------- Sauvegarde / restauration ---------------- */

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function exportData() {
  if (!items.length && !cases.length) { toast('Rien à exporter pour l’instant.'); return; }
  toast('Préparation de la sauvegarde…');
  const out = [];
  for (const it of items) {
    out.push({ ...it, photos: await Promise.all((it.photos || []).map(blobToDataURL)) });
  }
  const json = JSON.stringify({ app: 'miniatures-parfums', version: 3, exported: new Date().toISOString(), cases, items: out });
  const name = `miniatures-parfums-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Sauvegarde téléchargée');
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.items)) throw new Error('format');
    let n = 0;
    for (const c of data.cases || []) {
      if (c && Number.isInteger(c.number) && c.number > 0) {
        const oldFormat = !('cols' in c);   // anciennes sauvegardes : rows × slots
        await dbPutCase({
          number: c.number, name: String(c.name || ''), rows: toInt(c.rows) || 1,
          cols: toInt(oldFormat ? c.slots : c.cols) || 1, depth: oldFormat ? 1 : (toInt(c.depth) || 1),
        });
      }
    }
    for (const raw of data.items) {
      if (!raw || !raw.name || !raw.brand) continue;
      const photos = [];
      for (const p of raw.photos || []) {
        if (typeof p === 'string' && p.startsWith('data:')) photos.push(await (await fetch(p)).blob());
      }
      await dbPut({
        id: raw.id || uid(),
        name: String(raw.name), brand: String(raw.brand),
        creator: raw.creator || '', year: raw.year || '', size: raw.size || '',
        concentration: raw.concentration || '', family: raw.family || '',
        state: raw.state || '', notes: raw.notes || '', comment: raw.comment || '',
        ...(('col' in raw)
          ? { caseNo: toInt(raw.caseNo), row: toInt(raw.row), col: toInt(raw.col), slot: toInt(raw.slot) }
          : { caseNo: toInt(raw.caseNo), row: toInt(raw.row), col: toInt(raw.slot), slot: toInt(raw.slot) ? 1 : '' }),
        cible: raw.cible || '', niveau: raw.niveau || '', boite: raw.boite || '', rare: raw.rare || '', cote: raw.cote ?? '',
        photos, created: raw.created || Date.now(), updated: raw.updated || Date.now(),
      });
      n++;
    }
    await reload();
    toast(`${n} miniature${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}`);
  } catch (e) {
    console.error(e);
    toast('Fichier de sauvegarde invalide.');
  }
}

/* ---------------- Filtres ---------------- */

function resetFilters(redraw = true) {
  $('#q').value = '';
  $('#fCase').value = '';
  $('#fBrand').value = '';
  $('#fCreator').value = '';
  $('#fFamily').value = '';
  if (redraw) render();
}

/* ---------------- Initialisation ---------------- */

function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('#installBtn').hidden = false;
  });
  window.addEventListener('appinstalled', () => { deferredInstall = null; $('#installBtn').hidden = true; toast('Application installée'); });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('#installBtn').hidden = true;
  });
  const hint = $('#installHint');
  if (isStandalone()) hint.textContent = '';
  else if (isIOS()) hint.textContent = 'Pour installer : bouton Partager ⎋ puis « Sur l’écran d’accueil ».';
  else hint.textContent = 'Pour installer : menu du navigateur → « Installer l’application » ou « Ajouter à l’écran d’accueil ».';
}

function setup() {
  fillSelectOptions($('#f').elements.concentration, CONCENTRATIONS);
  fillSelectOptions($('#f').elements.family, FAMILIES);
  fillSelectOptions($('#f').elements.state, STATES);
  for (const [name, opts] of Object.entries(LABELED)) {
    $('#f').elements[name].replaceChildren(...opts.map(([v, l]) => h('option', { value: v }, l)));
  }

  $('#q').addEventListener('input', render);
  for (const id of ['#fCase', '#fBrand', '#fCreator', '#fFamily', '#sort']) $(id).addEventListener('change', render);
  for (const n of ['caseNo', 'row', 'col', 'slot']) $('#f').elements[n].addEventListener('input', updateLocPreview);
  $('#clearFilters').addEventListener('click', () => resetFilters());

  $('#fab').addEventListener('click', () => openForm());
  $('#editBtn').addEventListener('click', () => { $('#detail').close(); openForm(detailId); });
  $('#f').addEventListener('submit', saveForm);
  $('#deleteBtn').addEventListener('click', deleteCurrent);

  $('#camBtn').addEventListener('click', () => $('#camInput').click());
  $('#galBtn').addEventListener('click', () => $('#galInput').click());
  for (const id of ['#camInput', '#galInput']) {
    $(id).addEventListener('change', async (e) => { await addPhotos(e.target.files); e.target.value = ''; });
  }

  $('#menuBtn').addEventListener('click', () => $('#menu').showModal());
  $('#exportBtn').addEventListener('click', async () => { $('#menu').close(); await exportData(); });
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    $('#menu').close();
    if (file) await importData(file);
  });

  // Fermeture des fenêtres : bouton [data-close], clic sur le fond, échap
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      const d = closer.closest('dialog');
      if (d) d.close();
    }
  });
  for (const d of document.querySelectorAll('dialog.modal, dialog.lightbox')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  $('#lightbox').addEventListener('click', () => $('#lightbox').close());
  $('#form').addEventListener('close', releaseFormPhotos);
  $('#detail').addEventListener('close', () => {
    detailUrls.forEach((u) => URL.revokeObjectURL(u));
    detailUrls = [];
  });

  setupInstall();
}

async function init() {
  setup();
  try {
    db = await openDB();
    await reload();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    console.error(e);
    toast('Stockage local indisponible (navigation privée ?).');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
