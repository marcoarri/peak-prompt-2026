#!/usr/bin/env python3
"""Build timeline-data.js/.json from Wikiloc GPX + media EXIF/birth times."""

from __future__ import annotations

import bisect
import json
import struct
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ExifTags
from PIL.ExifTags import IFD

ROOT = Path(__file__).resolve().parent
FOTO = ROOT / "assets" / "foto"
GPX_PATH = (
    ROOT
    / "assets"
    / "gpx-metadata"
    / "Pian Falzarego - Forcella Lagazuoi - Baracca ufficiali austriaci - Rifugio Lagazuoi.gpx"
)
AUDIO = ROOT / "assets" / "audio"
MANIFEST = ROOT / "assets" / "web" / "media-manifest.json"  # da scripts/build_media.py
OUT_JS = ROOT / "timeline-data.js"
OUT_JSON = ROOT / "timeline-data.json"

exif_tags = {v: k for k, v in ExifTags.TAGS.items()}
TAG_DTO = exif_tags.get("DateTimeOriginal")
TAG_DT = exif_tags.get("DateTime")
TAG_OFF = exif_tags.get("OffsetTimeOriginal")
TAG_OFF2 = exif_tags.get("OffsetTime")

MEDIA_EXT = {".jpeg", ".jpg", ".png", ".mov", ".mp4", ".heic", ".webp", ".gif"}
VIDEO_EXT = {".mov", ".mp4"}
LOCAL_TZ = timezone(timedelta(hours=2))

# Manual local-time overrides (hike day) — videos lacked usable container timestamps.
VIDEO_TIME_OVERRIDES = {
    "IMG_6878": "14:10",
    "IMG_6879": "14:12",
    "IMG_6899": "14:21",
    "IMG_6932": "14:48",
    "IMG_6933": "14:50",
    "IMG_6935": "14:56",
    "IMG_6943": "15:02",
    "IMG_6974": "15:26",
    "IMG_6979": "15:29",
}


# Media outside the hike (no EXIF, not on the GPX): fixed data shown as-is.
#   extra   → not counted in the "N/184" total (shows as 185/184)
#   detachM → metres past the trail end (explore: longer gap before it)
#   hideInOverview → not drawn in the volumetric overview (explore only)
EXTRA_MEDIA = {
    # Photopoint Lagazuoi group shot, 03.10.2026 18:05 — closes the walk
    "IMG_0001": {
        "time": "2026-10-03T16:05:20Z",  # real capture time: sorts after the hike
        "timeLocal": "00:00:00",
        "lat": 46.527677,  # a few metres off the last photo (IMG_7085)
        "lon": 12.00921,
        "ele": 2739.9,
        "extra": True,
        "detachM": 110,
        "hideInOverview": True,
    },
}


def local_tag(tag: str) -> str:
    return tag.split("}")[-1]


def parse_gpx(path: Path):
    root = ET.parse(path).getroot()
    track = []
    for el in root.iter():
        if local_tag(el.tag) != "trkpt":
            continue
        lat = float(el.attrib["lat"])
        lon = float(el.attrib["lon"])
        t = None
        ele = None
        for c in el:
            ln = local_tag(c.tag)
            if ln == "time" and c.text:
                t = datetime.fromisoformat(c.text.replace("Z", "+00:00"))
            elif ln == "ele" and c.text:
                ele = float(c.text)
        if t is None:
            continue
        track.append({"t": t, "lat": lat, "lon": lon, "ele": ele})
    track.sort(key=lambda p: p["t"])
    name = None
    for el in root.iter():
        if local_tag(el.tag) == "name" and el.text:
            name = el.text
            break
    return name, track


def jpeg_time(path: Path):
    try:
        im = Image.open(path)
        exif = im._getexif() or {}
    except Exception:
        return None
    raw = exif.get(TAG_DTO) or exif.get(TAG_DT)
    if not raw:
        return None
    naive = datetime.strptime(raw, "%Y:%m:%d %H:%M:%S")
    off = exif.get(TAG_OFF) or exif.get(TAG_OFF2) or "+00:00"
    sign = 1 if off[0] == "+" else -1
    hh, mm = map(int, off[1:].split(":"))
    tz = timezone(sign * timedelta(hours=hh, minutes=mm))
    return naive.replace(tzinfo=tz)


