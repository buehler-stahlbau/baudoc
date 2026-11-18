/* =========================================================
   BauDoc – Oberfläche
========================================================= */
import { CONFIG, APP_VERSION } from "./config.js";
import * as db from "./db.js";
import * as od from "./onedrive.js";
import * as sync from "./sync.js";
import {
  S, load, saveNow, saveSoon, touchProject, touchDoc, onChange,
  findProject, findByNumber, newProject, moveLocal, removeProjectLocal,
  allProjects, imagesOfDoc, imagesOfProject,
} from "./store.js";
import { processFile, makeThumb } from "./images.js";
import { buildPdf, PDF_MAX_BYTES } from "./pdf.js";
import { exportBackup, importBackup } from "./backup.js";
import { escapeHtml as h, formatDateDE, formatDateTimeDE, newId, toast } from "./util.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ---------- Flüchtige UI-Daten (nicht gespeichert) ---------- */
const drafts = {};      // docId -> Text "Neuer Eintrag"
const draftImgs = {};   // docId -> [imageId] für "Neuer Eintrag"
let filterText = "";
let pendingRender = false;
const loadingProjects = new Set();

/* ---------- Status-Overlay ---------- */
function setBusy(msg) {
  const b = $("#busy");
  if (!msg) { b.style.display = "none"; return; }
  b.textContent = msg;
  b.style.display = "block";
}

/* ---------- Fehler sichtbar machen ---------- */
window.addEventListener("error", (e) => {
  toast("Fehler: " + (e.message || "unbekannt"), "error", 8000);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  toast("Fehler: " + ((r && r.message) || r || "unbekannt"), "error", 8000);
});

/* ---------- Kontext ---------- */
function ctx() {
  const st = S.state;
  const p = st.selectedProjectId ? findProject(st.selectedProjectId) : null;
  const d = p && p.docs && st.selectedDocId ? p.docs.find((x) => x.id === st.selectedDocId) || null : null;
  return { p, d };
}

function go(changes) {
  Object.assign(S.state, changes);
  saveSoon();
  render();
}

/* =========================================================
   Vorschaubilder
========================================================= */
const thumbUrls = new Map();

async function thumbUrl(id, rid) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  let rec = null;
  try { rec = await db.imgGet(id); } catch {}
  let blob = rec && rec.thumb;
  if (!blob && rec && rec.archive) {
    try {
      blob = await makeThumb(rec.archive);
      await db.imgPut({ ...rec, thumb: blob });
    } catch {}
  }
  if (!blob && rid && od.isSignedIn() && navigator.onLine) {
    try {
      const t = await od.thumbnail(rid);
      if (t.blob) {
        blob = t.blob;
        await db.imgPut({ ...(rec || { id }), thumb: blob });
      } else if (t.url) {
        thumbUrls.set(id, t.url);
        return t.url;
      }
    } catch (e) { console.warn("Vorschau", e); }
  }
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  thumbUrls.set(id, u);
  return u;
}

function hydrateThumbs(root) {
  $$("img[data-img-id]", root).forEach(async (im) => {
    const u = await thumbUrl(im.dataset.imgId, im.dataset.rid || null);
    if (u) im.src = u;
    else im.classList.add("missing");
  });
}

function thumbHtml(img, deletable = true) {
  return `
    <div class="image-wrapper">
      <img data-img-id="${h(img.id)}" data-rid="${h(img.rid || "")}" alt="Bild" />
      ${img.rid || !od.isConfigured() ? "" : `<span class="img-pending" title="Noch nicht hochgeladen">⏳</span>`}
      ${deletable ? `<button class="img-delete" data-del-img="${h(img.id)}" type="button" aria-label="Bild löschen">×</button>` : ""}
    </div>`;
}

/* ---------- Großansicht ---------- */
async function openViewer(id, rid) {
  const modal = $("#imgModal");
  const im = $("#imgModalImg");
  im.src = (await thumbUrl(id, rid)) || "";
  modal.style.display = "flex";
  modal.onclick = () => { modal.style.display = "none"; im.src = ""; };
  try {
    const rec = await db.imgGet(id);
    let blob = rec && rec.archive;
    if (!blob && rid && od.isSignedIn() && navigator.onLine) blob = await od.downloadBlob(rid);
    if (blob && modal.style.display !== "none") {
      const u = URL.createObjectURL(blob);
      im.onload = () => setTimeout(() => URL.revokeObjectURL(u), 1000);
      im.src = u;
    }
  } catch (e) { console.warn(e); }
}

