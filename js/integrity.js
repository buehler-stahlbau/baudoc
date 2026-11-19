/* =========================================================
   Prüfcode
   - Aus dem Inhalt einer Dokumentation wird ein kurzer Code berechnet
     (SHA-256, die ersten 8 Stellen), z. B. "7F3A-91C2".
   - In den Code fließen ein: BV-Nummer, Titel, Datum, alle Einträge
     (Text + Fotos). Nicht enthalten: Anwesende und Unterschriften,
     Bauherr/Bauort (Stammdaten des BV).
   - Jede Unterschrift merkt sich den Code des Stands, zu dem sie
     geleistet wurde. Ändert sich der Inhalt, ist sie ungültig.
========================================================= */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

// SHA-256 (synchron, damit der Code sofort beim Tippen verfügbar ist)
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(total - 4, bits >>> 0);

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}

function day(dateLike) {
  const dt = new Date(dateLike);
  if (isNaN(dt)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

// Prüfcode einer Dokumentation, z. B. "7F3A-91C2"
export function contentCode(p, d) {
  const data = {
    n: String(p.number || ""),
    t: String(d.title || "").trim(),
    dt: day(d.date),
    e: (d.entries || []).map((e) => [String(e.description || "").trim(), (e.images || []).map((i) => i.id)]),
  };
  const hex = sha256Hex(JSON.stringify(data)).slice(0, 8).toUpperCase();
  return hex.slice(0, 4) + "-" + hex.slice(4);
}

// Eingabe vereinheitlichen: "7f3a91c2", "7F3A 91C2" -> "7F3A-91C2"
export function normalizeCode(input) {
  const hex = String(input || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  return hex.length === 8 ? hex.slice(0, 4) + "-" + hex.slice(4) : null;
}

export function sigValid(a, code) {
  return !!(a && a.sig && a.sigCode === code);
}

export function validSignatures(d, code) {
  const pr = d.protocol;
  if (!pr || !pr.enabled) return [];
  return (pr.attendees || []).filter((a) => sigValid(a, code));
}
