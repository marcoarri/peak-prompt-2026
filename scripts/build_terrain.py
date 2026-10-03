#!/usr/bin/env python3
"""Passo 1 — preprocess DEM + Wikiloc track → assets/terrain/terrain.json + preview.png."""

from __future__ import annotations

import json
import math
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio
from scipy.spatial import Delaunay

# --- project constants ---
ROOT = Path(__file__).resolve().parents[1]
DEM_PATH = ROOT / "assets" / "dem" / "Copernicus_DSM_COG_10_N46_00_E012_00_DEM.tif"
GPX_PATH = (
    ROOT
    / "assets"
    / "gpx-metadata"
    / "Pian Falzarego - Forcella Lagazuoi - Baracca ufficiali austriaci - Rifugio Lagazuoi.gpx"
)
TIMELINE_PATH = ROOT / "timeline-data.json"
OUT_DIR = ROOT / "assets" / "terrain"
OUT_JSON = OUT_DIR / "terrain.json"
OUT_PREVIEW = OUT_DIR / "preview.png"

R = 6_371_000.0
CORRIDOR_HALF_WIDTH_M = 100.0
# 12 m overshoots the 1.5k–6k triangle budget on this corridor; 16 m hits the target.
GRID_STEP_M = 16.0
SEED = 7
BBOX_MARGIN_M = 150.0
MAX_EDGE_M = 3.0 * GRID_STEP_M
PHOTO_DENSITY_RADIUS_M = 40.0
TRACK_LIFT_M = 1.5
GAP_UTC_START = (13, 39)  # 15:39 local (+02)
GAP_UTC_END = (14, 46)  # 16:46 local

rng = np.random.default_rng(SEED)


def local_tag(tag: str) -> str:
    return tag.split("}")[-1]


def parse_gpx_track(path: Path):
    root = ET.parse(path).getroot()
    pts = []
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
        pts.append({"lat": lat, "lon": lon, "ele_gps": ele, "time": t})
    return pts


class LocalFrame:
    """Equirectangular local meters: x=east, y=up, z=-north (three.js)."""

    def __init__(self, lat0: float, lon0: float, y0: float):
        self.lat0 = lat0
        self.lon0 = lon0
        self.y0 = y0
        self.cos_lat0 = math.cos(math.radians(lat0))

    def to_xz(self, lat: float, lon: float):
        x = R * math.radians(lon - self.lon0) * self.cos_lat0
        z = -R * math.radians(lat - self.lat0)
        return x, z

    def to_xyz(self, lat: float, lon: float, elev: float):
        x, z = self.to_xz(lat, lon)
        y = elev - self.y0
        return x, y, z

    def as_dict(self):
        return {
            "lat0": self.lat0,
            "lon0": self.lon0,
            "y0": self.y0,
            "R": R,
            "convention": "x=east, y=up, z=-north",
        }


def sample_dem_bilinear(dem: np.ndarray, transform, lat: float, lon: float) -> float:
    """Bilinear sample of DEM elevation at lat/lon (EPSG:4326)."""
    # rasterio: row/col from lon/lat via transform inverse
    # Affine: x = a*col + c, y = e*row + f  (lon, lat)
    inv = ~transform
    col_f, row_f = inv * (lon, lat)
    h, w = dem.shape
    if col_f < 0 or row_f < 0 or col_f >= w - 1 or row_f >= h - 1:
        # nearest clamp
        c = int(np.clip(round(col_f), 0, w - 1))
        r = int(np.clip(round(row_f), 0, h - 1))
        return float(dem[r, c])

    c0 = int(math.floor(col_f))
    r0 = int(math.floor(row_f))
    dc = col_f - c0
    dr = row_f - r0
    v00 = float(dem[r0, c0])
    v10 = float(dem[r0, c0 + 1])
    v01 = float(dem[r0 + 1, c0])
    v11 = float(dem[r0 + 1, c0 + 1])
    v0 = v00 * (1 - dc) + v10 * dc
    v1 = v01 * (1 - dc) + v11 * dc
    return v0 * (1 - dr) + v1 * dr


