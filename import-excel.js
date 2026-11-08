'use strict';

/* ============================================================
   Import d'un fichier Excel (.xlsx, .xls), LibreOffice (.ods) ou CSV, sans aucune bibliothèque externe.
   Colonnes reconnues (peu importe l'ordre, accents et majuscules ignorés) :
   Position · Parfumeur/Marque · Parfum/Nom · Type · Cible · Ctnce/Contenance · Niveau ·
   Boîte · Année · Rare · Cote · Observations
   La Position se lit au format P14-L2-C3-1 (présentoir, ligne, colonne, emplacement).
   ============================================================ */

/* ---------- Lecture d'un .xlsx (zip + XML) ---------- */

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Fichier .xlsx invalide');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    files[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async (name) => {
    const f = files[name];
    if (!f) return null;
    const bytes = f.method === 0 ? f.data : await inflateRaw(f.data);
    return dec.decode(bytes);
  };
  return { files, read };
}

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const colIndex = (ref) => {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

async function parseXlsx(buffer) {
  const zip = await unzip(buffer);

  const shared = [];
  const sstXml = await zip.read('xl/sharedStrings.xml');
  if (sstXml) {
    for (const si of xml(sstXml).getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
    }
  }

  // Première feuille du classeur
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wb = xml(await zip.read('xl/workbook.xml'));
    const rels = xml(await zip.read('xl/_rels/workbook.xml.rels'));
    const first = wb.getElementsByTagName('sheet')[0];
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    for (const r of rels.getElementsByTagName('Relationship')) {
      if (r.getAttribute('Id') === rid) {
        const t = r.getAttribute('Target');
        sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.?\//, '');
      }
    }
  } catch (_) { /* on garde sheet1 */ }

  const sheetXml = await zip.read(sheetPath);
  if (!sheetXml) throw new Error('Feuille introuvable');
  const rows = [];
  for (const row of xml(sheetXml).getElementsByTagName('row')) {
    const arr = [];
    for (const c of row.getElementsByTagName('c')) {
      const idx = colIndex(c.getAttribute('r') || 'A1');
      const type = c.getAttribute('t');
      let val = '';
      if (type === 'inlineStr') val = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      else {
        const v = c.getElementsByTagName('v')[0];
        if (v) val = type === 's' ? (shared[+v.textContent] ?? '') : v.textContent;
      }
      arr[idx] = val;
    }
    rows.push(arr);
  }
  return rows;
}



/* ---------- Lecture d'un ancien .xls (Excel 97-2003, format BIFF8 dans un conteneur OLE2) ---------- */

