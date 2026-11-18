/* =========================================================
   PDF-Export
   - Anschrift links + Logo rechts, Seitenzahlen unten rechts
   - Bilder 3 Spalten, proportional
   - Bilder werden so komprimiert, dass das PDF ≤ 15 MB bleibt
========================================================= */
import * as db from "./db.js";
import * as od from "./onedrive.js";
import { toPdfImage } from "./images.js";
import { formatDateDE, sanitizeName } from "./util.js";
import { imagesOfDoc } from "./store.js";

export const PDF_MAX_BYTES = 15 * 1024 * 1024;
const IMG_BUDGET = 13.5 * 1024 * 1024;
const LEVELS = [
  [1600, 0.65],
  [1400, 0.55],
  [1200, 0.5],
  [1000, 0.45],
  [800, 0.4],
];

let logoDataURL = null;
let logoRatio = 1005 / 248; // Breite : Höhe, wird beim Laden aus der Datei gelesen
async function ensureLogo() {
  if (logoDataURL) return logoDataURL;
  try {
    const resp = await fetch("logo.png", { cache: "no-store" });
    if (!resp.ok) throw new Error("logo.png nicht gefunden");
    const blob = await resp.blob();
    logoDataURL = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => { if (im.naturalWidth && im.naturalHeight) logoRatio = im.naturalWidth / im.naturalHeight; resolve(); };
      im.onerror = resolve;
      im.src = logoDataURL;
    });
  } catch (e) {
    console.warn("Logo konnte nicht geladen werden", e);
    logoDataURL = null;
  }
  return logoDataURL;
}

async function sourceBlob(img) {
  const rec = await db.imgGet(img.id);
  if (rec && rec.archive) return rec.archive;
  if (img.rid && od.isSignedIn() && navigator.onLine) {
    try { return await od.downloadBlob(img.rid); } catch (e) { console.warn("Bild-Download", e); }
  }
  return (rec && rec.thumb) || null; // Notlösung: Vorschaubild
}

export function pdfFilename(p, d) {
  return `${p.number} ${sanitizeName(d.title || "Dokumentation")}.pdf`;
}

