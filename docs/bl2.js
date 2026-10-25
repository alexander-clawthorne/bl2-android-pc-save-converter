// Borderlands 2 save converter: Android <-> PC, in the browser.
// JavaScript port of bl2_convert.py; see that file and the README for the format.
// "Mobile" means Wicked's Android port of Borderlands 2, version 1.7.
// Runs entirely client-side: no file ever leaves the user's machine.

// ------------------------------------------------------------------ helpers

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32be = v => new Uint8Array([v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const readU32be = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const readU32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u32le = v => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24]);
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function sha1(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', data));
}

async function pipe(data, stream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
// 'deflate' in the Compression Streams API is the zlib format (RFC 1950), as the game uses.
const zlibCompress = data => pipe(data, new CompressionStream('deflate'));
const zlibDecompress = data => pipe(data, new DecompressionStream('deflate'));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ outer layer

export async function readContainer(file) {
  if (file.length < 26 || !equal(await sha1(file.subarray(20)), file.subarray(0, 20)))
    throw new Error('not a Borderlands 2 save (SHA1 check failed)');
  return { size: readU32be(file, 20), body: file.subarray(24) };
}

async function buildContainer(inner, platform) {
  const body = platform === 'mobile' ? await zlibCompress(inner) : lzo1xLiteral(inner);
  const rest = concat(u32be(inner.length), body);
  return concat(await sha1(rest), rest);
}

export function detect(body) {
  // zlib streams start 0x78 and their 2-byte header is divisible by 31.
  return body[0] === 0x78 && ((body[0] << 8) | body[1]) % 31 === 0 ? 'mobile' : 'pc';
}

async function decompress(size, body, platform) {
  const inner = platform === 'mobile' ? await zlibDecompress(body) : lzo1xDecompress(body, size);
  if (inner.length !== size) throw new Error(`decompressed size ${inner.length} != header ${size}`);
  return inner;
}

// ------------------------------------------------------------------ LZO1X

function lzo1xLiteral(data) {
  // A valid LZO1X stream made of one literal run plus the end-of-stream marker.
  const head = [];
  const t = data.length;
  if (t <= 238) head.push(t + 17);
  else {
    let tt = t - 18; head.push(0);
    while (tt > 255) { tt -= 255; head.push(0); }
    head.push(tt);
  }
  return concat(new Uint8Array(head), data, new Uint8Array([0x11, 0, 0]));
}

function lzo1xDecompress(src, outLen) {
  // state = literals copied after the previous instruction (4 means 4 or more).
  const out = new Uint8Array(outLen);
  let op = 0, ip = 0, state = 0;
  const ext = base => {
    let t = 0;
    while (src[ip] === 0) { t += 255; ip++; }
    return t + base + src[ip++];
  };
  const lit = n => {
    if (op + n > outLen) throw new Error('corrupt LZO stream');
    out.set(src.subarray(ip, ip + n), op); op += n; ip += n;
  };
  if (src[0] > 17) { const n = src[0] - 17; ip = 1; lit(n); state = n >= 4 ? 4 : n; }
  for (;;) {
    if (ip >= src.length) throw new Error('corrupt LZO stream');
    const t = src[ip++];
    let d, ln, nxt;
    if (t < 16) {
      if (state === 0) { lit((t === 0 ? ext(15) : t) + 3); state = 4; continue; }
      d = 1 + (t >> 2) + (src[ip++] << 2) + (state === 4 ? 0x800 : 0);
      ln = state === 4 ? 3 : 2; nxt = t & 3;
    } else if (t >= 64) {
      d = 1 + ((t >> 2) & 7) + (src[ip++] << 3); ln = (t >> 5) + 1; nxt = t & 3;
    } else if (t >= 32) {
      ln = ((t & 31) || ext(31)) + 2;
      const ds = src[ip] | (src[ip + 1] << 8); ip += 2; d = 1 + (ds >> 2); nxt = ds & 3;
    } else {
      ln = ((t & 7) || ext(7)) + 2;
      const ds = src[ip] | (src[ip + 1] << 8); ip += 2;
      d = ((t & 8) << 11) + (ds >> 2);
      if (d === 0) break;
      d += 0x4000; nxt = ds & 3;
    }
    const s0 = op - d;
    if (s0 < 0 || op + ln > outLen) throw new Error('corrupt LZO stream');
    for (let i = 0; i < ln; i++) out[op++] = out[s0 + i];
    lit(nxt); state = nxt;
  }
  if (op !== outLen) throw new Error(`LZO length ${op} != ${outLen}`);
  return out;
}

// ------------------------------------------------------------------ WSG payload
// inner = [len BE u32] "WSG" [version LE u32] [crc32 LE u32] [size LE i32]
//         [Huffman tree + bitstream] [4-byte trailer]
// The trailer must be kept: without it the game shows the save as !Corrupted!.

export const isCharacter = inner =>
  inner[4] === 0x57 && inner[5] === 0x53 && inner[6] === 0x47; // "WSG"

function wsgDecode(inner) {
  const n = readU32be(inner, 0), w = inner.subarray(4, 4 + n);
  const ver = readU32le(w, 3), crc = readU32le(w, 7), size = readU32le(w, 11) | 0;
  const bits = w.subarray(15);
  let p = 0;
  const bit = () => { const v = (bits[p >> 3] >> (7 - (p & 7))) & 1; p++; return v; };
  const byte = () => { let v = 0; for (let i = 0; i < 8; i++) v = (v << 1) | bit(); return v; };
  const tree = () => (bit() ? byte() : [tree(), tree()]);
  const root = tree();
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    let node = root;
    while (Array.isArray(node)) node = node[bit()];
    out[i] = node;
  }
  if (crc32(out) !== crc) throw new Error('payload CRC mismatch');
  return { ver, pb: out, trailer: w.subarray(w.length - 4) };
}