/* =========================================================
   Render
========================================================= */
// Nicht neu zeichnen, während jemand tippt – sonst geht der Fokus/Tipp verloren
function requestRender() {
  const a = document.activeElement;
  if (a && a.closest && a.closest("#app") && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "file"))) {
    pendingRender = true;
    return;
  }
  render();
}
document.addEventListener("focusout", () => {
  if (!pendingRender) return;
  setTimeout(() => {
    if (!pendingRender) return;
    pendingRender = false;
    requestRender();
  }, 400);
});

// Nach bewusster Aktion (z. B. Fotos gewählt): sofort neu zeichnen.
// Eingetippte Texte sind bereits gespeichert (input-Event), es geht nichts verloren.
function renderNow() {
  const a = document.activeElement;
  if (a && a.blur && a !== document.body) a.blur();
  render();
}

function render() {
  pendingRender = false;
  updateTopbar();
  const app = $("#app");
  app.innerHTML = "";
  const st = S.state;

  if (st.view === "archive") renderArchive(app);
  else if (st.view === "settings") renderSettings(app);
  else {
    const { p, d } = ctx();
    if (!p) renderProjectList(app);
    else renderProjectDetail(app, p, d);
  }
  hydrateThumbs(app);
}

/* ---------- Kopfzeile ---------- */
function updateTopbar() {
  const st = S.state;
  const pBtn = $("#tabProjects");
  const aBtn = $("#tabArchive");
  const sBtn = $("#tabSettings");
  pBtn.classList.toggle("active", st.view === "projects");
  aBtn.classList.toggle("active", st.view === "archive");
  sBtn.classList.toggle("active", st.view === "settings");
  pBtn.textContent = `Bauvorhaben (${st.projects.length})`;
  aBtn.textContent = `Archiv (${st.archivedProjects.length})`;
  pBtn.onclick = () => go({ view: "projects", selectedProjectId: null, selectedDocId: null });
  aBtn.onclick = () => go({ view: "archive", selectedProjectId: null, selectedDocId: null });
  sBtn.onclick = () => go({ view: "settings" });
  updateSyncChip();
}

function updateSyncChip() {
  const chip = $("#syncChip");
  if (!chip) return;
  const s = sync.status;
  const texts = {
    off: "Nur lokal",
    signedout: "☁ Anmelden",
    syncing: "⟳ Synchronisiere …",
    idle: "✓ OneDrive",
    pending: `⏳ ${s.pending} ausstehend`,
    offline: s.pending ? `Offline · ${s.pending} ausstehend` : "Offline",
    error: "⚠ Sync-Fehler",
  };
  chip.textContent = texts[s.kind] || s.kind;
  chip.className = "sync-chip " + s.kind;
  chip.title = s.message || "";
  chip.onclick = () => {
    if (s.kind === "signedout") { od.login(); return; }
    if (s.kind === "error") { toast(s.message || "Unbekannter Fehler", "error", 8000); sync.run({ full: true }); return; }
    if (s.kind === "pending" || s.kind === "idle") { sync.run({ full: true }); return; }
    go({ view: "settings" });
  };
}

