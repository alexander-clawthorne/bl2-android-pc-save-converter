"""Borderlands 2 save converter: Android <-> PC.

"Mobile" below means Wicked's Android port of Borderlands 2, version 1.7, the only
Android build this was made and tested against. Android port by Wicked.

Both platforms use the same file layout:
    SHA1 (20 bytes) | uncompressed size (4 bytes, big-endian) | compressed payload
and the same payload once decompressed. The only difference is the compression:
mobile uses zlib, PC uses LZO1X. So converting is: check the hash, decompress,
recompress the other way, rewrite the hash.

Character saves (SaveXXXX.sav) also store their own slot ID inside the payload
(protobuf field 20). The game saves a character back to the file matching that ID,
so a converted character must get an ID that is not already used on the target
device, or it will overwrite another character. This script lets you set it.

Profiles (PC profile.bin / mobile Player1) are converted as-is; they hold
account-wide data (badass rank, golden keys, settings), so replacing one
overwrites that progress on the target device.

Usage:
    bl2_convert.py FILE [FILE ...] [--id N] [--out DIR]
With no --id, character saves prompt for a slot ID (Enter keeps the current one).
Output goes to a "converted to pc" / "converted to mobile" folder next to this script.
Existing files are never overwritten.
"""
import argparse, hashlib, os, struct, sys, zlib

# ---------------------------------------------------------------- outer layer

def read_container(path):
    b = open(path, 'rb').read()
    if len(b) < 26 or hashlib.sha1(b[20:]).digest() != b[:20]:
        raise ValueError('not a Borderlands 2 save (SHA1 check failed)')
    return struct.unpack('>I', b[20:24])[0], b[24:]

def write_container(path, inner, platform):
    body = zlib.compress(inner) if platform == 'mobile' else lzo1x_literal(inner)
    rest = struct.pack('>I', len(inner)) + body
    with open(path, 'xb') as f:  # 'x': refuse to overwrite
        f.write(hashlib.sha1(rest).digest() + rest)

def detect(body):
    # zlib streams start 0x78; a valid LZO1X stream from BL2 never does at this size.
    return 'mobile' if body[0] == 0x78 and (body[0] << 8 | body[1]) % 31 == 0 else 'pc'

def decompress(size, body, platform):
    inner = zlib.decompress(body) if platform == 'mobile' else lzo1x_decompress(body, size)
    if len(inner) != size:
        raise ValueError(f'decompressed size {len(inner)} != header {size}')
    return inner

# ---------------------------------------------------------------- LZO1X

def lzo1x_literal(data):
    # A valid LZO1X stream made of one literal run plus the end-of-stream marker.
    # Uncompressed, but any LZO1X decoder (including the game's) accepts it.
    out = bytearray(); t = len(data)
    if t <= 238:
        out.append(t + 17)
    else:
        tt = t - 18; out.append(0)
        while tt > 255:
            tt -= 255; out.append(0)
        out.append(tt)
    out += data
    out += b'\x11\x00\x00'
    return bytes(out)

def lzo1x_decompress(src, out_len):
    # state = literals copied after the previous instruction (4 means 4 or more).
    out = bytearray(); ip = 0; state = 0
    def ext(base):
        nonlocal ip
        t = 0
        while src[ip] == 0: t += 255; ip += 1
        t += base + src[ip]; ip += 1
        return t
    def lit(n):
        nonlocal ip
        out.extend(src[ip:ip+n]); ip += n
    if src[0] > 17:
        n = src[0] - 17; ip = 1; lit(n); state = 4 if n >= 4 else n
    while True:
        t = src[ip]; ip += 1
        if t < 16:
            if state == 0:
                n = ext(15) if t == 0 else t
                lit(n + 3); state = 4; continue
            d = (1 + (t >> 2) + (src[ip] << 2)) + (0x800 if state == 4 else 0)
            ln = 3 if state == 4 else 2; ip += 1; nxt = t & 3
        elif t >= 64:
            d = 1 + ((t >> 2) & 7) + (src[ip] << 3); ip += 1; ln = (t >> 5) + 1; nxt = t & 3
        elif t >= 32:
            ln = (t & 31 or ext(31)) + 2
            ds = src[ip] | (src[ip+1] << 8); ip += 2; d = 1 + (ds >> 2); nxt = ds & 3
        else:
            ln = (t & 7 or ext(7)) + 2
            ds = src[ip] | (src[ip+1] << 8); ip += 2
            d = ((t & 8) << 11) + (ds >> 2)
            if d == 0: break
            d += 0x4000; nxt = ds & 3
        s0 = len(out) - d
        if s0 < 0: raise ValueError('corrupt LZO stream')
        for i in range(ln): out.append(out[s0 + i])
        lit(nxt); state = nxt
    if len(out) != out_len: raise ValueError(f'LZO length {len(out)} != {out_len}')
    return bytes(out)