export async function buildPdf(p, d, onProgress = () => {}) {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error("PDF-Bibliothek nicht geladen");
  const { jsPDF } = window.jspdf;

  // ---- Bilder sammeln ----
  const all = imagesOfDoc(d);
  const sources = new Map();
  let missing = 0;
  for (let i = 0; i < all.length; i++) {
    onProgress(`Bilder laden ${i + 1}/${all.length} …`);
    const b = await sourceBlob(all[i]);
    if (b) sources.set(all[i].id, b);
    else missing++;
  }

  // ---- Bilder für PDF aufbereiten (bei Bedarf stärker komprimieren) ----
  let converted = new Map();
  for (const [maxDim, q] of LEVELS) {
    converted = new Map();
    let total = 0;
    let j = 0;
    for (const [id, blob] of sources) {
      onProgress(`Bilder aufbereiten ${++j}/${sources.size} …`);
      try {
        const r = await toPdfImage(blob, maxDim, q);
        converted.set(id, r);
        total += r.data.length * 0.75;
      } catch (e) {
        console.warn("Bild nicht lesbar", e);
      }
    }
    if (total <= IMG_BUDGET) break;
  }

  onProgress("PDF wird erstellt …");
  await ensureLogo();

  const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 40;
  const contentTop = margin + 75;
  const maxW = pageWidth - 2 * margin;
  const usableH = pageHeight - margin - contentTop;

  function drawHeader() {
    pdf.setFontSize(10);
    pdf.setTextColor(0);
    pdf.text(["Friedrich Bühler GmbH & Co. KG", "Daimlerstraße 7+11", "72213 Altensteig"], margin, margin);
    if (logoDataURL) {
      // Logo unverzerrt in einen Rahmen von max. 160 x 45 pt einpassen, rechtsbündig
      let lw = 160;
      let lh = lw / logoRatio;
      if (lh > 45) { lh = 45; lw = lh * logoRatio; }
      try { pdf.addImage(logoDataURL, "PNG", pageWidth - margin - lw, margin - 10, lw, lh); }
      catch (e) { console.warn("Logo nicht ins PDF", e); }
    }
    pdf.setDrawColor(220);
    pdf.line(margin, margin + 55, pageWidth - margin, margin + 55);
  }

  let y = contentTop;
  function newPage() {
    pdf.addPage();
    drawHeader();
    y = contentTop;
  }
  function ensureSpace(h) {
    if (y + h > pageHeight - margin) newPage();
  }

  drawHeader();

  // ---- Kopf ----
  pdf.setFontSize(16);
  pdf.text(`BV ${p.number}${p.client ? " – " + p.client : ""}`, margin, y, { maxWidth: maxW });
  y += 18;
  if (p.place) {
    pdf.setFontSize(11);
    pdf.setTextColor(90);
    pdf.text(`Bauort: ${p.place}`, margin, y, { maxWidth: maxW });
    pdf.setTextColor(0);
    y += 18;
  } else y += 6;
  pdf.setFontSize(13);
  pdf.text(d.title || "Dokumentation", margin, y, { maxWidth: maxW });
  y += 16;
  pdf.setFontSize(11);
  pdf.setTextColor(90);
  pdf.text("Datum: " + formatDateDE(d.date), margin, y);
  pdf.setTextColor(0);
  y += 16;

  // ---- Einträge ----
  const cols = 3;
  const gap = 10;
  const slotW = Math.floor((maxW - gap * (cols - 1)) / cols);
  const fontSize = 12;

  for (let idx = 0; idx < d.entries.length; idx++) {
    const en = d.entries[idx];
    y += 12;

    pdf.setFontSize(fontSize);
    const lineH = fontSize * pdf.getLineHeightFactor();
    const lines = pdf.splitTextToSize(`${idx + 1}. ${en.description || ""}`, maxW);

    const infos = (en.images || []).map((i) => converted.get(i.id)).filter(Boolean);
    const rowHeight = (row) => Math.min(usableH, row.reduce((mx, it) => Math.max(mx, slotW * (it.h / it.w)), 0));
    const firstRowH = infos.length ? rowHeight(infos.slice(0, cols)) : 0;

    // Text + erste Bildreihe möglichst zusammenhalten
    const blockH = lines.length * lineH + 4 + firstRowH;
    if (blockH <= usableH) ensureSpace(blockH);

    for (const line of lines) {
      ensureSpace(lineH);
      pdf.text(line, margin, y, { baseline: "top" });
      y += lineH;
    }
    y += 4;

    for (let i = 0; i < infos.length; i += cols) {
      const row = infos.slice(i, i + cols);
      const rowH = rowHeight(row);
      ensureSpace(rowH);
      let x = margin;
      for (const it of row) {
        let w = slotW;
        let h = slotW * (it.h / it.w);
        if (h > rowH) { w = w * (rowH / h); h = rowH; } // sehr hohe Bilder einpassen
        try { pdf.addImage(it.data, "JPEG", x, y, w, h); }
        catch (e) { console.warn("Bild nicht ins PDF", e); }
        x += slotW + gap;
      }
      y += rowH + 10;
    }
  }

  // ---- Seitenzahlen ----
  const total = pdf.getNumberOfPages();
  for (let n = 1; n <= total; n++) {
    pdf.setPage(n);
    pdf.setFontSize(9);
    pdf.setTextColor(90);
    pdf.text(`Seite ${n} von ${total}`, pageWidth - margin, pageHeight - 20, { align: "right" });
    pdf.setTextColor(0);
  }

  const blob = pdf.output("blob");
  return { blob, filename: pdfFilename(p, d), missing };
}
