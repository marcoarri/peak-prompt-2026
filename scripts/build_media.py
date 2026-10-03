#!/usr/bin/env python3
"""Genera versioni web dei media in assets/web/ senza toccare gli originali.

Uso:  python3 scripts/build_media.py            (incrementale: salta i file già aggiornati)
      python3 scripts/build_media.py --force    (rigenera tutto)
      python3 scripts/build_media.py --only images|video|audio

Dipendenze: Python 3.9+, Pillow (con WebP), ffmpeg/ffprobe nel PATH.

Output:
  assets/web/img/{sm,md,lg}/<id>.avif   foto ridimensionate (lato lungo 640/1600/2560 px)
  assets/web/video/<id>.mp4             H.264 + AAC, faststart, yuv420p bt709
  assets/web/poster/<id>.webp           primo fotogramma dei video (lato lungo 1600 px)
  assets/web/audio/<nome>.m4a           copia degli audio (AAC, già leggeri)
  assets/web/media-manifest.json        percorsi, dimensioni, peso, orario di scatto
"""
from __future__ import annotations

import argparse
import os
import json
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC_MEDIA = ROOT / "assets" / "foto"
SRC_AUDIO = ROOT / "assets" / "audio"
OUT = ROOT / "assets" / "web"
MANIFEST = OUT / "media-manifest.json"

# lato lungo in px -> qualità. AVIF: ~45% più leggero di WebP a resa visiva equivalente
# (test su campione: lg WebP q82 ≈ 1.1 MB, AVIF q50 ≈ 0.5 MB). Supporto: browser desktop moderni.
IMG_FORMAT, IMG_EXT_OUT = "AVIF", ".avif"
IMG_SIZES = {"sm": (640, 50), "md": (1600, 50), "lg": (2560, 55)}
POSTER_SIZE = 1600
VIDEO_CRF = 26          # più basso = più qualità/peso (18-28 range sensato)
VIDEO_MAXRATE = "8M"    # tetto: le riprese in montagna sono rumorose e a CRF libero gonfiano
VIDEO_MAX_SIDE = 1920
IMG_EXT = {".jpg", ".jpeg", ".png", ".heic", ".webp"}
VID_EXT = {".mov", ".mp4", ".m4v"}
AUD_EXT = {".m4a", ".mp3", ".wav", ".aac"}


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def up_to_date(src: Path, dst: Path, force: bool) -> bool:
    return not force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime


# ---------- immagini ----------
def exif_time(im: Image.Image) -> str | None:
    ex = im.getexif().get_ifd(0x8769)
    raw, off = ex.get(0x9003), ex.get(0x9011)  # DateTimeOriginal, OffsetTimeOriginal
    if not raw:
        return None
    t = datetime.strptime(raw, "%Y:%m:%d %H:%M:%S").isoformat()
    return t + (off or "")


def process_image(args):
    src, force = Path(args[0]), args[1]
    with Image.open(src) as im:
        taken = exif_time(im)
        icc = im.info.get("icc_profile")  # iPhone = Display P3: va conservato
        im = ImageOps.exif_transpose(im).convert("RGB")
        entry = {"id": src.stem, "kind": "photo", "original": rel(src),
                 "taken": taken, "width": im.width, "height": im.height}
        for key, (side, q) in IMG_SIZES.items():
            dst = OUT / "img" / key / f"{src.stem}{IMG_EXT_OUT}"
            if not up_to_date(src, dst, force):
                dst.parent.mkdir(parents=True, exist_ok=True)
                r = im.copy()
                r.thumbnail((side, side), Image.LANCZOS)
                kw = {"quality": q, "speed": 6} if IMG_FORMAT == "AVIF" else {"quality": q, "method": 5}
                if icc:
                    kw["icc_profile"] = icc
                tmp = dst.with_name(dst.stem + ".tmp" + IMG_EXT_OUT)
                r.save(tmp, IMG_FORMAT, **kw)  # niente EXIF: orientamento già applicato
                os.replace(tmp, dst)       # scrittura atomica: niente file a metà se interrotto
            with Image.open(dst) as d:
                entry[key] = {"src": rel(dst), "w": d.width, "h": d.height,
                              "bytes": dst.stat().st_size}
    return entry


# ---------- video ----------
def ffprobe_json(src: Path) -> dict:
    out = subprocess.check_output(["ffprobe", "-v", "error", "-print_format", "json",
                                   "-show_format", "-show_streams", str(src)])
    return json.loads(out)


