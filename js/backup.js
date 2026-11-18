/* =========================================================
   Datensicherung als Datei (zusätzlich zu OneDrive)
   Enthält alle Texte und alle Bilder, die auf diesem Gerät liegen.
========================================================= */
import * as db from "./db.js";
import { S, allProjects, imagesOfProject, normalizeProject, saveNow } from "./store.js";
import { blobToDataUrl, dataUrlToBlob } from "./images.js";
import { isoDay, saveOrShareFile } from "./util.js";

export async function exportBackup(onProgress = () => {}) {
  const st = S.state;
  const meta = JSON.stringify({
    format: "baudoc-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    projects: st.projects,
    archivedProjects: st.archivedProjects,
  });
  const parts = [meta.slice(0, -1), ',"images":{'];
  const imgs = allProjects().flatMap(imagesOfProject);
  let first = true;
  let count = 0;
  let online = 0;
  for (let i = 0; i < imgs.length; i++) {
    onProgress(`Sicherung: Bild ${i + 1}/${imgs.length} …`);
    const rec = await db.imgGet(imgs[i].id);
    const blob = rec && (rec.archive || rec.thumb);
    if (!blob) { online++; continue; }
    if (!rec.archive) online++;
    const du = await blobToDataUrl(blob);
    parts.push((first ? "" : ",") + JSON.stringify(imgs[i].id) + ":" + JSON.stringify(du));
    first = false;
    count++;
  }
  parts.push("}}");
  const blob = new Blob(parts, { type: "application/json" });
  await saveOrShareFile(blob, `BauDoc-Sicherung-${isoDay()}.json`);
  return { count, online };
}

export async function importBackup(file, onProgress = () => {}) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Datei ist keine gültige Sicherung"); }
  if (!data || data.format !== "baudoc-backup") throw new Error("Datei ist keine BauDoc-Sicherung");

  const entries = Object.entries(data.images || {});
  for (let i = 0; i < entries.length; i++) {
    onProgress(`Wiederherstellen: Bild ${i + 1}/${entries.length} …`);
    const [id, du] = entries[i];
    await db.imgPut({ id, archive: dataUrlToBlob(du) });
  }

  const st = S.state;
  st.projects = data.projects || [];
  st.archivedProjects = data.archivedProjects || [];
  st.selectedProjectId = null;
  st.selectedDocId = null;
  st.view = "projects";
  for (const p of allProjects()) {
    normalizeProject(p);
    if (p.docs) { p.dirty = true; p.rev = (p.rev || 0) + 1; }
  }
  await saveNow();
  return { projects: allProjects().length, images: entries.length };
}
