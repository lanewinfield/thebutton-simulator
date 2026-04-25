import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "assets" / "thebutton-posts.json"

START = 1427846400
END   = 1433548800

API = "https://api.pullpush.io/reddit/search/submission/"
PAGE_SIZE = 100
USER_AGENT = "thebutton-simulator-archive-tool/0.1"


def fetch(before: int):
    url = (
        f"{API}?subreddit=thebutton&after={START}&before={before}"
        f"&size={PAGE_SIZE}&sort=desc&sort_type=created_utc"
    )
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    posts: list[dict] = []
    seen: set[str] = set()
    before = END

    while True:
        try:
            data = fetch(before)
        except Exception as e:
            print(f"  fetch failed: {e}; retrying in 5s", flush=True)
            time.sleep(5)
            continue

        rows = data.get("data", [])
        if not rows:
            print("  empty page — done", flush=True)
            break

        added = 0
        oldest_in_page = None
        for row in rows:
            rid = row.get("id")
            if not rid or rid in seen:
                continue
            seen.add(rid)
            t = row.get("created_utc")
            if t is None:
                continue
            try:
                t = int(t)
            except (TypeError, ValueError):
                continue
            posts.append({
                "t": t,
                "T": row.get("title", "") or "",
                "s": int(row.get("score") or 0),
                "c": int(row.get("num_comments") or 0),
                "p": row.get("permalink") or f"/r/thebutton/comments/{rid}/",
            })
            added += 1
            if oldest_in_page is None or t < oldest_in_page:
                oldest_in_page = t

        print(f"  +{added} new (total {len(posts)}); oldest={oldest_in_page}", flush=True)

        if added == 0 or oldest_in_page is None or oldest_in_page <= START:
            break
        before = int(oldest_in_page)
        time.sleep(0.4)

    posts.sort(key=lambda p: p["t"])
    with OUT.open("w") as f:
        json.dump(posts, f, separators=(",", ":"))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(posts)} posts)")


if __name__ == "__main__":
    main()
