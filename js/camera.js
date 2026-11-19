/* =========================================================
   Live-Kamera im Browser (Laptop-/PC-Kamera)
   Am Handy wird weiterhin die eingebaute Kamera-App genutzt
   (bessere Bildqualität); dieses Fenster ist für PC/Laptop.
   captureFromWebcam() liefert ein Array von Fotos (File),
   leer wenn abgebrochen.
========================================================= */
import { toast } from "./util.js";

export const isMobileDevice =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function hasWebcam() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
}

export function captureFromWebcam() {
  return new Promise((resolve) => {
    const shots = [];
    let stream = null;
    let devices = [];
    let deviceIdx = 0;

    const wrap = document.createElement("div");
    wrap.className = "cam-modal";
    wrap.innerHTML = `
      <div class="cam-inner" role="dialog" aria-label="Kamera">
        <div class="cam-view">
          <video playsinline muted autoplay></video>
          <div class="cam-flash"></div>
          <div class="cam-msg">Kamera wird gestartet …</div>
        </div>
        <div class="cam-shots"></div>
        <div class="cam-actions">
          <button class="secondary" data-a="cancel" type="button">Abbrechen</button>
          <button class="secondary" data-a="switch" type="button" hidden>Kamera wechseln</button>
          <button class="cam-shutter" data-a="shot" type="button" aria-label="Foto aufnehmen" disabled></button>
          <button class="primary" data-a="done" type="button" disabled>Übernehmen</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const video = wrap.querySelector("video");
    const msg = wrap.querySelector(".cam-msg");
    const flash = wrap.querySelector(".cam-flash");
    const strip = wrap.querySelector(".cam-shots");
    const btnShot = wrap.querySelector('[data-a="shot"]');
    const btnDone = wrap.querySelector('[data-a="done"]');
    const btnSwitch = wrap.querySelector('[data-a="switch"]');

    function stop() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    async function start() {
      stop();
      btnShot.disabled = true;
      msg.style.display = "";
      msg.textContent = "Kamera wird gestartet …";
      const video0 = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      const constraints = devices[deviceIdx]
        ? { video: { ...video0, deviceId: { exact: devices[deviceIdx].deviceId } }, audio: false }
        : { video: { ...video0, facingMode: "environment" }, audio: false };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        await video.play().catch(() => {});
        msg.style.display = "none";
        btnShot.disabled = false;
        if (!devices.length) {
          devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
          const cur = stream.getVideoTracks()[0]?.getSettings().deviceId;
          const i = devices.findIndex((d) => d.deviceId === cur);
          deviceIdx = i >= 0 ? i : 0;
          btnSwitch.hidden = devices.length < 2;
        }
      } catch (e) {
        console.warn("Kamera", e);
        const text = e && e.name === "NotAllowedError"
          ? "Kein Zugriff auf die Kamera. Bitte im Browser erlauben (Schloss-Symbol links neben der Adresse)."
          : e && e.name === "NotFoundError"
            ? "Keine Kamera gefunden."
            : e && e.name === "NotReadableError"
              ? "Die Kamera wird gerade von einem anderen Programm benutzt (z. B. Teams)."
              : "Kamera konnte nicht gestartet werden.";
        msg.textContent = text;
        msg.style.display = "";
      }
    }

    function shoot() {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(video, 0, 0, w, h);
      flash.classList.remove("on");
      void flash.offsetWidth;
      flash.classList.add("on");
      c.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], `kamera-${Date.now()}.jpg`, { type: "image/jpeg" });
        shots.push(file);
        const url = URL.createObjectURL(blob);
        const item = document.createElement("div");
        item.className = "cam-shot";
        item.innerHTML = `<img src="${url}" alt="Foto" /><button type="button" aria-label="Foto verwerfen">×</button>`;
        item.querySelector("button").onclick = () => {
          const i = shots.indexOf(file);
          if (i >= 0) shots.splice(i, 1);
          URL.revokeObjectURL(url);
          item.remove();
          updateDone();
        };
        strip.appendChild(item);
        strip.scrollLeft = strip.scrollWidth;
        updateDone();
      }, "image/jpeg", 0.92);
    }

    function updateDone() {
      btnDone.disabled = !shots.length;
      btnDone.textContent = shots.length ? `Übernehmen (${shots.length})` : "Übernehmen";
    }

    function close(result) {
      stop();
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      strip.querySelectorAll("img").forEach((im) => URL.revokeObjectURL(im.src));
      wrap.remove();
      resolve(result);
    }

    const onKey = (e) => {
      if (e.key === "Escape") close([]);
      if ((e.key === " " || e.key === "Enter") && !btnShot.disabled && document.activeElement === document.body) {
        e.preventDefault();
        shoot();
      }
    };
    document.addEventListener("keydown", onKey);

    wrap.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]");
      if (!a) return;
      if (a.dataset.a === "cancel") {
        if (shots.length && !confirm(`${shots.length} aufgenommene(s) Foto(s) verwerfen?`)) return;
        close([]);
      }
      if (a.dataset.a === "shot") shoot();
      if (a.dataset.a === "done") close(shots.slice());
      if (a.dataset.a === "switch" && devices.length > 1) {
        deviceIdx = (deviceIdx + 1) % devices.length;
        start();
      }
    });

    if (!hasWebcam()) {
      toast("Dieser Browser erlaubt keinen Kamerazugriff.", "warn");
      close([]);
      return;
    }
    start();
  });
}