/* =========================================================
   Bauvorhaben-Liste
========================================================= */
function renderProjectList(app) {
  const st = S.state;

  const head = el(`
    <div class="card">
      <h1>Bauvorhaben</h1>
      <div class="add-row">
        <input id="newNum" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" placeholder="Nr." autocomplete="off" />
        <input id="newTitle" type="text" placeholder="Bezeichnung, z. B. Neubau Lagerhalle" autocomplete="off" />
        <button class="primary" id="addP" type="button">+ Hinzufügen</button>
      </div>
      <input id="filter" type="search" placeholder="Suchen (Nummer oder Bezeichnung) …" value="${h(filterText)}" />
    </div>`);
  app.appendChild(head);

  const sorted = st.projects.slice().sort((a, b) => a.number.localeCompare(b.number) || a.title.localeCompare(b.title));
  const favs = sorted.filter((p) => p.fav);
  const others = sorted.filter((p) => !p.fav);

  if (favs.length) {
    const c = el(`<div class="card"><h3 class="section-title">Favoriten <span class="muted">· komplett auf diesem Gerät</span></h3></div>`);
    favs.forEach((p) => c.appendChild(projectRow(p)));
    app.appendChild(c);
  }

  const list = el(`<div class="card"><h3 class="section-title">${favs.length ? "Weitere Bauvorhaben" : "Alle Bauvorhaben"}</h3></div>`);
  if (!sorted.length) list.appendChild(el(`<p class="muted">Noch keine Bauvorhaben.</p>`));
  else if (!others.length) list.appendChild(el(`<p class="muted">Alle Bauvorhaben sind Favoriten.</p>`));
  else others.forEach((p) => list.appendChild(projectRow(p)));
  app.appendChild(list);

  const applyFilter = () => {
    const q = filterText.trim().toLowerCase();
    $$(".project-item", app).forEach((r) => { r.style.display = !q || r.dataset.search.includes(q) ? "" : "none"; });
  };
  $("#filter").addEventListener("input", (e) => { filterText = e.target.value; applyFilter(); });
  applyFilter();

  const numEl = $("#newNum");
  numEl.addEventListener("input", () => { numEl.value = numEl.value.replace(/\D/g, "").slice(0, 5); });
  $("#addP").onclick = () => addProject();
  $("#newTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") addProject(); });
}

function projectRow(p) {
  const meta = p.docs === null
    ? `<span class="badge">☁ online</span>`
    : `<span class="muted">${p.docs.length} Dokumentation${p.docs.length === 1 ? "" : "en"}</span>`;
  const pend = p.dirty && od.isConfigured() ? ` <span class="muted" title="Noch nicht hochgeladen">⏳</span>` : "";
  const row = el(`
    <div class="project-item" data-search="${h((p.number + " " + p.title).toLowerCase())}">
      <button class="fav-btn ${p.fav ? "is-fav" : ""}" type="button" data-a="fav" aria-label="Favorit umschalten">${p.fav ? "★" : "☆"}</button>
      <div class="p-info">
        <div><span class="bv-num">${h(p.number)}</span> <strong>${h(p.title)}</strong></div>
        <div>${meta}${pend}</div>
      </div>
      <button class="small secondary" type="button" data-a="archive">Archivieren</button>
    </div>`);
  row.onclick = (e) => {
    const a = e.target.closest("[data-a]");
    if (a) {
      e.stopPropagation();
      if (a.dataset.a === "fav") toggleFav(p);
      else archiveProject(p);
      return;
    }
    go({ view: "projects", selectedProjectId: p.id, selectedDocId: null });
  };
  return row;
}

function addProject() {
  const num = $("#newNum").value.trim();
  const title = $("#newTitle").value.trim().replace(/\s+/g, " ");
  if (!/^\d{5}$/.test(num)) {
    alert("Bitte eine 5-stellige Bauvorhaben-Nummer eingeben (nur Ziffern).");
    $("#newNum").focus();
    return;
  }
  if (!title) {
    alert("Bitte eine Bezeichnung für das Bauvorhaben eingeben.");
    $("#newTitle").focus();
    return;
  }
  const ex = findByNumber(num);
  if (ex) {
    const where = S.state.archivedProjects.includes(ex) ? " (im Archiv)" : "";
    alert(`Bauvorhaben ${num} existiert bereits${where}:\n${ex.number} ${ex.title}`);
    return;
  }
  const p = newProject(num, title);
  S.state.projects.push(p);
  touchProject(p);
  render();
}

function toggleFav(p) {
  p.fav = !p.fav;
  saveSoon();
  render();
  if (p.fav) sync.schedule(300, { full: true });
  else sync.freeLocal(p).catch((e) => console.warn(e));
}

function archiveProject(p) {
  if (!confirm(`Bauvorhaben „${p.number} ${p.title}“ ins Archiv verschieben?`)) return;
  moveLocal(p, "archive");
  if (p.remote.folderId) p.moveTo = "archive";
  touchProject(p);
  render();
}