def apple_acceleration_vector(path: Path):
    """Apple MakerNote tag 0x0008 — gravity vector in device coords (x,y,z)."""
    try:
        mn = Image.open(path).getexif().get_ifd(IFD.Exif).get(37500)
    except Exception:
        return None
    if not mn or not mn.startswith(b"Apple iOS"):
        return None
    mm = mn.find(b"MM")
    if mm < 0:
        return None
    tiff = mn[mm:]
    count = struct.unpack(">H", tiff[2:4])[0]
    pos = 4
    for _ in range(count):
        if pos + 12 > len(tiff):
            break
        tag, typ, cnt = struct.unpack(">HHI", tiff[pos : pos + 8])
        val = tiff[pos + 8 : pos + 12]
        pos += 12
        if tag != 0x0008:
            continue
        if typ != 10 or cnt != 3:  # SRATIONAL × 3
            return None
        off = struct.unpack(">I", val)[0]
        # Offsets are relative to the MakerNote start (not the TIFF header)
        data = mn[off : off + 24]
        if len(data) < 24:
            return None
        out = []
        for i in range(3):
            num, den = struct.unpack(">ii", data[i * 8 : i * 8 + 8])
            out.append(round(num / den, 6) if den else 0.0)
        return out
    return None


def container_time(path: Path):
    """Orario scritto dentro il file (QuickTime creationdate / creation_time).
    Sostituisce la vecchia birth time del filesystem macOS, che cambia se il file viene ricopiato."""
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "format_tags", "-of", "json", str(path)],
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None, None
    tags = json.loads(out).get("format", {}).get("tags", {})
    for key, label in (("com.apple.quicktime.creationdate", "quicktime"), ("creation_time", "container")):
        if tags.get(key):
            return datetime.fromisoformat(tags[key].replace("Z", "+00:00")), label
    return None, None


def media_time(path: Path):
    if path.suffix.lower() in {".jpeg", ".jpg", ".png", ".heic", ".webp"}:
        t = jpeg_time(path)
        if t:
            return t, "exif"
    t, label = container_time(path)
    if t:
        return t, label
    # ultima risorsa: data di modifica del file (inaffidabile)
    return datetime.fromtimestamp(path.stat().st_mtime, tz=LOCAL_TZ), "mtime"


def load_manifest():
    if not MANIFEST.exists():
        print("! media-manifest.json assente: uso gli originali. Lancia prima scripts/build_media.py")
        return {}
    return {e["id"]: e for e in json.loads(MANIFEST.read_text())["media"]}


def web_fields(entry, fallback_src):
    """Percorsi web dal manifest; se mancano resta l'originale."""
    if not entry:
        return {"src": fallback_src, "original": fallback_src}
    if entry["kind"] == "photo":
        fields = {"src": entry["lg"]["src"], "md": entry["md"]["src"], "thumb": entry["sm"]["src"],
                  "width": entry["lg"]["w"], "height": entry["lg"]["h"], "original": entry["original"]}
        if entry.get("pc"):
            fields["pc"] = entry["pc"]["src"]
            fields["pcW"] = entry["pc"]["w"]
            fields["pcH"] = entry["pc"]["h"]
        return fields
    if entry["kind"] == "video":
        fields = {"src": entry["video"]["src"], "poster": entry["poster"]["src"],
                  "thumb": entry["poster"]["src"], "width": entry["video"]["w"],
                  "height": entry["video"]["h"], "duration": entry["duration"],
                  "original": entry["original"]}
        if entry.get("pc"):
            fields["pc"] = entry["pc"]["src"]
            fields["pcW"] = entry["pc"]["w"]
            fields["pcH"] = entry["pc"]["h"]
        return fields
    return {"src": entry["audio"]["src"], "duration": entry["duration"], "original": entry["original"]}


def nearest_point(track, times, t):
    i = bisect.bisect_left(times, t)
    candidates = []
    if i < len(track):
        candidates.append(track[i])
    if i > 0:
        candidates.append(track[i - 1])
    best = min(candidates, key=lambda p: abs((p["t"] - t).total_seconds()))
    return best, abs((best["t"] - t).total_seconds())