def point_to_polyline_dist(px: float, pz: float, poly: np.ndarray):
    """Min distance from point (px,pz) to polyline segments. poly: (N,2) as x,z."""
    best = np.inf
    best_i = 0
    best_t_along = 0.0
    # cumulative lengths for t
    seg_len = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg_len)])
    total = cum[-1] if cum[-1] > 0 else 1.0

    for i in range(len(poly) - 1):
        ax, az = poly[i]
        bx, bz = poly[i + 1]
        abx, abz = bx - ax, bz - az
        ab2 = abx * abx + abz * abz
        if ab2 < 1e-12:
            d = math.hypot(px - ax, pz - az)
            t_seg = 0.0
        else:
            t_seg = ((px - ax) * abx + (pz - az) * abz) / ab2
            t_seg = max(0.0, min(1.0, t_seg))
            qx = ax + t_seg * abx
            qz = az + t_seg * abz
            d = math.hypot(px - qx, pz - qz)
        if d < best:
            best = d
            best_i = i
            best_t_along = (cum[i] + t_seg * seg_len[i]) / total
    return best, best_i, best_t_along


def heading_at_index(poly_xz: np.ndarray, i: int) -> float:
    """Heading degrees: 0 = +Z? We want degrees from +Z (north=-z so north is 180 in atan2(x,-z)?) 
    Three.js: heading as atan2(dx, -dz) so 0° = north (-z), 90° = east (+x).
    """
    i0 = max(0, min(i, len(poly_xz) - 2))
    dx = poly_xz[i0 + 1, 0] - poly_xz[i0, 0]
    dz = poly_xz[i0 + 1, 1] - poly_xz[i0, 1]
    # north = -z → angle from north clockwise or CCW: atan2(east, north) = atan2(dx, -dz)
    deg = math.degrees(math.atan2(dx, -dz))
    return deg