function wsgEncode(ver, data, trailer) {
  // Huffman tree built exactly like bl2_convert.py (ties broken by insertion order),
  // so both produce byte-identical files.
  const freq = new Map();
  for (const c of data) freq.set(c, (freq.get(c) || 0) + 1);
  let cnt = 0;
  const heap = [...freq.keys()].sort((a, b) => a - b).map(s => [freq.get(s), cnt++, s]);
  if (heap.length === 1) heap.push([0, cnt++, (heap[0][2] + 1) & 255]);
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const popMin = () => {
    let m = 0;
    for (let i = 1; i < heap.length; i++) if (less(heap[i], heap[m])) m = i;
    return heap.splice(m, 1)[0];
  };
  while (heap.length > 1) {
    const a = popMin(), b = popMin();
    heap.push([a[0] + b[0], cnt++, [a[2], b[2]]]);
  }
  const codes = new Map(), out = [];
  let acc = 0, nbits = 0;
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) {
      acc = (acc << 1) | ((v >> i) & 1);
      if (++nbits === 8) { out.push(acc); acc = 0; nbits = 0; }
    }
  };
  const walk = (node, code, len) => {
    if (Array.isArray(node)) {
      put(0, 1); walk(node[0], code * 2, len + 1); walk(node[1], code * 2 + 1, len + 1);
    } else {
      put(1, 1); put(node, 8); codes.set(node, [code, len]);
    }
  };
  walk(heap[0][2], 0, 0);
  for (const c of data) { const [code, len] = codes.get(c); put(code, len); }
  if (nbits) put(0, 8 - nbits);
  const w = concat(new TextEncoder().encode('WSG'), u32le(ver), u32le(crc32(data)),
                   u32le(data.length), new Uint8Array(out), trailer);
  return concat(u32be(w.length), w);
}

function varint(b, p) {
  let v = 0, mul = 1;
  for (;;) {
    const c = b[p++]; v += (c & 0x7f) * mul; mul *= 128;
    if (!(c & 0x80)) return [v, p];
  }
}
function encVarint(v) {
  const out = [];
  for (;;) {
    if (v < 0x80) { out.push(v); return new Uint8Array(out); }
    out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128);
  }
}
function* topFields(pb) {
  let p = 0;
  while (p < pb.length) {
    let key; [key, p] = varint(pb, p);
    const f = Math.floor(key / 8), wt = key & 7, vstart = p;
    let v = null;
    if (wt === 0) [v, p] = varint(pb, p);
    else if (wt === 2) { let ln; [ln, p] = varint(pb, p); p += ln; }
    else if (wt === 5) p += 4;
    else if (wt === 1) p += 8;
    else throw new Error(`unexpected protobuf wire type ${wt}`);
    yield { f, wt, v, vstart, end: p };
  }
}

const SAVE_ID_FIELD = 20, LEVEL_FIELD = 2, CLASS_FIELD = 1;
const CLASS_NAMES = { Soldier: 'Commando', Siren: 'Siren', Mercenary: 'Gunzerker',
  Assassin: 'Assassin', Mechromancer: 'Mechromancer', LilacPlayerClass: 'Psycho' };

function characterInfo(pb) {
  const info = {};
  for (const { f, wt, v, vstart } of topFields(pb)) {
    if ((f === SAVE_ID_FIELD || f === LEVEL_FIELD) && wt === 0) info[f] = v;
    if (f === CLASS_FIELD && wt === 2) {
      const [ln, p] = varint(pb, vstart);
      info[f] = new TextDecoder().decode(pb.subarray(p, p + ln));
    }
  }
  const raw = (info[CLASS_FIELD] || '?').split('_').pop();
  return { cls: CLASS_NAMES[raw] || raw, level: info[LEVEL_FIELD], slot: info[SAVE_ID_FIELD] ?? 1 };
}

function setSaveId(pb, id) {
  for (const { f, wt, vstart, end } of topFields(pb))
    if (f === SAVE_ID_FIELD && wt === 0)
      return concat(pb.subarray(0, vstart), encVarint(id), pb.subarray(end));
  throw new Error('save has no slot ID field');
}

// ------------------------------------------------------------------ public API

// Step 1: read and describe a file. Returns everything convert() needs.
export async function inspect(file) {
  const { size, body } = await readContainer(file);
  const from = detect(body), to = from === 'mobile' ? 'pc' : 'mobile';
  const inner = await decompress(size, body, from);
  if (!isCharacter(inner)) return { kind: 'profile', from, to, inner };
  const wsg = wsgDecode(inner);
  return { kind: 'character', from, to, inner, wsg, ...characterInfo(wsg.pb) };
}

// Step 2: build the converted file, then read it back and verify it.
export async function convert(info, newSlot) {
  let inner = info.inner, name, pb = null;
  if (info.kind === 'character') {
    const slot = newSlot ?? info.slot;
    pb = info.wsg.pb;
    if (slot !== info.slot) {
      pb = setSaveId(pb, slot);
      inner = wsgEncode(info.wsg.ver, pb, info.wsg.trailer);
    }
    name = `Save${slot.toString(16).padStart(4, '0')}.sav`; // the game names files by the ID in hex
  } else {
    name = info.to === 'pc' ? 'profile.bin' : 'Player1';
  }
  const file = await buildContainer(inner, info.to);

  const { size, body } = await readContainer(file);
  const back = await decompress(size, body, detect(body));
  if (!equal(back, inner) || (pb && !equal(wsgDecode(back).pb, pb)))
    throw new Error('verification of the converted file failed');
  return { name, file };
}
