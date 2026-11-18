/* =========================================================
   Bildverarbeitung
   - Archivbild: max. 1 MB (geht nach OneDrive)
   - Vorschaubild: ca. 400 px (für die Anzeige in der App)
   - PDF-Bild: wird beim PDF-Export aus dem Archivbild erzeugt
   Die EXIF-Ausrichtung übernimmt der Browser selbst
   (alle aktuellen Browser drehen Fotos beim Zeichnen richtig).
========================================================= */
export const ARCHIVE_MAX_BYTES = 1024 * 1024;
const ARCHIVE_MAX_DIM = 3000;
const THUMB_MAX_DIM = 400;

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("Bild konnte nicht gelesen werden (Format nicht unterstützt?)"));
      im.src = url;
    });
    if (img.decode) { try { await img.decode(); } catch {} }
    return { img, w: img.naturalWidth || 1, h: img.naturalHeight || 1, release: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function fit(w, h, maxDim) {
  const r = Math.min(1, maxDim / Math.max(w, h));
  return [Math.max(1, Math.round(w * r)), Math.max(1, Math.round(h * r))];
}

function draw(img, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function toBlob(canvas, q) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG konnte nicht erzeugt werden"))), "image/jpeg", q)
  );
}

function freeCanvas(c) { c.width = 0; c.height = 0; }

// Foto aus Kamera/Mediathek -> Archivbild (≤ 1 MB) + Vorschaubild
export async function processFile(file) {
  const { img, w, h, release } = await loadImage(file);
  try {
    let maxDim = ARCHIVE_MAX_DIM;
    let q = 0.85;
    let archive = null;
    for (let i = 0; i < 14; i++) {
      const [dw, dh] = fit(w, h, maxDim);
      const c = draw(img, dw, dh);
      archive = await toBlob(c, q);
      freeCanvas(c);
      if (archive.size <= ARCHIVE_MAX_BYTES) break;
      if (q > 0.6) q = Math.round((q - 0.1) * 100) / 100;
      else maxDim = Math.round(maxDim * 0.85);
    }
    const [tw, th] = fit(w, h, THUMB_MAX_DIM);
    const tc = draw(img, tw, th);
    const thumb = await toBlob(tc, 0.7);
    freeCanvas(tc);
    return { archive, thumb };
  } finally {
    release();
  }
}

export async function makeThumb(blob) {
  const { img, w, h, release } = await loadImage(blob);
  try {
    const [tw, th] = fit(w, h, THUMB_MAX_DIM);
    const c = draw(img, tw, th);
    const t = await toBlob(c, 0.7);
    freeCanvas(c);
    return t;
  } finally {
    release();
  }
}

// Für das PDF: verkleinern + stärker komprimieren
export async function toPdfImage(blob, maxDim, q) {
  const { img, w, h, release } = await loadImage(blob);
  try {
    const [dw, dh] = fit(w, h, maxDim);
    const c = draw(img, dw, dh);
    const data = c.toDataURL("image/jpeg", q);
    freeCanvas(c);
    return { data, w: dw, h: dh };
  } finally {
    release();
  }
}

export function dataUrlToBlob(dataUrl) {
  const [head, b64] = String(dataUrl).split(",");
  const mime = (head.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
  const bin = atob(b64 || "");
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