function parseXls(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const FREE = 0xFFFFFFFA;                                   // valeurs >= : secteurs spéciaux
  const ss = 1 << dv.getUint16(30, true);
  const mss = 1 << dv.getUint16(32, true);
  const dirStart = dv.getUint32(48, true);
  const cutoff = dv.getUint32(56, true);
  const miniStart = dv.getUint32(60, true);
  const difStart = dv.getUint32(68, true);
  const numDif = dv.getUint32(72, true);
  const off = (n) => (n + 1) * ss;

  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = dv.getUint32(76 + i * 4, true); if (s < FREE) fatSectors.push(s); }
  let d = difStart;
  for (let k = 0; k < numDif && d < FREE; k++) {
    for (let i = 0; i < ss / 4 - 1; i++) { const s = dv.getUint32(off(d) + i * 4, true); if (s < FREE) fatSectors.push(s); }
    d = dv.getUint32(off(d) + ss - 4, true);
  }
  const fat = [];
  for (const s of fatSectors) for (let i = 0; i < ss / 4; i++) fat.push(dv.getUint32(off(s) + i * 4, true));

  const chain = (start, table) => {
    const out = [];
    for (let s = start; s < FREE && out.length <= table.length; s = table[s]) out.push(s);
    return out;
  };
  const readBig = (start, size) => {
    const secs = chain(start, fat);
    const out = new Uint8Array(secs.length * ss);
    secs.forEach((s, i) => out.set(u8.subarray(off(s), off(s) + ss), i * ss));
    return size === undefined ? out : out.subarray(0, size);
  };

  const dir = readBig(dirStart);
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  let root = null, book = null;
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = ddv.getUint16(p + 64, true);
    let name = '';
    for (let i = 0; i < Math.max(0, nameLen / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(p + i * 2, true));
    const e = { name, type: dir[p + 66], start: ddv.getUint32(p + 116, true), size: ddv.getUint32(p + 120, true) };
    if (e.type === 5) root = e;
    if (e.type === 2 && (name === 'Workbook' || name === 'Book')) book = e;
  }
  if (!book) throw new Error('Classeur Excel introuvable dans le fichier');

  let wb;
  if (book.size >= cutoff) wb = readBig(book.start, book.size);
  else {                                                      // petit classeur : flux « mini »
    const mf = readBig(miniStart);
    const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    const miniFat = [];
    for (let i = 0; i < mf.length / 4; i++) miniFat.push(mdv.getUint32(i * 4, true));
    const ministream = readBig(root.start, root.size);
    const secs = chain(book.start, miniFat);
    wb = new Uint8Array(secs.length * mss);
    secs.forEach((s, i) => wb.set(ministream.subarray(s * mss, s * mss + mss), i * mss));
    wb = wb.subarray(0, book.size);
  }

  // Découpage en enregistrements BIFF
  const wdv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const recs = [];
  for (let p = 0; p + 4 <= wb.length;) {
    const id = wdv.getUint16(p, true), len = wdv.getUint16(p + 2, true);
    recs.push({ id, pos: p, data: wb.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }

  // Table des chaînes partagées (SST + CONTINUE)
  const sst = [];
  const si = recs.findIndex((r) => r.id === 0x00FC);
  if (si >= 0) {
    const chunks = [recs[si].data.subarray(8)];
    for (let i = si + 1; i < recs.length && recs[i].id === 0x003C; i++) chunks.push(recs[i].data);
    const unique = new DataView(recs[si].data.buffer, recs[si].data.byteOffset, recs[si].data.byteLength).getUint32(4, true);
    let ci = 0, pos = 0;
    const u8n = () => { while (ci < chunks.length && pos >= chunks[ci].length) { ci++; pos = 0; } return ci < chunks.length ? chunks[ci][pos++] : 0; };
    const skip = (n) => { while (n > 0 && ci < chunks.length) { if (pos >= chunks[ci].length) { ci++; pos = 0; continue; } const t = Math.min(n, chunks[ci].length - pos); pos += t; n -= t; } };
    for (let k = 0; k < unique && ci < chunks.length; k++) {
      const cch = u8n() | (u8n() << 8);
      const flags = u8n();
      let rich = 0, ext = 0;
      if (flags & 8) rich = u8n() | (u8n() << 8);
      if (flags & 4) ext = u8n() | (u8n() << 8) | (u8n() << 16) | (u8n() * 16777216);
      let wide = flags & 1, left = cch, str = '';
      while (left > 0 && ci < chunks.length) {
        const c = chunks[ci];
        const avail = Math.floor((c.length - pos) / (wide ? 2 : 1));
        if (avail <= 0) { ci++; pos = 0; if (ci < chunks.length) wide = chunks[ci][pos++] & 1; continue; }
        const take = Math.min(left, avail);
        for (let j = 0; j < take; j++) {
          if (wide) { str += String.fromCharCode(c[pos] | (c[pos + 1] << 8)); pos += 2; } else str += String.fromCharCode(c[pos++]);
        }
        left -= take;
      }
      skip(rich * 4 + ext);
      sst.push(str);
    }
  }

  // Première feuille : position donnée par le premier enregistrement BOUNDSHEET
  const bs = recs.find((r) => r.id === 0x0085);
  if (!bs) throw new Error('Feuille introuvable');
  const sheetPos = new DataView(bs.data.buffer, bs.data.byteOffset, bs.data.byteLength).getUint32(0, true);
  let ri = recs.findIndex((r) => r.pos === sheetPos);
  if (ri < 0) throw new Error('Feuille introuvable');

  const rk = (v) => {
    let n;
    if (v & 2) n = (v | 0) >> 2;
    else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, (v & 0xFFFFFFFC) >>> 0, true); n = b.getFloat64(0, true); }
    return v & 1 ? n / 100 : n;
  };
  const numStr = (n) => String(Math.round(n * 1e6) / 1e6);
  const rows = [];
  const put = (r, c, v) => { (rows[r] = rows[r] || [])[c] = v; };
  let depth = 0;
  for (; ri < recs.length; ri++) {
    const { id, data } = recs[ri];
    if (id === 0x0809) { depth++; continue; }
    if (id === 0x000A) { depth--; if (depth <= 0) break; continue; }
    if (!data.length) continue;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (id === 0x00FD) put(v.getUint16(0, true), v.getUint16(2, true), sst[v.getUint32(6, true)] ?? '');
    else if (id === 0x0203) put(v.getUint16(0, true), v.getUint16(2, true), numStr(v.getFloat64(6, true)));
    else if (id === 0x027E) put(v.getUint16(0, true), v.getUint16(2, true), numStr(rk(v.getUint32(6, true))));
    else if (id === 0x00BD) {
      const r = v.getUint16(0, true), c0 = v.getUint16(2, true), n = (data.length - 6) / 6;
      for (let i = 0; i < n; i++) put(r, c0 + i, numStr(rk(v.getUint32(4 + i * 6 + 2, true))));
    } else if (id === 0x0204) {
      const cch = v.getUint16(6, true);
      let s = '';
      if (data.length > 8 && (data[8] & 1)) for (let i = 0; i < cch; i++) s += String.fromCharCode(v.getUint16(9 + i * 2, true));
      else for (let i = 0; i < cch; i++) s += String.fromCharCode(data[9 + i] ?? 0);
      put(v.getUint16(0, true), v.getUint16(2, true), s);
    } else if (id === 0x0006 && data.length >= 14 && !(data[12] === 0xFF && data[13] === 0xFF)) {
      put(v.getUint16(0, true), v.getUint16(2, true), numStr(v.getFloat64(6, true)));
    }
  }
  return Array.from(rows, (r) => r || []);
}

