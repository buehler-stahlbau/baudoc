/* =========================================================
   Abgleich mit OneDrive

   Ablage:
     BauDoc/
       12345 Neubau Lagerhalle/
         baudoc.json                 <- Texte, Struktur (klein)
         18.11.2026 Rohbau/
           12345 18.11.2026 Rohbau.pdf
           Bilder/
             20261118-143512-a3f91c.jpg   (≤ 1 MB)
       _Archiv/
         ...archivierte Bauvorhaben

   Regeln:
   - Lokale Änderungen werden immer hochgeladen.
   - Die Liste aller Bauvorhaben wird immer geladen (nur Ordnernamen).
   - Favoriten: Inhalt + alle Bilder werden auf dem Gerät gehalten.
   - Andere Bauvorhaben: Inhalt nur beim Öffnen, Bilder nur als
     Vorschau; Archivbilder werden nach dem Hochladen vom Gerät gelöscht.
========================================================= */
import * as od from "./onedrive.js";
import * as db from "./db.js";
import { CONFIG } from "./config.js";
import {
  S, saveNow, allProjects, findByNumber, isActive, moveLocal,
  removeProjectLocal, normalizeProject, imagesOfDoc, imagesOfProject,
} from "./store.js";
import { sanitizeName, projectLabel, sleep, isoDay } from "./util.js";
import { makeThumb } from "./images.js";

const PROJECT_FILE = "baudoc.json";
const FOLDER_RE = /^(\d{5})(?:\s+(.*))?$/;
const TOMBSTONE_MAX_AGE = 180 * 24 * 3600 * 1000;

/* ---------- Status ---------- */
export const status = { kind: "off", message: "", pending: 0, lastSync: null };
const statusListeners = new Set();
const dataListeners = new Set();
export const onStatus = (fn) => statusListeners.add(fn);
export const onData = (fn) => dataListeners.add(fn);

let outboxCount = 0;

function hasUnuploaded(p) {
  return imagesOfProject(p).some((i) => !i.rid && !i.missing);
}

function countPending() {
  let n = outboxCount + (S.state.remote.pendingFolderDeletes || []).length + (S.state.prefs.dirty ? 1 : 0);
  for (const p of allProjects()) {
    if (p.dirty || p.moveTo) n++;
    n += (p.pendingDeletes || []).length;
    n += imagesOfProject(p).filter((i) => !i.rid && !i.missing).length;
  }
  return n;
}

function setStatus(kind, message = "") {
  status.kind = kind;
  status.message = message;
  status.pending = countPending();
  statusListeners.forEach((fn) => { try { fn(status); } catch (e) { console.error(e); } });
}

export function refreshStatus() {
  if (status.kind === "syncing") return setStatus("syncing", status.message);
  if (!od.isConfigured()) return setStatus("off");
  if (!od.isSignedIn()) return setStatus("signedout", status.kind === "signedout" ? status.message : "");
  if (!navigator.onLine) return setStatus("offline");
  if (status.kind === "error") return setStatus("error", status.message);
  setStatus(countPending() ? "pending" : "idle");
}

export async function updateOutboxCount() {
  try { outboxCount = (await db.outboxAll()).length; } catch {}
  refreshStatus();
}

/* ---------- Steuerung ---------- */
let running = false;
let rerun = false;
let rerunFull = false;
let timer = null;
let nextFull = false;

export function schedule(delay = 3000, { full = false } = {}) {
  nextFull = nextFull || full;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const f = nextFull;
    nextFull = false;
    run({ full: f });
  }, delay);
}

export async function whenIdle() {
  while (running) await sleep(150);
}

function snapshot() {
  try {
    return JSON.stringify([S.state.projects, S.state.archivedProjects, S.state.selectedProjectId]);
  } catch { return Math.random().toString(); }
}