/* =========================================================
   Archiv
========================================================= */
function renderArchive(app) {
  app.appendChild(el(`
    <div class="card">
      <h1>Archiv</h1>
      <p class="muted">Wiederherstellen oder endgültig löschen.${od.isConfigured() ? " In OneDrive liegen archivierte Bauvorhaben im Ordner „BauDoc/_Archiv“." : ""}</p>
    </div>`));

  const list = el(`<div class="card"></div>`);
  const arch = S.state.archivedProjects.slice().sort((a, b) => a.number.localeCompare(b.number));
  if (!arch.length) list.appendChild(el(`<p class="muted">Archiv ist leer.</p>`));

  arch.forEach((p) => {
    const count = p.docs === null ? "☁ online" : `${p.docs.length} Dokumentation(en)`;
    const row = el(`
      <div class="row space-between wrap list-row">
        <div>
          <span class="bv-num">${h(p.number)}</span> <strong>${h(p.title)}</strong>
          <div class="muted">${count}</div>
        </div>
        <div class="row">
          <button class="small" data-a="restore" type="button">Wiederherstellen</button>
          <button class="danger small" data-a="delete" type="button">Endgültig löschen</button>
        </div>
      </div>`);
    $('[data-a="restore"]', row).onclick = () => {
      moveLocal(p, "active");
      if (p.remote.folderId) p.moveTo = "active";
      touchProject(p);
      render();
    };
    $('[data-a="delete"]', row).onclick = async () => {
      const extra = p.remote.folderId ? "\n\nDer Ordner wird auch in OneDrive gelöscht (landet im OneDrive-Papierkorb)." : "";
      if (!confirm(`Bauvorhaben „${p.number} ${p.title}“ endgültig löschen?${extra}`)) return;
      if (p.remote.folderId) S.state.remote.pendingFolderDeletes.push(p.remote.folderId);
      await removeProjectLocal(p);
      await saveNow();
      render();
      sync.schedule(500);
    };
    list.appendChild(row);
  });
  app.appendChild(list);
}

/* =========================================================
   Bauvorhaben – Detail
========================================================= */
function renderProjectDetail(app, p, d) {
  const head = el(`
    <div class="card">
      <div class="row">
        <button id="back" type="button" aria-label="Zurück">←</button>
        <span class="bv-num big">${h(p.number)}</span>
        <input id="projTitle" class="grow title-input" type="text" value="${h(p.title)}" placeholder="Bezeichnung" />
        <button class="fav-btn ${p.fav ? "is-fav" : ""}" id="favD" type="button" aria-label="Favorit umschalten">${p.fav ? "★" : "☆"}</button>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="primary small" id="newD" type="button">+ Neue Dokumentation</button>
      </div>
    </div>`);
  app.appendChild(head);

  $("#back").onclick = () => go({ selectedProjectId: null, selectedDocId: null });
  $("#favD").onclick = () => toggleFav(p);

  const titleEl = $("#projTitle");
  titleEl.addEventListener("input", () => {
    const v = titleEl.value.trim().replace(/\s+/g, " ");
    if (!v) return;
    const cur = findProject(p.id);
    if (cur && cur.title !== v) { cur.title = v; touchProject(cur); }
  });
  titleEl.addEventListener("change", () => {
    if (!titleEl.value.trim()) titleEl.value = p.title;
  });

  // Inhalt liegt nur online
  if (p.docs === null) {
    $("#newD").disabled = true;
    const c = el(`<div class="card"><p class="muted" id="loadMsg">Inhalt wird aus OneDrive geladen …</p></div>`);
    app.appendChild(c);
    if (!od.isSignedIn() || !navigator.onLine) {
      $("#loadMsg").textContent = "Der Inhalt liegt nur in OneDrive. Bitte anmelden bzw. Internetverbindung herstellen.";
    } else if (!loadingProjects.has(p.id)) {
      loadingProjects.add(p.id);
      sync.loadProject(p).finally(() => {
        loadingProjects.delete(p.id);
        const cur = findProject(p.id);
        if (cur && cur.docs === null) {
          const m = $("#loadMsg");
          if (m) m.textContent = "Laden fehlgeschlagen. " + (sync.status.message || "");
        } else requestRender();
      });
    }
    return;
  }

  $("#newD").onclick = () => {
    const now = new Date();
    const doc = {
      id: newId(),
      title: formatDateDE(now) + " neue Dokumentation",
      date: now.toISOString(),
      updatedAt: Date.now(),
      entries: [],
      remote: {},
    };
    p.docs.push(doc);
    S.state.selectedDocId = doc.id;
    touchDoc(p, doc);
    render();
    const t = $("#docTitle");
    if (t) { t.focus(); t.select(); }
  };

  // ---- Liste der Dokumentationen ----
  const list = el(`<div class="card"></div>`);
  if (!p.docs.length) list.appendChild(el(`<p class="muted">Noch keine Dokumentationen.</p>`));
  p.docs.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).forEach((doc) => {
    const n = imagesOfDoc(doc).length;
    const r = el(`
      <div class="doc-item ${d && d.id === doc.id ? "selected" : ""}" data-doc-id="${h(doc.id)}">
        <div>
          <div class="doc-title">${h(doc.title)}</div>
          <div class="muted">${formatDateDE(doc.date)} · ${doc.entries.length} Einträge · ${n} Bilder</div>
        </div>
        <div class="row">
          <button class="small" data-a="pdf" type="button">PDF</button>
          <button class="danger small" data-a="del" type="button" aria-label="Löschen">X</button>
        </div>
      </div>`);
    r.onclick = (e) => {
      const a = e.target.closest("[data-a]");
      if (a) {
        e.stopPropagation();
        if (a.dataset.a === "pdf") exportPdf(p.id, doc.id);
        if (a.dataset.a === "del") deleteDoc(p.id, doc.id);
        return;
      }
      go({ selectedDocId: d && d.id === doc.id ? null : doc.id });
    };
    list.appendChild(r);
  });
  app.appendChild(list);

  if (d) renderDocEditor(app, p, d);
}

