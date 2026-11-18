/* =========================================================
   BauDoc – Oberfläche
   Läuft als App (Home-Bildschirm) und im Browser.
========================================================= */
import { CONFIG, APP_VERSION } from "./config.js";
import * as db from "./db.js";
import * as od from "./onedrive.js";
import * as sync from "./sync.js";
import {
  S, load, saveNow, saveSoon, touchProject, touchDoc, onChange,
  findProject, findByNumber, newProject, moveLocal, removeProjectLocal,
  allProjects, imagesOfDoc, imagesOfProject, favoritesChanged, resetLocal, setTitleParts,
  newProtocol, CONTRACTOR_COMPANY,
} from "./store.js";
import { captureSignature } from "./signature.js";
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

const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isTouch = window.matchMedia("(pointer: coarse)").matches;
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

/* ---------- Flüchtige UI-Daten (nicht gespeichert) ---------- */
const drafts = {};      // docId -> Text "Neuer Eintrag"
const draftImgs = {};   // docId -> [imageId] für "Neuer Eintrag"
let filterText = "";
let addOpen = false;
let justAdded = null; // frisch angelegtes BV kurz hervorheben
let pendingRender = false;
let deferredInstall = null;
const loadingProjects = new Set();

/* ---------- Fortschritt ---------- */
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

/* =========================================================
   Navigation (mit Zurück-Taste von Handy und Browser)
========================================================= */
function navState() {
  const st = S.state;
  return { view: st.view, pid: st.selectedProjectId, did: st.selectedDocId };
}

function go(changes, { replace = false, scroll = true } = {}) {
  const opening = changes.selectedProjectId && changes.selectedProjectId !== S.state.selectedProjectId;
  Object.assign(S.state, changes);
  if (opening) sync.schedule(100); // beim Öffnen neuesten Stand holen
  saveSoon();
  try {
    if (replace) history.replaceState(navState(), "");
    else history.pushState(navState(), "");
  } catch {}
  render();
  if (scroll) window.scrollTo(0, 0);
}

window.addEventListener("popstate", (e) => {
  const s = e.state;
  if (!s) return;
  S.state.view = s.view || "projects";
  S.state.selectedProjectId = s.pid || null;
  S.state.selectedDocId = s.did || null;
  saveSoon();
  render();
});