/* ---------- Lecture d'un .ods (LibreOffice / OpenOffice) ---------- */

async function parseOds(zip) {
  const doc = xml(await zip.read('content.xml'));
  const table = doc.getElementsByTagName('table:table')[0];
  if (!table) throw new Error('Feuille introuvable');
  const rows = [];
  for (const tr of table.getElementsByTagName('table:table-row')) {
    const arr = [];
    for (const c of tr.children) {
      if (c.tagName !== 'table:table-cell' && c.tagName !== 'table:covered-table-cell') continue;
      const rep = parseInt(c.getAttribute('table:number-columns-repeated') || '1', 10);
      const type = c.getAttribute('office:value-type');
      let val = [...c.getElementsByTagName('text:p')].map((p) => p.textContent).join(' ');
      if (type === 'float' || type === 'percentage' || type === 'currency') val = c.getAttribute('office:value') ?? val;
      if (val === '' && rep > 50) { arr.length += rep; continue; }
      for (let i = 0; i < Math.min(rep, 50); i++) arr.push(val);
    }
    const repRow = parseInt(tr.getAttribute('table:number-rows-repeated') || '1', 10);
    const empty = !arr.some((v) => String(v ?? '').trim() !== '');
    if (empty) { if (repRow > 50) continue; }
    for (let i = 0; i < Math.min(repRow, empty ? 1 : 50); i++) rows.push(arr);
  }
  return rows;
}

/* ---------- Lecture d'un CSV ---------- */

async function parseCsv(buffer) {
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buffer);
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ---------- Interprétation des colonnes ---------- */

const HEADERS = {
  pos: ['position', 'emplacement', 'n', 'numero', 'localisation'],
  brand: ['parfumeur', 'marque', 'maison', 'createur marque'],
  name: ['parfum', 'nom', 'nom du parfum', 'miniature'],
  creator: ['createur', 'nez', 'auteur'],
  concentration: ['type', 'concentration'],
  cible: ['cible', 'genre', 'sexe'],
  size: ['ctnce', 'contenance', 'volume', 'ml', 'cont'],
  niveau: ['niveau', 'remplissage'],
  boite: ['boite', 'boite'],
  year: ['annee', 'date'],
  rare: ['rare', 'rarete'],
  cote: ['cote', 'prix', 'valeur', 'estimation'],
  comment: ['observations', 'observation', 'remarques', 'commentaire', 'commentaires'],
  notes: ['notes', 'notes olfactives'],
  family: ['famille', 'famille olfactive'],
};

