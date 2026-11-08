'use strict';

/* ============================================================
   Présentoirs : vue en grille, gestion, impression
   Numéro d'emplacement = P(résentoir) - L(igne) - C(olonne) - emplacement
   ex. P14-L2-C3-1 : présentoir 14, ligne 2 (du haut), colonne 3 (de la gauche), emplacement 1
   ============================================================ */

let curCase = null;
let caseUrls = [];
let printUrls = [];
let editingCaseNo = null;

const ABBR = {
  'Eau de parfum': 'EDP', 'Eau de toilette': 'EDT', 'Eau de cologne': 'EDC',
  'Extrait de parfum': 'Extrait', 'Parfum': 'Parfum', 'Eau fraîche': 'Eau fr.',
};
const fmtMl = (s) => (s && !isNaN(parseFloat(s)) ? `${parseFloat(s).toFixed(1).replace('.', ',')} ml` : '');
const fmtEuro = (c) => (c === '' || c === undefined || c === null ? '' : `${String(c).replace('.', ',')} €`);

/* ---------- Données ---------- */

function allCaseNumbers() {
  return [...new Set([...cases.map((c) => c.number), ...items.filter(hasLoc).map((i) => i.caseNo)])].sort((a, b) => a - b);
}

function dimsOf(n) {
  const c = cases.find((x) => x.number === n);
  const its = items.filter((i) => hasLoc(i) && i.caseNo === n);
  return {
    name: (c && c.name) || '',
    rows: Math.max((c && c.rows) || 0, ...its.map((i) => i.row), 1),
    cols: Math.max((c && c.cols) || 0, ...its.map((i) => i.col), 1),
    depth: Math.max((c && c.depth) || 0, ...its.map((i) => i.slot), 1),
    defined: !!c,
  };
}