function ctx() {
  const st = S.state;
  const p = st.selectedProjectId ? findProject(st.selectedProjectId) : null;
  const d = p && p.docs && st.selectedDocId ? p.docs.find((x) => x.id === st.selectedDocId) || null : null;
  return { p, d };
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
      <img data-img-id="${h(img.id)}" data-rid="${h(img.rid || "")}" alt="Foto" />
      ${img.rid || !od.isConfigured() ? "" : `<span class="img-pending" title="Noch nicht hochgeladen">⏳</span>`}
      ${deletable ? `<button class="img-delete" data-del-img="${h(img.id)}" type="button" aria-label="Foto löschen">×</button>` : ""}
    </div>`;
}

// Foto-Knöpfe: Kamera (direkt) + Mediathek/Dateien
function photoButtons(cls, small = false) {
  return `
    <div class="photo-btns">
      <label class="file-btn camera-only ${small ? "small" : ""}"><svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/></svg> Kamera
        <input class="${cls}" type="file" accept="image/*" capture="environment" />
      </label>
      <label class="file-btn ${small ? "small" : ""}"><svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg> ${isTouch ? "Fotos" : "Fotos hinzufügen"}
        <input class="${cls}" type="file" accept="image/*" multiple />
      </label>
    </div>`;
}

/* ---------- Großansicht ---------- */
async function openViewer(id, rid) {
  const modal = $("#imgModal");
  const im = $("#imgModalImg");
  im.src = (await thumbUrl(id, rid)) || "";
  modal.style.display = "flex";
  const close = () => { modal.style.display = "none"; im.src = ""; };
  modal.onclick = close;
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
// Nicht neu zeichnen, während jemand im Inhalt tippt
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
// Eingetippte Texte sind bereits gespeichert, es geht nichts verloren.
function renderNow() {
  const a = document.activeElement;
  if (a && a.blur && a !== document.body && !a.closest(".appbar")) a.blur();
  render();
}

function render() {
  pendingRender = false;
  updateHeader();
  const app = $("#app");
  app.innerHTML = "";
  const st = S.state;

  if (st.view === "archive") renderArchive(app);
  else if (st.view === "settings") renderSettings(app);
  else {
    const { p, d } = ctx();
    if (p) renderProjectDetail(app, p, d);
    else renderProjectList(app, st.view === "favorites");
  }
  hydrateThumbs(app);
}

/* =========================================================
   Kopfzeile: BV · Fav · Archiv · Einstellungen · Logo + Suche
========================================================= */
function updateHeader() {
  const st = S.state;
  const tabs = {
    tabProjects: "projects",
    tabFav: "favorites",
    tabArchive: "archive",
    tabSettings: "settings",
  };
  for (const [id, view] of Object.entries(tabs)) {
    const b = $("#" + id);
    b.classList.toggle("active", st.view === view);
    b.onclick = () => {
      if (st.view === view && !st.selectedProjectId) { window.scrollTo(0, 0); return; }
      go({ view, selectedProjectId: null, selectedDocId: null });
    };
  }
  const cnt = (n) => (n ? String(n) : ""); // 0 nicht anzeigen
  $("#cntProjects").textContent = cnt(st.projects.length);
  $("#cntFav").textContent = cnt(st.projects.filter((p) => p.fav).length);
  $("#cntArchive").textContent = cnt(st.archivedProjects.length);

  $("#searchBtn").classList.toggle("active", !!filterText.trim());
  const search = $("#search");
  search.placeholder = st.view === "archive" ? "Archiv durchsuchen …" : "Suchen: Nr., Bauherr, Ort …";
  if (search.value !== filterText) search.value = filterText;
  updateSyncChip();
}

function setupSearch() {
  const search = $("#search");
  const bar = $("#appbar");
  // App-Ansicht: Lupe klappt das Suchfeld auf
  $("#searchBtn").onclick = () => {
    bar.classList.add("searching");
    search.focus();
  };
  const closeSearch = () => {
    bar.classList.remove("searching");
    if (filterText) { filterText = ""; search.value = ""; render(); }
    search.blur();
  };
  $("#searchClose").onclick = closeSearch;
  search.addEventListener("blur", () => {
    // leer verlassen -> wieder zuklappen
    if (!search.value.trim()) setTimeout(() => { if (document.activeElement !== search) bar.classList.remove("searching"); }, 150);
  });
  search.addEventListener("input", () => {
    filterText = search.value;
    const st = S.state;
    if (!filterText.trim()) {
      if (!st.selectedProjectId && st.view !== "settings") render();
    } else if (st.view === "settings" || st.selectedProjectId) {
      go({ view: st.view === "settings" ? "projects" : st.view, selectedProjectId: null, selectedDocId: null }, { replace: true });
    } else {
      render();
    }
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      // Genau ein Treffer -> direkt öffnen
      const hits = $$("#app .project-item[data-pid]");
      if (hits.length === 1) hits[0].click();
      else search.blur();
    }
    if (e.key === "Escape") closeSearch();
  });
}

function matches(p) {
  const q = filterText.trim().toLowerCase();
  if (!q) return true;
  const hay = (p.number + " " + p.title).toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function updateSyncChip() {
  const chip = $("#syncChip");
  if (!chip) return;
  const s = sync.status;
  const texts = {
    off: "Nur lokal",
    signedout: "Anmelden",
    syncing: "⟳ Sync …",
    idle: "✓ Synchron",
    pending: `⏳ ${s.pending}`,
    offline: s.pending ? `Offline · ${s.pending}` : "Offline",
    error: "⚠ Fehler",
  };
  const titles = {
    off: "Daten liegen nur auf diesem Gerät",
    signedout: "Mit Microsoft anmelden, um mit OneDrive abzugleichen",
    syncing: "Abgleich mit OneDrive läuft",
    idle: "Alles mit OneDrive abgeglichen",
    pending: `${s.pending} Änderung(en) warten auf Upload – tippen zum Abgleichen`,
    offline: "Keine Internetverbindung – Änderungen werden später hochgeladen",
    error: s.message,
  };
  chip.textContent = texts[s.kind] || s.kind;
  chip.className = "sync-chip " + s.kind;
  chip.title = titles[s.kind] || "";
  const dot = $("#syncDot");
  if (dot) dot.className = "sync-dot " + s.kind;
  const set = $("#tabSettings");
  if (set) set.title = "Einstellungen" + (titles[s.kind] ? " – " + titles[s.kind] : "");
  chip.onclick = () => {
    if (s.kind === "signedout") { od.login(); return; }
    if (s.kind === "error") { toast(s.message || "Unbekannter Fehler", "error", 8000); sync.run({ full: true }); return; }
    if (s.kind === "pending" || s.kind === "idle") { sync.run({ full: true }); return; }
    go({ view: "settings", selectedProjectId: null, selectedDocId: null });
  };
}

/* =========================================================
   Listen: Bauvorhaben / Favoriten
========================================================= */
function renderProjectList(app, onlyFav) {
  const st = S.state;
  const sorted = st.projects.slice().sort((a, b) => a.number.localeCompare(b.number) || a.title.localeCompare(b.title));
  const base = onlyFav ? sorted.filter((p) => p.fav) : sorted;
  const shown = base.filter(matches);

  const head = el(`
    <div class="page-head">
      <h1>${onlyFav ? "Favoriten" : "Bauvorhaben"}</h1>
      ${onlyFav ? "" : `<button class="${addOpen ? "secondary" : "primary"}" id="toggleAdd" type="button">${addOpen ? "Abbrechen" : "+ Neu"}</button>`}
    </div>`);
  app.appendChild(head);

  if (!onlyFav && addOpen) {
    const form = el(`
      <div class="card add-card">
        <label class="field-label" for="newNum">Neues Bauvorhaben</label>
        <div class="add-row">
          <input id="newNum" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" placeholder="BV-Nr." autocomplete="off" enterkeyhint="next" />
          <input id="newClient" type="text" placeholder="Bauherr / Auftraggeber" autocomplete="off" enterkeyhint="next" />
          <input id="newPlace" type="text" placeholder="Bauort" autocomplete="off" enterkeyhint="done" />
        </div>
        <button class="primary block" id="addP" type="button">Bauvorhaben anlegen</button>
      </div>`);
    app.appendChild(form);
    const numEl = $("#newNum");
    numEl.addEventListener("input", () => {
      numEl.value = numEl.value.replace(/\D/g, "").slice(0, 5);
      if (numEl.value.length === 5) $("#newClient").focus();
    });
    $("#addP").onclick = () => addProject();
    $("#newClient").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#newPlace").focus(); });
    $("#newPlace").addEventListener("keydown", (e) => { if (e.key === "Enter") addProject(); });
    setTimeout(() => numEl.focus(), 50);
  }
  const t = $("#toggleAdd");
  if (t) t.onclick = () => { addOpen = !addOpen; render(); };

  const list = el(`<div class="card list-card"></div>`);
  if (filterText.trim()) {
    list.appendChild(el(`<div class="muted list-info">${shown.length} Treffer für „${h(filterText.trim())}“</div>`));
  }
  if (!base.length) {
    list.appendChild(el(onlyFav
      ? `<div class="empty"><div class="empty-icon">☆</div><p><strong>Noch keine Favoriten.</strong></p>
         <p class="muted">Markiere deine eigenen Bauvorhaben mit dem Stern. Favoriten werden komplett auf dem Gerät gespeichert – auch die Fotos – und sind offline verfügbar.</p></div>`
      : `<div class="empty"><div class="empty-icon">▦</div><p><strong>Noch keine Bauvorhaben.</strong></p>
         <p class="muted">Lege mit „+ Neu“ das erste Bauvorhaben an.</p></div>`));
  } else if (!shown.length) {
    list.appendChild(el(`<p class="muted">Keine Treffer.</p>`));
  }
  shown.forEach((p) => list.appendChild(projectRow(p)));
  app.appendChild(list);
}

function projectRow(p) {
  let meta;
  if (p.docs === null) meta = `<span class="badge">☁ in OneDrive</span>`;
  else {
    const n = p.docs.length;
    const last = p.docs.reduce((mx, d) => Math.max(mx, Date.parse(d.date) || 0), 0);
    meta = `<span class="muted">${n} Dokumentation${n === 1 ? "" : "en"}${last ? " · zuletzt " + formatDateDE(last) : ""}</span>`;
  }
  const pend = p.dirty && od.isConfigured() ? ` <span class="muted" title="Noch nicht hochgeladen">⏳</span>` : "";
  const row = el(`
    <div class="project-item ${justAdded === p.id ? "flash" : ""}" data-pid="${h(p.id)}">
      <button class="fav-btn ${p.fav ? "is-fav" : ""}" type="button" data-a="fav" aria-label="Favorit umschalten">${p.fav ? "★" : "☆"}</button>
      <div class="p-info">
        <div class="p-title"><span class="bv-num">${h(p.number)}</span> ${h(p.client || p.title)}</div>
        ${p.place ? `<div class="p-place">${h(p.place)}</div>` : ""}
        <div>${meta}${pend}</div>
      </div>
      <span class="chevron" aria-hidden="true">›</span>
    </div>`);
  row.onclick = (e) => {
    const a = e.target.closest("[data-a]");
    if (a) { e.stopPropagation(); toggleFav(p); return; }
    go({ selectedProjectId: p.id, selectedDocId: null });
  };
  return row;
}

function addProject() {
  const num = $("#newNum").value.trim();
  const client = $("#newClient").value.trim();
  const place = $("#newPlace").value.trim();
  if (!/^\d{5}$/.test(num)) {
    toast("Bitte eine 5-stellige Bauvorhaben-Nummer eingeben (nur Ziffern).", "warn");
    $("#newNum").focus();
    return;
  }
  if (!client) {
    toast("Bitte Bauherr / Auftraggeber eingeben.", "warn");
    $("#newClient").focus();
    return;
  }
  if (!place) {
    toast("Bitte den Bauort eingeben.", "warn");
    $("#newPlace").focus();
    return;
  }
  const ex = findByNumber(num);
  if (ex) {
    const where = S.state.archivedProjects.includes(ex) ? " (im Archiv)" : "";
    toast(`Bauvorhaben ${num} existiert bereits${where}: ${ex.number} ${ex.title}`, "warn", 6000);
    return;
  }
  const p = newProject(num, client, place);
  S.state.projects.push(p);
  touchProject(p);
  favoritesChanged();
  addOpen = false;
  justAdded = p.id;
  render();
  toast(`BV ${p.number} angelegt.`, "info", 2500);
  const row = $(`.project-item[data-pid="${CSS.escape(p.id)}"]`);
  if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => { justAdded = null; }, 2500);
}

function toggleFav(p) {
  p.fav = !p.fav;
  favoritesChanged();
  render();
  toast(p.fav ? `${p.number} ist jetzt Favorit – wird auf diesem Gerät gespeichert.` : `${p.number} ist kein Favorit mehr.`, "info", 2500);
  sync.refreshStatus();
  if (p.fav) sync.schedule(300, { full: true });
  else { sync.freeLocal(p).catch((e) => console.warn(e)); sync.schedule(1500); }
}

/* =========================================================
   Archiv
========================================================= */
function renderArchive(app) {
  app.appendChild(el(`
    <div class="page-head">
      <h1>Archiv</h1>
    </div>`));
  const list = el(`<div class="card list-card"></div>`);
  const all = S.state.archivedProjects.slice().sort((a, b) => a.number.localeCompare(b.number));
  const arch = all.filter(matches);
  if (!all.length) {
    list.appendChild(el(`<div class="empty"><div class="empty-icon">🗄</div><p><strong>Archiv ist leer.</strong></p>
      <p class="muted">Abgeschlossene Bauvorhaben kannst du im Bauvorhaben über „Archivieren“ hierher verschieben.</p></div>`));
  } else if (!arch.length) list.appendChild(el(`<p class="muted">Keine Treffer.</p>`));

  arch.forEach((p) => {
    const count = p.docs === null ? "☁ in OneDrive" : `${p.docs.length} Dokumentation(en)`;
    const row = el(`
      <div class="archive-item">
        <div class="p-info">
          <div class="p-title"><span class="bv-num">${h(p.number)}</span> ${h(p.client || p.title)}</div>
          <div class="muted">${p.place ? h(p.place) + " · " : ""}${count}</div>
        </div>
        <div class="row">
          <button class="secondary small" data-a="restore" type="button">Wiederherstellen</button>
          <button class="danger-outline small" data-a="delete" type="button">Löschen</button>
        </div>
      </div>`);
    $('[data-a="restore"]', row).onclick = () => {
      moveLocal(p, "active");
      if (p.remote.folderId) p.moveTo = "active";
      touchProject(p);
      toast(`${p.number} wiederhergestellt.`, "info", 2500);
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
   Handy: untereinander · Breiter Bildschirm: Liste links, Bearbeiten rechts
========================================================= */
function renderProjectDetail(app, p, d) {
  const wrap = el(`<div class="detail ${d ? "has-doc" : ""}"><div class="detail-main"></div><div class="detail-side"></div></div>`);
  app.appendChild(wrap);
  const main = $(".detail-main", wrap);
  const side = $(".detail-side", wrap);

  const head = el(`
    <div class="card">
      <div class="row">
        <button id="back" class="icon-btn" type="button" aria-label="Zurück">←</button>
        <span class="bv-num big grow">BV ${h(p.number)}</span>
        <button class="fav-btn ${p.fav ? "is-fav" : ""}" id="favD" type="button" aria-label="Favorit umschalten">${p.fav ? "★" : "☆"}</button>
      </div>
      <div class="bv-fields">
        <div>
          <label class="field-label" for="projClient">Bauherr / Auftraggeber</label>
          <input id="projClient" class="title-input" type="text" value="${h(p.client)}" enterkeyhint="next" />
        </div>
        <div>
          <label class="field-label" for="projPlace">Bauort</label>
          <input id="projPlace" type="text" value="${h(p.place)}" enterkeyhint="done" />
        </div>
      </div>
      <div class="row wrap actions">
        <button class="primary" id="newD" type="button">+ Neue Dokumentation</button>
        <button class="secondary" id="archP" type="button">Archivieren</button>
      </div>
    </div>`);
  main.appendChild(head);

  $("#back").onclick = () => go({ selectedProjectId: null, selectedDocId: null });
  $("#favD").onclick = () => toggleFav(p);
  $("#archP").onclick = () => {
    if (!confirm(`Bauvorhaben „${p.number} ${p.title}“ ins Archiv verschieben?`)) return;
    moveLocal(p, "archive");
    if (p.remote.folderId) p.moveTo = "archive";
    touchProject(p);
    toast(`${p.number} archiviert.`, "info", 2500);
    go({ selectedProjectId: null, selectedDocId: null }, { replace: true });
  };

  const clientEl = $("#projClient");
  const placeEl = $("#projPlace");
  const onTitle = () => {
    const c = clientEl.value.trim();
    if (!c) return; // Bauherr ist Pflicht
    const cur = findProject(p.id);
    if (!cur) return;
    const before = cur.title;
    setTitleParts(cur, c, placeEl.value);
    if (cur.title !== before) touchProject(cur);
  };
  clientEl.addEventListener("input", onTitle);
  placeEl.addEventListener("input", onTitle);
  clientEl.addEventListener("change", () => { if (!clientEl.value.trim()) clientEl.value = p.client; });
  clientEl.addEventListener("keydown", (e) => { if (e.key === "Enter") placeEl.focus(); });
  placeEl.addEventListener("keydown", (e) => { if (e.key === "Enter") placeEl.blur(); });

  // Inhalt liegt nur online
  if (p.docs === null) {
    $("#newD").disabled = true;
    const c = el(`<div class="card"><p class="muted" id="loadMsg">Inhalt wird aus OneDrive geladen …</p></div>`);
    main.appendChild(c);
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
      title: "Dokumentation",
      date: now.toISOString(),
      updatedAt: Date.now(),
      entries: [],
      remote: {},
    };
    p.docs.push(doc);
    touchDoc(p, doc);
    go({ selectedDocId: doc.id }, { scroll: false });
    const t = $("#docTitle");
    if (t) { t.focus(); t.select(); }
  };

  // ---- Dokumentationen (neueste oben) ----
  const list = el(`<div class="card list-card"><h3 class="section-title">Dokumentationen</h3></div>`);
  if (!p.docs.length) {
    list.appendChild(el(`<div class="empty small"><p class="muted">Noch keine Dokumentationen. Lege mit „+ Neue Dokumentation“ die erste an.</p></div>`));
  }
  p.docs.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).forEach((doc) => {
    const n = imagesOfDoc(doc).length;
    const r = el(`
      <div class="doc-item ${d && d.id === doc.id ? "selected" : ""}" data-doc-id="${h(doc.id)}">
        <div class="grow">
          <div class="doc-title">${doc.protocol && doc.protocol.enabled ? `<span class="badge-abn">Abnahme</span> ` : ""}${h(doc.title)}</div>
          <div class="muted doc-meta">${formatDateDE(doc.date)} · ${doc.entries.length} Einträge · ${n} Fotos</div>
        </div>
        <button class="secondary small" data-a="pdf" type="button">PDF</button>
      </div>`);
    r.onclick = (e) => {
      const a = e.target.closest("[data-a]");
      if (a) { e.stopPropagation(); exportPdf(p.id, doc.id); return; }
      if (d && d.id === doc.id) {
        go({ selectedDocId: null }, { scroll: false });
      } else {
        go({ selectedDocId: doc.id }, { replace: !!d, scroll: false });
        const ed = $("#docEditor");
        if (ed && window.innerWidth < 1000) ed.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    list.appendChild(r);
  });
  main.appendChild(list);

  if (d) renderDocEditor(side, p, d);
  else side.appendChild(el(`<div class="card side-hint"><p class="muted">Dokumentation auswählen oder neu anlegen.</p></div>`));
}

async function deleteDoc(pid, did) {
  const p = findProject(pid);
  const d = p && p.docs.find((x) => x.id === did);
  if (!d) return;
  const extra = d.remote && d.remote.folderId ? "\n\nDer Ordner in OneDrive (inkl. Fotos und PDF) wird ebenfalls gelöscht (OneDrive-Papierkorb)." : "";
  if (!confirm(`Dokumentation „${d.title}“ wirklich löschen?${extra}`)) return;
  p.docs = p.docs.filter((x) => x.id !== did);
  p.deletedDocs.push({ id: did, at: Date.now() });
  if (d.remote && d.remote.folderId) p.pendingDeletes.push(d.remote.folderId);
  for (const img of imagesOfDoc(d)) { try { await db.imgDelete(img.id); } catch {} }
  try { await db.outboxDelete(`pdf:${pid}:${did}`); } catch {}
  touchProject(p);
  go({ selectedDocId: null }, { replace: true, scroll: false });
}

/* =========================================================
   Dokumentation bearbeiten
========================================================= */
function toDateInput(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function renderDocEditor(container, p, d) {
  const pend = draftImgs[d.id] || [];
  const card = el(`
    <div class="card" id="docEditor">
      <div class="row space-between">
        <h3 class="section-title">Dokumentation</h3>
        <button class="icon-btn" id="closeDoc" type="button" aria-label="Schließen">✕</button>
      </div>
      <div class="doc-fields">
        <div class="grow">
          <label class="field-label" for="docTitle">Titel</label>
          <input id="docTitle" type="text" value="${h(d.title)}" enterkeyhint="done" />
        </div>
        <div>
          <label class="field-label" for="docDate">Datum</label>
          <input id="docDate" type="date" value="${toDateInput(d.date)}" />
        </div>
      </div>

      <label class="switch-row">
        <input type="checkbox" id="protoToggle" ${d.protocol && d.protocol.enabled ? "checked" : ""} />
        <span class="switch" aria-hidden="true"></span>
        <span><strong>Abnahmeprotokoll</strong><br><span class="muted">mit Anwesenden und Unterschriften im PDF</span></span>
      </label>
      <div id="protoBox"></div>

      <div class="new-entry">
        <label class="field-label" for="eText">Neuer Eintrag</label>
        <textarea id="eText" placeholder="Was wurde gemacht / festgestellt?">${h(drafts[d.id] || "")}</textarea>
        <div class="images" id="draftImages">${pend.map((id) => thumbHtml({ id }, true)).join("")}</div>
        <div class="row wrap entry-actions">
          ${photoButtons("newImg")}
          <button type="button" class="primary" id="addE">Eintrag speichern</button>
        </div>
      </div>

      <h3 class="section-title">Einträge (${d.entries.length})</h3>
      <div id="elist"></div>

      <div class="row wrap doc-footer">
        <button class="primary" id="pdfDoc" type="button">PDF erstellen</button>
        <button class="danger-outline" id="delDoc" type="button">Dokumentation löschen</button>
      </div>
    </div>`);
  container.appendChild(card);

  $("#closeDoc").onclick = () => go({ selectedDocId: null }, { scroll: false });
  $("#pdfDoc").onclick = () => exportPdf(p.id, d.id);
  $("#delDoc").onclick = () => deleteDoc(p.id, d.id);

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
  titleEl.addEventListener("change", () => { if (!titleEl.value.trim()) titleEl.value = d.title; });
  titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") titleEl.blur(); });

  $("#docDate").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    const { p: cp, d: cd } = ctx();
    if (!cd) return;
    cd.date = new Date(v + "T12:00:00").toISOString();
    touchDoc(cp, cd);
    renderNow();
  });

  const tEl = $("#eText");
  tEl.addEventListener("input", () => { drafts[d.id] = tEl.value; });

  $$("input.newImg", card).forEach((inp) => inp.addEventListener("change", async (ev) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = "";
    if (!files.length) return;
    const ids = await processFiles(files);
    draftImgs[d.id] = (draftImgs[d.id] || []).concat(ids);
    renderNow();
  }));

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

  $("#protoToggle").addEventListener("change", (e) => {
    const { p: cp, d: cd } = ctx();
    if (!cd) return;
    if (e.target.checked) {
      if (!cd.protocol) cd.protocol = newProtocol(cp);
      cd.protocol.enabled = true;
    } else if (cd.protocol) {
      cd.protocol.enabled = false; // Angaben bleiben erhalten, falls wieder eingeschaltet wird
    }
    touchDoc(cp, cd);
    renderNow();
  });
  if (d.protocol && d.protocol.enabled) renderProtocol($("#protoBox"), p, d);

  renderEntries($("#elist"), p, d);
}

/* ---------- Abnahmeprotokoll: Anwesende + Unterschriften ---------- */
function sigCell(sig, sigAt, key) {
  return sig
    ? `<button class="sig-thumb" data-sign="${h(key)}" type="button" title="Unterschrift ändern">
         <img src="${sig}" alt="Unterschrift" /><span class="muted">${sigAt ? formatDateDE(sigAt) : ""}</span>
       </button>`
    : `<button class="secondary small sign-btn" data-sign="${h(key)}" type="button"><svg class="ico ico-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21c3-1 5-4 7-4s1 3 4 3 4-3 7-3"/><path d="M14.5 4.5l3 3L9 16l-4 1 1-4z"/></svg> Unterschreiben</button>`;
}

function renderProtocol(box, p, d) {
  const pr = d.protocol;
  box.appendChild(el(`
    <div class="proto">
      <h4>Anwesende <span class="muted">· Unterschrift direkt hinter dem Namen</span></h4>
      <div id="attList">
        ${pr.attendees.map((a) => `
          <div class="att-row" data-att="${h(a.id)}">
            <input class="att-name" type="text" placeholder="Name" value="${h(a.name)}" autocomplete="off" />
            <input class="att-company" type="text" placeholder="Firma" value="${h(a.company)}" autocomplete="off" />
            <div class="att-sig">${sigCell(a.sig, a.sigAt, "att:" + a.id)}</div>
            <button class="icon-btn att-del" data-del-att="${h(a.id)}" type="button" aria-label="Person entfernen">×</button>
          </div>`).join("")}
      </div>
      <button class="secondary small" id="attAdd" type="button">+ Person hinzufügen</button>
      <p class="muted proto-hint">Ohne Unterschrift bleibt das Feld im PDF frei (zum Unterschreiben auf Papier). Nachträglich unterschreiben: hier unterschreiben und PDF neu erstellen.</p>
    </div>`));

  const cur = () => {
    const { p: cp, d: cd } = ctx();
    return cd && cd.protocol ? { cp, cd, pr: cd.protocol } : null;
  };

  $$(".att-row", box).forEach((row) => {
    const id = row.dataset.att;
    const upd = () => {
      const c = cur(); if (!c) return;
      const a = c.pr.attendees.find((x) => x.id === id); if (!a) return;
      a.name = $(".att-name", row).value;
      a.company = $(".att-company", row).value;
      touchDoc(c.cp, c.cd);
    };
    $(".att-name", row).addEventListener("input", upd);
    $(".att-company", row).addEventListener("input", upd);
  });
  $$("[data-del-att]", box).forEach((b) => {
    b.onclick = () => {
      const c = cur(); if (!c) return;
      const a = c.pr.attendees.find((x) => x.id === b.dataset.delAtt);
      if (a && a.sig && !confirm(`${a.name || "Person"} hat bereits unterschrieben. Trotzdem entfernen?`)) return;
      c.pr.attendees = c.pr.attendees.filter((x) => x.id !== b.dataset.delAtt);
      touchDoc(c.cp, c.cd);
      renderNow();
    };
  });
  $("#attAdd").onclick = () => {
    const c = cur(); if (!c) return;
    const id = newId();
    c.pr.attendees.push({ id, name: "", company: "", sig: null, sigAt: null });
    touchDoc(c.cp, c.cd);
    renderNow();
    const inp = $(`[data-att="${CSS.escape(id)}"] .att-name`);
    if (inp) inp.focus();
  };

  $$("[data-sign]", box).forEach((b) => {
    b.onclick = async () => {
      const c = cur(); if (!c) return;
      const [kind, key] = b.dataset.sign.split(":");
      let target, title, subtitle;
      if (kind === "att") {
        target = c.pr.attendees.find((x) => x.id === key);
        if (!target) return;
        if (!target.name.trim()) {
          toast("Bitte zuerst den Namen eintragen.", "warn");
          const nameEl = $(`[data-att="${CSS.escape(key)}"] .att-name`);
          if (nameEl) nameEl.focus();
          return;
        }
        title = `Unterschrift ${target.name}`;
        subtitle = target.company;
      } else {
        target = c.pr[key];
        title = `Unterschrift ${key === "contractor" ? "Auftragnehmer" : "Auftraggeber"}${target.name ? " – " + target.name : ""}`;
        subtitle = key === "contractor" ? CONTRACTOR_COMPANY : (c.cp.client || "");
      }
      const res = await captureSignature({ title, subtitle, canRemove: !!target.sig });
      if (res === undefined) return;
      target.sig = res;
      target.sigAt = res ? Date.now() : null;
      touchDoc(c.cp, c.cd);
      renderNow();
    };
  });
}

async function processFiles(files) {
  const ids = [];
  try {
    for (let i = 0; i < files.length; i++) {
      setBusy(files.length > 1 ? `Foto ${i + 1}/${files.length} wird verarbeitet …` : "Foto wird verarbeitet …");
      try {
        const r = await processFile(files[i]);
        const id = newId();
        await db.imgPut({ id, archive: r.archive, thumb: r.thumb });
        ids.push(id);
      } catch (e) {
        console.warn(e);
        toast(`Foto „${files[i].name}“: ${e.message}`, "error", 7000);
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
  renderNow();
  toast("Eintrag gespeichert.", "info", 1800);
}

function renderEntries(container, p, d) {
  if (!d.entries.length) {
    container.appendChild(el(`<p class="muted">Noch keine Einträge.</p>`));
    return;
  }
  d.entries.forEach((en, i) => {
    const c = el(`
      <div class="entry" data-entry-id="${h(en.id)}">
        <div class="row space-between">
          <span class="entry-no">${i + 1}.</span>
          <button class="link-danger small" data-a="del-entry" type="button">Löschen</button>
        </div>
        <textarea class="entryText" placeholder="Beschreibung">${h(en.description)}</textarea>
        <div class="images">${en.images.map((img) => thumbHtml(img, true)).join("")}</div>
        ${photoButtons("entryImg", true)}
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
      renderNow();
    };

    $$("[data-del-img]", c).forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm("Foto löschen?")) return;
        const f = findEntry();
        if (!f) return;
        const img = f.ce.images.find((x) => x.id === b.dataset.delImg);
        if (!img) return;
        f.ce.images = f.ce.images.filter((x) => x !== img);
        if (img.rid) f.cp.pendingDeletes.push(img.rid);
        try { await db.imgDelete(img.id); } catch {}
        touchDoc(f.cp, f.cd);
        renderNow();
      };
    });

    $$("input.entryImg", c).forEach((inp) => inp.addEventListener("change", async (ev) => {
      const files = Array.from(ev.target.files || []);
      ev.target.value = "";
      if (!files.length) return;
      const ids = await processFiles(files);
      const f = findEntry();
      if (!f) return;
      f.ce.images.push(...ids.map((id) => ({ id })));
      touchDoc(f.cp, f.cd);
      renderNow();
    }));

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
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  await saveNow();
  setBusy("PDF wird erstellt …");
  try {
    const { blob, filename, missing } = await buildPdf(p, d, (m) => setBusy(m));
    const what = d.protocol && d.protocol.enabled ? "Abnahmeprotokoll" : "Dokumentation";
    openPdfPreview(blob, filename, `BV ${p.number}${p.client ? " " + p.client : ""} – ${what} „${d.title}“ vom ${formatDateDE(d.date)}`);
    if (missing) toast(`${missing} Foto(s) konnten nicht geladen werden (offline?).`, "warn", 7000);
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

function openPdfPreview(blob, filename, shareText = "") {
  if (lastPdf.url) { try { URL.revokeObjectURL(lastPdf.url); } catch {} }
  lastPdf = { blob, url: URL.createObjectURL(blob), name: filename };

  const modal = $("#pdfModal");
  const frame = $("#pdfFrame");
  const pages = $("#pdfPages");
  $("#pdfName").textContent = filename;
  $("#pdfSize").textContent = `${(blob.size / 1048576).toFixed(1)} MB` +
    (od.isConfigured() ? " · wird in OneDrive abgelegt" : "");
  modal.style.display = "block";
  document.body.style.overflow = "hidden";
  if (isTouch) {
    // Handy/Tablet: Seiten direkt in der App anzeigen (Browser können PDFs dort oft nicht öffnen)
    pages.innerHTML = `<p class="muted center">PDF wird angezeigt …</p>`;
    renderPdfPages(blob, pages).catch((e) => {
      console.warn(e);
      pages.innerHTML = `<p class="muted center">Vorschau nicht möglich – bitte „Teilen“ verwenden.</p>`;
    });
  } else {
    frame.src = lastPdf.url;
  }
  try { history.pushState({ ...navState(), pdf: true }, ""); } catch {}

  const close = () => {
    modal.style.display = "none";
    frame.src = "about:blank";
    pages.innerHTML = "";
    document.body.style.overflow = "";
  };
  $("#pdfClose").onclick = () => { if (history.state && history.state.pdf) history.back(); else close(); };
  window.addEventListener("popstate", close, { once: true });

  $("#pdfOpenTab").onclick = () => window.open(lastPdf.url, "_blank");
  $("#pdfDownload").onclick = () => {
    const a = document.createElement("a");
    a.href = lastPdf.url;
    a.download = lastPdf.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  $("#pdfOpenTab").style.display = isTouch ? "none" : "";
  // iPhone: „Speichern“ steckt im Teilen-Menü („In Dateien sichern“)
  $("#pdfDownload").style.display = isIOS && navigator.share ? "none" : "";
  const shareBtn = $("#pdfShare");
  shareBtn.style.display = navigator.share ? "" : "none";
  shareBtn.onclick = async () => {
    try {
      const file = new File([lastPdf.blob], lastPdf.name, { type: "application/pdf" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        toast("Dieses Gerät kann PDFs nicht direkt teilen – bitte „Speichern“ verwenden.", "warn", 6000);
        return;
      }
      await navigator.share({ files: [file], title: lastPdf.name, text: shareText || lastPdf.name });
    } catch (e) {
      if (!e || e.name !== "AbortError") toast("Teilen nicht möglich – bitte „Öffnen“ oder „Speichern“ verwenden.", "warn");
    }
  };
}

// pdf.js erst bei Bedarf laden (spart Ladezeit beim Start)
let pdfjsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/pdf.min.js";
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfjsPromise = null; reject(new Error("PDF-Anzeige konnte nicht geladen werden")); };
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}

async function renderPdfPages(blob, container) {
  const lib = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await lib.getDocument({ data }).promise;
  container.innerHTML = "";
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const cssW = Math.min(container.clientWidth - 16, 900);
  for (let n = 1; n <= doc.numPages; n++) {
    if (!container.isConnected || $("#pdfModal").style.display === "none") return;
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = (cssW / base.width) * dpr;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = cssW + "px";
    canvas.className = "pdf-page";
    container.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  }
  doc.destroy();
}

/* =========================================================
   Einstellungen
========================================================= */
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  if (S.state.view === "settings") requestRender();
});