async function deleteDoc(pid, did) {
  const p = findProject(pid);
  const d = p && p.docs.find((x) => x.id === did);
  if (!d) return;
  const extra = d.remote && d.remote.folderId ? "\n\nDer Ordner in OneDrive (inkl. Bilder und PDF) wird ebenfalls gelöscht (OneDrive-Papierkorb)." : "";
  if (!confirm(`Dokumentation „${d.title}“ wirklich löschen?${extra}`)) return;
  p.docs = p.docs.filter((x) => x.id !== did);
  p.deletedDocs.push({ id: did, at: Date.now() });
  if (d.remote && d.remote.folderId) p.pendingDeletes.push(d.remote.folderId);
  for (const img of imagesOfDoc(d)) { try { await db.imgDelete(img.id); } catch {} }
  try { await db.outboxDelete(`pdf:${pid}:${did}`); } catch {}
  if (S.state.selectedDocId === did) S.state.selectedDocId = null;
  touchProject(p);
  render();
}

/* =========================================================
   Dokumentation bearbeiten
========================================================= */
function renderDocEditor(app, p, d) {
  const pend = draftImgs[d.id] || [];
  const card = el(`
    <div class="card" id="docEditor">
      <h3>Dokumentation bearbeiten</h3>
      <input id="docTitle" type="text" value="${h(d.title)}" />
      <hr />
      <h3>Neuer Eintrag</h3>
      <textarea id="eText" placeholder="Beschreibung">${h(drafts[d.id] || "")}</textarea>
      <div class="images" id="draftImages">${pend.map((id) => thumbHtml({ id }, true)).join("")}</div>
      <div class="row wrap" style="margin-top:8px;">
        <label class="file-btn">📷 Fotos hinzufügen
          <input id="eImg" type="file" multiple accept="image/*" />
        </label>
        <button type="button" class="primary" id="addE">+ Eintrag speichern</button>
      </div>
      <hr />
      <h3>Einträge</h3>
      <div id="elist"></div>
    </div>`);
  app.appendChild(card);

  const titleEl = $("#docTitle");
  titleEl.addEventListener("input", () => {
    const v = titleEl.value.trim().replace(/\s+/g, " ");
    if (!v) return;
    const { p: cp, d: cd } = ctx();
    if (!cd || cd.id !== d.id || cd.title === v) return;
    cd.title = v;
    touchDoc(cp, cd);
    const rowTitle = $(`[data-doc-id="${CSS.escape(d.id)}"] .doc-title`);
    if (rowTitle) rowTitle.textContent = v;
  });
  titleEl.addEventListener("change", () => {
    if (!titleEl.value.trim()) titleEl.value = d.title;
  });

  const tEl = $("#eText");
  tEl.addEventListener("input", () => { drafts[d.id] = tEl.value; });

  $("#eImg").addEventListener("change", async (ev) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = "";
    if (!files.length) return;
    const ids = await processFiles(files);
    draftImgs[d.id] = (draftImgs[d.id] || []).concat(ids);
    renderNow();
  });

  $$("[data-del-img]", $("#draftImages")).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.delImg;
      draftImgs[d.id] = (draftImgs[d.id] || []).filter((x) => x !== id);
      try { await db.imgDelete(id); } catch {}
      render();
    };
  });

  $("#addE").onclick = () => addEntry();

  renderEntries($("#elist"), p, d);
}