def process_video(src: Path, force: bool) -> dict:
    meta = ffprobe_json(src)
    v = next(s for s in meta["streams"] if s["codec_type"] == "video")
    tags = meta["format"].get("tags", {})
    taken = tags.get("com.apple.quicktime.creationdate") or tags.get("creation_time")
    has_audio = any(s["codec_type"] == "audio" for s in meta["streams"])

    dst = OUT / "video" / f"{src.stem}.mp4"
    if not up_to_date(src, dst, force):
        dst.parent.mkdir(parents=True, exist_ok=True)
        vf = (f"scale='if(gt(iw,ih),min({VIDEO_MAX_SIDE},iw),-2)':"
              f"'if(gt(iw,ih),-2,min({VIDEO_MAX_SIDE},ih))':out_range=tv,format=yuv420p")
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-map", "0:v:0",
               "-c:v", "libx264", "-preset", "slow", "-crf", str(VIDEO_CRF),
               "-maxrate", VIDEO_MAXRATE, "-bufsize", "16M",
               "-profile:v", "high", "-vf", vf,
               "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
               "-movflags", "+faststart", "-map_metadata", "-1"]
        cmd += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k"] if has_audio else ["-an"]
        tmp = dst.with_name(dst.stem + ".tmp.mp4")
        subprocess.run(cmd + [str(tmp)], check=True)
        os.replace(tmp, dst)

    poster = OUT / "poster" / f"{src.stem}.webp"
    if not up_to_date(src, poster, force):
        poster.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "0.1", "-i", str(dst),
                        "-frames:v", "1", "-vf",
                        f"scale='if(gt(iw,ih),{POSTER_SIZE},-2)':'if(gt(iw,ih),-2,{POSTER_SIZE})'",
                        "-c:v", "libwebp", "-quality", "80", str(poster.with_name(poster.stem + ".tmp.webp"))], check=True)
        os.replace(poster.with_name(poster.stem + ".tmp.webp"), poster)

    out_v = next(s for s in ffprobe_json(dst)["streams"] if s["codec_type"] == "video")
    return {"id": src.stem, "kind": "video", "original": rel(src), "taken": taken,
            "duration": round(float(meta["format"]["duration"]), 2),
            "hasAudio": has_audio,
            "video": {"src": rel(dst), "w": out_v["width"], "h": out_v["height"],
                      "bytes": dst.stat().st_size},
            "poster": {"src": rel(poster), "bytes": poster.stat().st_size}}


# ---------- audio ----------
def process_audio(src: Path, force: bool) -> dict:
    meta = ffprobe_json(src)
    dst = OUT / "audio" / src.name
    if not up_to_date(src, dst, force):
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return {"id": src.stem, "kind": "audio", "original": rel(src),
            "taken": meta["format"].get("tags", {}).get("creation_time"),
            "duration": round(float(meta["format"]["duration"]), 2),
            "audio": {"src": rel(dst), "bytes": dst.stat().st_size}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", choices=["images", "video", "audio"])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--match", help="processa solo i file il cui nome contiene questa stringa")
    a = ap.parse_args()

    old = {}
    if MANIFEST.exists():
        old = {e["id"]: e for e in json.loads(MANIFEST.read_text())["media"]}
    entries = dict(old)

    files = sorted(p for p in SRC_MEDIA.iterdir() if not p.name.startswith("."))
    if a.match:
        files = [p for p in files if a.match in p.name]
    imgs = [p for p in files if p.suffix.lower() in IMG_EXT]
    vids = [p for p in files if p.suffix.lower() in VID_EXT]
    auds = sorted(p for p in SRC_AUDIO.iterdir() if p.suffix.lower() in AUD_EXT) if SRC_AUDIO.exists() else []

    if a.only in (None, "images"):
        with ProcessPoolExecutor(a.workers) as ex:
            for i, e in enumerate(ex.map(process_image, [(str(p), a.force) for p in imgs]), 1):
                entries[e["id"]] = e
                if i % 20 == 0 or i == len(imgs):
                    print(f"immagini {i}/{len(imgs)}", flush=True)
    if a.only in (None, "video"):
        for i, p in enumerate(vids, 1):
            entries[p.stem] = process_video(p, a.force)
            print(f"video {i}/{len(vids)} {p.name}", flush=True)
    if a.only in (None, "audio"):
        for p in auds:
            entries[p.stem] = process_audio(p, a.force)
        print(f"audio {len(auds)}", flush=True)

    media = sorted(entries.values(), key=lambda e: (e.get("taken") or "", e["id"]))
    MANIFEST.write_text(json.dumps({"generated": datetime.now().isoformat(timespec="seconds"),
                                    "sizes": {k: v[0] for k, v in IMG_SIZES.items()},
                                    "media": media}, indent=2, ensure_ascii=False))
    tot = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file() and ".tmp." not in f.name)
    print(f"OK -> {rel(MANIFEST)} · {len(media)} voci · assets/web = {tot/1e6:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