function installHtml() {
  if (isStandalone()) return `<p>✓ BauDoc läuft als App.</p>`;
  if (deferredInstall) return `
    <p class="muted">BauDoc als App installieren: eigenes Symbol auf dem Startbildschirm, Vollbild, schneller Start.</p>
    <button class="primary" id="installBtn" type="button">App installieren</button>`;
  if (isIOS) return `
    <p class="muted">So wird BauDoc zur App auf dem iPhone/iPad:</p>
    <ol class="steps">
      <li>Diese Seite in <strong>Safari</strong> öffnen</li>
      <li>Unten auf <strong>Teilen</strong> tippen (Quadrat mit Pfeil nach oben)</li>
      <li><strong>„Zum Home-Bildschirm“</strong> wählen</li>
    </ol>
    <p class="muted">Wichtig: Als App bleiben die Daten auf dem Gerät dauerhaft gespeichert.</p>`;
  return `<p class="muted">Im Browser-Menü <strong>„App installieren“</strong> bzw. <strong>„Zum Startbildschirm hinzufügen“</strong> wählen. Im Browser am PC funktioniert BauDoc auch ohne Installation.</p>`;
}

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
      <p class="muted">Mit dem Firmenkonto anmelden. Danach sind deine Bauvorhaben und Favoriten auf allen deinen Geräten gleich.</p>
      <button class="primary" id="login" type="button">Mit Microsoft anmelden</button>`;
  } else {
    const acc = od.getAccount();
    odHtml = `
      <p>Angemeldet als <strong>${h(acc.name || acc.username)}</strong><br><span class="muted">${h(acc.username || "")}</span></p>
      <p class="muted">Ablage: OneDrive › ${h(CONFIG.rootFolder)}<br>
        Letzter Abgleich: ${s.lastSync ? formatDateTimeDE(s.lastSync) : "–"}<br>
        Ausstehend: ${s.pending}${s.kind === "error" ? `<br><span class="error-text">Fehler: ${h(s.message)}</span>` : ""}</p>
      <div class="row wrap">
        <button class="primary" id="syncNow" type="button">Jetzt abgleichen</button>
        <button class="secondary" id="logout" type="button">Abmelden</button>
      </div>`;
  }

  app.appendChild(el(`<div class="page-head"><h1>Einstellungen</h1></div>`));
  app.appendChild(el(`<div class="card"><h3 class="section-title">Konto &amp; OneDrive</h3>${odHtml}</div>`));
  app.appendChild(el(`<div class="card"><h3 class="section-title">App</h3>${installHtml()}</div>`));
  app.appendChild(el(`
    <div class="card">
      <h3 class="section-title">Datensicherung</h3>
      <p class="muted">Speichert alle Bauvorhaben und alle Fotos, die auf diesem Gerät liegen, in eine Datei.</p>
      <div class="row wrap">
        <button class="secondary" id="bkExport" type="button">Sicherung speichern</button>
        <label class="file-btn">Sicherung laden
          <input id="bkImport" type="file" accept="application/json,.json" />
        </label>
      </div>
    </div>`));
  app.appendChild(el(`
    <div class="card">
      <h3 class="section-title">Speicher auf diesem Gerät</h3>
      <p class="muted" id="storageInfo">wird ermittelt …</p>
    </div>`));
  app.appendChild(el(`<p class="muted center">BauDoc ${h(APP_VERSION)}</p>`));

  const loginBtn = $("#login");
  if (loginBtn) loginBtn.onclick = () => od.login();
  const syncBtn = $("#syncNow");
  if (syncBtn) syncBtn.onclick = async () => { await sync.run({ full: true }); render(); };
  const logoutBtn = $("#logout");
  if (logoutBtn) logoutBtn.onclick = () => {
    if (confirm("Abmelden? Die Daten auf diesem Gerät bleiben erhalten.")) od.logout();
  };
  const installBtn = $("#installBtn");
  if (installBtn) installBtn.onclick = async () => {
    try { deferredInstall.prompt(); await deferredInstall.userChoice; } catch {}
    deferredInstall = null;
    render();
  };

  $("#bkExport").onclick = async () => {
    try {
      const r = await exportBackup((m) => setBusy(m));
      if (r.online) toast(`${r.online} Foto(s) liegen nur in OneDrive und sind nur als Vorschau bzw. gar nicht enthalten.`, "warn", 8000);
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
      toast(`Sicherung geladen: ${r.projects} Bauvorhaben, ${r.images} Fotos.`, "info", 6000);
      go({ view: "projects", selectedProjectId: null, selectedDocId: null }, { replace: true });
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
          (est ? `Belegt: ${mb(est.usage || 0)}<br>` : "") +
          (persisted || isStandalone()
            ? "Daten sind vor automatischem Löschen geschützt ✓"
            : "Daten sind <strong>nicht</strong> vor automatischem Löschen durch den Browser geschützt. Tipp: BauDoc als App installieren (siehe oben).");
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

// Anderes Konto als zuletzt? Dann nicht die Daten zweier Nutzer vermischen.
async function checkAccount() {
  const acc = od.getAccount();
  if (!acc) return;
  const st = S.state;
  const id = acc.homeAccountId || acc.username;
  if (st.accountId && st.accountId !== id && allProjects().length) {
    const ok = confirm(
      `Angemeldet als ${acc.username}.\n\nAuf diesem Gerät liegen noch Daten eines anderen Kontos. ` +
      `Sollen diese lokalen Daten entfernt werden? (In OneDrive bleibt alles erhalten.)\n\n` +
      `Abbrechen = Daten behalten`
    );
    if (ok) await resetLocal();
  }
  st.accountId = id;
  await saveNow();
}

(async function init() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}

  await load();
  // Startansicht: eigene Favoriten, falls vorhanden
  if (S.state.view === "projects" && !S.state.selectedProjectId && S.state.projects.some((p) => p.fav)) {
    S.state.view = "favorites";
  }

  try {
    await od.init();
  } catch (e) {
    console.warn("Anmeldung", e);
    toast("Anmeldung fehlgeschlagen: " + (e.message || e), "error", 10000);
  }
  await checkAccount();

  setupSearch();
  sync.onStatus(() => updateSyncChip());
  sync.onData(() => requestRender());
  onChange((kind) => {
    if (kind === "data") { sync.refreshStatus(); sync.schedule(4000); }
  });

  try { history.replaceState(navState(), ""); } catch {}
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
