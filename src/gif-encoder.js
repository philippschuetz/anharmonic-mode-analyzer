// Minimal, dependency-free animated-GIF encoder (GIF89a + LZW).
// window.AMGif.encode(frames, opts) -> Blob
//   frames: [{ data: Uint8ClampedArray (RGBA), width, height }]  (all same size)
//   opts:   { delayCs?: number (centiseconds, default 5), loop?: number (0 = forever), maxColors?: 256 }
// Quantizes to a shared palette via median cut, then LZW-compresses each frame.
(function () {
  "use strict";

  function channelStats(colors) {
    let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
    for (const c of colors) {
      if (c.r < rmin) rmin = c.r; if (c.r > rmax) rmax = c.r;
      if (c.g < gmin) gmin = c.g; if (c.g > gmax) gmax = c.g;
      if (c.b < bmin) bmin = c.b; if (c.b > bmax) bmax = c.b;
    }
    const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
    let chan = "r", range = rr;
    if (gr > range) { chan = "g"; range = gr; }
    if (br > range) { chan = "b"; range = br; }
    return { chan, range };
  }

  function medianCut(frames, maxColors) {
    // histogram at 5 bits/channel for speed; molecule renders have a modest palette
    const hist = new Map();
    for (const fr of frames) {
      const d = fr.data;
      for (let i = 0; i < d.length; i += 4) {
        const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
        hist.set(key, (hist.get(key) || 0) + 1);
      }
    }
    let colors = [];
    for (const [key, count] of hist) {
      colors.push({ r: (((key >> 10) & 31) << 3) | 4, g: (((key >> 5) & 31) << 3) | 4, b: ((key & 31) << 3) | 4, count });
    }
    if (colors.length === 0) colors = [{ r: 0, g: 0, b: 0, count: 1 }];
    let boxes = [colors];
    while (boxes.length < maxColors) {
      let bi = -1, best = -1, bestChan = "r";
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const st = channelStats(boxes[i]);
        if (st.range > best) { best = st.range; bi = i; bestChan = st.chan; }
      }
      if (bi < 0) break;
      const box = boxes[bi];
      box.sort((a, b) => a[bestChan] - b[bestChan]);
      let total = 0; for (const c of box) total += c.count;
      let acc = 0, mid = 0;
      for (; mid < box.length - 1; mid++) { acc += box[mid].count; if (acc >= total / 2) break; }
      boxes.splice(bi, 1, box.slice(0, mid + 1), box.slice(mid + 1));
    }
    return boxes.map(box => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const c of box) { r += c.r * c.count; g += c.g * c.count; b += c.b * c.count; n += c.count; }
      n = n || 1;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  function buildMapper(palette) {
    const cache = new Int16Array(32768).fill(-1);
    return function (r, g, b) {
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let idx = cache[key];
      if (idx >= 0) return idx;
      let best = 0, bestD = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        const dr = r - p[0], dg = g - p[1], db = b - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = i; }
      }
      cache[key] = best;
      return best;
    };
  }

  // GIF LZW compression -> array of bytes (raw stream, not yet sub-blocked)
  function lzwEncode(minCodeSize, indices) {
    const out = [];
    let cur = 0, curBits = 0;
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let dict, next;
    function reset() { dict = new Map(); next = eoiCode + 1; codeSize = minCodeSize + 1; }
    function put(code) {
      cur |= code << curBits; curBits += codeSize;
      while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
    }
    reset();
    put(clearCode);
    let prefix = "" + indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = prefix + "," + k;
      if (dict.has(key)) { prefix = key; continue; }
      put(dict.has(prefix) ? dict.get(prefix) : +prefix);
      dict.set(key, next++);
      if (next === (1 << codeSize) + 1) { if (codeSize < 12) codeSize++; }
      if (next === 4096) { put(clearCode); reset(); }
      prefix = "" + k;
    }
    put(dict.has(prefix) ? dict.get(prefix) : +prefix);
    put(eoiCode);
    if (curBits > 0) out.push(cur & 0xff);
    return out;
  }

  function encode(frames, opts) {
    opts = opts || {};
    const delayCs = Math.max(2, Math.round(opts.delayCs != null ? opts.delayCs : 5));
    const loop = opts.loop != null ? opts.loop : 0;
    const maxColors = Math.min(256, opts.maxColors || 256);
    const W = frames[0].width, H = frames[0].height;

    const palette = medianCut(frames, maxColors);
    const mapper = buildMapper(palette);
    let gctBits = 1; while ((1 << gctBits) < palette.length) gctBits++; // 1..8
    if (gctBits < 1) gctBits = 1;
    const gctSize = 1 << gctBits;
    const minCodeSize = Math.max(2, gctBits);

    const bytes = [];
    const push = (...a) => { for (const v of a) bytes.push(v & 0xff); };
    const pushStr = (s) => { for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i)); };
    const pushU16 = (v) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };

    pushStr("GIF89a");
    pushU16(W); pushU16(H);
    push(0x80 | ((gctBits - 1) << 4) | (gctBits - 1)); // GCT present, color res, size
    push(0, 0); // bg color index, aspect ratio
    for (let i = 0; i < gctSize; i++) {
      const p = palette[i] || [0, 0, 0];
      push(p[0], p[1], p[2]);
    }
    // NETSCAPE loop
    push(0x21, 0xff, 0x0b); pushStr("NETSCAPE2.0"); push(0x03, 0x01); pushU16(loop); push(0x00);

    for (const fr of frames) {
      // graphic control extension
      push(0x21, 0xf9, 0x04, 0x04); pushU16(delayCs); push(0x00, 0x00);
      // image descriptor
      push(0x2c); pushU16(0); pushU16(0); pushU16(W); pushU16(H); push(0x00);
      // indices
      const d = fr.data;
      const idx = new Uint8Array(W * H);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) idx[j] = mapper(d[i], d[i + 1], d[i + 2]);
      const lzw = lzwEncode(minCodeSize, idx);
      push(minCodeSize);
      for (let off = 0; off < lzw.length; off += 255) {
        const chunk = lzw.slice(off, off + 255);
        push(chunk.length);
        for (const b of chunk) push(b);
      }
      push(0x00); // block terminator
    }
    push(0x3b); // trailer

    return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
  }

  window.AMGif = { encode };
})();