function byCell(n) {
  const map = new Map();
  for (const it of items) {
    if (!hasLoc(it) || it.caseNo !== n) continue;
    const k = `${it.row}-${it.col}-${it.slot}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

/* ---------- Onglets ---------- */

function showView(v) {
  document.body.dataset.view = v;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'cases') renderCases();
  window.scrollTo({ top: 0 });
}
window.showCase = (n) => { curCase = n; showView('cases'); };
window.showView = showView;

window.onRendered = () => {
  if (document.body.dataset.view === 'cases') renderCases();
};

/* ---------- Vue grille d'un présentoir ---------- */

function renderCases() {
  caseUrls.forEach((u) => URL.revokeObjectURL(u));
  caseUrls = [];

  const nums = allCaseNumbers();
  if (!nums.includes(curCase)) curCase = nums.length ? nums[0] : null;

  $('#caseTabs').replaceChildren(...nums.map((n) =>
    h('button', {
      type: 'button', role: 'tab', class: 'case-tab' + (n === curCase ? ' on' : ''),
      onclick: () => { curCase = n; renderCases(); },
    }, `P${n}`)));

  const board = $('#caseBoard');
  board.replaceChildren();

  if (curCase === null) {
    board.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '🗄️'),
      h('h2', {}, 'Aucun présentoir'),
      h('p', {}, 'Créez un présentoir, ou importez votre fichier Excel (menu ⋯ → Importer un fichier Excel / CSV).'),
      h('button', { type: 'button', class: 'btn primary', onclick: openCasesDlg }, 'Créer un présentoir')));
    return;
  }

  const d = dimsOf(curCase);
  const map = byCell(curCase);

  board.append(
    h('h2', { class: 'board-title' }, `Présentoir n°${curCase}`, d.name ? ` · ${d.name}` : ''),
    h('p', { class: 'stats board-stats' },
      `${d.rows} ligne${d.rows > 1 ? 's' : ''} × ${d.cols} colonne${d.cols > 1 ? 's' : ''} · ${map.size} miniature${map.size > 1 ? 's' : ''} rangée${map.size > 1 ? 's' : ''}`),
  );

  for (let r = 1; r <= d.rows; r++) {
    const cols = h('div', { class: 'cslots' });
    for (let c = 1; c <= d.cols; c++) {
      const stack = h('div', { class: 'cstack' });
      for (let s = 1; s <= d.depth; s++) {
        const list = map.get(`${r}-${c}-${s}`);
        const code = codeOf(curCase, r, c, s);
        if (list) {
          const it = list[0];
          let img;
          if (it.photos && it.photos[0]) {
            const url = URL.createObjectURL(it.photos[0]);
            caseUrls.push(url);
            img = h('img', { src: url, alt: '', loading: 'lazy' });
          } else img = h('span', { class: 'cph', 'aria-hidden': 'true' }, '🧴');
          stack.append(h('button', {
            type: 'button', class: 'cell full', title: `${code} — ${it.brand} ${it.name}`,
            onclick: () => openDetail(it.id),
          },
          h('span', { class: 'cnum' }, s),
          h('span', { class: 'cimg' }, img),
          h('span', { class: 'ctext' },
            h('span', { class: 'cname' }, it.name),
            h('span', { class: 'cbrand' }, it.brand)),
          list.length > 1 ? h('span', { class: 'cwarn', title: 'Plusieurs miniatures sur cet emplacement' }, `⚠${list.length}`) : null));
        } else {
          stack.append(h('button', {
            type: 'button', class: 'cell free', title: `${code} — libre, toucher pour ajouter`,
            onclick: () => openForm(null, { caseNo: curCase, row: r, col: c, slot: s }),
          }, h('span', { class: 'cnum' }, s), h('span', { class: 'plus', 'aria-hidden': 'true' }, '+')));
        }
      }
      cols.append(h('div', { class: 'ccol' }, h('div', { class: 'ccol-head' }, `C${c}`), stack));
    }
    board.append(h('div', { class: 'crow' }, h('div', { class: 'crow-label' }, `Ligne ${r}`), cols));
  }
}

/* ---------- Gestion des présentoirs ---------- */

function openCasesDlg() {
  if ($('#menu').open) $('#menu').close();
  resetCaseForm();
  renderCasesList();
  $('#casesDlg').showModal();
}

function nextCaseNumber() {
  const nums = allCaseNumbers();
  return nums.length ? Math.max(...nums) + 1 : 1;
}

function resetCaseForm() {
  editingCaseNo = null;
  const f = $('#caseForm');
  f.reset();
  f.elements.number.readOnly = false;
  f.elements.number.value = nextCaseNumber();
  $('#caseFormTitle').textContent = 'Ajouter un présentoir';
  $('#caseCancel').hidden = true;
}

function renderCasesList() {
  const box = $('#casesList');
  box.replaceChildren();
  const nums = allCaseNumbers();
  if (!nums.length) { box.append(h('p', { class: 'hint' }, 'Aucun présentoir pour l’instant.')); return; }
  for (const n of nums) {
    const d = dimsOf(n);
    const count = items.filter((i) => hasLoc(i) && i.caseNo === n).length;
    box.append(h('div', { class: 'case-item' },
      h('div', { class: 'case-item-text' },
        h('strong', {}, `Présentoir ${n}`, d.name ? ` · ${d.name}` : ''),
        h('span', {}, `${d.rows} lignes × ${d.cols} colonnes × ${d.depth} empl. · ${count} miniature${count > 1 ? 's' : ''}` + (d.defined ? '' : ' · non défini')),
      ),
      h('button', {
        type: 'button', class: 'link',
        onclick: () => {
          editingCaseNo = n;
          const f = $('#caseForm');
          f.elements.number.value = n;
          f.elements.number.readOnly = true;
          f.elements.rows.value = d.rows;
          f.elements.cols.value = d.cols;
          f.elements.depth.value = d.depth;
          f.elements.name.value = d.name;
          $('#caseFormTitle').textContent = `Modifier le présentoir ${n}`;
          $('#caseCancel').hidden = false;
        },
      }, 'Modifier'),
      d.defined ? h('button', {
        type: 'button', class: 'link danger-text',
        onclick: async () => {
          if (!confirm(`Supprimer la définition du présentoir ${n} ?\nLes miniatures gardent leur numéro d’emplacement.`)) return;
          await dbDeleteCase(n);
          await reload();
          resetCaseForm();
          renderCasesList();
        },
      }, 'Supprimer') : null));
  }
}

async function saveCase(e) {
  e.preventDefault();
  const f = $('#caseForm');
  const number = toInt(f.elements.number.value);
  const rows = toInt(f.elements.rows.value);
  const cols = toInt(f.elements.cols.value);
  const depth = toInt(f.elements.depth.value);
  if (!number || !rows || !cols || !depth) { toast('Numéro, lignes, colonnes et emplacements doivent être des nombres positifs.'); return; }
  const exists = cases.some((c) => c.number === number);
  if (exists && editingCaseNo !== number && !confirm(`Le présentoir ${number} existe déjà. Le remplacer ?`)) return;
  await dbPutCase({ number, rows, cols, depth, name: f.elements.name.value.trim() });
  await reload();
  curCase = number;
  resetCaseForm();
  renderCasesList();
  toast('Présentoir enregistré');
}

/* ---------- Impression ---------- */

function openPrintDlg() {
  if ($('#menu').open) $('#menu').close();
  const sel = $('#pScope');
  sel.replaceChildren(
    h('option', { value: '' }, 'Tous les présentoirs'),
    ...allCaseNumbers().map((n) => { const d = dimsOf(n); return h('option', { value: String(n) }, `Présentoir ${n}${d.name ? ' · ' + d.name : ''}`); }),
    h('option', { value: '__filtered' }, 'Résultats de la recherche en cours (tableau)'),
  );
  $('#printDlg').showModal();
}

function pimg(it, withPhotos) {
  if (!withPhotos || !it.photos || !it.photos[0]) return null;
  const url = URL.createObjectURL(it.photos[0]);
  printUrls.push(url);
  return h('img', { src: url, alt: '' });
}

const today = () => new Date().toLocaleDateString('fr-FR');

function sheetTable(list, withPhotos) {
  const head = ['Position'];
  if (withPhotos) head.push('Photo');
  head.push('Parfumeur', 'Parfum', 'Type', 'Cible', 'Ctnce', 'Niveau', 'Boîte', 'Année', 'Rare', 'Cote', 'Observations');
  const cls = { Position: 'pcode', Photo: 'pphoto', Type: 'pc', Cible: 'pc', Niveau: 'pc', 'Boîte': 'pc', 'Année': 'pc', Rare: 'pc', Cote: 'pr', Ctnce: 'pr' };
  return h('table', { class: 'plist' },
    h('thead', {}, h('tr', {}, head.map((t) => h('th', { class: cls[t] || '' }, t)))),
    h('tbody', {}, list.map((it) => h('tr', {},
      h('td', { class: 'pcode' }, locCode(it) || '—'),
      withPhotos ? h('td', { class: 'pphoto' }, pimg(it, true)) : null,
      h('td', {}, it.brand),
      h('td', {}, h('strong', {}, it.name)),
      h('td', { class: 'pc' }, ABBR[it.concentration] || it.concentration || ''),
      h('td', { class: 'pc' }, ({ F: 'F', M: 'M', U: 'Mixte' })[it.cible] || ''),
      h('td', { class: 'pr' }, fmtMl(it.size)),
      h('td', { class: 'pc' }, it.niveau || ''),
      h('td', { class: 'pc' }, it.boite === 'oui' ? 'X' : ''),
      h('td', { class: 'pc' }, it.year || ''),
      h('td', { class: 'pc' }, it.rare || ''),
      h('td', { class: 'pr' }, fmtEuro(it.cote)),
      h('td', { class: 'pobs' }, it.comment || '')))));
}

function sheetSection(title, list, withPhotos) {
  const total = list.reduce((s, i) => s + (parseFloat(i.cote) || 0), 0);
  return h('section', { class: 'psec' },
    h('h1', {}, title),
    h('p', { class: 'psub' }, `${list.length} miniature${list.length > 1 ? 's' : ''}` +
      (total ? ` · cote totale ${fmtEuro(Math.round(total * 100) / 100)}` : '') + ` · imprimé le ${today()}`),
    sheetTable(list, withPhotos));
}

function buildSheets(withPhotos, scope) {
  const byPlace = (a, b) => (locKey(a) === locKey(b) ? String(a.name).localeCompare(String(b.name), 'fr') : locKey(a) < locKey(b) ? -1 : 1);
  if (scope === '__filtered') {
    return [sheetSection('Ma collection de miniatures', [...filtered()].sort(byPlace), withPhotos)];
  }
  const nums = scope ? [Number(scope)] : allCaseNumbers();
  const out = nums.map((n) => {
    const d = dimsOf(n);
    return sheetSection(`Contenu du présentoir n°${n}${d.name ? ' · ' + d.name : ''}`,
      items.filter((i) => hasLoc(i) && i.caseNo === n).sort(byPlace), withPhotos);
  });
  const loose = items.filter((i) => !hasLoc(i));
  if (!scope && loose.length) out.push(sheetSection('Miniatures non rangées', loose.sort(byPlace), withPhotos));
  if (!out.length) out.push(h('p', {}, 'Rien à imprimer.'));
  return out;
}

function buildPlans(withPhotos, scope) {
  const nums = scope && scope !== '__filtered' ? [Number(scope)] : allCaseNumbers();
  const out = [];
  for (const n of nums) {
    const d = dimsOf(n);
    const map = byCell(n);
    const headRow = h('tr', {}, h('th', { class: 'corner' }, ''), ...Array.from({ length: d.cols }, (_, i) => h('th', {}, `C${i + 1}`)));
    const rows = Array.from({ length: d.rows }, (_, ri) => {
      const r = ri + 1;
      return h('tr', {}, h('th', { class: 'rowh' }, `L${r}`),
        ...Array.from({ length: d.cols }, (_, ci) => {
          const c = ci + 1;
          const slots = Array.from({ length: d.depth }, (_, si) => {
            const s = si + 1;
            const list = map.get(`${r}-${c}-${s}`);
            if (!list) return h('div', { class: 'pslot free' }, h('b', {}, s), ' –');
            const it = list[0];
            return h('div', { class: 'pslot' }, h('b', {}, s), pimg(it, withPhotos), h('span', {}, ' ', h('strong', {}, it.name), ' ', h('em', {}, it.brand)));
          });
          return h('td', {}, slots);
        }));
    });
    out.push(h('section', { class: 'psec' },
      h('h1', {}, `Plan du présentoir n°${n}`, d.name ? ` · ${d.name}` : ''),
      h('p', { class: 'psub' }, `${d.rows} lignes × ${d.cols} colonnes · numéro = P${n}-L(igne)-C(olonne)-emplacement · imprimé le ${today()}`),
      h('table', { class: 'pplan' }, h('thead', {}, headRow), h('tbody', {}, rows))));
  }
  if (!out.length) out.push(h('p', {}, 'Aucun présentoir à imprimer.'));
  return out;
}

async function doPrint() {
  const mode = document.querySelector('input[name="pmode"]:checked').value;
  const withPhotos = $('#pPhotos').checked;
  const scope = $('#pScope').value;
  printUrls.forEach((u) => URL.revokeObjectURL(u));
  printUrls = [];
  const area = $('#printArea');
  area.replaceChildren(...(mode === 'plans' ? buildPlans(withPhotos, scope) : buildSheets(withPhotos, scope)));

  let st = document.getElementById('pageStyle');
  if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.append(st); }
  st.textContent = '@page { size: A4 landscape; margin: 10mm; }';

  $('#printDlg').close();
  await Promise.all([...area.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => {}) : Promise.resolve())));
  await new Promise((r) => setTimeout(r, 150));
  window.print();
}

window.addEventListener('afterprint', () => {
  $('#printArea').replaceChildren();
  printUrls.forEach((u) => URL.revokeObjectURL(u));
  printUrls = [];
});

/* ---------- Branchements ---------- */

for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
$('#manageCasesBtn').addEventListener('click', openCasesDlg);
$('#manageCasesBtn2').addEventListener('click', openCasesDlg);
$('#caseForm').addEventListener('submit', saveCase);
$('#caseCancel').addEventListener('click', resetCaseForm);
$('#printBtn').addEventListener('click', openPrintDlg);
$('#doPrint').addEventListener('click', doPrint);
document.body.dataset.view = 'collection';