export async function run({ full = false } = {}) {
  if (!od.isConfigured()) return setStatus("off");
  if (!od.isSignedIn()) return setStatus("signedout");
  if (!navigator.onLine) return setStatus("offline");
  if (running) { rerun = true; rerunFull = rerunFull || full; return; }

  running = true;
  const before = snapshot();
  setStatus("syncing");
  try {
    outboxCount = (await db.outboxAll()).length;
    await syncAll(full);
    status.lastSync = Date.now();
    setStatus(countPending() ? "pending" : "idle");
  } catch (e) {
    console.warn("Sync-Fehler", e);
    if (e && e.authRequired) setStatus("signedout", "Anmeldung abgelaufen – bitte neu anmelden");
    else setStatus(navigator.onLine ? "error" : "offline", (e && e.message) || String(e));
  } finally {
    running = false;
    await saveNow();
    if (snapshot() !== before) dataListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    if (rerun) {
      const f = rerunFull;
      rerun = false;
      rerunFull = false;
      schedule(300, { full: f });
    }
  }
}

// Bauvorhaben öffnen, dessen Inhalt nur online liegt
export async function loadProject() {
  await whenIdle();
  await run({ full: false });
}

/* ---------- Ablauf ---------- */
async function syncAll(full) {
  const st = S.state;
  const root = await od.getRootFolder();
  st.remote.rootId = root.id;

  for (const id of [...st.remote.pendingFolderDeletes]) {
    await od.deleteItem(id);
    st.remote.pendingFolderDeletes = st.remote.pendingFolderDeletes.filter((x) => x !== id);
  }

  if (full) await refreshListing(root);
  if (full || S.state.prefs.dirty) await syncPrefs(root);

  const outbox = await db.outboxAll();
  const sel = st.selectedProjectId;
  const targets = allProjects().filter((p) =>
    p.dirty || p.moveTo || p.pendingDeletes.length || hasUnuploaded(p) ||
    outbox.some((o) => o.projectId === p.id) ||
    p.id === sel || // geöffnetes Bauvorhaben immer aktuell halten (1 kleine Abfrage)
    (full && p.fav && isActive(p))
  );

  let firstError = null;
  for (const p of targets) {
    try {
      await syncProject(p, root, outbox);
    } catch (e) {
      if (e && e.authRequired) throw e;
      console.warn(`Sync ${p.number} fehlgeschlagen`, e);
      if (!firstError) firstError = e;
    }
  }
  outboxCount = (await db.outboxAll()).length;
  if (firstError) throw firstError;
}

/* Favoriten je Nutzer: BauDoc/_Nutzer/<anmeldename>.json */
async function syncPrefs(root) {
  const acc = od.getAccount();
  if (!acc) return;
  const pr = S.state.prefs;
  const folder = await od.ensureFolder(root.id, CONFIG.usersFolder);
  const name = sanitizeName(String(acc.username || acc.homeAccountId || "nutzer").toLowerCase()) + ".json";
  const remote = await od.getJson(folder.id, name);
  const remoteAt = (remote && remote.data && remote.data.favUpdatedAt) || 0;

  if (remote && remoteAt > (pr.favUpdatedAt || 0)) {
    const favs = new Set(remote.data.favorites || []);
    for (const p of allProjects()) {
      const was = p.fav;
      p.fav = favs.has(p.number);
      if (was && !p.fav) { try { await freeLocal(p); } catch (e) { console.warn(e); } }
    }
    pr.favUpdatedAt = remoteAt;
    pr.dirty = false;
    return;
  }
  if (!remote || pr.dirty) {
    const rev = pr.rev;
    if (!pr.favUpdatedAt) pr.favUpdatedAt = Date.now();
    await od.putJson(folder.id, name, {
      format: "baudoc-user",
      user: acc.username || "",
      favorites: allProjects().filter((p) => p.fav).map((p) => p.number).sort(),
      favUpdatedAt: pr.favUpdatedAt,
    }, null);
    if (pr.rev === rev) pr.dirty = false;
  }
}

async function ensureArchive(root) {
  return od.ensureFolder(root.id, CONFIG.archiveFolder);
}

function folderNameFor(p) {
  return sanitizeName(projectLabel(p));
}