async function processFiles(files) {
  const ids = [];
  try {
    for (let i = 0; i < files.length; i++) {
      setBusy(`Bild ${i + 1}/${files.length} wird verarbeitet …`);
      try {
        const r = await processFile(files[i]);
        const id = newId();
        await db.imgPut({ id, archive: r.archive, thumb: r.thumb });
        ids.push(id);
      } catch (e) {
        console.warn(e);
        toast(`Bild „${files[i].name}“: ${e.message}`, "error", 7000);
      }
    }
  } finally {
    setBusy(null);
  }
  return ids;
}

async function addEntry() {
  const { p, d } = ctx();
  if (!d) return;
  const text = (drafts[d.id] || "").trim();
  const imgs = draftImgs[d.id] || [];
  if (!text && !imgs.length) {
    toast("Bitte Beschreibung eingeben oder Fotos hinzufügen.", "warn");
    return;
  }
  d.entries.push({ id: newId(), description: text, images: imgs.map((id) => ({ id })) });
  drafts[d.id] = "";
  draftImgs[d.id] = [];
  touchDoc(p, d);
  await saveNow();
  render();
}

function renderEntries(container, p, d) {
  if (!d.entries.length) {
    container.appendChild(el(`<p class="muted">Keine Einträge.</p>`));
    return;
  }
  d.entries.forEach((en, i) => {
    const c = el(`
      <div class="card entry" data-entry-id="${h(en.id)}">
        <div class="row space-between">
          <label class="muted">Eintrag ${i + 1}</label>
          <button class="danger small" data-a="del-entry" type="button">Eintrag löschen</button>
        </div>
        <textarea class="entryText">${h(en.description)}</textarea>
        <div class="images">${en.images.map((img) => thumbHtml(img, true)).join("")}</div>
        <label class="file-btn small">📷 Fotos hinzufügen
          <input type="file" class="entryImg" multiple accept="image/*" />
        </label>
      </div>`);

    const findEntry = () => {
      const { p: cp, d: cd } = ctx();
      const ce = cd && cd.entries.find((x) => x.id === en.id);
      return ce ? { cp, cd, ce } : null;
    };

    const ta = $(".entryText", c);
    ta.addEventListener("input", () => {
      const f = findEntry();
      if (!f) return;
      f.ce.description = ta.value;
      touchDoc(f.cp, f.cd);
    });

    $('[data-a="del-entry"]', c).onclick = async () => {
      if (!confirm(`Eintrag ${i + 1} wirklich löschen?`)) return;
      const f = findEntry();
      if (!f) return;
      for (const img of f.ce.images) {
        if (img.rid) f.cp.pendingDeletes.push(img.rid);
        try { await db.imgDelete(img.id); } catch {}
      }
      f.cd.entries = f.cd.entries.filter((x) => x.id !== en.id);
      touchDoc(f.cp, f.cd);
      render();
    };

    $$("[data-del-img]", c).forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm("Bild löschen?")) return;
        const f = findEntry();
        if (!f) return;
        const img = f.ce.images.find((x) => x.id === b.dataset.delImg);
        if (!img) return;
        f.ce.images = f.ce.images.filter((x) => x !== img);
        if (img.rid) f.cp.pendingDeletes.push(img.rid);
        try { await db.imgDelete(img.id); } catch {}
        touchDoc(f.cp, f.cd);
        render();
      };
    });

    $(".entryImg", c).addEventListener("change", async (ev) => {
      const files = Array.from(ev.target.files || []);
      ev.target.value = "";
      if (!files.length) return;
      const ids = await processFiles(files);
      const f = findEntry();
      if (!f) return;
      f.ce.images.push(...ids.map((id) => ({ id })));
      touchDoc(f.cp, f.cd);
      renderNow();
    });

    container.appendChild(c);
  });
}

// Tippen auf ein Vorschaubild -> Großansicht
document.addEventListener("click", (e) => {
  const im = e.target.closest && e.target.closest("#app img[data-img-id]");
  if (im) openViewer(im.dataset.imgId, im.dataset.rid || null);
});

/* =========================================================
   PDF
========================================================= */
let lastPdf = { blob: null, url: null, name: "dokumentation.pdf" };

