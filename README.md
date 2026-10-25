# BL2 Android <-> PC Save Converter

Convert Borderlands 2 save files between **Wicked's Android port (v1.7)** and the
**PC (Steam)** version, in either direction. Drag a save onto a `.bat` file and get a
converted copy.

> **Scope:** this was built and tested against **Wicked's Android port, version 1.7**,
> only. Other Android builds, other versions of the port, or other mobile platforms may
> store saves differently. Wherever this README or the tool says "mobile", it means that
> port. Back up your files before trying it with anything else.

## Credits

The Android port of Borderlands 2 is by **Wicked**. This tool only converts save files
between that port and the PC game. Without Wicked's port there would be nothing to convert.
This project is not affiliated with Wicked, Gearbox Software or 2K.

- Works on character saves (`Save0001.sav`, ...) and profiles (`profile.bin` on PC,
  `Player1` on mobile).
- Works out the direction by itself: a mobile file becomes a PC file and vice versa.
- Never touches the file you drop on it and never overwrites anything. It always writes a new file.
- One Python file, standard library only. Nothing to install apart from Python 3.

## Quick start

1. Install Python 3 if you don't have it (python.org, tick "Add to PATH").
2. Drag one or more save files onto **`Drop BL2 save here.bat`**.
3. For a character save, it shows something like `Siren, level 7, slot ID 1` and asks for a
   slot ID. Press Enter to keep it, or type a number no other character on the target
   device uses (see [Slot IDs](#slot-ids-the-one-thing-you-must-get-right)).
4. Get the result from `converted to pc\` or `converted to mobile\` next to the script, and
   copy it into the target device's save folder.

**Back up the target save folder first.** On Steam it is
`Documents\My Games\Borderlands 2\WillowGame\SaveData\<your Steam ID>\`. If Steam Cloud
reports a conflict the next time you start the game, choose the **local** files.

Command line, if you prefer it:

```
python bl2_convert.py SAVE [SAVE ...] [--id N] [--no-prompt] [--out FOLDER]
```

| Option | Meaning |
|---|---|
| `--id N` | Give character saves slot ID `N` without asking |
| `--no-prompt` | Keep each save's current slot ID without asking |
| `--out FOLDER` | Write output here instead of `converted to <platform>\` |

## How it works, in plain terms

A BL2 save is like a box inside a box inside a box:

```
+-- outer box: the file ----------------------------------------------+
| SHA1 fingerprint | size | compressed data                           |
|  (20 bytes)      | (4)  |   mobile: zlib     PC: LZO                |
|                  |      | +-- middle box (after decompressing) ---+ |
|                  |      | | "WSG" header | Huffman-packed data |  | |
|                  |      | |              | +-- inner box -----+ |  | |
|                  |      | |              | | your character   | |  | |
|                  |      | |              | | (protobuf)       | |  | |
|                  |      | |              | +------------------+ |  | |
|                  |      | |              |      + 4-byte trailer|  | |
|                  |      | +---------------------------------------+ |
+---------------------------------------------------------------------+
```

The key finding: **the middle and inner boxes are identical on mobile and PC.** Only the
outer box differs, in how the data is compressed: mobile uses **zlib** and PC uses
**LZO**. So converting comes down to:

1. **Check the fingerprint.** The first 20 bytes are a SHA1 hash of the rest of the file.
   If it doesn't match, the file isn't a BL2 save (or it is damaged), and the script stops.
2. **Work out which platform it's from.** zlib data always starts with a recognisable
   2-byte header (`78 9c` and similar). If that's present it's mobile, otherwise it's PC.
3. **Unpack it** with zlib or LZO, as appropriate.
4. **Repack it the other way** and write a new SHA1 fingerprint in front.
5. **Check its own work.** Read the new file back, unpack it, and confirm it gives exactly
   the same data. If it doesn't, the file is deleted and an error is shown.

For profiles that's the whole job. For character saves there is one more step.

### Slot IDs: the one thing you must get right

Each character save records **its own slot number** inside the inner box. The game saves
the character back to the file that matches that number, *not* to the file it was loaded
from. If you copy a mobile character with slot 1 onto a PC that already has a slot-1
character, playing it **saves over the PC character**.

So the script reads the slot ID, lets you change it, and names the output file to match
(slot 6 -> `Save0006.sav`). Changing it means opening all three boxes:

1. Unpack the outer box (zlib/LZO), as above.
2. Unpack the middle box: decode the **Huffman** compression to get the raw character data.
3. In the character data (a **protobuf** message), find field 20, the slot ID, and
   replace its value.
4. Pack it again: build a new Huffman encoding, recompute the CRC32 checksum in the
   WSG header, put the **4-byte trailer** back, then do the outer box as usual.

If you keep the current slot ID, steps 2-4 are skipped and the middle box is copied
byte for byte.

### The gotcha that took a while: the 4-byte trailer

Every save the game writes ends with 4 extra bytes after the Huffman data (usually
`d4 93 9f 1a`). They are easy to miss because decoding stops before reaching them. The
first version of this tool dropped them, and the game showed the character as
`!Corrupted!` in the character list. Putting them back fixed it.

## Code walkthrough

Everything is in [`bl2_convert.py`](bl2_convert.py), in four sections.

### 1. Outer layer: SHA1 + size + compression

| Function | What it does |
|---|---|
| `read_container(path)` | Reads the file, checks that `SHA1(bytes 20..end) == bytes 0..19`, and returns the uncompressed size (big-endian, bytes 20-23) and the compressed data. |
| `detect(body)` | Returns `'mobile'` if the data starts with a valid zlib header (first byte `0x78`, and the 2-byte header is divisible by 31 as the zlib spec requires), otherwise `'pc'`. |
| `decompress(size, body, platform)` | zlib or LZO, then checks the result is the size the header claims. |
| `write_container(path, inner, platform)` | Compresses for the target platform, adds the size and the SHA1, and opens the file in `'xb'` mode so it **cannot** overwrite an existing file. |

### 2. LZO

Python has no built-in LZO, and adding a third-party package would make the tool harder
to run, so there are two small functions:

- **`lzo1x_literal(data)`** writes a valid LZO1X stream without actually compressing.
  LZO data is a series of instructions: "copy the next N bytes as-is" (a *literal*) or
  "repeat N bytes from earlier" (a *match*). This function writes a single literal run
  holding the whole save, then LZO's end-of-stream marker (`11 00 00`). The file comes out
  nearly twice the size of one the game writes (around 10 KB instead of 5-6 KB), but any
  LZO decoder, including the game's, reads it fine. The game recompresses it properly the first time it saves.
- **`lzo1x_decompress(src, out_len)`** is a full LZO1X decoder, needed to read PC saves
  (which the game *does* compress). It walks the instruction bytes: the value of each
  instruction byte says whether it is a literal run or a match, how long it is, and how
  far back to copy from. `state` tracks how many literals followed the previous
  instruction, because LZO interprets small instruction values differently depending on
  that.

### 3. WSG payload: Huffman + protobuf (character saves only)

Layout of the middle box:

```
[length, 4 bytes BE] "WSG" [version, 4 LE] [CRC32, 4 LE] [size, 4 LE]
[Huffman tree][Huffman bitstream][4-byte trailer]
```

| Function | What it does |
|---|---|
| `is_character(inner)` | Character saves have `"WSG"` at offset 4; profiles don't. |
| `BitReader`, `read_tree` | The Huffman tree is stored in the file bit by bit: `1` + 8 bits = a leaf (a byte value), `0` = a branch followed by its left and right subtrees. `read_tree` rebuilds it recursively as nested tuples. |
| `wsg_decode(inner)` | Rebuilds the tree, then for each output byte walks from the root (bit `0` = left, `1` = right) until it reaches a leaf. It stops after `size` bytes, checks the CRC32, and returns the version, the raw protobuf and the trailer. |
| `wsg_encode(ver, data, trailer)` | The reverse. It counts how often each byte value appears, builds a Huffman tree by repeatedly merging the two rarest entries (a `heapq` priority queue), writes the tree in the same bit format, then each byte's code, pads to a whole byte, and adds the header and the trailer. The tree doesn't have to match the game's; it only has to be valid, because the tree travels inside the file. |

Protobuf helpers. Protobuf is Google's compact format: a sequence of
`(field number, type, value)` entries, with numbers stored as variable-length "varints"
(7 bits per byte, top bit = "more bytes follow").

| Function | What it does |
|---|---|
| `varint`, `enc_varint` | Read or write one varint. |
| `top_fields(pb)` | Steps through the top-level fields and yields each one's number, type, value (for integers) and byte position. Nested messages are skipped over, not parsed. |
| `character_info(pb)` | Picks out field 1 (class, e.g. `GD_Siren.Character.CharClass_Siren`), field 2 (level) and field 20 (slot ID) for the on-screen summary. |
| `set_save_id(pb, new_id)` | Replaces only the *value* bytes of field 20 and keeps everything else as it was. |

How field 20 was identified as the slot ID: on a PC with saves `Save0001`-`Save0005`,
field 20 was 1, 2, 3, 4, 5 in the matching files, and it was the only field that did that.

### 4. Driver

- `convert(...)` ties it together for one file: read, detect, decompress, optionally
  change the slot ID, choose the output name and folder, write, then read the file back
  and verify it.
- `ask_id(...)` is the slot-ID prompt. It removes stray non-ASCII bytes from the input, such
  as a byte-order mark when input is piped in.
- `main()` handles the command-line options and processes each file separately. One bad
  file doesn't stop the others, and the exit code is 1 if any file failed.

[`Drop BL2 save here.bat`](Drop%20BL2%20save%20here.bat) passes every dropped file
to the script (`%*`), using the `py` launcher if it's installed and `python` otherwise,
then pauses so you can read the output.

## How it was checked

- **Mobile -> PC:** converted a real mobile character and loaded it in the Steam game. It
  played, and the game saved it back to the slot the tool assigned.
- **PC -> mobile:** converted a PC save, loaded it in the mobile game, and it worked.
- **The LZO decoder** correctly reads every save and profile written by the PC game.
- **Round trips** (PC -> mobile -> PC, and the reverse) give back identical data, including
  saves the game had already rewritten.
- **The Huffman encoder** was checked by decoding its output and comparing with the
  original data.

## Known limits

- **Output names use the slot ID in hex** (slot 10 -> `Save000a.sav`), which is believed
  to be how BL2 names its files but has only been confirmed for IDs 1-9. Using 1-9
  avoids the question.
- `--id N` with several character files gives them **all** the same ID. Convert them
  one at a time if they each need their own.
- Profiles hold account-wide progress (badass rank, golden keys, settings). Replacing
  the target device's profile overwrites that progress.