# ---------------------------------------------------------------- WSG payload
# inner = [len BE u32] "WSG" [version LE u32] [crc32 LE u32] [size LE i32]
#         [Huffman tree + bitstream] [4-byte trailer]
# The trailer must be kept: without it the game shows the save as !Corrupted!.

class BitReader:
    def __init__(s, b): s.b = b; s.p = 0
    def bit(s):
        v = (s.b[s.p >> 3] >> (7 - (s.p & 7))) & 1; s.p += 1; return v
    def byte(s):
        v = 0
        for _ in range(8): v = (v << 1) | s.bit()
        return v

def read_tree(r):
    return r.byte() if r.bit() else (read_tree(r), read_tree(r))

def is_character(inner):
    return inner[4:7] == b'WSG'

def wsg_decode(inner):
    n = struct.unpack('>I', inner[:4])[0]; w = inner[4:4+n]
    ver, crc, size = struct.unpack('<IIi', w[3:15])
    r = BitReader(w[15:]); tree = read_tree(r); out = bytearray()
    while len(out) < size:
        node = tree
        while isinstance(node, tuple): node = node[r.bit()]
        out.append(node)
    if zlib.crc32(out) != crc: raise ValueError('payload CRC mismatch')
    return ver, bytes(out), w[-4:]

def wsg_encode(ver, data, trailer):
    import heapq, itertools
    freq = {}
    for c in data: freq[c] = freq.get(c, 0) + 1
    cnt = itertools.count()
    h = [(f, next(cnt), s) for s, f in sorted(freq.items())]
    heapq.heapify(h)
    if len(h) == 1: h.append((0, next(cnt), (h[0][2] + 1) & 255))
    while len(h) > 1:
        a = heapq.heappop(h); b = heapq.heappop(h)
        heapq.heappush(h, (a[0] + b[0], next(cnt), (a[2], b[2])))
    codes = {}; bits = []
    def walk(n, pre):
        if isinstance(n, tuple):
            bits.append('0'); walk(n[0], pre + '0'); walk(n[1], pre + '1')
        else:
            bits.append('1' + format(n, '08b')); codes[n] = pre
    walk(h[0][2], '')
    s = ''.join(bits) + ''.join(codes[c] for c in data)
    s += '0' * (-len(s) % 8)
    body = int(s, 2).to_bytes(len(s) // 8, 'big')
    w = b'WSG' + struct.pack('<IIi', ver, zlib.crc32(data), len(data)) + body + trailer
    return struct.pack('>I', len(w)) + w

def varint(b, p):
    v = sh = 0
    while True:
        c = b[p]; p += 1; v |= (c & 0x7f) << sh; sh += 7
        if not c & 0x80: return v, p

def enc_varint(v):
    out = bytearray()
    while True:
        if v < 0x80: out.append(v); return bytes(out)
        out.append(v & 0x7f | 0x80); v >>= 7

def top_fields(pb):
    p = 0
    while p < len(pb):
        start = p; key, p = varint(pb, p); f, wt = key >> 3, key & 7
        vstart = p
        if wt == 0: v, p = varint(pb, p)
        elif wt == 2: ln, p = varint(pb, p); v = None; p += ln
        elif wt == 5: v = None; p += 4
        elif wt == 1: v = None; p += 8
        else: raise ValueError(f'unexpected protobuf wire type {wt}')
        yield f, wt, v, vstart, p

SAVE_ID_FIELD, LEVEL_FIELD, CLASS_FIELD = 20, 2, 1
CLASS_NAMES = {'Soldier': 'Commando', 'Siren': 'Siren', 'Mercenary': 'Gunzerker',
               'Assassin': 'Assassin', 'Mechromancer': 'Mechromancer', 'LilacPlayerClass': 'Psycho'}

def character_info(pb):
    info = {}
    for f, wt, v, s, e in top_fields(pb):
        if f in (SAVE_ID_FIELD, LEVEL_FIELD) and wt == 0: info[f] = v
        if f == CLASS_FIELD and wt == 2:
            ln, p = varint(pb, s); info[f] = pb[p:p+ln].decode('ascii', 'replace')
    return info

def set_save_id(pb, new_id):
    for f, wt, v, s, e in top_fields(pb):
        if f == SAVE_ID_FIELD and wt == 0:
            return pb[:s] + enc_varint(new_id) + pb[e:]
    raise ValueError('save has no slot ID field')

# ---------------------------------------------------------------- driver

def ask_id(current, name):
    while True:
        a = input(f'  Slot ID for {name} [Enter keeps {current}]: ')
        a = a.encode('ascii', 'ignore').decode().strip()  # drop stray BOM/odd bytes from piped input
        if not a: return current
        if a.isdigit() and 1 <= int(a) <= 9999: return int(a)
        print('  Enter a number from 1 to 9999.')

def convert(path, out_dir, new_id, interactive):
    size, body = read_container(path)
    src = detect(body); dst = 'pc' if src == 'mobile' else 'mobile'
    inner = decompress(size, body, src)
    name = os.path.basename(path)
    print(f'{name}: {src} save -> {dst}')

    if is_character(inner):
        ver, pb, trailer = wsg_decode(inner)
        info = character_info(pb)
        cls = info.get(CLASS_FIELD, '?').rsplit('_', 1)[-1]
        cls = CLASS_NAMES.get(cls, cls)
        cur = info.get(SAVE_ID_FIELD, 1)
        print(f'  Character: {cls}, level {info.get(LEVEL_FIELD, "?")}, slot ID {cur}')
        if new_id is None:
            new_id = ask_id(cur, name) if interactive else cur
        if new_id != cur:
            pb = set_save_id(pb, new_id)
            inner = wsg_encode(ver, pb, trailer)
        out_name = f'Save{new_id:04x}.sav'  # the game names files by the ID in hex
    else:
        print('  Profile (account-wide data)')
        pb = None
        out_name = 'profile.bin' if dst == 'pc' else 'Player1'

    out_dir = out_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), f'converted to {dst}')
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, out_name)
    if os.path.exists(out_path):
        raise FileExistsError(f'{out_path} already exists; move it away first')
    write_container(out_path, inner, dst)

    # Read the result back and make sure it decodes to the same thing.
    s2, b2 = read_container(out_path)
    back = decompress(s2, b2, detect(b2))
    if back != inner or (pb is not None and wsg_decode(back)[1] != pb):
        os.remove(out_path)
        raise ValueError('verification of the written file failed')
    print(f'  Wrote {out_path}')
    if pb is not None:
        print(f'  Put it in the {dst} save folder; make sure no other character there uses slot {new_id}.')
    else:
        print(f'  Replacing the {dst} {out_name} overwrites that device\'s badass rank, keys and settings.')

def main():
    ap = argparse.ArgumentParser(description='Convert Borderlands 2 saves between mobile and PC.')
    ap.add_argument('files', nargs='+')
    ap.add_argument('--id', type=int, help='slot ID for character saves (skips the prompt)')
    ap.add_argument('--out', help='output folder (default: "converted to <platform>" next to this script)')
    ap.add_argument('--no-prompt', action='store_true', help='keep slot IDs without asking')
    a = ap.parse_args()
    failed = 0
    for p in a.files:
        try:
            convert(p, a.out, a.id, not a.no_prompt)
        except Exception as e:
            failed += 1; print(f'  ERROR ({os.path.basename(p)}): {e}')
        print()
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(main())