function mapHeader(cells) {
  const idx = {};
  cells.forEach((raw, i) => {
    const key = norm(raw).replace(/[^a-z0-9 ]/g, '').trim();
    for (const [field, names] of Object.entries(HEADERS)) {
      if (idx[field] === undefined && names.includes(key)) idx[field] = i;
    }
  });
  return idx;
}

const cellText = (v) => String(v ?? '').trim();
const num = (v) => { const m = cellText(v).replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)/); return m ? m[1].replace(',', '.') : ''; };

function parsePosition(v) {
  const m = cellText(v).match(/p\s*(\d+)\s*[-._/ ]*\s*l\s*(\d+)\s*[-._/ ]*\s*c\s*(\d+)\s*[-._/ ]*\s*e?\s*(\d+)/i);
  return m ? { caseNo: +m[1], row: +m[2], col: +m[3], slot: +m[4] } : null;
}

function normConcentration(v) {
  const t = cellText(v);
  const u = norm(t).replace(/[^a-z]/g, '');
  const map = { edt: 'Eau de toilette', edp: 'Eau de parfum', edc: 'Eau de cologne', extrait: 'Extrait de parfum', ext: 'Extrait de parfum', parfum: 'Parfum', pdt: 'Eau de toilette' };
  return map[u] || t;
}
function normCible(v) {
  const t = norm(cellText(v));
  if (!t) return '';
  if (/^(f|femme|feminin|dame)/.test(t)) return 'F';
  if (/^(m$|h|homme|masculin)/.test(t)) return 'M';
  if (/^(u|mixte|unisexe|fh|mf|x)/.test(t)) return 'U';
  return '';
}
function normNiveau(v) {
  const t = cellText(v).toLowerCase();
  if (!t) return '';
  if (t === 'p' || t.startsWith('plein') || t === '100%' || t === '1') return 'P';
  if (t === 'v' || t.startsWith('vide') || t === '0') return 'V';
  if (['¼', '1/4', '25%', '0.25', '0,25'].includes(t)) return '¼';
  if (['½', '1/2', '50%', '0.5', '0,5'].includes(t)) return '½';
  if (['¾', '3/4', '75%', '0.75', '0,75'].includes(t)) return '¾';
  return '';
}
function normBoite(v) {
  const t = norm(cellText(v));
  if (!t) return '';
  if (/^(non|no|n|0|-|faux)$/.test(t)) return 'non';
  return 'oui';
}
function normRare(v) {
  const t = norm(cellText(v));
  if (!t) return '';
  if (/^x{2,}$/.test(t) || t.includes('tres')) return 'XX';
  return 'X';
}

function rowsToRecords(rows) {
  // ligne d'en-têtes : la première qui contient un « parfum » et une « position »/« parfumeur »
  let hi = -1, idx = {};
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const m = mapHeader(rows[i] || []);
    if (m.name !== undefined && (m.pos !== undefined || m.brand !== undefined)) { hi = i; idx = m; break; }
  }
  if (hi < 0) throw new Error('En-têtes non reconnus : il faut au moins les colonnes « Parfum » et « Position » (ou « Parfumeur »).');
  const get = (r, f) => (idx[f] === undefined ? '' : r[idx[f]]);

  const out = [];
  for (const r of rows.slice(hi + 1)) {
    if (!r || !r.some((c) => cellText(c))) continue;
    const name = cellText(get(r, 'name'));
    const brand = cellText(get(r, 'brand'));
    if (!name && !brand) continue;
    const pos = parsePosition(get(r, 'pos'));
    out.push({
      name: name || '(sans nom)',
      brand: brand || '(à compléter)',
      creator: cellText(get(r, 'creator')),
      concentration: normConcentration(get(r, 'concentration')),
      cible: normCible(get(r, 'cible')),
      size: num(get(r, 'size')),
      niveau: normNiveau(get(r, 'niveau')),
      boite: normBoite(get(r, 'boite')),
      year: (cellText(get(r, 'year')).match(/\d{4}/) || [''])[0],
      rare: normRare(get(r, 'rare')),
      cote: num(get(r, 'cote')),
      comment: cellText(get(r, 'comment')),
      notes: cellText(get(r, 'notes')),
      family: cellText(get(r, 'family')),
      loc: pos,
      rawPos: cellText(get(r, 'pos')),
    });
  }
  return out;
}

/* ---------- Enregistrement ---------- */