async function exportPdf(pid, did) {
  const p = findProject(pid);
  const d = p && p.docs && p.docs.find((x) => x.id === did);
  if (!d) return;
  setBusy("PDF wird erstellt …");
  try {
    const { blob, filename, missing } = await buildPdf(p, d, (m) => setBusy(m));
    openPdfPreview(blob, filename);
    if (missing) toast(`${missing} Bild(er) konnten nicht geladen werden (offline?).`, "warn", 7000);
    if (blob.size > PDF_MAX_BYTES) toast(`PDF ist ${(blob.size / 1048576).toFixed(1)} MB groß (über 15 MB).`, "warn", 7000);
    if (od.isConfigured()) {
      await db.outboxPut({ id: `pdf:${p.id}:${d.id}`, projectId: p.id, docId: d.id, name: filename, blob });
      await sync.updateOutboxCount();
      sync.schedule(800);
    }
  } catch (e) {
    console.error(e);
    toast("PDF konnte nicht erstellt werden: " + e.message, "error", 8000);
  } finally {
    setBusy(null);
  }
}

function openPdfPreview(blob, filename) {
  if (lastPdf.url) { try { URL.revokeObjectURL(lastPdf.url); } catch {} }
  lastPdf = { blob, url: URL.createObjectURL(blob), name: filename };

  const modal = $("#pdfModal");
  const frame = $("#pdfFrame");
  frame.src = lastPdf.url;
  modal.style.display = "block";

  $("#pdfClose").onclick = () => { modal.style.display = "none"; frame.src = "about:blank"; };
  $("#pdfOpenTab").onclick = () => window.open(lastPdf.url, "_blank");
  $("#pdfDownload").onclick = () => {
    const a = document.createElement("a");
    a.href = lastPdf.url;
    a.download = lastPdf.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  $("#pdfShare").onclick = async () => {
    try {
      if (!navigator.share) {
        alert("Teilen wird von deinem Browser nicht direkt unterstützt. Nutze „In neuem Tab öffnen“ und dann das Teilen-Symbol im PDF-Viewer.");
        return;
      }
      const file = new File([lastPdf.blob], lastPdf.name, { type: "application/pdf" });
      await navigator.share({ files: [file], title: lastPdf.name, text: "PDF Export aus BauDoc" });
    } catch (e) {
      console.warn("Teilen abgebrochen/fehlgeschlagen", e);
    }
  };
}

/* =========================================================
   Einstellungen
========================================================= */
function renderSettings(app) {
  const s = sync.status;
  let odHtml;
  if (!od.isConfigured()) {
    odHtml = `
      <p><strong>Noch nicht eingerichtet.</strong> BauDoc speichert derzeit nur auf diesem Gerät.</p>
      <p class="muted">Für OneDrive muss die App bei Microsoft registriert und die Anwendungs-ID in <code>js/config.js</code> eingetragen werden (siehe README).</p>`;
  } else if (!od.isSignedIn()) {
    odHtml = `
      <p>Nicht angemeldet.${s.message ? ` <span class="muted">(${h(s.message)})</span>` : ""}</p>
      <button class="primary" id="login" type="button">Mit Microsoft anmelden</button>`;
  } else {
    const acc = od.getAccount();
    odHtml = `
      <p>Angemeldet als <strong>${h(acc.name || acc.username)}</strong><br><span class="muted">${h(acc.username || "")}</span></p>
      <p class="muted">Ablage: OneDrive › ${h(CONFIG.rootFolder)}<br>
        Letzter Abgleich: ${s.lastSync ? formatDateTimeDE(s.lastSync) : "–"}<br>
        Ausstehend: ${s.pending}${s.kind === "error" ? `<br><span class="error-text">Fehler: ${h(s.message)}</span>` : ""}</p>
      <div class="row wrap">
        <button class="primary" id="syncNow" type="button">Jetzt synchronisieren</button>
        <button class="secondary" id="logout" type="button">Abmelden</button>
      </div>`;
  }

  app.appendChild(el(`
    <div class="card">
      <h1>Einstellungen</h1>
      <h3>OneDrive</h3>
      ${odHtml}
    </div>`));

  app.appendChild(el(`
    <div class="card">
      <h3>Datensicherung</h3>
      <p class="muted">Speichert alle Bauvorhaben und alle Bilder, die auf diesem Gerät liegen, in eine Datei.
      Damit lassen sich die Daten auf einem anderen Gerät oder nach einem Verlust wiederherstellen.</p>
      <div class="row wrap">
        <button class="primary" id="bkExport" type="button">Sicherung speichern</button>
        <label class="file-btn">Sicherung laden
          <input id="bkImport" type="file" accept="application/json,.json" />
        </label>
      </div>
    </div>`));

  const storageCard = el(`
    <div class="card">
      <h3>Speicher auf diesem Gerät</h3>
      <p class="muted" id="storageInfo">wird ermittelt …</p>
    </div>`);
  app.appendChild(storageCard);

  app.appendChild(el(`<p class="muted center">BauDoc ${h(APP_VERSION)}</p>`));

  const loginBtn = $("#login");
  if (loginBtn) loginBtn.onclick = () => od.login();
  const syncBtn = $("#syncNow");
  if (syncBtn) syncBtn.onclick = async () => { await sync.run({ full: true }); render(); };
  const logoutBtn = $("#logout");
  if (logoutBtn) logoutBtn.onclick = () => {
    if (confirm("Abmelden? Die Daten auf diesem Gerät bleiben erhalten.")) od.logout();
  };

  $("#bkExport").onclick = async () => {
    try {
      const r = await exportBackup((m) => setBusy(m));
      if (r.online) toast(`${r.online} Bild(er) liegen nur in OneDrive und sind nur als Vorschau bzw. gar nicht enthalten.`, "warn", 8000);
    } catch (e) {
      toast("Sicherung fehlgeschlagen: " + e.message, "error", 8000);
    } finally { setBusy(null); }
  };
  $("#bkImport").addEventListener("change", async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    if (!confirm("Sicherung laden?\n\nAlle Bauvorhaben auf diesem Gerät werden durch den Inhalt der Sicherung ersetzt.")) return;
    try {
      const r = await importBackup(f, (m) => setBusy(m));
      toast(`Sicherung geladen: ${r.projects} Bauvorhaben, ${r.images} Bilder.`, "info", 6000);
      render();
      sync.schedule(1000, { full: true });
    } catch (e) {
      toast("Laden fehlgeschlagen: " + e.message, "error", 8000);
    } finally { setBusy(null); }
  });

  (async () => {
    const info = $("#storageInfo");
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const mb = (n) => (n / 1048576).toFixed(1) + " MB";
      if (info) {
        info.innerHTML =
          (est ? `Belegt: ${mb(est.usage || 0)}${est.quota ? ` von ca. ${mb(est.quota)}` : ""}<br>` : "") +
          (persisted ? "Daten sind vor automatischem Löschen geschützt ✓" : "Daten sind <strong>nicht</strong> vor automatischem Löschen durch den Browser geschützt. Tipp: BauDoc zum Home-Bildschirm hinzufügen.");
      }
    } catch {
      if (info) info.textContent = "Keine Angaben verfügbar.";
    }
  })();
}

