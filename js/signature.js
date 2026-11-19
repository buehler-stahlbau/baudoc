/* =========================================================
   Unterschriftenfeld – Finger, Stift oder Maus
   captureSignature() liefert:
     - String (PNG-DataURL)  = neue Unterschrift
     - null                  = Unterschrift entfernen
     - undefined             = abgebrochen
========================================================= */
import { escapeHtml as h } from "./util.js";

export function captureSignature({ title = "Unterschrift", subtitle = "", canRemove = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "sig-modal";
    wrap.innerHTML = `
      <div class="sig-inner" role="dialog" aria-label="${h(title)}">
        <div>
          <strong>${h(title)}</strong>
          ${subtitle ? `<div class="muted">${h(subtitle)}</div>` : ""}
          <div class="sig-turn">↻ Handy quer halten</div>
        </div>
        <div class="sig-pad">
          <div class="sig-line"></div>
          <div class="sig-hint">Hier unterschreiben</div>
          <canvas></canvas>
        </div>
        <div class="sig-actions">
          ${canRemove ? `<button class="danger-outline" data-a="remove" type="button">Unterschrift entfernen</button>` : ""}
          <span class="grow"></span>
          <button class="secondary" data-a="clear" type="button">Neu</button>
          <button class="secondary" data-a="cancel" type="button">Abbrechen</button>
          <button class="primary" data-a="ok" type="button">Übernehmen</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const pad = wrap.querySelector(".sig-pad");
    const canvas = wrap.querySelector("canvas");
    const hint = wrap.querySelector(".sig-hint");
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const inner = wrap.querySelector(".sig-inner");

    // Handy hochkant: Feld um 90° drehen -> Handy quer halten, volle Displaylänge zum Unterschreiben
    const portraitPhone = window.matchMedia("(orientation: portrait) and (max-width: 600px)");
    let rotated = false;
    function applyRotation() {
      rotated = portraitPhone.matches;
      wrap.classList.toggle("sig-rotated", rotated);
      if (rotated) {
        inner.style.width = window.innerHeight + "px";
        inner.style.height = window.innerWidth + "px";
      } else {
        inner.style.width = "";
        inner.style.height = "";
      }
    }
    applyRotation();
    let drawing = false;
    let pts = [];
    let hasInk = false;
    let bounds = null;

    function setup() {
      const r = { width: pad.clientWidth, height: pad.clientHeight }; // Maße ohne Drehung
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = r.width + "px";
      canvas.style.height = r.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#10213a";
      ctx.fillStyle = "#10213a";
      clear();
    }
    function clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasInk = false;
      bounds = null;
      hint.style.display = "";
    }
    function grow(x, y, w) {
      if (!bounds) bounds = { x0: x, y0: y, x1: x, y1: y };
      bounds.x0 = Math.min(bounds.x0, x - w); bounds.y0 = Math.min(bounds.y0, y - w);
      bounds.x1 = Math.max(bounds.x1, x + w); bounds.y1 = Math.max(bounds.y1, y + w);
    }
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const pressure = e.pointerType === "pen" && e.pressure ? e.pressure : 0.5;
      const w = 1.4 + pressure * 2.2;
      // gedreht (90° im Uhrzeigersinn): Bildschirm-unten = Feld-rechts, Bildschirm-links = Feld-unten
      if (rotated) return { x: e.clientY - r.top, y: r.right - e.clientX, w };
      return { x: e.clientX - r.left, y: e.clientY - r.top, w };
    }

    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drawing = true;
      const p = pos(e);
      pts = [p];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.w / 2, 0, Math.PI * 2);
      ctx.fill();
      grow(p.x, p.y, p.w);
      hasInk = true;
      hint.style.display = "none";
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      e.preventDefault();
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of events) {
        const p = pos(ev);
        pts.push(p);
        if (pts.length < 3) continue;
        const [a, b, c] = pts.slice(-3);
        const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const m2 = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
        ctx.lineWidth = (b.w + c.w) / 2;
        ctx.beginPath();
        ctx.moveTo(m1.x, m1.y);
        ctx.quadraticCurveTo(b.x, b.y, m2.x, m2.y);
        ctx.stroke();
        grow(c.x, c.y, c.w);
      }
    });
    const end = () => { drawing = false; pts = []; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    // Unterschrift zuschneiden und auf handliche Größe bringen
    function exportPng() {
      const pad2 = 8;
      const x0 = Math.max(0, bounds.x0 - pad2) * dpr;
      const y0 = Math.max(0, bounds.y0 - pad2) * dpr;
      const x1 = Math.min(canvas.width, (bounds.x1 + pad2) * dpr);
      const y1 = Math.min(canvas.height, (bounds.y1 + pad2) * dpr);
      const w = Math.max(1, x1 - x0);
      const hh = Math.max(1, y1 - y0);
      const scale = Math.min(1, 600 / w, 220 / hh);
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * scale));
      out.height = Math.max(1, Math.round(hh * scale));
      out.getContext("2d").drawImage(canvas, x0, y0, w, hh, 0, 0, out.width, out.height);
      return out.toDataURL("image/png");
    }

    function close(result) {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      wrap.remove();
      resolve(result);
    }
    const onKey = (e) => { if (e.key === "Escape") close(undefined); };
    // Drehen des Handys: Feld neu aufbauen (nur solange noch nichts gezeichnet ist)
    const onResize = () => { applyRotation(); if (!hasInk) setup(); };
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);

    wrap.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]");
      if (!a) return;
      if (a.dataset.a === "clear") clear();
      if (a.dataset.a === "cancel") close(undefined);
      if (a.dataset.a === "remove") close(null);
      if (a.dataset.a === "ok") {
        if (!hasInk) { hint.textContent = "Bitte zuerst unterschreiben"; hint.style.display = ""; return; }
        close(exportPng());
      }
    });

    requestAnimationFrame(setup);
  });
}
