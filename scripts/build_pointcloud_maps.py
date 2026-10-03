#!/usr/bin/env python3
"""Generate aspect-correct point-cloud maps via ImageMagick.

Sources:
  assets/web/img/md/*.avif   → photos
  assets/web/poster/*.{webp,avif,jpg,png} → video first-frame posters

Each output pixel maps to one explore point (1:1). Long side = PC_LONG_SIDE.

Uso:
  python3 scripts/build_pointcloud_maps.py
  python3 scripts/build_pointcloud_maps.py --force
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "web"
MD_DIR = OUT / "img" / "md"
POSTER_DIR = OUT / "poster"
PC_DIR = OUT / "img" / "pc"
MANIFEST = OUT / "media-manifest.json"

# Must stay in sync with path3d.js CLOUD_LONG_SIDE
PC_LONG_SIDE = 360
PC_EXT = ".avif"
PC_QUALITY = 55
POSTER_EXT = {".webp", ".avif", ".jpg", ".jpeg", ".png"}


def find_magick() -> str:
    env = os.environ.get("MAGICK_BIN")
    if env and Path(env).is_file():
        return env
    which = shutil.which("magick")
    if which:
        return which
    local = ROOT / "tools" / "homebrew" / "bin" / "magick"
    if local.is_file():
        return str(local)
    raise SystemExit(
        "ImageMagick `magick` non trovato.\n"
        "Installa con: brew install imagemagick\n"
        "oppure esporta MAGICK_BIN=/path/to/magick"
    )


def up_to_date(src: Path, dst: Path, force: bool) -> bool:
    return not force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime


def pc_dims(src_w: int, src_h: int) -> tuple[int, int]:
    src_w = max(1, src_w)
    src_h = max(1, src_h)
    if src_w >= src_h:
        cols = PC_LONG_SIDE
        rows = max(1, round(PC_LONG_SIDE * src_h / src_w))
    else:
        rows = PC_LONG_SIDE
        cols = max(1, round(PC_LONG_SIDE * src_w / src_h))
    return cols, rows


def identify(magick: str, path: Path) -> tuple[int, int]:
    out = subprocess.check_output(
        [magick, "identify", "-format", "%w %h", str(path)], text=True
    ).strip()
    w, h = (int(x) for x in out.split())
    return w, h


def make_pc(magick: str, src: Path, dst: Path) -> tuple[int, int]:
    src_w, src_h = identify(magick, src)
    cols, rows = pc_dims(src_w, src_h)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.stem + ".tmp" + PC_EXT)
    subprocess.run(
        [
            magick,
            str(src),
            "-auto-orient",
            "-resize",
            f"{cols}x{rows}!",
            "-quality",
            str(PC_QUALITY),
            str(tmp),
        ],
        check=True,
    )
    os.replace(tmp, dst)
    return cols, rows


def collect_sources() -> list[Path]:
    """Photos from md/; videos from poster/ only if no md sibling."""
    md = {p.stem: p for p in MD_DIR.glob(f"*{PC_EXT}")} if MD_DIR.is_dir() else {}
    sources = list(md.values())
    if POSTER_DIR.is_dir():
        for p in sorted(POSTER_DIR.iterdir()):
            if p.suffix.lower() not in POSTER_EXT:
                continue
            if p.stem in md:
                continue  # photo already covered
            sources.append(p)
    return sorted(sources, key=lambda p: p.stem)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--match", help="solo id che contengono questa stringa")
    a = ap.parse_args()

    magick = find_magick()
    ver = subprocess.check_output([magick, "-version"], text=True).splitlines()[0]
    print(ver)
    print(f"long side {PC_LONG_SIDE}px (aspect preserved) → {PC_DIR.relative_to(ROOT)}")

    sources = collect_sources()
    if a.match:
        sources = [p for p in sources if a.match in p.stem]
    if not sources:
        raise SystemExit("nessuna sorgente md/ o poster/")

    done = 0
    skipped = 0
    dims_by_id: dict[str, tuple[int, int]] = {}
    for i, src in enumerate(sources, 1):
        dst = PC_DIR / f"{src.stem}{PC_EXT}"
        if up_to_date(src, dst, a.force):
            skipped += 1
            dims_by_id[src.stem] = identify(magick, dst)
        else:
            dims_by_id[src.stem] = make_pc(magick, src, dst)
            done += 1
        if i % 40 == 0 or i == len(sources):
            print(f"pc {i}/{len(sources)} (+{done} new, {skipped} skip)", flush=True)

    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text())
        by_id = {e["id"]: e for e in data.get("media", [])}
        for stem, (w, h) in dims_by_id.items():
            dst = PC_DIR / f"{stem}{PC_EXT}"
            if not dst.exists():
                continue
            entry = by_id.get(stem)
            if not entry:
                continue
            entry["pc"] = {
                "src": dst.relative_to(ROOT).as_posix(),
                "w": w,
                "h": h,
                "bytes": dst.stat().st_size,
            }
        sizes = data.setdefault("sizes", {})
        sizes["pc"] = {"longSide": PC_LONG_SIDE, "aspectPreserved": True}
        data["generated"] = datetime.now().isoformat(timespec="seconds")
        MANIFEST.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        print(f"OK → {MANIFEST.relative_to(ROOT)}")
    else:
        print("! manifest assente — pc scritte ma non linkate")

    return 0


if __name__ == "__main__":
    sys.exit(main())