def main():
    name, track = parse_gpx(GPX_PATH)
    times = [p["t"] for p in track]

    manifest = load_manifest()
    media_files = sorted(p for p in FOTO.iterdir() if p.suffix.lower() in MEDIA_EXT)
    gpx_day = times[0].astimezone(LOCAL_TZ).date()
    items = []
    for path in media_files:
        kind = "video" if path.suffix.lower() in VIDEO_EXT else "photo"
        extra = EXTRA_MEDIA.get(path.stem)
        if extra:
            items.append(
                {
                    "id": path.stem,
                    "file": path.name,
                    **web_fields(manifest.get(path.stem), f"assets/foto/{path.name}"),
                    "kind": kind,
                    "timeSource": "manual",
                    **extra,
                }
            )
            continue
        override = VIDEO_TIME_OVERRIDES.get(path.stem) if kind == "video" else None
        if override:
            hh, mm = map(int, override.split(":"))
            t = datetime(gpx_day.year, gpx_day.month, gpx_day.day, hh, mm, 0, tzinfo=LOCAL_TZ)
            source = "manual"
        else:
            t, source = media_time(path)
        t_utc = t.astimezone(timezone.utc)
        pt, delta = nearest_point(track, times, t_utc)
        accel = apple_acceleration_vector(path) if kind == "photo" else None
        item = {
            "id": path.stem,
            "file": path.name,
            **web_fields(manifest.get(path.stem), f"assets/foto/{path.name}"),
            "kind": kind,
            "time": t_utc.isoformat().replace("+00:00", "Z"),
            "timeLocal": t.astimezone(LOCAL_TZ).strftime("%H:%M:%S"),
            "timeSource": source,
            "matchDeltaSec": round(delta, 1),
            "lat": pt["lat"],
            "lon": pt["lon"],
            "ele": round(pt["ele"], 1) if pt["ele"] is not None else None,
        }
        if accel:
            item["accel"] = accel
        items.append(item)
    items.sort(key=lambda x: x["time"])

    # audio: agganciati alla traccia solo se registrati durante la salita
    audio = []
    for path in sorted(p for p in AUDIO.glob("*") if p.suffix.lower() in {".m4a", ".mp3", ".wav"}):
        t, source = media_time(path)
        t_utc = t.astimezone(timezone.utc)
        inside = times[0] <= t_utc <= times[-1]
        pt, delta = nearest_point(track, times, t_utc)
        audio.append(
            {
                "id": path.stem,
                "file": path.name,
                **web_fields(manifest.get(path.stem), f"assets/audio/{path.name}"),
                "time": t_utc.isoformat().replace("+00:00", "Z"),
                "timeLocal": t.astimezone(LOCAL_TZ).strftime("%H:%M:%S"),
                "timeSource": source,
                "onTrack": inside,
                "lat": pt["lat"] if inside else None,
                "lon": pt["lon"] if inside else None,
                "ele": round(pt["ele"], 1) if inside and pt["ele"] is not None else None,
            }
        )

    # Full Wikiloc track for 3D path (lat / lon / elevation)
    track_out = [
        {
            "time": p["t"].isoformat().replace("+00:00", "Z"),
            "lat": p["lat"],
            "lon": p["lon"],
            "ele": round(p["ele"], 1) if p["ele"] is not None else None,
        }
        for p in track
    ]

    data = {
        "title": name,
        "route": "Lagazuoi",
        "gpxFile": GPX_PATH.name,
        "start": times[0].isoformat().replace("+00:00", "Z"),
        "end": times[-1].isoformat().replace("+00:00", "Z"),
        "durationMin": round((times[-1] - times[0]).total_seconds() / 60, 1),
        "eleMin": round(min(p["ele"] for p in track if p["ele"] is not None), 1),
        "eleMax": round(max(p["ele"] for p in track if p["ele"] is not None), 1),
        "trackPointCount": len(track),
        "mediaCount": len(items),
        "photoCount": sum(1 for i in items if i["kind"] == "photo"),
        "videoCount": sum(1 for i in items if i["kind"] == "video"),
        "track": track_out,
        "media": items,
        "audio": audio,
    }

    OUT_JSON.write_text(json.dumps(data, indent=2))
    OUT_JS.write_text("window.TIMELINE_DATA = " + json.dumps(data) + ";\n")
    print(f"Wrote {OUT_JSON.name} and {OUT_JS.name}")
    print(
        f"{data['mediaCount']} media · {data['photoCount']} photos · "
        f"{data['videoCount']} videos · {data['durationMin']} min"
    )


if __name__ == "__main__":
    main()