/* Liste aller Bauvorhaben aus OneDrive (nur Ordnernamen) */
async function refreshListing(root) {
  const st = S.state;
  const kids = await od.listChildren(root.id);
  const arch = kids.find((k) => k.folder && k.name === CONFIG.archiveFolder);
  const archKids = arch ? await od.listChildren(arch.id) : [];

  const found = [];
  const collect = (list, loc) => {
    for (const k of list) {
      const m = k.folder && k.name.match(FOLDER_RE);
      if (m) found.push({ item: k, number: m[1], title: (m[2] || "").trim(), loc });
    }
  };
  collect(kids, "active");
  collect(archKids, "archive");
  const foundIds = new Set(found.map((f) => f.item.id));

  for (const f of found) {
    let p = findByNumber(f.number);
    if (!p) {
      p = {
        id: f.number, number: f.number, title: f.title, fav: false,
        docs: null, deletedDocs: [], pendingDeletes: [], moveTo: null,
        remote: { folderId: f.item.id, baseName: f.item.name, etag: null },
        updatedAt: 0, rev: 0, dirty: false,
      };
      normalizeProject(p);
      (f.loc === "archive" ? st.archivedProjects : st.projects).push(p);
      continue;
    }
    if (p.remote.folderId !== f.item.id) {
      if (p.remote.folderId && foundIds.has(p.remote.folderId)) continue; // doppelter Ordner – ignorieren
      p.remote = { folderId: f.item.id, baseName: f.item.name, etag: null };
    }
    if (p.remote.baseName !== f.item.name && !p.dirty) {
      p.remote.baseName = f.item.name;
      if (p.docs === null) { p.title = f.title; delete p.client; delete p.place; normalizeProject(p); }
    }
    const loc = isActive(p) ? "active" : "archive";
    if (!p.moveTo && loc !== f.loc) moveLocal(p, f.loc);
  }

  // Ordner in OneDrive gelöscht?
  for (const p of allProjects()) {
    if (!p.remote.folderId || foundIds.has(p.remote.folderId)) continue;
    if (p.dirty || hasUnuploaded(p)) {
      // Lokale Änderungen vorhanden -> neu anlegen statt löschen
      p.remote = {};
      for (const d of p.docs || []) {
        d.remote = {};
        for (const img of imagesOfDoc(d)) delete img.rid;
      }
      p.dirty = true;
    } else {
      await removeProjectLocal(p);
    }
  }
}

async function syncProject(p, root, outbox) {
  // 1) Projektordner
  if (!p.remote.folderId) {
    const parent = isActive(p) ? root : await ensureArchive(root);
    const existing = (await od.listChildren(parent.id)).find((k) => {
      const m = k.folder && k.name.match(FOLDER_RE);
      return m && m[1] === p.number;
    });
    const f = existing || (await od.createFolder(parent.id, folderNameFor(p), "fail"));
    p.remote = { folderId: f.id, baseName: f.name, etag: null };
    p.moveTo = null;
  }

  // 2) Archivieren / Wiederherstellen
  if (p.moveTo) {
    const parent = p.moveTo === "archive" ? await ensureArchive(root) : root;
    await od.moveItem(p.remote.folderId, parent.id);
    p.moveTo = null;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    // 3) Stand aus OneDrive holen und zusammenführen
    const remote = await od.getJson(p.remote.folderId, PROJECT_FILE);
    if (remote && remote.eTag !== p.remote.etag) {
      if (p.docs === null) adoptRemote(p, remote.data);
      else await mergeRemote(p, remote.data);
    }
    if (p.docs === null) p.docs = [];

    // 4) Ordnername an Bezeichnung anpassen
    const want = folderNameFor(p);
    if (want !== p.remote.baseName) {
      await od.renameItem(p.remote.folderId, want);
      p.remote.baseName = want;
    }

    // 5) Doku-Ordner + Bilder
    for (const d of p.docs) await syncDoc(p, d);

    // 6) Gelöschtes in OneDrive entfernen (-> Papierkorb)
    for (const id of [...p.pendingDeletes]) {
      await od.deleteItem(id);
      p.pendingDeletes = p.pendingDeletes.filter((x) => x !== id);
    }

    // 7) PDFs ablegen
    for (const o of outbox.filter((x) => x.projectId === p.id && !x.done)) {
      const d = p.docs.find((x) => x.id === o.docId);
      if (d) {
        await syncDoc(p, d);
        await od.uploadFile(d.remote.folderId, o.name, o.blob, "application/pdf");
      }
      await db.outboxDelete(o.id);
      o.done = true;
      outboxCount = Math.max(0, outboxCount - 1);
    }

    // 8) baudoc.json schreiben (nur wenn sich etwas geändert hat)
    const rev = p.rev;
    const json = serialize(p);
    if (!remote || JSON.stringify(remote.data) !== JSON.stringify(json)) {
      const res = await od.putJson(p.remote.folderId, PROJECT_FILE, json, remote ? remote.eTag : null);
      if (res.conflict) continue; // zwischenzeitlich von anderem Gerät geändert -> nochmal
      p.remote.etag = res.eTag;
    } else {
      p.remote.etag = remote.eTag;
    }
    if (p.rev === rev) p.dirty = false;

    // 9) Speicher auf dem Gerät
    await applyCachePolicy(p);
    return;
  }
  throw new Error(`Bauvorhaben ${p.number}: gleichzeitige Änderung – wird erneut versucht`);
}