def in_gap_utc(t: datetime) -> bool:
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    t = t.astimezone(timezone.utc)
    minutes = t.hour * 60 + t.minute + t.second / 60.0
    a = GAP_UTC_START[0] * 60 + GAP_UTC_START[1]
    b = GAP_UTC_END[0] * 60 + GAP_UTC_END[1]
    return a <= minutes <= b


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    gpx = parse_gpx_track(GPX_PATH)
    timeline = json.loads(TIMELINE_PATH.read_text())
    media_src = timeline["media"]

    lat0, lon0 = gpx[0]["lat"], gpx[0]["lon"]

    with rasterio.open(DEM_PATH) as ds:
        # Crop window: track bbox + margin in degrees
        lats = np.array([p["lat"] for p in gpx])
        lons = np.array([p["lon"] for p in gpx])
        dlat = BBOX_MARGIN_M / R * (180.0 / math.pi)
        dlon = BBOX_MARGIN_M / (R * math.cos(math.radians(lat0))) * (180.0 / math.pi)
        west, east = float(lons.min()) - dlon, float(lons.max()) + dlon
        south, north = float(lats.min()) - dlat, float(lats.max()) + dlat

        from rasterio.windows import from_bounds

        window = from_bounds(west, south, east, north, ds.transform)
        dem = ds.read(1, window=window).astype(np.float64)
        transform = ds.window_transform(window)
        nodata = ds.nodata
        if nodata is not None:
            dem = np.where(dem == nodata, np.nan, dem)
        # fill nan with local mean if any
        if np.isnan(dem).any():
            dem = np.where(np.isnan(dem), np.nanmedian(dem), dem)

        y0 = sample_dem_bilinear(dem, transform, lat0, lon0)
        frame = LocalFrame(lat0, lon0, y0)

        def elev_at(lat, lon):
            return sample_dem_bilinear(dem, transform, lat, lon)

        # Track in local coords (y = DEM + lift)
        track_xyz = []
        track_xz = []
        track_times = []
        for p in gpx:
            e = elev_at(p["lat"], p["lon"])
            x, y, z = frame.to_xyz(p["lat"], p["lon"], e + TRACK_LIFT_M)
            track_xyz.append([x, y, z])
            track_xz.append([x, z])
            track_times.append(p["time"])
        track_xyz = np.array(track_xyz, dtype=np.float64)
        track_xz = np.array(track_xz, dtype=np.float64)

        # Grid points with jitter inside corridor
        xs = track_xz[:, 0]
        zs = track_xz[:, 1]
        pad = CORRIDOR_HALF_WIDTH_M + GRID_STEP_M
        xmin, xmax = xs.min() - pad, xs.max() + pad
        zmin, zmax = zs.min() - pad, zs.max() + pad

        gx = np.arange(xmin, xmax + GRID_STEP_M, GRID_STEP_M)
        gz = np.arange(zmin, zmax + GRID_STEP_M, GRID_STEP_M)
        grid = []
        jitter = 0.4 * GRID_STEP_M
        for x in gx:
            for z in gz:
                jx = float(x + rng.uniform(-jitter, jitter))
                jz = float(z + rng.uniform(-jitter, jitter))
                d, _, _ = point_to_polyline_dist(jx, jz, track_xz)
                if d <= CORRIDOR_HALF_WIDTH_M:
                    grid.append((jx, jz))

        # Include track samples every ~GRID_STEP_M (full track stays in output separately)
        acc = 0.0
        grid.append((float(track_xz[0, 0]), float(track_xz[0, 1])))
        for i in range(1, len(track_xz)):
            acc += float(np.linalg.norm(track_xz[i] - track_xz[i - 1]))
            if acc >= GRID_STEP_M:
                grid.append((float(track_xz[i, 0]), float(track_xz[i, 1])))
                acc = 0.0
        grid.append((float(track_xz[-1, 0]), float(track_xz[-1, 1])))

        # Unique-ish
        pts2 = np.unique(np.round(np.array(grid, dtype=np.float64), 3), axis=0)

        # Sample elevation: convert x,z back to lat/lon
        def xz_to_latlon(x, z):
            lat = frame.lat0 - (z / R) * (180.0 / math.pi)  # z = -R*dlat_rad → dlat_rad = -z/R
            lon = frame.lon0 + (x / (R * frame.cos_lat0)) * (180.0 / math.pi)
            return lat, lon

        elevs = np.empty(len(pts2), dtype=np.float64)
        for i, (x, z) in enumerate(pts2):
            lat, lon = xz_to_latlon(x, z)
            elevs[i] = elev_at(lat, lon)

        ys = elevs - frame.y0

        # Delaunay on x/z
        delaunay = Delaunay(pts2)
        tris = []
        for sim in delaunay.simplices:
            a, b, c = pts2[sim]
            # edge lengths
            e1 = np.linalg.norm(a - b)
            e2 = np.linalg.norm(b - c)
            e3 = np.linalg.norm(c - a)
            if max(e1, e2, e3) > MAX_EDGE_M:
                continue
            cx = (a[0] + b[0] + c[0]) / 3.0
            cz = (a[1] + b[1] + c[1]) / 3.0
            d, _, _ = point_to_polyline_dist(cx, cz, track_xz)
            if d > CORRIDOR_HALF_WIDTH_M:
                continue
            tris.append(sim)

        tris = np.array(tris, dtype=np.int32)
        if len(tris) == 0:
            raise RuntimeError("No triangles kept — check corridor / DEM")

        # Media positions for density + output
        media_out = []
        media_xz = []
        for m in media_src:
            if m.get("lat") is None or m.get("lon") is None:
                continue
            e_ground = elev_at(m["lat"], m["lon"])
            x, y_ground, z = frame.to_xyz(m["lat"], m["lon"], e_ground)
            d, idx, _ = point_to_polyline_dist(x, z, track_xz)
            heading = heading_at_index(track_xz, idx)
            media_out.append(
                {
                    "id": m["id"],
                    "kind": m["kind"],
                    "thumb": m.get("thumb") or m.get("src"),
                    "x": round(x, 3),
                    "y_ground": round(y_ground, 3),
                    "z": round(z, 3),
                    "heading_deg": round(heading, 2),
                    "timeLocal": m.get("timeLocal"),
                    "ele_gps": m.get("ele"),
                }
            )
            media_xz.append((x, z))
        media_xz = np.array(media_xz, dtype=np.float64) if media_xz else np.zeros((0, 2))

        # Build non-indexed positions; triAttr = one value per triangle (expand in Passo 2)
        positions = []
        attr_dist = []
        attr_t = []
        attr_photo = []
        attr_gap = []
        attr_seed = []

        raw_densities = []
        tri_meta = []
        for sim in tris:
            ia, ib, ic = sim
            cx = (pts2[ia, 0] + pts2[ib, 0] + pts2[ic, 0]) / 3.0
            cz = (pts2[ia, 1] + pts2[ib, 1] + pts2[ic, 1]) / 3.0
            dist, idx, t_along = point_to_polyline_dist(cx, cz, track_xz)
            if len(media_xz):
                dd = np.hypot(media_xz[:, 0] - cx, media_xz[:, 1] - cz)
                n_photos = int(np.sum(dd <= PHOTO_DENSITY_RADIUS_M))
            else:
                n_photos = 0
            gap = 1.0 if in_gap_utc(track_times[idx]) else 0.0
            seed = float(rng.random())
            raw_densities.append(n_photos)
            tri_meta.append((sim, dist, t_along, n_photos, gap, seed))

        max_photos = max(raw_densities) if raw_densities else 1
        max_photos = max(max_photos, 1)

        for (sim, dist, t_along, n_photos, gap, seed), n_raw in zip(tri_meta, raw_densities):
            photo_n = n_raw / max_photos
            for vi in sim:
                positions.extend(
                    [
                        round(float(pts2[vi, 0]), 2),
                        round(float(ys[vi]), 2),
                        round(float(pts2[vi, 1]), 2),
                    ]
                )
            attr_dist.append(round(float(dist), 2))
            attr_t.append(round(float(t_along), 4))
            attr_photo.append(round(float(photo_n), 3))
            attr_gap.append(float(gap))
            attr_seed.append(round(float(seed), 4))

        n_tri = len(tris)
        n_vert = n_tri * 3

        payload = {
            "origin": frame.as_dict(),
            "params": {
                "CORRIDOR_HALF_WIDTH_M": CORRIDOR_HALF_WIDTH_M,
                "GRID_STEP_M": GRID_STEP_M,
                "SEED": SEED,
                "BBOX_MARGIN_M": BBOX_MARGIN_M,
                "MAX_EDGE_M": MAX_EDGE_M,
                "PHOTO_DENSITY_RADIUS_M": PHOTO_DENSITY_RADIUS_M,
                "TRACK_LIFT_M": TRACK_LIFT_M,
                "photoDensityMax": int(max_photos),
                "triAttrPerTriangle": True,
            },
            "positions": positions,
            "triAttr": {
                "dist": attr_dist,
                "t": attr_t,
                "photoDensity": attr_photo,
                "gap": attr_gap,
                "seed": attr_seed,
            },
            "track": [[round(float(v), 2) for v in row] for row in track_xyz],
            "media": media_out,
        }

        OUT_JSON.write_text(json.dumps(payload, separators=(",", ":")))
        json_bytes = OUT_JSON.stat().st_size

        # Preview: top-down, north-up, triangles colored by elevation
        elev_face = np.array([(ys[a] + ys[b] + ys[c]) / 3.0 for a, b, c in tris])
        fig, ax = plt.subplots(figsize=(10, 10), dpi=140)
        tpc = ax.tripcolor(
            pts2[:, 0],
            -pts2[:, 1],
            tris,
            facecolors=elev_face,
            cmap="terrain",
            edgecolors="0.55",
            linewidth=0.15,
        )
        ax.plot(track_xz[:, 0], -track_xz[:, 1], color="#111111", lw=1.4)
        if len(media_xz):
            ax.scatter(media_xz[:, 0], -media_xz[:, 1], s=8, c="#c0392b", zorder=5, linewidths=0)
        ax.set_aspect("equal")
        ax.set_xlabel("x east (m)")
        ax.set_ylabel("north (m)")
        ax.set_title("Peak Prompt terrain — top-down (DEM elev, corridor)")
        cb = fig.colorbar(tpc, ax=ax, fraction=0.035, pad=0.02)
        cb.set_label("y relative to origin DEM (m)")
        fig.tight_layout()
        fig.savefig(OUT_PREVIEW)
        plt.close(fig)

        y_all = ys[tris.ravel()]
        print("--- Passo 1 stats ---")
        print(f"triangles: {n_tri}")
        print(f"vertices (non-indexed): {n_vert}")
        print(f"JSON bytes: {json_bytes} ({json_bytes / 1024:.1f} KB)")
        print(f"elev y range (m, relative): {float(y_all.min()):.1f} … {float(y_all.max()):.1f}")
        print(f"DEM absolute at origin y0: {y0:.1f} m")
        print(f"DEM absolute terrain: {float(elevs.min()):.1f} … {float(elevs.max()):.1f} m")
        print(f"track points: {len(track_xyz)}")
        print(f"media placed: {len(media_out)}")
        print(f"grid samples kept: {len(pts2)}")
        print(f"wrote {OUT_JSON.relative_to(ROOT)}")
        print(f"wrote {OUT_PREVIEW.relative_to(ROOT)}")
        if not (1500 <= n_tri <= 6000):
            print(f"WARNING: triangle count {n_tri} outside target 1500–6000", file=sys.stderr)
        if json_bytes >= 1_000_000:
            print(f"WARNING: JSON >= 1 MB", file=sys.stderr)


if __name__ == "__main__":
    main()
