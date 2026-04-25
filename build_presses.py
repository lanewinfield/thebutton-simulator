"""
Convert the historical thebutton_presses.csv into a compact binary playback
file the browser can stream.

Output:
  assets/presses.bin  - little-endian uint32 array; each value is ms since the
                        first press in the timeline. (Final press is ~5.6 days
                        beyond the 32-bit limit? Let's check: 65 days * 86400 *
                        1000 = 5.6e9 ms which exceeds 2^32 = 4.29e9. So we use
                        uint32 deltas (ms since previous press) instead.)
  assets/presses.meta.json - { start_iso, count, end_iso }

Each entry in presses.bin is a uint32 = milliseconds since previous press.
First entry is 0.
"""
import csv
import json
import struct
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "data" / "thebutton_presses.csv"
OUT_DIR = ROOT / "assets"
OUT_BIN = OUT_DIR / "presses.bin"
OUT_META = OUT_DIR / "presses.meta.json"
OUT_FLAIRS = OUT_DIR / "flairs.bin"

CSS_TO_TIER = {
    "": 0,
    "press-1": 1,
    "press-2": 2,
    "press-3": 3,
    "press-4": 4,
    "press-5": 5,
    "press-6": 6,
    "no-press": 7,
    "cheater": 8,
}


def parse_iso(s: str) -> datetime:
    # "2015-04-01T16:10:04.468000"
    return datetime.fromisoformat(s)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    deltas = []
    flairs = bytearray()
    prev_ms = None
    start_iso = None
    end_iso = None
    count = 0
    min_flair = None
    min_flair_index = None
    min_flair_iso = None
    with SRC.open(newline="") as f:
        r = csv.reader(f)
        next(r)  # header
        for row in r:
            ts_str, flair_str, css, outage = row[0], row[1], row[2], row[3]
            flairs.append(CSS_TO_TIER.get(css, 0))
            t = parse_iso(ts_str)
            t_ms = int(t.timestamp() * 1000)
            if prev_ms is None:
                deltas.append(0)
                start_iso = ts_str
            else:
                d = t_ms - prev_ms
                if d < 0:
                    d = 0
                if d > 0xFFFFFFFF:
                    d = 0xFFFFFFFF
                deltas.append(d)
            prev_ms = t_ms
            end_iso = ts_str
            # flair is like "59s" / "0s"
            try:
                flair_val = int(flair_str.rstrip("s"))
            except ValueError:
                flair_val = None
            if flair_val is not None and (min_flair is None or flair_val < min_flair):
                min_flair = flair_val
                min_flair_index = count
                min_flair_iso = ts_str
            count += 1
            if count % 100000 == 0:
                print(f"  {count} rows processed")

    print(f"total presses: {count}")
    print(f"start: {start_iso}")
    print(f"end:   {end_iso}")

    # Pack as little-endian uint32
    with OUT_BIN.open("wb") as bf:
        # write in chunks
        CHUNK = 100000
        for i in range(0, len(deltas), CHUNK):
            bf.write(struct.pack(f"<{min(CHUNK, len(deltas)-i)}I", *deltas[i : i + CHUNK]))

    with OUT_FLAIRS.open("wb") as ff:
        ff.write(bytes(flairs))

    with OUT_META.open("w") as mf:
        json.dump(
            {
                "start_iso": start_iso,
                "end_iso": end_iso,
                "count": count,
                "format": "uint32 little-endian milliseconds-delta-from-previous-press",
                "min_flair": {
                    "seconds": min_flair,
                    "index": min_flair_index,
                    "iso": min_flair_iso,
                },
                "flairs": {
                    "format": "uint8 per-press tier",
                    "tiers": {str(v): k for k, v in CSS_TO_TIER.items()},
                },
            },
            mf,
            indent=2,
        )

    print(f"wrote {OUT_BIN} ({OUT_BIN.stat().st_size} bytes)")
    print(f"wrote {OUT_META}")


if __name__ == "__main__":
    main()