export function docFolderName(d) {
  const dt = new Date(d.date);
  return sanitizeName(`${isNaN(dt) ? "" : isoDay(dt) + " "}${d.title || "Dokumentation"}`);
}

async function syncDoc(p, d, retry = true) {
  if (!d.remote) d.remote = {};
  const want = docFolderName(d);
  try {
    if (!d.remote.folderId) {
      const f = await od.createFolder(p.remote.folderId, want, "rename");
      d.remote = { folderId: f.id, baseName: want, bilderId: null };
    } else if (d.remote.baseName !== want) {
      await od.renameItem(d.remote.folderId, want);
      d.remote.baseName = want;
    }

    const todo = imagesOfDoc(d).filter((i) => !i.rid && !i.missing);
    if (!todo.length) return;
    if (!d.remote.bilderId) {
      const b = await od.ensureFolder(d.remote.folderId, "Bilder");
      d.remote.bilderId = b.id;
    }
    for (const img of todo) {
      const rec = await db.imgGet(img.id);
      if (!rec || !rec.archive) { img.missing = true; continue; }
      const item = await od.uploadFile(d.remote.bilderId, `${img.id}.jpg`, rec.archive, "image/jpeg");
      img.rid = item.id;
      setStatus("syncing");
    }
  } catch (e) {
    if (retry && e && e.status === 404) {
      d.remote = {};
      return syncDoc(p, d, false);
    }
    throw e;
  }
}

/* ---------- Format von baudoc.json ---------- */
function serialize(p) {
  return {
    format: "baudoc-project",
    version: 2,
    number: p.number,
    title: p.title,
    client: p.client || "",
    place: p.place || "",
    updatedAt: p.updatedAt || 0,
    deletedDocs: p.deletedDocs || [],
    docs: (p.docs || []).map((d) => ({
      id: d.id,
      title: d.title,
      date: d.date,
      updatedAt: d.updatedAt || 0,
      protocol: d.protocol || null,
      remote: {
        folderId: d.remote?.folderId || null,
        baseName: d.remote?.baseName || null,
        bilderId: d.remote?.bilderId || null,
      },
      entries: (d.entries || []).map((e) => ({
        id: e.id,
        description: e.description || "",
        images: (e.images || []).map((i) => ({ id: i.id, rid: i.rid || null })),
      })),
    })),
  };
}

function cleanDoc(d) {
  const c = JSON.parse(JSON.stringify(d));
  c.remote = c.remote || {};
  for (const e of c.entries || []) {
    for (const i of e.images || []) if (!i.rid) delete i.rid;
  }
  return c;
}

function adoptTitle(p, r) {
  if (!r.title) return;
  p.title = r.title;
  if (typeof r.client === "string") { p.client = r.client; p.place = r.place || ""; }
  else { delete p.client; delete p.place; } // wird aus title abgeleitet
}

function adoptRemote(p, r) {
  adoptTitle(p, r);
  p.updatedAt = r.updatedAt || 0;
  p.deletedDocs = r.deletedDocs || [];
  p.docs = (r.docs || []).map(cleanDoc);
  normalizeProject(p);
}