async function importSpreadsheet(file) {
  let rows;
  try {
    const buf = await file.arrayBuffer();
    const sig = new Uint8Array(buf, 0, 4).join();
    if (sig === '80,75,3,4') {                                    // « PK » : .xlsx ou .ods
      const zip = await unzip(buf);
      rows = zip.files['content.xml'] ? await parseOds(zip) : await parseXlsx(buf);
    } else if (sig === '208,207,17,224') rows = parseXls(buf);   // ancien .xls
    else rows = await parseCsv(buf);
  } catch (e) {
    console.error(e);
    toast('Impossible de lire ce fichier : ' + (e && e.message ? e.message : 'format non reconnu') + ' (formats acceptés : .xlsx, .xls, .ods, .csv).');
    return;
  }

  let recs;
  try { recs = rowsToRecords(rows); } catch (e) { toast(e.message); return; }
  if (!recs.length) { toast('Aucune ligne à importer dans ce fichier.'); return; }

  // Rapprochement avec l'existant : même emplacement, sinon même marque + nom + contenance
  const matchOf = (rec) => items.find((it) => (rec.loc && hasLoc(it) && sameLoc(it, rec.loc))
    || (norm(it.brand) === norm(rec.brand) && norm(it.name) === norm(rec.name) && String(it.size) === String(rec.size) && !hasLoc(it) && !rec.loc));
  const nUpdate = recs.filter((r) => matchOf(r)).length;
  const nLoose = recs.filter((r) => !r.loc).length;
  const msg = `${recs.length} miniature${recs.length > 1 ? 's' : ''} trouvée${recs.length > 1 ? 's' : ''} dans « ${file.name} ».\n` +
    `• ${recs.length - nUpdate} nouvelle${recs.length - nUpdate > 1 ? 's' : ''}\n• ${nUpdate} déjà présente${nUpdate > 1 ? 's' : ''} (mise${nUpdate > 1 ? 's' : ''} à jour, photos conservées)\n` +
    (nLoose ? `• ${nLoose} sans position lisible (importée${nLoose > 1 ? 's' : ''} comme non rangée${nLoose > 1 ? 's' : ''})\n` : '') + '\nImporter ?';
  if (!confirm(msg)) return;

  const now = Date.now();
  const dims = new Map();
  let k = 0;
  for (const rec of recs) {
    const ex = matchOf(rec);
    const loc = rec.loc || { caseNo: '', row: '', col: '', slot: '' };
    const record = {
      id: ex ? ex.id : uid(),
      name: rec.name, brand: rec.brand, creator: rec.creator || (ex ? ex.creator : ''),
      year: rec.year, size: rec.size, concentration: rec.concentration,
      family: rec.family || (ex ? ex.family : ''), state: ex ? ex.state : STATES[0],
      notes: rec.notes || (ex ? ex.notes : ''), comment: rec.comment,
      caseNo: loc.caseNo, row: loc.row, col: loc.col, slot: loc.slot,
      cible: rec.cible, niveau: rec.niveau, boite: rec.boite, rare: rec.rare, cote: rec.cote,
      photos: ex ? ex.photos || [] : [],
      created: ex ? ex.created : now + k++, updated: now,
    };
    await dbPut(record);
    if (rec.loc) {
      const d = dims.get(rec.loc.caseNo) || { rows: 0, cols: 0, depth: 0 };
      d.rows = Math.max(d.rows, rec.loc.row); d.cols = Math.max(d.cols, rec.loc.col); d.depth = Math.max(d.depth, rec.loc.slot);
      dims.set(rec.loc.caseNo, d);
    }
  }
  for (const [number, d] of dims) {
    const c = cases.find((x) => x.number === number);
    await dbPutCase({
      number, name: c ? c.name : '',
      rows: Math.max(d.rows, c ? c.rows : 0), cols: Math.max(d.cols, c ? c.cols : 0), depth: Math.max(d.depth, c ? c.depth : 0),
    });
  }
  await reload();
  toast(`${recs.length} miniature${recs.length > 1 ? 's' : ''} importée${recs.length > 1 ? 's' : ''}`);
  const first = [...dims.keys()].sort((a, b) => a - b)[0];
  if (first !== undefined && window.showCase) window.showCase(first);
}

$('#xlsBtn').addEventListener('click', () => $('#xlsInput').click());
$('#xlsInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  $('#menu').close();
  if (file) await importSpreadsheet(file);
});