/* =========================================================
   Start
========================================================= */
async function cleanupOrphanImages() {
  try {
    const used = new Set();
    for (const p of allProjects()) for (const img of imagesOfProject(p)) used.add(img.id);
    for (const ids of Object.values(draftImgs)) ids.forEach((id) => used.add(id));
    const keys = await db.imgKeys();
    for (const k of keys) if (!used.has(k)) await db.imgDelete(k);
  } catch (e) { console.warn("Aufräumen", e); }
}

(async function init() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}

  await load();

  try {
    await od.init();
  } catch (e) {
    console.warn("Anmeldung", e);
    toast("Anmeldung fehlgeschlagen: " + (e.message || e), "error", 10000);
  }

  sync.onStatus(() => updateSyncChip());
  sync.onData(() => requestRender());
  onChange((kind) => {
    if (kind === "data") { sync.refreshStatus(); sync.schedule(4000); }
  });

  render();
  await sync.updateOutboxCount();
  cleanupOrphanImages();
  sync.run({ full: true });

  window.addEventListener("online", () => sync.run({ full: true }));
  window.addEventListener("offline", () => sync.refreshStatus());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveNow();
    else sync.schedule(500, { full: true });
  });
  window.addEventListener("pagehide", () => { saveNow(); });
  setInterval(() => { if (document.visibilityState === "visible") sync.schedule(0, { full: true }); }, 5 * 60 * 1000);

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service Worker", e));
  }
})();