// Zusammenführen auf Ebene der Dokumentationen: neuere Version gewinnt
async function mergeRemote(p, r) {
  if ((r.updatedAt || 0) > (p.updatedAt || 0)) {
    adoptTitle(p, r);
    p.updatedAt = r.updatedAt;
  }

  const tomb = new Map();
  for (const t of [...(p.deletedDocs || []), ...(r.deletedDocs || [])]) {
    if (!tomb.has(t.id) || tomb.get(t.id) < t.at) tomb.set(t.id, t.at);
  }
  const now = Date.now();
  p.deletedDocs = [...tomb].map(([id, at]) => ({ id, at })).filter((t) => now - t.at < TOMBSTONE_MAX_AGE);

  const rById = new Map((r.docs || []).map((d) => [d.id, d]));
  const isDeleted = (d) => tomb.has(d.id) && tomb.get(d.id) >= (d.updatedAt || 0);

  for (let i = p.docs.length - 1; i >= 0; i--) {
    const ld = p.docs[i];
    const rd = rById.get(ld.id);
    if (isDeleted(ld)) {
      p.docs.splice(i, 1);
      for (const img of imagesOfDoc(ld)) { try { await db.imgDelete(img.id); } catch {} }
      continue;
    }
    if (!rd) continue;
    if ((rd.updatedAt || 0) > (ld.updatedAt || 0)) {
      // Remote ist neuer -> lokal ersetzen (Objekt bleibt dasselbe)
      const oldRids = new Map(imagesOfDoc(ld).map((x) => [x.id, x.rid]));
      const oldIds = new Set(oldRids.keys());
      const oldRemote = ld.remote || {};
      const fresh = cleanDoc(rd);
      for (const k of Object.keys(ld)) delete ld[k];
      Object.assign(ld, fresh);
      ld.remote = { ...oldRemote, ...Object.fromEntries(Object.entries(fresh.remote).filter(([, v]) => v)) };
      for (const img of imagesOfDoc(ld)) {
        if (!img.rid && oldRids.get(img.id)) img.rid = oldRids.get(img.id);
        oldIds.delete(img.id);
      }
      for (const id of oldIds) { try { await db.imgDelete(id); } catch {} }
    } else {
      // Lokal ist neuer/gleich -> nur fehlende OneDrive-IDs übernehmen
      const rRids = new Map(imagesOfDoc(rd).map((x) => [x.id, x.rid]));
      for (const img of imagesOfDoc(ld)) if (!img.rid && rRids.get(img.id)) img.rid = rRids.get(img.id);
      ld.remote = ld.remote || {};
      for (const k of ["folderId", "baseName", "bilderId"]) {
        if (!ld.remote[k] && rd.remote && rd.remote[k]) ld.remote[k] = rd.remote[k];
      }
    }
  }

  const localIds = new Set(p.docs.map((d) => d.id));
  for (const rd of r.docs || []) {
    if (!localIds.has(rd.id) && !isDeleted(rd)) p.docs.push(cleanDoc(rd));
  }
  normalizeProject(p);
}

/* ---------- Was bleibt auf dem Gerät? ---------- */
async function applyCachePolicy(p) {
  for (const img of imagesOfProject(p)) {
    if (!img.rid) continue;
    try {
      const rec = await db.imgGet(img.id);
      if (p.fav) {
        if (!rec || !rec.archive) {
          const blob = await od.downloadBlob(img.rid);
          const thumb = (rec && rec.thumb) || (await makeThumb(blob));
          await db.imgPut({ id: img.id, archive: blob, thumb });
        }
      } else if (rec && rec.archive) {
        const thumb = rec.thumb || (await makeThumb(rec.archive));
        await db.imgPut({ id: img.id, thumb });
      }
    } catch (e) {
      if (e && e.authRequired) throw e;
      console.warn("Bild-Cache", img.id, e);
    }
  }
}

// Favorit entfernt -> Archivbilder (die schon online sind) vom Gerät löschen
export async function freeLocal(p) {
  if (p.fav || !od.isConfigured()) return;
  for (const img of imagesOfProject(p)) {
    if (!img.rid) continue;
    const rec = await db.imgGet(img.id);
    if (rec && rec.archive) {
      const thumb = rec.thumb || (await makeThumb(rec.archive));
      await db.imgPut({ id: img.id, thumb });
    }
  }
}
