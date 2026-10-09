/**
 * Peak Prompt 3D — overview (volumetric) + first-person explore along Wikiloc.
 * Explore: far photos as exploded point-cloud mist → reform into solid as you approach → grow out.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const DEG = Math.PI / 180;
const EARTH_R = 6378137;
const EYE_H = 1.65;
const PHOTO_H = 3.6; // smaller so cards don't fill the viewport
// Spacing along explore path (proportions kept).
const PATH_COMPRESS = 0.62;
// Lead-in before the first photo so the opening shot shows cards ahead
const START_LEAD_M = 40;
const START_AHEAD_M = 32;
// Point-cloud density: long side of pc maps (scripts/build_pointcloud_maps.py).
// Aspect preserved; ~10% less than prior 360 long-side.
const CLOUD_LONG_SIDE = 324;
const MAX_ACTIVE_CLOUDS = 12;
const SHOW_AHEAD_M = 120;
const MAX_VISIBLE_CARDS = 22;
// Soft white fog — cards ease in from the distance
const FOG_NEAR_M = 32;
const FOG_FAR_M = 110;
// Far = fully exploded mist; approaches 0 as the photo reforms
const DISP_MAX = PHOTO_H * 2.375; // ~8.55 m (−5% from 2.5) — Z uses (lum - 0.4)
// Reform target (limiting side vs viewport) — solid reads clearly around here
const REFORM_SCREEN_FRAC = 0.38;
// Formed-image opacity: fade in → hold at 100% → linear dissolve (original pace).
const EXIT_FADE_IN_START = REFORM_SCREEN_FRAC - 0.34; // crossfade with collapsing cloud
const EXIT_HOLD_SPAN = 0.22; // extra coverFrac at full opacity after reform
const EXIT_DISSOLVE_SPAN = 0.75; // same length as the original exit, linear
const EXPLORE_FOV_DEG = 62;
// Far clouds are oversized mist; they shrink to the photo footprint as they reform
const CLOUD_FAR_SCALE = 4.5;
const CLOUD_NEAR_SCALE = 1;
const CLOUD_FAR_SPREAD = 1.45;
// Min explore gap between consecutive media (timeline padding — not path-based)
const MIN_EXPLORE_GAP_M = 10;
// A detached media (data detachM) keeps a longer explore gap before it
const DETACH_EXPLORE_GAP_M = 25;
// Light GPS denoise only — keep real bends, just kill harsh spikes
const PATH_SMOOTH_PASSES = 1;
const PATH_SMOOTH_RADIUS = 2;
// Autoplay-only path: heavy smooth + resample (manual scroll keeps explore curve)
const AUTOPLAY_SMOOTH_PASSES = 6;
const AUTOPLAY_SMOOTH_RADIUS = 12;
const AUTOPLAY_RESAMPLE_N = 160;
const AUTOPLAY_LUT_N = 720;
const AUTOPLAY_MAX_CLOUDS = 6;
// Overview volumetric mass
const OVERVIEW_SPREAD = 1.15; // +15% spacing between images
const OVERVIEW_CLOUD_SCALE = 9.5;
// Sparse grid — all media visible at once. 96 (was 80) → +44% points
const OVERVIEW_CLOUD_LONG = 96;
const OVERVIEW_DISP_MUL = 2; // +100% displacement vs base exploded mist
// Light live drift — scaled with overview cloud size (explore uses ~0.055 m)
const OVERVIEW_WIGGLE_M = 0.32;
const POINT_MUL = 2.5;
const DEFAULT_ACCEL = [0, -1, 0]; // upright portrait fallback
// Covered snow cannons photographed along the trail (user-confirmed)
const SPUTANEVE_IDS = [
  "IMG_6877",
  "IMG_6885",
  "IMG_6887",
  "IMG_6897",
  "IMG_6906",
  "IMG_6911",
  "IMG_6922",
  "IMG_6934",
  "IMG_6987",
  "IMG_7067",
];

function projectFactory(track) {
  const lats = track.map((p) => p.lat);
  const lons = track.map((p) => p.lon);
  const eles = track.map((p) => p.ele).filter((e) => e != null);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
  const ele0 = Math.min(...eles);
  const cosLat = Math.cos(lat0 * DEG);

  function toVec3(lat, lon, ele) {
    const x = (lon - lon0) * DEG * EARTH_R * cosLat;
    const z = -((lat - lat0) * DEG * EARTH_R);
    const y = (ele ?? ele0) - ele0;
    return new THREE.Vector3(x, y, z);
  }
  return { toVec3, ele0 };
}

function buildPath(track, toVec3) {
  const pts = track
    .filter((p) => p.ele != null && p.time)
    .map((p) => ({
      t: Date.parse(p.time),
      pos: toVec3(p.lat, p.lon, p.ele),
    }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + pts[i].pos.distanceTo(pts[i - 1].pos));
  }
  const total = cum[cum.length - 1] || 1;

  function atDistance(d) {
    const dist = THREE.MathUtils.clamp(d, 0, total);
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= dist) lo = mid;
      else hi = mid;
    }
    const span = Math.max(1e-6, cum[hi] - cum[lo]);
    const u = (dist - cum[lo]) / span;
    const pos = pts[lo].pos.clone().lerp(pts[hi].pos, u);
    let tangent;
    if (hi < pts.length - 1 && u > 0.5) {
      tangent = pts[Math.min(hi + 1, pts.length - 1)].pos.clone().sub(pts[hi].pos);
    } else {
      tangent = pts[hi].pos.clone().sub(pts[lo].pos);
    }
    if (tangent.lengthSq() < 1e-8) tangent.set(0, 0, -1);
    tangent.normalize();
    return { pos, tangent, dist };
  }

  function distanceAtTime(iso) {
    const t = Date.parse(iso);
    if (t <= pts[0].t) return 0;
    if (t >= pts[pts.length - 1].t) return total;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const u = (t - pts[lo].t) / Math.max(1, pts[hi].t - pts[lo].t);
    return cum[lo] + (cum[hi] - cum[lo]) * u;
  }

  // Overall hike pace (m/s) — autoplay uses this constant rate (not GPS spikes)
  const durationSec = Math.max(1, (pts[pts.length - 1].t - pts[0].t) / 1000);
  const avgSpeed = THREE.MathUtils.clamp(total / durationSec, 0.15, 1.6);

  return { pts, cum, total, atDistance, distanceAtTime, avgSpeed };
}

/** Light moving-average denoise for explore POV — preserves path shape */
function smoothPathPoints(pathPts, passes, radius) {
  let pts = pathPts.map((p) => (p.pos ? p.pos.clone() : p.clone()));
  for (let pass = 0; pass < passes; pass++) {
    const next = pts.map((p) => p.clone());
    for (let i = 0; i < pts.length; i++) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      let wsum = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = THREE.MathUtils.clamp(i + k, 0, pts.length - 1);
        const w = radius + 1 - Math.abs(k);
        ax += pts[j].x * w;
        ay += pts[j].y * w;
        az += pts[j].z * w;
        wsum += w;
      }
      next[i].set(ax / wsum, ay / wsum, az / wsum);
    }
    pts = next;
  }
  return pts;
}

function resamplePolyline(pts, count) {
  if (pts.length < 2) return pts.map((p) => p.clone());
  const seg = [0];
  for (let i = 1; i < pts.length; i++) {
    seg.push(seg[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  const total = seg[seg.length - 1] || 1;
  const out = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const d = (i / Math.max(1, count - 1)) * total;
    while (j < seg.length - 2 && seg[j + 1] < d) j++;
    const span = Math.max(1e-6, seg[j + 1] - seg[j]);
    const u = THREE.MathUtils.clamp((d - seg[j]) / span, 0, 1);
    out.push(pts[j].clone().lerp(pts[j + 1], u));
  }
  return out;
}

function buildExploreCurve(pathPts) {
  if (pathPts.length < 2) return null;
  const pts = smoothPathPoints(pathPts, PATH_SMOOTH_PASSES, PATH_SMOOTH_RADIUS);
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.15);
}

/** Ultra-smooth ribbon used only while autoplay is running */
function buildAutoplayCurve(pathPts) {
  if (pathPts.length < 2) return null;
  const smoothed = smoothPathPoints(pathPts, AUTOPLAY_SMOOTH_PASSES, AUTOPLAY_SMOOTH_RADIUS);
  const pts = resamplePolyline(smoothed, AUTOPLAY_RESAMPLE_N);
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.05);
}

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** Orient a capture from Apple AccelerationVector (device gravity) + preferred look. */
function quatFromAccel(accel, lookDir, out = new THREE.Quaternion()) {
  const g = new THREE.Vector3(
    Number(accel?.[0]) || 0,
    Number(accel?.[1]) || 0,
    Number(accel?.[2]) || 0
  );
  if (g.lengthSq() < 1e-8) g.set(0, -1, 0);
  else g.normalize();

  const worldDown = new THREE.Vector3(0, -1, 0);
  out.setFromUnitVectors(g, worldDown);

  // Twist around gravity so camera look (−Z device) matches lookDir azimuth
  const lookNow = new THREE.Vector3(0, 0, -1).applyQuaternion(out);
  const a = lookNow.clone();
  a.y = 0;
  const b = lookDir.clone();
  b.y = 0;
  if (a.lengthSq() > 1e-8 && b.lengthSq() > 1e-8) {
    a.normalize();
    b.normalize();
    const twist = new THREE.Quaternion().setFromUnitVectors(a, b);
    out.premultiply(twist);
  }
  return out;
}

function configureTexture(tex, forCloud) {
  if (forCloud) {
    // Display-referred for custom Points shader (avoid HW sRGB decode)
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
  } else {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
  }
  return tex;
}

// Images are decoded off the main thread (createImageBitmap), so a photo that
// forms in explore never stalls a frame on a synchronous AVIF decode at upload.
// Pixel-identical to TextureLoader: three r170 uploads 8-bit textures with no
// colour conversion, so bitmaps are decoded with colorSpaceConversion "none",
// and flipped at decode time (UNPACK_FLIP_Y is ignored for ImageBitmap).
const BITMAP_OPTIONS = {
  imageOrientation: "flipY",
  premultiplyAlpha: "none",
  colorSpaceConversion: "none",
};
// 1×2 PNG — red on top, blue below. Must come back flipped (blue on top).
const FLIP_PROBE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAIAAAAW4yFwAAAAEElEQVR42mP4z8DAwMDwHwAIAAH/72AS3AAAAABJRU5ErkJggg==";
let bitmapSupport = null;
function canUseBitmaps() {
  bitmapSupport ??= (async () => {
    if (typeof createImageBitmap !== "function" || typeof fetch !== "function") return false;
    const ua = navigator.userAgent;
    // Same gate as three's GLTFLoader: older Safari / Firefox mishandle the options
    if (/^((?!chrome|android).)*safari/i.test(ua)) {
      const v = ua.match(/Version\/(\d+)/);
      if (!v || Number(v[1]) < 17) return false;
    }
    const ff = ua.match(/Firefox\/(\d+)/);
    if (ff && Number(ff[1]) < 98) return false;
    try {
      const blob = await (await fetch(FLIP_PROBE_PNG)).blob();
      const bmp = await createImageBitmap(blob, BITMAP_OPTIONS);
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 2;
      const g = c.getContext("2d");
      g.drawImage(bmp, 0, 0);
      bmp.close?.();
      const top = g.getImageData(0, 0, 1, 1).data;
      return top[2] > 200 && top[0] < 60;
    } catch {
      return false;
    }
  })();
  return bitmapSupport;
}

function loadTextureClassic(url, loader, forCloud) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        configureTexture(tex, forCloud);
        tex.flipY = true; // same as MeshBasic plane
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
}

async function loadTexture(url, loader, { forCloud = false } = {}) {
  if (!url) return null;
  if (await canUseBitmaps()) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob(), BITMAP_OPTIONS);
      const tex = new THREE.Texture(bmp);
      tex.flipY = false; // already flipped by createImageBitmap
      configureTexture(tex, forCloud);
      tex.needsUpdate = true;
      return tex;
    } catch {
      // Format this browser can't bitmap-decode — fall back to <img>
    }
  }
  return loadTextureClassic(url, loader, forCloud);
}

function disposeTexture(tex, { closeImage = true } = {}) {
  if (!tex) return;
  tex.dispose();
  if (closeImage && typeof ImageBitmap !== "undefined" && tex.image instanceof ImageBitmap) {
    tex.image.close();
  }
}

function makeCloudGeometry(cols, rows) {
  const w = Math.max(1, cols | 0);
  const h = Math.max(1, rows | 0);
  const n = w * h;
  const uvs = new Float32Array(n * 2);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      uvs[i++] = (x + 0.5) / w;
      uvs[i++] = (y + 0.5) / h;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute("aUv", new THREE.BufferAttribute(uvs, 2));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 80);
  geo.userData.cloudW = w;
  geo.userData.cloudH = h;
  return geo;
}

function makeCloudMaterial(tex, aspect) {
  const w = PHOTO_H * aspect;
  const h = PHOTO_H;
  // uSize is world-space point diameter (meters).
  // uScale = viewportHeight/2 (Three.js sizeAttenuation convention).
  const spacing = PHOTO_H / CLOUD_LONG_SIDE;
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: tex },
      uDisp: { value: 0 },
      uSize: { value: spacing * 2.4 },
      uSpread: { value: 1 },
      uScale: { value: 400 },
      uPointMul: { value: 1 },
      uFogNear: { value: FOG_NEAR_M },
      uFogFar: { value: FOG_FAR_M },
      uFogColor: { value: new THREE.Color(0xffffff) },
      uPlane: { value: new THREE.Vector2(w, h) },
      uTime: { value: 0 },
      uWiggle: { value: 0 }, // meters — explore mist only
    },
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    fog: false, // custom distance fog in shader (Points skip scene.fog)
    vertexShader: /* glsl */ `
      attribute vec2 aUv;
      uniform sampler2D uColor;
      uniform float uDisp, uSize, uSpread, uScale, uPointMul;
      uniform float uFogNear, uFogFar;
      uniform float uTime, uWiggle;
      uniform vec2 uPlane;
      varying vec3 vColor;
      varying float vFog;

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        vec3 pos = vec3(
          (aUv.x - 0.5) * uPlane.x * uSpread,
          (aUv.y - 0.5) * uPlane.y * uSpread,
          0.0
        );
        vec3 color = texture2D(uColor, aUv).rgb;
        float lum = dot(color, vec3(0.299, 0.587, 0.114));
        // Depth explode (luminance, biased so midtones push forward)
        pos.z = (lum - 0.4) * uDisp;

        // Light lateral explode — stable per-point, organic mix of
        // outward push + swirl, tinted by color channels
        float n0 = hash21(aUv);
        float n1 = hash21(aUv + vec2(17.13, 9.27));
        float n2 = hash21(aUv + vec2(3.71, 28.53));
        vec2 fromC = aUv - 0.5;
        float r = length(fromC);
        vec2 radial = r > 1e-4 ? fromC / r : vec2(1.0, 0.0);
        float ang = n0 * 6.2831853;
        vec2 swirl = vec2(cos(ang), sin(ang));
        // Bias: warmer tones drift one way, cooler the other
        vec2 chroma = vec2(color.r - color.b, color.g - lum) * 1.4;
        vec2 latDir = normalize(radial * (0.55 + n1 * 0.7) + swirl * 0.65 + chroma * 0.35);
        float latAmp = uDisp * 0.01 * (0.4 + lum * 0.75 + n2 * 0.45);
        // Soften near image center so silhouette stays readable
        latAmp *= mix(0.55, 1.15, smoothstep(0.05, 0.55, r));
        pos.xy += latDir * latAmp;

        // Soft live wiggle — stronger while exploded, fades as the image reforms
        if (uWiggle > 1e-5) {
          float ph = n0 * 6.2831853;
          float ph2 = n1 * 6.2831853;
          float t = uTime;
          vec3 wig = vec3(
            sin(t * 1.55 + ph) * 0.55 + sin(t * 2.7 + ph2) * 0.35,
            cos(t * 1.75 + ph2) * 0.55 + sin(t * 2.2 + ph) * 0.35,
            sin(t * 2.05 + ph * 1.3) * 0.45
          );
          float live = mix(0.2, 1.0, clamp(uDisp / max(1e-3, uPlane.y * 1.2), 0.0, 1.0));
          pos += wig * uWiggle * live;
        }

        vColor = color;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = max(0.0, -mv.z);
        // Soft entrance: fully fogged at far, clear as the mist approaches
        vFog = smoothstep(uFogNear, uFogFar, depth);
        float attn = uScale / max(0.55, depth);
        gl_PointSize = clamp(uSize * attn * uPointMul, 1.0, 15.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform vec3 uFogColor;
      varying vec3 vColor;
      varying float vFog;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        if (dot(d, d) > 0.25) discard;
        vec3 col = mix(vColor, uFogColor, vFog);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function initPath3D({
  container,
  data,
  onSelect,
  onExploreAutoplayChange,
  onModeChange,
  onHoverItem,
  onExploreProgress,
  onTransitionChange,
  onTransitionFade,
  onPrepareExploreEnter, // (done) => … — e.g. scramble CTA out before a checkpoint jump
  onIntroProgress,
  onIntroComplete,
  onLoadProgress, // (0..1) share of the landing assets decoded
  beforeIntro, // async — e.g. the loading screen dissolves before the reveal
  checkpointIconSrc,
  initialMode = "overview",
}) {
  if (!container || !data?.track?.length) return null;

  let mode = initialMode === "explore" ? "explore" : "overview";
  const track = data.track.filter((p) => p.ele != null);
  const media = (data.media || [])
    .filter((m) => m.time && m.lat != null && m.lon != null && m.ele != null)
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time));

  const { toVec3, ele0: trailEle0 } = projectFactory(track);
  const path = buildPath(track, toVec3);

  // Explore: light denoise. Autoplay: separate ultra-smooth ribbon (+ LUT).
  const exploreCurve = buildExploreCurve(path.pts);
  const exploreCurveLen = exploreCurve?.getLength() || path.total;
  const autoplayCurve = buildAutoplayCurve(path.pts);
  const autoplayCurveLen = autoplayCurve?.getLength() || path.total;

  const _fA = new THREE.Vector3();
  const _fB = new THREE.Vector3();
  const _worldUp = new THREE.Vector3(0, 1, 0);
  const _delta = new THREE.Vector3();
  const _photoWorld = new THREE.Vector3();
  const _camWorld = new THREE.Vector3();
  const _eyePos = new THREE.Vector3();
  const _eyeTan = new THREE.Vector3();
  const _eyeSide = new THREE.Vector3();
  const _eyeUp = new THREE.Vector3();
  const _pPos = new THREE.Vector3();
  const _pTan = new THREE.Vector3();
  const _pSide = new THREE.Vector3();
  const _pUp = new THREE.Vector3();
  /** @param {"raw"|"explore"|"autoplay"} curveMode */
  function writeFrame(realDist, pos, tan, side, up, curveMode = "explore") {
    // Sample on-path, then extend past the GPX end along the final tangent so
    // padded explore slots near the summit don't all collapse onto one point.
    const overshoot = Math.max(0, realDist - path.total);
    const d = THREE.MathUtils.clamp(realDist, 0, path.total);
    const curve = curveMode === "autoplay" ? autoplayCurve : curveMode === "explore" ? exploreCurve : null;
    const curveLen = curveMode === "autoplay" ? autoplayCurveLen : curveMode === "explore" ? exploreCurveLen : 0;
    if (curve && curveLen > 1e-3) {
      const u = THREE.MathUtils.clamp(d / path.total, 0, 1);
      const span = Math.min(0.02, 12 / curveLen);
      const u0 = Math.max(0, u - span);
      const u1 = Math.min(1, u + span);
      curve.getPointAt(u, pos);
      curve.getPointAt(u0, _fA);
      curve.getPointAt(u1, _fB);
      tan.copy(_fB).sub(_fA);
      if (tan.lengthSq() < 1e-8) curve.getTangentAt(u, tan);
    } else {
      const sample = path.atDistance(d);
      pos.copy(sample.pos);
      tan.copy(sample.tangent);
    }
    if (tan.lengthSq() < 1e-8) tan.set(0, 0, -1);
    tan.normalize();
    if (overshoot > 0) pos.addScaledVector(tan, overshoot);
    side.crossVectors(tan, _worldUp);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    up.crossVectors(side, tan).normalize();
  }

  function captureFrame(realDist, curveMode) {
    writeFrame(realDist, _pPos, _pTan, _pSide, _pUp, curveMode);
    return {
      pos: _pPos.clone(),
      tan: _pTan.clone(),
      side: _pSide.clone(),
      up: _pUp.clone(),
    };
  }

  function applyCapturedFrame(frame, pos, tan, side, up) {
    pos.copy(frame.pos);
    tan.copy(frame.tan);
    side.copy(frame.side);
    up.copy(frame.up);
  }

  // Autoplay camera LUT — O(1) lerp, no CatmullRom in the hot loop
  const autoplayLut = [];
  {
    const n = AUTOPLAY_LUT_N;
    for (let i = 0; i < n; i++) {
      const realDist = (i / Math.max(1, n - 1)) * path.total;
      autoplayLut.push(captureFrame(realDist, "autoplay"));
    }
  }
  function sampleAutoplayLut(realDist, pos, tan, side, up) {
    const overshoot = Math.max(0, realDist - path.total);
    const d = THREE.MathUtils.clamp(realDist, 0, path.total);
    const u = (d / Math.max(1e-6, path.total)) * (autoplayLut.length - 1);
    const i = Math.min(autoplayLut.length - 2, Math.max(0, u | 0));
    const f = u - i;
    const a = autoplayLut[i];
    const b = autoplayLut[i + 1];
    pos.lerpVectors(a.pos, b.pos, f);
    tan.lerpVectors(a.tan, b.tan, f);
    if (tan.lengthSq() < 1e-8) tan.copy(a.tan);
    tan.normalize();
    side.lerpVectors(a.side, b.side, f);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    up.crossVectors(side, tan).normalize();
    if (overshoot > 0) pos.addScaledVector(tan, overshoot);
  }

  function exploreToReal(exploreDist) {
    // Lead-in sits before path start; then map compressed explore → real meters
    return Math.max(0, exploreDist - START_LEAD_M) / PATH_COMPRESS;
  }

  // Place each media at time-accurate path distance, offset off-center
  const placements = media.map((item, index) => {
    // detachM (data): place this media past its time position — the closing
    // photo comes after a longer explore gap (DETACH_EXPLORE_GAP_M)
    const detach = Math.max(0, Number(item.detachM) || 0);
    const timeDist = path.distanceAtTime(item.time);
    const realDist = timeDist + detach;
    const naturalDist = realDist * PATH_COMPRESS + START_LEAD_M;
    writeFrame(realDist, _pPos, _pTan, _pSide, _pUp, "raw");
    const h1 = hash01(item.id + ":side");
    const h2 = hash01(item.id + ":mag");
    const lateral = (h1 < 0.5 ? -1 : 1) * (1.4 + h2 * 4.2); // 1.4–5.6 m off path
    const yawJitter = (hash01(item.id + ":yaw") - 0.5) * 0.4;
    const world = _pPos
      .clone()
      .addScaledVector(_pSide, lateral)
      .add(new THREE.Vector3(0, EYE_H * 0.85, 0));
    return { item, index, dist: naturalDist, naturalDist, realDist, world, lateral, yawJitter };
  });

  // Enforce min explore gap so clustered shots each get a full animation window
  {
    let cursor = -Infinity;
    for (const p of placements) {
      const gap = Number(p.item.detachM) > 0 ? DETACH_EXPLORE_GAP_M : MIN_EXPLORE_GAP_M;
      const padded = Math.max(p.naturalDist, cursor + gap);
      p.dist = padded;
      cursor = padded;
    }
  }

  // Precompute photo frames (fixed along path) — avoids CatmullRom every layout tick
  for (const p of placements) {
    const realForSlot = exploreToReal(p.dist);
    p.exploreFrame = captureFrame(realForSlot, "explore");
    p.autoplayFrame = captureFrame(realForSlot, "autoplay");
  }

  const lastPlacementDist = placements[placements.length - 1]?.dist ?? 0;

  // —— Walk stats (explore HUD): altitude, elapsed time, distance covered ——
  // The walk maps onto the GPS trail through the photos themselves (each photo
  // slot ↔ its real position/time on the track), so the numbers always agree
  // with the image on screen. Distance is horizontal, like Wikiloc reports it.
  const trailCum2D = [0];
  for (let i = 1; i < path.pts.length; i++) {
    const a = path.pts[i - 1].pos;
    const b = path.pts[i].pos;
    trailCum2D.push(trailCum2D[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const _walkStats = { altitudeM: 0, elapsedS: 0, distanceM: 0 };
  let statKnots = null; // [walk, realDist] — built once the trail length is final
  function buildStatKnots() {
    const k = [[0, 0], [START_LEAD_M, 0]];
    for (const p of placements) {
      if (p.item.extra) continue; // detached closing photo isn't on the trail
      const real = Math.min(path.total, path.distanceAtTime(p.item.time));
      const last = k[k.length - 1];
      if (p.dist > last[0]) k.push([p.dist, Math.max(real, last[1])]);
    }
    const last = k[k.length - 1];
    k.push([Math.max(exploreTotal, last[0] + 1e-3), path.total]);
    return k;
  }
  function walkStats(walk) {
    statKnots ??= buildStatKnots();
    const k = statKnots;
    let real;
    if (walk <= k[0][0]) real = k[0][1];
    else if (walk >= k[k.length - 1][0]) real = k[k.length - 1][1];
    else {
      let lo = 0;
      let hi = k.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (k[mid][0] <= walk) lo = mid;
        else hi = mid;
      }
      const u = (walk - k[lo][0]) / Math.max(1e-6, k[hi][0] - k[lo][0]);
      real = k[lo][1] + (k[hi][1] - k[lo][1]) * u;
    }
    // real (3D metres along the track) → track segment
    const cum = path.cum;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= real) lo = mid;
      else hi = mid;
    }
    const u = THREE.MathUtils.clamp((real - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]), 0, 1);
    const a = path.pts[lo];
    const b = path.pts[hi];
    _walkStats.altitudeM = trailEle0 + a.pos.y + (b.pos.y - a.pos.y) * u;
    _walkStats.elapsedS = (a.t + (b.t - a.t) * u - path.pts[0].t) / 1000;
    _walkStats.distanceM = trailCum2D[lo] + (trailCum2D[hi] - trailCum2D[lo]) * u;
    return _walkStats;
  }
  // "extra" media (data) don't count: the closing photo reads 185/184
  const countedTotal = placements.filter((p) => !p.item.extra).length;
  const exploreTotal = Math.max(
    path.total * PATH_COMPRESS + START_LEAD_M,
    lastPlacementDist + START_AHEAD_M + 8
  );
  // Closing line: right after the walker passes the last photo (half the
  // original scroll, tuned on site — independent of the gap before it)
  const OUTRO_AFTER_LAST_M = 0.4;
  const outroRevealDist = lastPlacementDist + OUTRO_AFTER_LAST_M;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(55, 1, 0.15, 6000);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    // logarithmicDepthBuffer breaks Points / gl_PointSize — keep off for the cloud
  });
  let nightMode = false;
  const fadeEl = document.createElement("div");
  fadeEl.setAttribute("aria-hidden", "true");
  fadeEl.style.cssText =
    "position:absolute;inset:0;pointer-events:none;opacity:0;z-index:2;background:#fff;";
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  function applyBackground() {
    const hex = nightMode ? "#000000" : "#ffffff";
    const clear = nightMode ? 0x000000 : 0xffffff;
    renderer.setClearColor(clear, 0);
    renderer.domElement.style.background = hex;
    container.style.background = hex;
    fadeEl.style.background = hex;
  }
  renderer.setClearColor(0xffffff, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.sortObjects = true;
  container.appendChild(renderer.domElement);
  container.appendChild(fadeEl);
  applyBackground();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  // Keep orbiting after drag / click — only explore mode disables autoRotate

  // Explore rig: fixed camera looking -Z; images move toward the viewer
  const exploreRoot = new THREE.Group();
  exploreRoot.visible = false;
  scene.add(exploreRoot);

  const loader = new THREE.TextureLoader();
  const cloudFogFar = Math.min(FOG_FAR_M, SHOW_AHEAD_M * 0.95);
  const cloudGeoCache = new Map(); // `${cols}x${rows}` → geometry
  function cloudGeoFor(cols, rows) {
    const w = Math.max(1, cols | 0);
    const h = Math.max(1, rows | 0);
    const key = `${w}x${h}`;
    let g = cloudGeoCache.get(key);
    if (!g) {
      g = makeCloudGeometry(w, h);
      cloudGeoCache.set(key, g);
    }
    return g;
  }
  // Placeholder so the shader always has a valid sampler
  const placeholderTex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    THREE.RGBAFormat
  );
  placeholderTex.needsUpdate = true;
  // Explore planes always carry a map, so swapping photo ↔ fallback never
  // changes the shader program. Never shown: a fallback is set before display.
  const placeholderHiTex = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    THREE.RGBAFormat
  );
  placeholderHiTex.colorSpace = THREE.SRGBColorSpace;
  placeholderHiTex.needsUpdate = true;
  // Pool of clouds — several photos can dissolve together
  const EXPLORE_WIGGLE_M = 0.055; // subtle point drift while mist is alive
  const cloudPool = Array.from({ length: MAX_ACTIVE_CLOUDS }, (_, i) => {
    const mat = makeCloudMaterial(placeholderTex, 1);
    mat.uniforms.uScale.value = (container.clientHeight || 800) * 0.5;
    mat.uniforms.uPointMul.value = POINT_MUL;
    mat.uniforms.uWiggle.value = EXPLORE_WIGGLE_M;
    const pts = new THREE.Points(cloudGeoFor(CLOUD_LONG_SIDE, CLOUD_LONG_SIDE), mat);
    pts.visible = false;
    pts.frustumCulled = false;
    pts.renderOrder = 40 + i;
    exploreRoot.add(pts);
    return { pts, mat };
  });

  function applyCloudSlot(slot, node, { disp, spread, scale, planeW, planeH, ahead }) {
    const { pts, mat } = slot;
    const cols = node.cloudW || CLOUD_LONG_SIDE;
    const rows = node.cloudH || CLOUD_LONG_SIDE;
    pts.geometry = cloudGeoFor(cols, rows);
    pts.visible = true;
    pts.position.copy(node.group.position);
    pts.rotation.copy(node.group.rotation);
    pts.scale.setScalar(1);
    mat.uniforms.uColor.value = node.dissolveTex;
    const s = Math.max(0.2, scale);
    const w = planeW * s;
    const h = planeH * s;
    mat.uniforms.uPlane.value.set(w, h);
    mat.uniforms.uDisp.value = disp * s;
    const spacing = h / Math.max(1, rows);
    const t = THREE.MathUtils.clamp(disp / Math.max(1e-3, DISP_MAX), 0, 1);
    mat.uniforms.uSize.value = spacing * (2.1 + t * 0.55);
    mat.uniforms.uSpread.value = spread;
    mat.uniforms.uFogFar.value = cloudFogFar;
    let fogNear = FOG_NEAR_M;
    // Extra wash when just entering the visible ahead window
    if (ahead != null && ahead > FOG_NEAR_M) {
      const enter = THREE.MathUtils.clamp(
        (ahead - FOG_NEAR_M) / Math.max(1, cloudFogFar - FOG_NEAR_M),
        0,
        1
      );
      fogNear = THREE.MathUtils.lerp(FOG_NEAR_M, FOG_NEAR_M * 0.35, enter);
    }
    mat.uniforms.uFogNear.value = fogNear;
    mat.uniformsNeedUpdate = true;
  }

  const overviewBillboards = []; // invisible pick planes
  const overviewNodes = []; // { group, pick }
  const overviewCloudMats = []; // for live wiggle time updates
  const exploreNodes = [];
  const videoNodes = []; // explore nodes that carry a video
  const planeGeoCache = new Map(); // aspect key → geometry
  const _ovLook = new THREE.Vector3();
  const _ovQuat = new THREE.Quaternion();

  let walkDist = 0;
  // Smoothed wheel: steps move this target, walkDist eases toward it per frame
  let scrollTarget = null;
  const SCROLL_EASE_S = 0.12;
  // Scrolling back, a photo re-enters from behind the camera: its reverse
  // dissolve may un-dissolve at most this fast (full re-entry ≈ 1.1 s), so it
  // no longer pops in within one wheel notch. Forward motion is untouched.
  const REENTRY_S = 1.1;
  let snapReentry = true; // jumps / mode changes: no re-entry animation
  let lastLayoutMs = 0;
  /** Any walk change that isn't a wheel scroll: stop easing, no re-entry lag */
  function resetWalkMotion() {
    scrollTarget = null;
    snapReentry = true;
  }
  let camTransition = null; // overview → explore fly-in state
  let landingIntro = null; // base→peak reveal on first load
  // Keep white veil + hide overview until the landing intro actually starts
  // (prevents a one-frame flash of the full model after textures load)
  let pendingLandingIntro = mode === "overview";
  let exploreAutoplay = false;
  let autoplayLastMs = 0;
  // Soft follow of a linear target — avoids wall-clock catch-up jumps on heavy frames
  let autoplayTargetWalk = 0;
  let autoplayOriginMs = 0;
  let autoplayOriginWalk = 0;

  function reanchorAutoplay() {
    autoplayOriginMs = performance.now();
    autoplayOriginWalk = walkDist;
    autoplayTargetWalk = walkDist;
    autoplayLastMs = autoplayOriginMs;
  }

  function setExploreAutoplay(on) {
    const next = !!on && mode === "explore" && !camTransition && !winding;
    if (next === exploreAutoplay) return exploreAutoplay;
    if (next && walkDist >= exploreTotal - 1e-3) walkDist = 0;
    if (next) resetWalkMotion();
    exploreAutoplay = next;
    if (next) reanchorAutoplay();
    onExploreAutoplayChange?.(exploreAutoplay);
    return exploreAutoplay;
  }

  let autoplaySpeedMul = 1; // UI label 1–9; keys 1–9 → display xN
  function setExploreAutoplaySpeed(mul) {
    const n = Math.round(Number(mul) || 1);
    autoplaySpeedMul = THREE.MathUtils.clamp(n, 1, 9);
    if (exploreAutoplay) reanchorAutoplay();
    return autoplaySpeedMul;
  }
  // Constant cruise speed (explore-m/s). UI x1 = 10× base, so x9 = 90×.
  const AUTOPLAY_BASE_MPS = path.avgSpeed * PATH_COMPRESS;
  const AUTOPLAY_UI_SPEED_SCALE = 10;
  function exploreAutoplaySpeed() {
    return AUTOPLAY_BASE_MPS * autoplaySpeedMul * AUTOPLAY_UI_SPEED_SCALE;
  }

  function planeGeoFor(aspect) {
    const key = aspect.toFixed(3);
    let g = planeGeoCache.get(key);
    if (!g) {
      g = new THREE.PlaneGeometry(PHOTO_H * aspect, PHOTO_H);
      planeGeoCache.set(key, g);
    }
    return g;
  }

  function makeVideoElement(url) {
    const video = document.createElement("video");
    video.src = url;
    video.crossOrigin = "anonymous";
    video.loop = true;
    video.muted = true; // required for autoplay
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    return video;
  }

  function stopNodeVideo(node) {
    const v = node.video;
    if (!v) return;
    if (!v.paused) v.pause();
    try {
      if (v.currentTime > 0.05) v.currentTime = 0;
    } catch {
      /* ignore seek before ready */
    }
    node.videoPlaying = false;
  }

  // Explore videos play with their sound. Volume follows the card opacity, so
  // the audio fades with the image. Lightbox open / page hidden suspend them.
  const mediaSuspend = new Set();
  function playNodeVideo(node, level = 1) {
    const v = node.video;
    if (!v || mediaSuspend.size) return;
    const vol = THREE.MathUtils.clamp(level, 0, 1);
    if (Math.abs(v.volume - vol) > 0.01) v.volume = vol;
    if (node.videoPlaying) return;
    // Flag first so play() isn't re-issued every frame while it is pending
    node.videoPlaying = true;
    v.muted = false;
    const p = v.play();
    if (p && typeof p.catch === "function") {
      p.catch((err) => {
        if (node.video !== v) return;
        if (err?.name === "NotAllowedError" && !v.muted) {
          // Browser blocks sound without a prior click: play muted instead
          v.muted = true;
          v.play().catch(() => {
            if (node.video === v && v.paused) node.videoPlaying = false;
          });
          return;
        }
        if (v.paused) node.videoPlaying = false;
      });
    }
  }

  function pauseNodeVideo(node) {
    const v = node.video;
    if (v && !v.paused) v.pause();
    node.videoPlaying = false;
  }

  /** reason: "lightbox" | "hidden" … videos stay paused while any is set */
  function setMediaSuspended(reason, on) {
    if (on) {
      mediaSuspend.add(reason);
      for (const n of videoNodes) pauseNodeVideo(n);
    } else if (mediaSuspend.delete(reason) && !mediaSuspend.size) {
      layoutDirty = true; // the layout restarts the formed video
    }
  }

  // —— Full-size map streaming (explore) ——
  // Photos (md) and video posters are decoded only near the walker and freed
  // again behind/far ahead of it: GPU memory stays bounded (~30 photos) instead
  // of growing to every photo of the trail (~1.7 GB) on a full walk.
  const HI_IDLE = 0;
  const HI_LOADING = 1;
  const HI_READY = 2;
  const HI_FAILED = 3;
  const HI_LOAD_AHEAD_M = SHOW_AHEAD_M + 40; // decoded well before it leaves the mist
  const HI_LOAD_BEHIND_M = 40; // scroll-back finds the last photos sharp
  const HI_KEEP_AHEAD_M = HI_LOAD_AHEAD_M + 60; // hysteresis before freeing
  const HI_KEEP_BEHIND_M = 70;
  const HI_MAX_INFLIGHT = 4;
  const HI_PREFETCH_PARALLEL = 2;
  // Checkpoint jump waits for every photo the layout may show at arrival…
  const JUMP_READY_AHEAD_M = SHOW_AHEAD_M;
  const JUMP_WAIT_MAX_MS = 450; // …but never longer than this
  let hiInflight = 0;
  const hiUploadQueue = [];
  const hiCandidates = [];
  let jumpProtect = null; // nodes a pending checkpoint jump needs (never evicted)
  let currentVeil = 1;
  let streamCenter = null; // walk position the streaming window follows
  let streamDirty = false; // a decode finished — top the window up next frame

  function hiUrlFor(node) {
    const it = node.placement.item;
    return node.isVideo ? it.poster || it.thumb : it.md || it.thumb || it.src;
  }

  function videoHasFrame(node) {
    const v = node.video;
    if (!v || !node.videoTex) return false;
    // rVFC marks the texture once a frame exists (also while paused at 0)
    return "requestVideoFrameCallback" in v ? node.videoTex.version > 0 : v.readyState >= 2;
  }

  /** Low-res stand-in (point-cloud map, linear) if a card shows before its photo */
  function fallbackFor(node) {
    if (!node.fallbackTex) {
      const src = node.dissolveTex;
      if (!src?.image) return placeholderHiTex;
      const tex = new THREE.Texture(src.image);
      tex.flipY = src.flipY;
      configureTexture(tex, false);
      tex.needsUpdate = true;
      node.fallbackTex = tex;
    }
    return node.fallbackTex;
  }

  function syncNodeMap(node) {
    const mat = node.hiPlane.material;
    const next = videoHasFrame(node) ? node.videoTex : node.hiTex || fallbackFor(node);
    if (mat.map === next) return;
    // Video maps use another shader variant (sRGB decoded in the shader)
    const variantChange = !!mat.map?.isVideoTexture !== !!next.isVideoTexture;
    mat.map = next;
    if (variantChange) mat.needsUpdate = true;
  }

  function requestHi(node) {
    if (node.hiState !== HI_IDLE) return;
    const url = hiUrlFor(node);
    if (!url) {
      node.hiState = HI_FAILED;
      return;
    }
    node.hiState = HI_LOADING;
    const gen = node.hiGen;
    hiInflight++;
    const done = (tex) => {
      hiInflight--;
      streamDirty = true;
      if (gen !== node.hiGen) {
        disposeTexture(tex); // released while decoding
        return;
      }
      if (!tex) {
        node.hiState = HI_FAILED;
        return;
      }
      node.hiTex = tex;
      node.hiState = HI_READY;
      // Once on the GPU the decoded copy (~7.7 MB per photo) is dropped
      if (typeof ImageBitmap !== "undefined" && tex.image instanceof ImageBitmap) {
        tex.onUpdate = () => {
          tex.onUpdate = null;
          tex.image.close();
        };
      }
      hiUploadQueue.push(node);
      if (node.fallbackTex) {
        const mat = node.hiPlane.material;
        if (mat.map === node.fallbackTex) mat.map = tex;
        disposeTexture(node.fallbackTex, { closeImage: false }); // image = cloud map
        node.fallbackTex = null;
      }
    };
    loadTexture(url, loader).then(done, () => done(null));
  }

  function ensureVideo(node) {
    const src = node.placement.item.src;
    if (!node.isVideo || node.video || !src) return;
    const video = makeVideoElement(src);
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    node.video = video;
    node.videoTex = tex;
    node.videoPlaying = false;
    layoutDirty = true; // a formed card already on screen starts its video now
    try {
      video.load();
    } catch {
      /* ignore */
    }
  }

  function releaseVideo(node) {
    const v = node.video;
    if (!v) return;
    stopNodeVideo(node);
    const mat = node.hiPlane.material;
    if (mat.map === node.videoTex) {
      mat.map = node.hiTex || placeholderHiTex;
      mat.needsUpdate = true;
    }
    node.videoTex?.dispose();
    v.removeAttribute("src");
    try {
      v.load(); // drop the buffered media
    } catch {
      /* ignore */
    }
    node.video = null;
    node.videoTex = null;
    node.videoPlaying = false;
  }

  function releaseHi(node) {
    node.hiGen++; // cancels an in-flight decode
    releaseVideo(node);
    const mat = node.hiPlane.material;
    if (node.hiTex) {
      if (mat.map === node.hiTex) mat.map = placeholderHiTex;
      disposeTexture(node.hiTex);
      node.hiTex = null;
    }
    if (node.fallbackTex) {
      if (mat.map === node.fallbackTex) mat.map = placeholderHiTex;
      disposeTexture(node.fallbackTex, { closeImage: false });
      node.fallbackTex = null;
    }
    node.hiState = HI_IDLE;
  }

  /** Decode what's near `center` (nearest first), free what's far from it */
  function updateHiStreaming(center) {
    streamCenter = center;
    streamDirty = false;
    hiCandidates.length = 0;
    for (const node of exploreNodes) {
      const ahead = node.placement.dist - center;
      const keep = ahead > -HI_KEEP_BEHIND_M && ahead < HI_KEEP_AHEAD_M;
      if (!keep) {
        if (jumpProtect?.has(node)) continue;
        if (node.hiState !== HI_IDLE || node.video || node.fallbackTex) releaseHi(node);
        continue;
      }
      const want = ahead > -HI_LOAD_BEHIND_M && ahead < HI_LOAD_AHEAD_M;
      if (!want) continue;
      ensureVideo(node);
      if (node.hiState === HI_IDLE) hiCandidates.push(node);
    }
    if (!hiCandidates.length || hiInflight >= HI_MAX_INFLIGHT) return;
    // Forward-biased nearest-first
    const key = (n) => {
      const a = n.placement.dist - center;
      return a >= 0 ? a : -a * 2;
    };
    hiCandidates.sort((a, b) => key(a) - key(b));
    for (const node of hiCandidates) {
      if (hiInflight >= HI_MAX_INFLIGHT) break;
      requestHi(node);
    }
  }

  /**
   * Per frame, independent of scrolling: refill the decode window as slots
   * free up, and swap a formed video card from poster to live video as soon
   * as it has a frame (the layout itself only runs on scroll / autoplay).
   */
  function tickHiStreaming() {
    if (streamDirty && streamCenter != null && !pendingJump) updateHiStreaming(streamCenter);
    if (mode !== "explore") return;
    for (const node of videoNodes) {
      if (node.video && node.hiPlane.visible && node.group.visible) syncNodeMap(node);
    }
  }

  /**
   * GPU upload of decoded photos, paced outside the visible card fade-in:
   * one per frame while exploring, a batch while the level veil is opaque.
   */
  function pumpHiUploads() {
    if (!hiUploadQueue.length) return;
    // Small batches even under the veil: a slow GPU must not stretch one frame
    // past the black hold into the visible fade-in.
    let budget = currentVeil >= 0.999 ? 3 : mode === "explore" && !camTransition ? 1 : 0;
    while (budget > 0 && hiUploadQueue.length) {
      const node = hiUploadQueue.shift();
      if (node.hiState !== HI_READY || !node.hiTex) continue;
      renderer.initTexture(node.hiTex);
      budget--;
    }
  }

  // Warm the HTTP cache with the remaining photos/posters in path order once
  // the visitor starts exploring, so later decodes never wait on the network.
  let prefetchStarted = false;
  const prefetchWaiters = [];
  function startHiPrefetch() {
    if (prefetchStarted || typeof fetch !== "function") return;
    prefetchStarted = true;
    let i = 0;
    const next = () => {
      if (document.hidden) {
        prefetchWaiters.push(next); // resumes when the page is visible again
        return undefined;
      }
      while (i < exploreNodes.length) {
        const node = exploreNodes[i++];
        if (node.hiState !== HI_IDLE) continue; // already streamed
        const url = hiUrlFor(node);
        if (!url) continue;
        return fetch(url, { priority: "low" })
          .then((r) => r.blob())
          .catch(() => {})
          .then(next);
      }
      return undefined;
    };
    for (let k = 0; k < HI_PREFETCH_PARALLEL; k++) next();
  }

  async function buildMediaVisuals() {
    // Only the point-cloud maps (pc, ~4 MB in all) gate the landing. Full-size
    // photos, posters and videos stream in later around the explore walker
    // (see updateHiStreaming), so the reveal starts after seconds, not minutes.
    let loadedCount = 0;
    onLoadProgress?.(0);
    const jobs = placements.map(async (placement) => {
      const { item } = placement;
      const isVideo = item.kind === "video";
      const cloudUrl = item.pc || item.poster || item.md || item.thumb || item.src;

      let cloudTex = await loadTexture(cloudUrl, loader, { forCloud: true });
      if (!cloudTex && item.thumb && item.thumb !== cloudUrl) {
        cloudTex = await loadTexture(item.thumb, loader, { forCloud: true });
      }
      onLoadProgress?.(++loadedCount / placements.length);

      const dissolveTex = cloudTex;
      // Source dimensions (identical ratio to the web renditions for all media)
      const aspect =
        item.width && item.height
          ? item.width / item.height
          : dissolveTex?.image
            ? (dissolveTex.image.width || 4) / (dissolveTex.image.height || 3)
            : 4 / 3;
      const clamped = Math.min(Math.max(aspect, 0.7), 1.7);
      const cloudW =
        item.pcW ||
        dissolveTex?.image?.width ||
        (clamped >= 1 ? CLOUD_LONG_SIDE : Math.max(1, Math.round(CLOUD_LONG_SIDE * clamped)));
      const cloudH =
        item.pcH ||
        dissolveTex?.image?.height ||
        (clamped >= 1 ? Math.max(1, Math.round(CLOUD_LONG_SIDE / clamped)) : CLOUD_LONG_SIDE);

      // Volumetric overview — skipped for media flagged hideInOverview (data)
      if (!item.hideInOverview) {
        // Overview: point-cloud only — oriented from AccelerationVector
        const ovGroup = new THREE.Group();
        const cloudScale = OVERVIEW_CLOUD_SCALE;
        const planeW = PHOTO_H * clamped * cloudScale;
        const planeH = PHOTO_H * cloudScale;
        const disp = DISP_MAX * cloudScale * OVERVIEW_DISP_MUL;
        let cloudMat = null;

        if (dissolveTex) {
          const ovLong = OVERVIEW_CLOUD_LONG;
          const ovW =
            clamped >= 1 ? ovLong : Math.max(1, Math.round(ovLong * clamped));
          const ovH =
            clamped >= 1 ? Math.max(1, Math.round(ovLong / clamped)) : ovLong;
          cloudMat = makeCloudMaterial(dissolveTex, clamped);
          cloudMat.uniforms.uScale.value = (container.clientHeight || 800) * 0.5;
          cloudMat.uniforms.uPointMul.value = POINT_MUL;
          cloudMat.uniforms.uPlane.value.set(planeW, planeH);
          cloudMat.uniforms.uDisp.value = disp;
          cloudMat.uniforms.uSpread.value = CLOUD_FAR_SPREAD;
          cloudMat.uniforms.uSize.value = (planeH / Math.max(1, ovH)) * 2.35;
          // No distance fog in overview
          cloudMat.uniforms.uFogNear.value = 1e5;
          cloudMat.uniforms.uFogFar.value = 1e5 + 1;
          cloudMat.uniforms.uWiggle.value = OVERVIEW_WIGGLE_M;
          const cloudPts = new THREE.Points(cloudGeoFor(ovW, ovH), cloudMat);
          cloudPts.frustumCulled = false;
          cloudPts.renderOrder = 5;
          ovGroup.add(cloudPts);
          overviewCloudMats.push(cloudMat);
        }

        // Invisible pick plane (same footprint as the cloud core). Material
        // visible:false keeps it out of the draw list; raycasts still hit it.
        const pickMat = new THREE.MeshBasicMaterial({
          visible: false,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: false,
        });
        const pick = new THREE.Mesh(planeGeoFor(clamped), pickMat);
        pick.scale.setScalar(cloudScale);
        pick.userData.item = item;
        pick.userData.baseScale = cloudScale;
        ovGroup.add(pick);

        ovGroup.position.copy(placement.overviewWorld);
        _ovLook.copy(placement.overviewWorld).sub(overviewCenter);
        if (_ovLook.lengthSq() < 1e-6) _ovLook.set(0, 0, 1);
        else _ovLook.normalize();
        quatFromAccel(item.accel || DEFAULT_ACCEL, _ovLook, _ovQuat);
        ovGroup.quaternion.copy(_ovQuat);

        // Hidden until landing reveal owns visibility (avoids preload flash)
        if (pendingLandingIntro) ovGroup.visible = false;
        scene.add(ovGroup);
        overviewBillboards.push(pick);
        overviewNodes.push({
          group: ovGroup,
          pick,
          cloudMat,
          placement,
          homeQuat: _ovQuat.clone(),
          ele: item.ele ?? 0,
          jitter: hash01(item.id + ":intro"),
        });
      }

      const group = new THREE.Group();
      // Map is swapped to the streamed photo / video when they are ready
      const hiMat = new THREE.MeshBasicMaterial({
        map: placeholderHiTex,
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
        fog: true,
      });
      const hiPlane = new THREE.Mesh(planeGeoFor(clamped), hiMat);
      hiPlane.userData.item = item;
      group.add(hiPlane);
      group.visible = false;
      exploreRoot.add(group);
      exploreNodes.push({
        placement,
        hiPlane,
        group,
        dissolveTex,
        isVideo,
        cloudW,
        cloudH,
        aspect: clamped,
        // Streamed full-size map (photo md / video poster) + lazy video
        hiState: HI_IDLE,
        hiTex: null,
        hiGen: 0,
        fallbackTex: null,
        video: null,
        videoTex: null,
        videoPlaying: false,
        visStamp: -1,
      });
    });
    await Promise.all(jobs);
    // Texture loads finish out of order — restore path order for O(n) visible scans
    exploreNodes.sort((a, b) => a.placement.dist - b.placement.dist);
    for (const n of exploreNodes) if (n.isVideo) videoNodes.push(n);
  }

  // Media drawn in the volumetric overview (data hideInOverview opts out)
  const overviewPlacements = placements.filter((p) => !p.item.hideInOverview);
  // Inflate path spacing for the volumetric mass, then frame the camera on it
  const overviewRawCenter = new THREE.Vector3();
  {
    const rawBox = new THREE.Box3().setFromPoints(overviewPlacements.map((p) => p.world));
    rawBox.getCenter(overviewRawCenter);
    for (const p of placements) {
      p.overviewWorld = p.world
        .clone()
        .sub(overviewRawCenter)
        .multiplyScalar(OVERVIEW_SPREAD)
        .add(overviewRawCenter);
      p.overviewWorld.y += 2;
    }
  }
  const box = new THREE.Box3().setFromPoints(overviewPlacements.map((p) => p.overviewWorld));
  const overviewCenter = box.getCenter(new THREE.Vector3());
  // Inflate by each cloud's volume so framing includes the mist, not just anchors
  const overviewCloudRadius = Math.hypot(
    PHOTO_H * 1.7 * OVERVIEW_CLOUD_SCALE * CLOUD_FAR_SPREAD * 0.5,
    PHOTO_H * OVERVIEW_CLOUD_SCALE * CLOUD_FAR_SPREAD * 0.5,
    DISP_MAX * OVERVIEW_CLOUD_SCALE * OVERVIEW_DISP_MUL * 0.65
  );
  const overviewFitBox = box.clone().expandByScalar(overviewCloudRadius);
  const overviewSphere = overviewFitBox.getBoundingSphere(new THREE.Sphere());
  overviewCenter.copy(overviewSphere.center);
  const overviewCamDir = new THREE.Vector3(0.82, 0.4, 0.92).normalize();
  const OVERVIEW_FIT_PAD = 0.6;
  const OVERVIEW_FOV = 48;
  const OVERVIEW_VIEW_Y = 0.1;
  const _ovViewUp = new THREE.Vector3();

  // Trail-base eye in overview space — fly-in target for the Explore CTA pan
  // (path runs straight into the screen, perpendicular to the view plane)
  const overviewBaseEye = new THREE.Vector3();
  const overviewBaseLook = new THREE.Vector3();
  const overviewBaseQuat = new THREE.Quaternion();
  {
    writeFrame(0, _eyePos, _eyeTan, _eyeSide, _eyeUp, "explore");
    const basePull = START_LEAD_M / Math.max(1e-6, PATH_COMPRESS);
    overviewBaseEye
      .copy(_eyePos)
      .addScaledVector(_worldUp, EYE_H)
      .addScaledVector(_eyeTan, -basePull)
      .sub(overviewRawCenter)
      .multiplyScalar(OVERVIEW_SPREAD)
      .add(overviewRawCenter);
    overviewBaseLook.copy(overviewBaseEye).addScaledVector(_eyeTan, 80 * OVERVIEW_SPREAD);
    const basCam = new THREE.PerspectiveCamera(EXPLORE_FOV_DEG, 1, 0.15, 6000);
    basCam.position.copy(overviewBaseEye);
    basCam.up.copy(_worldUp);
    basCam.lookAt(overviewBaseLook);
    overviewBaseQuat.copy(basCam.quaternion);
  }

  // Checkpoint anchors at each sputaneve photo — the mesh is an invisible pick
  // target, the visible marker is an HTML pin projected on top of the canvas
  const checkpointMarkers = [];
  const checkpointPins = [];
  const MORPH_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz0123456789#%*+=";
  const CP_MORPH_MS = 1100; // dedicated scramble window once a pin appears
  {
    const markGeo = new THREE.CircleGeometry(6.5, 28);
    const markMat = new THREE.MeshBasicMaterial({ visible: false });
    SPUTANEVE_IDS.forEach((id, i) => {
      const p = placements.find((x) => x.item.id === id);
      if (!p) return;
      const mesh = new THREE.Mesh(markGeo, markMat);
      mesh.position.copy(p.overviewWorld);
      mesh.userData.item = p.item;
      mesh.userData.checkpoint = true;
      mesh.userData.checkpointIndex = i;
      mesh.visible = false;
      scene.add(mesh);
      checkpointMarkers.push(mesh);

      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "checkpoint-pin";
      pin.hidden = true;
      pin.disabled = true;
      pin.classList.add("is-locked");
      pin.style.opacity = "0";
      if (checkpointIconSrc) {
        const icon = document.createElement("img");
        icon.src = checkpointIconSrc;
        icon.alt = "";
        pin.appendChild(icon);
      }
      const label = document.createElement("span");
      const targetText = `checkpoint-${i + 1}`;
      label.textContent = "";
      pin.appendChild(label);
      pin.addEventListener("click", () => {
        if (landingIntro || !isCheckpointUnlocked(i)) return;
        goToCheckpoint(p.item.id);
      });
      pin.addEventListener("pointerenter", () => onHoverItem?.(p.item));
      pin.addEventListener("pointerleave", () => onHoverItem?.(null));
      container.appendChild(pin);
      checkpointPins.push({
        pin,
        mesh,
        label,
        targetText,
        ele: p.item.ele ?? 0,
        jitter: hash01(id + ":cp-intro"),
        reveal: 0,
        morphStart: null,
      });
    });
  }

  // Checkpoints unlock in order as the explore walk reaches them (driven by the page)
  let unlockedCheckpoints = 0;
  function isCheckpointUnlocked(index) {
    return index < unlockedCheckpoints;
  }
  function setUnlockedCheckpoints(count) {
    unlockedCheckpoints = count;
    for (const { pin, mesh } of checkpointPins) {
      const locked = !isCheckpointUnlocked(mesh.userData.checkpointIndex);
      pin.disabled = locked;
      pin.classList.toggle("is-locked", locked);
    }
  }

  function morphLabel(target, t, seed) {
    if (t <= 0.001) return "";
    if (t >= 0.999) return target;
    // Full scramble for longer, then resolve L→R (reads more like a decode)
    const resolveU = THREE.MathUtils.smoothstep(t, 0.38, 1);
    const resolved = Math.floor(Math.pow(resolveU, 1.25) * target.length);
    const tick = (t * 56) | 0;
    let out = "";
    for (let i = 0; i < target.length; i++) {
      const ch = target[i];
      if (ch === "-" || ch === " ") {
        out += ch;
        continue;
      }
      if (i < resolved) out += ch;
      else {
        const r = hash01(`${seed}:${i}:${tick}`);
        out += MORPH_CHARS[(r * MORPH_CHARS.length) | 0];
      }
    }
    return out;
  }

  const _pinNdc = new THREE.Vector3();
  /** @param {number} [fade=1] extra opacity multiplier (level-change veil) */
  function updateCheckpointPins(fade = 1) {
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const now = performance.now();
    // Enter fly: pins may dissolve with the veil. Leave: never over explore —
    // only unveil with overview after handoff.
    const enterFly = camTransition?.kind === "enter" && !camTransition.handedOff;
    const leaveUnveil = camTransition?.kind === "leave" && camTransition.handedOff;
    const overviewIdle = mode === "overview" && !camTransition;
    for (const cp of checkpointPins) {
      const { pin, mesh, label, targetText } = cp;
      _pinNdc.copy(mesh.position).project(camera);
      const inFront = _pinNdc.z < 1;
      const reveal = landingIntro
        ? cp.reveal
        : enterFly || leaveUnveil || (overviewIdle && mesh.visible)
          ? 1
          : 0;
      const show = reveal > 0.04 && inFront && fade > 0.03;
      // DOM writes only on change — unchanged writes still dirty style/layout
      if (pin.hidden !== !show) pin.hidden = !show;
      if (!show) continue;
      const x = (_pinNdc.x * 0.5 + 0.5) * w;
      const y = (-_pinNdc.y * 0.5 + 0.5) * h;
      pin.style.transform = `translate(${x}px, ${y}px) translate(-5.8px, -50%)`;
      const opacity = String(reveal * fade);
      if (pin.style.opacity !== opacity) pin.style.opacity = opacity;

      let morphT = 1;
      if (landingIntro) {
        if (reveal > 0.08 && cp.morphStart == null) cp.morphStart = now;
        morphT =
          cp.morphStart != null
            ? THREE.MathUtils.clamp((now - cp.morphStart) / CP_MORPH_MS, 0, 1)
            : 0;
      }
      const text = morphLabel(targetText, morphT, targetText);
      if (label.textContent !== text) label.textContent = text;
    }
  }

  function getCheckpoints() {
    return SPUTANEVE_IDS.map((id, i) => {
      const p = placements.find((x) => x.item.id === id);
      if (!p) return null;
      return {
        index: i + 1,
        id: p.item.id,
        label: `Sputaneve ${i + 1}`,
        timeLocal: p.item.timeLocal,
        ele: p.item.ele,
        dist: p.dist,
        arriveDist: checkpointArriveDist(p),
        item: p.item,
      };
    }).filter(Boolean);
  }

  // Stop inside the gap before this sputaneve so it is the nearest card ahead.
  // A fixed ~28 m lead often left the previous photo as the formed one.
  function checkpointArriveDist(p) {
    const i = placements.indexOf(p);
    const prevDist = i > 0 ? placements[i - 1].dist : Math.max(0, p.dist - 16);
    const gap = Math.max(1e-3, p.dist - prevDist);
    const lead = THREE.MathUtils.clamp(gap * 0.4, 3.5, 12);
    return THREE.MathUtils.clamp(p.dist - lead, 0, exploreTotal);
  }

  // The jump waits (briefly) for the photos around the destination to be
  // decoded, so it lands on sharp images instead of low-res stand-ins.
  let pendingJump = null;
  function goToCheckpoint(id) {
    const p = placements.find((x) => x.item.id === id);
    if (!p) return false;
    return jumpToWalk(jumpArriveDist(p));
  }

  // Where a jump lands: the card sits halfway through its full-opacity hold
  // (formed, no mist, not yet dissolving). Solved with the layout's own math
  // (cardPose) because path bends and lateral offsets make a fixed lead in
  // metres land anywhere from "still mist" to "half dissolved".
  const ARRIVE_COVER = REFORM_SCREEN_FRAC + EXIT_HOLD_SPAN * 0.5;
  const _arPos = new THREE.Vector3();
  const _arTan = new THREE.Vector3();
  const _arSide = new THREE.Vector3();
  const _arUp = new THREE.Vector3();
  const _arCam = new THREE.Vector3();
  const _arPose = {};
  function jumpArriveDist(p) {
    const node = exploreNodes.find((n) => n.placement === p);
    if (!node) return checkpointArriveDist(p);
    const cover = (walk) => {
      eyeAt(walk, false, _arPos, _arTan, _arSide, _arUp, _arCam);
      return cardPose(node, false, _arTan, _arSide, _arUp, _arCam, _arPose).coverFrac;
    };
    // Step back from the card until it reads smaller than the target, then
    // refine. Nearest-first matters near the summit, where the trail loops
    // around the hut and the card is close again from 60 m further back.
    const STEP = 0.25;
    let hi = Math.max(0, p.dist - 0.5);
    let lo = hi;
    const floor = Math.max(0, p.dist - 60);
    while (lo > floor && cover(lo) >= ARRIVE_COVER) {
      hi = lo;
      lo = Math.max(floor, lo - STEP);
    }
    if (cover(lo) >= ARRIVE_COVER) return lo;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) * 0.5;
      if (cover(mid) < ARRIVE_COVER) lo = mid;
      else hi = mid;
    }
    return THREE.MathUtils.clamp((lo + hi) * 0.5, 0, exploreTotal);
  }

  // —— "Winding": inside explore a jump fast-forwards / rewinds along the path
  // instead of cutting. Duration grows gently with distance; FOV widens with
  // speed (warp feel) and settles back exactly on arrival.
  const WIND_MIN_S = 0.9;
  const WIND_MAX_S = 2.1;
  const WIND_FOV_KICK_DEG = 14;
  let winding = null;
  function startWinding(target) {
    const from = walkDist;
    const dist = Math.abs(target - from);
    if (dist < 0.05) {
      walkDist = target;
      resetWalkMotion();
      updateExploreLayout();
      return;
    }
    winding = {
      from,
      to: target,
      t0: performance.now(),
      dur: THREE.MathUtils.clamp(0.75 + dist / 1600, WIND_MIN_S, WIND_MAX_S) * 1000,
    };
    resetWalkMotion();
  }
  function tickWinding(now) {
    const w = winding;
    const u = THREE.MathUtils.clamp((now - w.t0) / w.dur, 0, 1);
    walkDist = w.from + (w.to - w.from) * easeInOutQuint(u);
    const kick = Math.sin(Math.PI * u);
    camera.fov = EXPLORE_FOV_DEG + WIND_FOV_KICK_DEG * kick * kick;
    camera.updateProjectionMatrix();
    snapReentry = true; // no re-entry pacing while warping
    if (u >= 1) finishWinding();
    else updateExploreLayout();
  }
  function finishWinding() {
    if (!winding) return;
    walkDist = winding.to;
    winding = null;
    camera.fov = EXPLORE_FOV_DEG;
    camera.updateProjectionMatrix();
    resetWalkMotion();
    jumpProtect = null;
    if (mode === "explore") updateExploreLayout();
  }
  /** Abort mid-flight (mode change): stay where we are, restore the lens */
  function cancelWinding() {
    if (!winding) return;
    winding = null;
    camera.fov = EXPLORE_FOV_DEG;
    camera.updateProjectionMatrix();
    jumpProtect = null;
  }

  function jumpToWalk(target) {
    if (camTransition) return false;
    const inExplore = mode === "explore";
    if (inExplore) setExploreAutoplay(false);
    const needed = exploreNodes.filter((n) => {
      const a = n.placement.dist - target;
      return a > -HI_LOAD_BEHIND_M && a < JUMP_READY_AHEAD_M;
    });
    // Nearest first: if the wait times out, only faint far cards fall back
    const near = (n) => Math.abs(n.placement.dist - target);
    for (const n of needed.slice().sort((a, b) => near(a) - near(b))) requestHi(n);
    jumpProtect = new Set(needed);
    startHiPrefetch();
    if (inExplore) {
      // The flight itself covers the decode time of the destination photos
      cancelPendingJump();
      jumpProtect = new Set(needed);
      startWinding(target);
      return true;
    }
    if (mode === "overview") {
      // Dissolve only (no CTA fly-in pan), landing on this photo.
      // Wait for the CTA scramble to clear, then start the level fade immediately.
      if (checkpointEnterArmed) return false;
      cancelPendingJump();
      jumpProtect = new Set(needed);
      const go = () => {
        checkpointEnterArmed = false;
        if (mode !== "overview" || camTransition) return;
        setMode("explore", { animate: true, endWalk: target, pan: false });
      };
      checkpointEnterArmed = true;
      if (onPrepareExploreEnter) onPrepareExploreEnter(go);
      else go();
      return true;
    }
    pendingJump = { target, needed, deadline: performance.now() + JUMP_WAIT_MAX_MS };
    if (pendingJumpReady()) applyPendingJump();
    return true;
  }

  function pendingJumpReady() {
    return pendingJump.needed.every((n) => n.hiState === HI_READY || n.hiState === HI_FAILED);
  }

  function applyPendingJump() {
    const jump = pendingJump;
    pendingJump = null;
    if (!jump) return;
    // Fallback path (should be rare) — dissolve only, like checkpoint jumps
    if (mode === "overview" && !camTransition) {
      jumpProtect = new Set(jump.needed);
      setMode("explore", { animate: true, endWalk: jump.target, pan: false });
      return;
    }
    if (mode !== "explore" || camTransition) setMode("explore", { animate: false, endWalk: jump.target });
    else setExploreAutoplay(false);
    walkDist = jump.target;
    resetWalkMotion();
    updateExploreLayout();
    jumpProtect = null;
  }

  function cancelPendingJump() {
    if (!pendingJump) return;
    pendingJump = null;
    jumpProtect = null;
  }

  // Overview → explore: CTA uses pan + fade; checkpoint jumps are fade-only
  const ENTER_EXPLORE_MS = 3000;
  const ENTER_CHECKPOINT_MS = Math.round(ENTER_EXPLORE_MS * 0.75); // 25% faster
  let checkpointEnterArmed = false;
  const _trPos = new THREE.Vector3();
  const _trMid = new THREE.Vector3();
  const _trQuat = new THREE.Quaternion();

  function easeInOutQuint(u) {
    const t = THREE.MathUtils.clamp(u, 0, 1);
    return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
  }

  function easeInOutSine(u) {
    const t = THREE.MathUtils.clamp(u, 0, 1);
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  function easeInOutCubic(u) {
    const t = THREE.MathUtils.clamp(u, 0, 1);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function easeOutCubic(u) {
    const t = 1 - THREE.MathUtils.clamp(u, 0, 1);
    return 1 - t * t * t;
  }

  function bezier3(a, b, c, t, out) {
    const u = 1 - t;
    out.set(0, 0, 0)
      .addScaledVector(a, u * u)
      .addScaledVector(b, 2 * u * t)
      .addScaledVector(c, t * t);
    return out;
  }

  function setViewFade(opacity) {
    currentVeil = THREE.MathUtils.clamp(opacity, 0, 1);
    fadeEl.style.opacity = String(currentVeil);
  }

  function resetOverviewMistWash() {
    for (const n of overviewNodes) {
      n.group.traverse((obj) => {
        const u = obj.isPoints && obj.material?.uniforms;
        if (!u?.uFogNear || !u?.uFogFar) return;
        u.uFogNear.value = 1e5;
        u.uFogFar.value = 1e5 + 1;
      });
    }
  }

  function cancelCamTransition() {
    const had = camTransition;
    const dir = had?.kind === "leave" ? "leave" : "enter";
    if (had) {
      restoreOverviewNodesHome();
      for (const n of overviewNodes) n.group.visible = mode === "overview";
    }
    camTransition = null;
    // Only notify when aborting a real level fade. A no-op cancel (e.g. checkpoint
    // jump with animate:false) used to force exploreChrome=0 and hide the list.
    if (had) {
      onTransitionChange?.(false, { direction: dir });
      onTransitionFade?.(0, {
        direction: dir,
        exploreChrome: dir === "enter" ? 1 : 0,
      });
    }
    if (!landingIntro) setViewFade(0);
    resetOverviewMistWash();
  }

  // First-load: fade from white + organic base→peak reveal of the volumetric mass
  const LANDING_INTRO_MS = 5200;

  function revealAmount(ele, jitter, revealEle, band) {
    const localEle = ele + (jitter - 0.5) * band * 0.75;
    // Three.js: smoothstep(x, min, max) — not GLSL's (edge0, edge1, x)
    return THREE.MathUtils.smoothstep(
      (revealEle - localEle) / Math.max(1e-3, band),
      0,
      1
    );
  }

  function applyLandingReveal(revealEle, band) {
    const fogCol = nightMode ? 0x000000 : 0xffffff;
    const baseDisp = DISP_MAX * OVERVIEW_CLOUD_SCALE * OVERVIEW_DISP_MUL;
    for (const n of overviewNodes) {
      const t = revealAmount(n.ele, n.jitter, revealEle, band);
      const show = t > 0.001;
      n.group.visible = show;
      if (n.pick) n.pick.visible = t > 0.55;
      // Soft grow out of the mist
      const tEase = easeOutCubic(t);
      n.group.scale.setScalar(THREE.MathUtils.lerp(0.55, 1, tEase));
      if (n.cloudMat) {
        // t=0 → fully washed into bg (tiny fogFar). t=1 → no distance fog.
        const fogFar = THREE.MathUtils.lerp(0.35, 1e6, Math.pow(Math.max(t, 0), 1.85));
        n.cloudMat.uniforms.uFogNear.value = fogFar * 0.02;
        n.cloudMat.uniforms.uFogFar.value = fogFar;
        n.cloudMat.uniforms.uFogColor.value.setHex(fogCol);
        // Gentler density/explode — peak cards used to pop from 0.2→1 too late
        n.cloudMat.uniforms.uPointMul.value = POINT_MUL * THREE.MathUtils.lerp(0.35, 1, tEase);
        n.cloudMat.uniforms.uDisp.value = baseDisp * THREE.MathUtils.lerp(0.55, 1, tEase);
        n.cloudMat.uniforms.uSpread.value = THREE.MathUtils.lerp(
          CLOUD_FAR_SPREAD * 1.2,
          CLOUD_FAR_SPREAD,
          tEase
        );
      }
    }
    for (const cp of checkpointPins) {
      // Checkpoints trail the mist front slightly so labels bloom after the mass
      cp.reveal = revealAmount(cp.ele, cp.jitter, revealEle - band * 0.15, band * 0.85);
      cp.mesh.visible = cp.reveal > 0.2 && mode === "overview";
    }
  }

  function beginLandingIntro() {
    const eles = placements.map((p) => p.item.ele).filter((e) => e != null);
    if (!eles.length || mode !== "overview") {
      pendingLandingIntro = false;
      setViewFade(0);
      onIntroComplete?.();
      return;
    }
    const eleMin = Math.min(...eles);
    const eleMax = Math.max(...eles);
    const band = Math.max(48, (eleMax - eleMin) * 0.14);
    landingIntro = {
      t0: performance.now(),
      dur: LANDING_INTRO_MS,
      eleMin,
      eleMax,
      band,
    };
    pendingLandingIntro = false;
    controls.enabled = false;
    controls.autoRotate = true;
    setViewFade(1);
    applyLandingReveal(eleMin - band * 0.5, band);
    for (const cp of checkpointPins) {
      cp.reveal = 0;
      cp.morphStart = null;
      cp.mesh.visible = false;
      cp.label.textContent = "";
      cp.pin.style.opacity = "0";
    }
    onIntroProgress?.(0, { durationMs: LANDING_INTRO_MS, ms: 0 });
  }

  function finishLandingIntro() {
    if (!landingIntro) return;
    const durationMs = landingIntro.dur;
    landingIntro = null;
    const baseDisp = DISP_MAX * OVERVIEW_CLOUD_SCALE * OVERVIEW_DISP_MUL;
    for (const n of overviewNodes) {
      n.group.visible = true;
      n.group.scale.setScalar(1);
      if (n.pick) n.pick.visible = true;
      if (n.cloudMat) {
        n.cloudMat.uniforms.uFogNear.value = 1e5;
        n.cloudMat.uniforms.uFogFar.value = 1e5 + 1;
        n.cloudMat.uniforms.uPointMul.value = POINT_MUL;
        n.cloudMat.uniforms.uDisp.value = baseDisp;
        n.cloudMat.uniforms.uSpread.value = CLOUD_FAR_SPREAD;
      }
    }
    for (const cp of checkpointPins) {
      cp.reveal = 1;
      cp.mesh.visible = mode === "overview";
      cp.label.textContent = cp.targetText;
      cp.pin.style.opacity = mode === "overview" ? "1" : "0";
    }
    setViewFade(0);
    if (mode === "overview") {
      controls.enabled = true;
      controls.autoRotate = true;
    }
    onIntroProgress?.(1, { durationMs, ms: durationMs });
    onIntroComplete?.();
  }

  function tickLandingIntro(now) {
    if (!landingIntro) return false;
    const ms = now - landingIntro.t0;
    const u = THREE.MathUtils.clamp(ms / landingIntro.dur, 0, 1);
    // Soft overall ease, then bias time toward the upper trail so the peak
    // doesn't get cramped into the last beat (and snap-finish).
    const e = easeInOutSine(u);
    const eReveal = 1 - Math.pow(1 - e, 1.45);
    const { eleMin, eleMax, band, dur } = landingIntro;
    const revealEle = THREE.MathUtils.lerp(
      eleMin - band * 0.45,
      eleMax + band * 1.15,
      eReveal
    );
    applyLandingReveal(revealEle, band);

    // Lift the white veil quickly so the rising mist can read through
    const veil = u < 0.14 ? 1 - easeInOutCubic(u / 0.14) : 0;
    setViewFade(Math.max(0, veil));

    controls.update();
    const t = now * 0.001;
    for (const mat of overviewCloudMats) mat.uniforms.uTime.value = t;

    onIntroProgress?.(u, { durationMs: dur, ms });
    if (u >= 1) {
      finishLandingIntro();
      return true;
    }
    return true;
  }

  const overviewHomeDisp = DISP_MAX * OVERVIEW_CLOUD_SCALE * OVERVIEW_DISP_MUL;
  // Enter timeline (u 0→1): late fade-out → handoff → fade-in
  // (CTA also pans; checkpoint jumps skip the pan — see camTransition.pan)
  const ENTER_FADE_OUT_START = 0.58; // later — leave room for the explore… exit morph
  const ENTER_FADE_OUT_END = 0.72; // black a beat before the pan goes static
  const ENTER_PAN_END = 0.78;
  const ENTER_HANDOFF_AT = 0.8; // swap under black once the pan has settled
  const ENTER_FADE_IN_START = 0.84;
  const ENTER_FADE_IN_END = 0.97;
  // Leave timeline (no pan): fade-out → handoff → fade-in
  // LEAVE_* names — must not reuse EXIT_FADE_IN_START (module const for photo fade).
  const EXIT_OVERVIEW_MS = 2000;
  const LEAVE_FADE_OUT_END = 0.38;
  const EXIT_HANDOFF_AT = 0.42;
  const LEAVE_FADE_IN_START = 0.52;
  const LEAVE_FADE_IN_END = 0.92;

  function restoreOverviewNodesHome() {
    for (const n of overviewNodes) {
      n.group.position.copy(n.placement.overviewWorld);
      n.group.quaternion.copy(n.homeQuat);
      n.group.scale.setScalar(1);
      if (n.pick) n.pick.visible = true;
      if (n.cloudMat) {
        n.cloudMat.uniforms.uFogNear.value = 1e5;
        n.cloudMat.uniforms.uFogFar.value = 1e5 + 1;
        n.cloudMat.uniforms.uPointMul.value = POINT_MUL;
        n.cloudMat.uniforms.uDisp.value = overviewHomeDisp;
        n.cloudMat.uniforms.uSpread.value = CLOUD_FAR_SPREAD;
      }
    }
  }

  function handoffToExplore(endWalk = 0) {
    walkDist = THREE.MathUtils.clamp(endWalk, 0, exploreTotal);
    resetWalkMotion();
    for (const slot of cloudPool) slot.pts.visible = false;
    restoreOverviewNodesHome();
    for (const n of overviewNodes) n.group.visible = false;
    for (const m of checkpointMarkers) m.visible = false;
    for (const cp of checkpointPins) {
      cp.pin.hidden = true;
      cp.pin.style.opacity = "0";
    }
    resetOverviewMistWash();
    applyExploreCamera();
    // Page chrome switches under black (mode UI was deferred from setMode)
    onModeChange?.("explore");
  }

  function handoffToOverview() {
    setExploreAutoplay(false);
    for (const n of exploreNodes) stopNodeVideo(n);
    for (const slot of cloudPool) slot.pts.visible = false;
    mode = "overview";
    container.dataset.mode = mode;
    restoreOverviewNodesHome();
    applyOverviewCamera();
    // Spin from the first unveil frame (applyOverviewCamera would leave it off mid-transition)
    enableOverviewSpin();
    // Keep HTML pins hidden until the leave unveil (avoids labels over explore)
    for (const cp of checkpointPins) {
      cp.reveal = 1;
      cp.morphStart = null;
      cp.mesh.visible = true;
      cp.pin.hidden = true;
      cp.pin.style.opacity = "0";
      if (cp.label) cp.label.textContent = cp.targetText;
    }
    onModeChange?.("overview");
  }

  function beginLeaveExplore() {
    setExploreAutoplay(false);
    for (const n of exploreNodes) stopNodeVideo(n);
    controls.enabled = false;
    controls.autoRotate = false;
    setViewFade(0);
    onTransitionFade?.(0, { direction: "leave" });
    onTransitionChange?.(true, { durationMs: EXIT_OVERVIEW_MS, direction: "leave" });
    camTransition = {
      t0: performance.now(),
      dur: EXIT_OVERVIEW_MS,
      kind: "leave",
      handedOff: false,
    };
  }

  /** Overview should already be orbiting as it unveils on go-back. */
  function enableOverviewSpin() {
    controls.enabled = false; // no drag mid-veil; spin still runs via update()
    controls.autoRotate = true;
  }

  function beginEnterExplore(endWalk = 0, { pan = true } = {}) {
    setExploreAutoplay(false);
    for (const n of exploreNodes) stopNodeVideo(n);
    controls.enabled = false;
    // CTA pans from a frozen pose; checkpoint jumps keep orbiting through the dissolve
    controls.autoRotate = !pan;
    exploreRoot.visible = false;
    restoreOverviewNodesHome();
    for (const n of overviewNodes) n.group.visible = true;
    for (const m of checkpointMarkers) m.visible = false;
    for (const n of exploreNodes) n.group.visible = false;
    // Pins stay up and dissolve with the level fade (see tickCamTransition)
    for (const cp of checkpointPins) {
      cp.pin.hidden = false;
      cp.mesh.visible = true;
    }
    setViewFade(0);
    onTransitionFade?.(0, { direction: "enter" });
    resetOverviewMistWash();

    const clampedEnd = THREE.MathUtils.clamp(endWalk, 0, exploreTotal);
    // Decode destination photos during the transition; they upload under black
    updateHiStreaming(clampedEnd);
    startHiPrefetch();

    const clampedPan = !!pan;
    // Checkpoint jumps: shorter, and the veil starts immediately (no CTA lead-in)
    const fadeNow = !clampedPan;
    const dur = fadeNow ? ENTER_CHECKPOINT_MS : ENTER_EXPLORE_MS;
    onTransitionChange?.(true, { durationMs: dur, direction: "enter" });
    onTransitionFade?.(0, { direction: "enter" });

    camTransition = {
      t0: performance.now(),
      dur,
      kind: "enter",
      pan: clampedPan,
      fadeNow,
      handoffAt: fadeNow ? EXIT_HANDOFF_AT : ENTER_HANDOFF_AT,
      endWalk: clampedEnd,
      handedOff: false,
    };

    if (clampedPan) {
      // Live orbit pose → trailhead (path perpendicular into the screen)
      const fromPos = camera.position.clone();
      const fromQuat = camera.quaternion.clone();
      const fromFov = camera.fov;
      const toPos = overviewBaseEye.clone();
      const toQuat = overviewBaseQuat.clone();
      const travel = fromPos.distanceTo(toPos);
      _trMid
        .lerpVectors(fromPos, toPos, 0.5)
        .addScaledVector(
          _worldUp,
          Math.min(overviewSphere.radius * 0.045, travel * 0.06)
        );
      Object.assign(camTransition, {
        fromPos,
        midPos: _trMid.clone(),
        toPos,
        fromQuat,
        toQuat,
        fromFov,
        toFov: EXPLORE_FOV_DEG,
        farStart: Math.max(8000, overviewSphere.radius * 20),
      });
      scene.fog = null;
      camera.near = 0.5;
      camera.far = camTransition.farStart;
      camera.updateProjectionMatrix();
    }
  }

  function transitionVeil(u, kind) {
    // Leave + checkpoint-enter: dissolve starts immediately
    if (kind === "leave" || (kind === "enter" && camTransition?.fadeNow)) {
      if (u < LEAVE_FADE_OUT_END) return easeInOutSine(u / LEAVE_FADE_OUT_END);
      if (u < LEAVE_FADE_IN_START) return 1;
      if (u < LEAVE_FADE_IN_END) {
        return 1 - easeInOutSine((u - LEAVE_FADE_IN_START) / (LEAVE_FADE_IN_END - LEAVE_FADE_IN_START));
      }
      return 0;
    }
    // CTA enter: late fade-out so the explore… scramble can read first
    if (u < ENTER_FADE_OUT_START) return 0;
    if (u < ENTER_FADE_OUT_END) {
      return easeInOutSine((u - ENTER_FADE_OUT_START) / (ENTER_FADE_OUT_END - ENTER_FADE_OUT_START));
    }
    if (u < ENTER_FADE_IN_START) return 1;
    if (u < ENTER_FADE_IN_END) {
      return 1 - easeInOutSine((u - ENTER_FADE_IN_START) / (ENTER_FADE_IN_END - ENTER_FADE_IN_START));
    }
    return 0;
  }

  function tickCamTransition(now) {
    if (!camTransition) return false;
    const u = THREE.MathUtils.clamp((now - camTransition.t0) / camTransition.dur, 0, 1);
    const kind = camTransition.kind === "leave" ? "leave" : "enter";
    const direction = kind;

    if (kind === "leave") {
      if (!camTransition.handedOff) {
        updateExploreLayout();
        const t = now * 0.001;
        for (const slot of cloudPool) {
          if (!slot.pts.visible) continue;
          slot.mat.uniforms.uTime.value = t;
        }
      } else {
        const tOv = now * 0.001;
        for (const mat of overviewCloudMats) mat.uniforms.uTime.value = tOv;
        if (mode === "overview") controls.update();
      }

      const veil = transitionVeil(u, "leave");
      setViewFade(veil);
      // Explore chrome fades with the veil; after handoff pins unveil with it
      onTransitionFade?.(veil, { direction, exploreChrome: 1 - veil });
      if (camTransition.handedOff) updateCheckpointPins(1 - veil);

      if (!camTransition.handedOff && u >= EXIT_HANDOFF_AT) {
        camTransition.handedOff = true;
        handoffToOverview();
      }

      if (u >= 1) {
        if (!camTransition.handedOff) handoffToOverview();
        setViewFade(0);
        onTransitionFade?.(0, { direction, exploreChrome: 0 });
        camTransition = null;
        if (mode === "overview") {
          controls.enabled = !landingIntro && !pendingLandingIntro;
          controls.autoRotate = controls.enabled;
          updateCheckpointPins(1);
        }
        onTransitionChange?.(false, { direction });
        return true;
      }
      return true;
    }

    // —— enter: CTA pans + fades; checkpoint jumps fade only ——
    const doPan = !!camTransition.pan;
    if (!camTransition.handedOff) {
      if (doPan) {
        const flyU = THREE.MathUtils.clamp(u / ENTER_PAN_END, 0, 1);
        const posE = easeInOutSine(flyU);
        const lookE = easeInOutSine(flyU);
        const fovE = easeInOutSine(flyU);
        bezier3(
          camTransition.fromPos,
          camTransition.midPos,
          camTransition.toPos,
          posE,
          _trPos
        );
        _trQuat.slerpQuaternions(camTransition.fromQuat, camTransition.toQuat, lookE);
        camera.position.copy(_trPos);
        camera.quaternion.copy(_trQuat);
        camera.up.set(0, 1, 0);
        camera.fov = THREE.MathUtils.lerp(camTransition.fromFov, camTransition.toFov, fovE);
        camera.near = 0.5;
        camera.far = camTransition.farStart;
        camera.updateProjectionMatrix();
      } else {
        controls.update(); // keep overview orbit alive through the dissolve
      }
      const tOv = now * 0.001;
      for (const mat of overviewCloudMats) mat.uniforms.uTime.value = tOv;
    } else {
      updateExploreLayout();
      const t = now * 0.001;
      for (const slot of cloudPool) {
        if (!slot.pts.visible) continue;
        slot.mat.uniforms.uTime.value = t;
      }
    }

    const veil = transitionVeil(u, "enter");
    setViewFade(veil);
    // Explore type only during unveil (after handoff), synced to the veil
    const exploreChrome = camTransition.handedOff ? 1 - veil : 0;
    onTransitionFade?.(veil, { direction, exploreChrome });

    if (!camTransition.handedOff) updateCheckpointPins(1 - veil);

    const handoffAt = camTransition.handoffAt ?? ENTER_HANDOFF_AT;
    if (!camTransition.handedOff && u >= handoffAt) {
      camTransition.handedOff = true;
      if (doPan) {
        camera.position.copy(camTransition.toPos);
        camera.quaternion.copy(camTransition.toQuat);
        camera.fov = camTransition.toFov;
        camera.updateProjectionMatrix();
      }
      handoffToExplore(camTransition.endWalk);
    }

    if (u >= 1) {
      if (!camTransition.handedOff) handoffToExplore(camTransition.endWalk);
      setViewFade(0);
      onTransitionFade?.(0, { direction, exploreChrome: 1 });
      camTransition = null;
      jumpProtect = null;
      onTransitionChange?.(false, { direction });
      return true;
    }
    return true;
  }

  function frameOverviewToFit() {
    camera.fov = OVERVIEW_FOV;
    camera.near = 0.5;
    camera.far = Math.max(8000, overviewSphere.radius * 20);
    camera.updateProjectionMatrix();
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * Math.max(0.2, camera.aspect));
    const dist =
      (overviewSphere.radius * OVERVIEW_FIT_PAD) /
      Math.min(Math.sin(vFov * 0.5), Math.sin(hFov * 0.5));
    const visibleH = 2 * dist * Math.tan(vFov * 0.5);
    const screenShift = OVERVIEW_VIEW_Y * visibleH;

    camera.position.copy(overviewSphere.center).addScaledVector(overviewCamDir, dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(overviewSphere.center);
    camera.updateMatrixWorld();
    _ovViewUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    // Orbit target below the mass → mass reads above the viewport center
    controls.target.copy(overviewSphere.center).addScaledVector(_ovViewUp, -screenShift);
    camera.position.copy(controls.target).addScaledVector(overviewCamDir, dist);
    // Closest zoom. /1.04 → ~10% more on-screen magnification than before:
    // perspective amplifies the closest clouds, so the distance moves less
    controls.minDistance = Math.max(8, (dist * 0.25) / 1.04);
    controls.maxDistance = dist * 5;
    controls.update();
  }

  function applyOverviewCamera() {
    const veilLock = !!landingIntro || pendingLandingIntro;
    const leaveUnveil = camTransition?.kind === "leave";
    // During level-change, keep controls off until the transition finishes
    controls.enabled = !veilLock && !camTransition;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    // Keep orbiting while overview fades in on go-back
    controls.autoRotate = (!camTransition || leaveUnveil) && !veilLock;
    // Stay white while waiting for / playing the landing intro.
    // Don't clear the level-change veil mid-transition.
    if (!camTransition) {
      if (!veilLock) setViewFade(0);
      else setViewFade(1);
    }
    if (!veilLock) resetOverviewMistWash();
    frameOverviewToFit();
    scene.fog = null;
    exploreRoot.visible = false;
    // Don't clobber an in-flight / pending base→peak reveal
    if (!veilLock) {
      for (const n of overviewNodes) {
        n.group.visible = true;
        n.group.scale.setScalar(1);
        if (n.cloudMat) {
          n.cloudMat.uniforms.uPointMul.value = POINT_MUL;
          n.cloudMat.uniforms.uDisp.value =
            DISP_MAX * OVERVIEW_CLOUD_SCALE * OVERVIEW_DISP_MUL;
          n.cloudMat.uniforms.uSpread.value = CLOUD_FAR_SPREAD;
        }
      }
      for (const m of checkpointMarkers) m.visible = true;
      for (const cp of checkpointPins) {
        cp.reveal = 1;
        cp.pin.style.opacity = "1";
        if (cp.label) cp.label.textContent = cp.targetText;
      }
    } else {
      for (const n of overviewNodes) n.group.visible = false;
      for (const m of checkpointMarkers) m.visible = false;
      for (const cp of checkpointPins) {
        cp.reveal = 0;
        cp.morphStart = null;
        cp.pin.style.opacity = "0";
        cp.pin.hidden = true;
      }
    }
    for (const n of exploreNodes) n.group.visible = false;
  }

  function applyExploreCamera() {
    controls.enabled = false;
    controls.autoRotate = false;
    camera.fov = EXPLORE_FOV_DEG;
    camera.near = 0.15;
    camera.far = 220;
    camera.updateProjectionMatrix();
    scene.fog = new THREE.Fog(nightMode ? 0x000000 : 0xffffff, FOG_NEAR_M, FOG_FAR_M);
    // Fixed POV looking straight ahead (−Z); content is laid out in camera space
    camera.position.set(0, EYE_H, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, EYE_H, -10);
    for (const n of overviewNodes) n.group.visible = false;
    for (const m of checkpointMarkers) m.visible = false;
    // Layout first so cards don't pop/reshuffle on the first visible frame
    exploreRoot.visible = false;
    updateExploreLayout();
    exploreRoot.visible = true;
  }

  /**
   * World size so portrait & landscape share the same limiting screen fraction
   * at any depth (same visual footprint when they reform).
   */
  function planeSizeForAspect(aspect) {
    const camA = Math.max(0.2, camera.aspect);
    const base = PHOTO_H;
    if (aspect >= camA) {
      // Wider than the view — width-limited
      const w = base * camA;
      return { w, h: w / aspect };
    }
    // Taller than the view — height-limited
    return { w: base * aspect, h: base };
  }

  function screenCoverFrac(planeW, planeH, depth) {
    const d = Math.max(0.25, depth);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const visibleH = 2 * d * Math.tan(vFov * 0.5);
    const visibleW = visibleH * Math.max(0.2, camera.aspect);
    return Math.max(planeW / visibleW, planeH / visibleH);
  }

  /** 0 = far exploded mist, 1 = fully reformed toward a solid photo */
  function reformAmount(coverFrac) {
    const u = THREE.MathUtils.clamp(
      (coverFrac - 0.04) / Math.max(0.05, REFORM_SCREEN_FRAC - 0.04),
      0,
      1
    );
    // Gentler S-curve so collapse of the cloud tracks the rising photo
    return u * u * (3 - 2 * u);
  }

  function smooth01(u) {
    const t = THREE.MathUtils.clamp(u, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Eye frame + camera world point for a walk position (scroll curve or autoplay ribbon) */
  function eyeAt(walk, autoplay, pos, tan, side, up, camOut) {
    const realEye = exploreToReal(walk);
    if (autoplay) sampleAutoplayLut(realEye, pos, tan, side, up);
    else writeFrame(realEye, pos, tan, side, up, "explore");
    const leadPad = Math.max(0, START_LEAD_M - walk);
    camOut
      .copy(pos)
      .addScaledVector(_worldUp, EYE_H)
      .addScaledVector(tan, -leadPad / Math.max(1e-6, PATH_COMPRESS));
  }

  const _pose = {};
  /**
   * Camera-space pose and screen cover of a card, seen from an eye frame.
   * Shared by the layout and by the checkpoint arrival search.
   */
  function cardPose(node, autoplay, eyeTan, eyeSide, eyeUp, camW, out) {
    const frame = autoplay ? node.placement.autoplayFrame : node.placement.exploreFrame;
    const { w: planeW, h: planeH } = planeSizeForAspect(node.aspect);

    // Center as the mist reforms into a readable card
    _photoWorld.copy(frame.pos).addScaledVector(_worldUp, EYE_H * 0.9);
    _delta.copy(_photoWorld).sub(camW).multiplyScalar(PATH_COMPRESS);
    const centerDepth = Math.max(0.25, -_delta.dot(eyeTan));
    const centerCover = screenCoverFrac(planeW, planeH, centerDepth);
    let centerT = 0;
    if (centerCover > REFORM_SCREEN_FRAC * 0.55) {
      const u = THREE.MathUtils.clamp(
        (centerCover - REFORM_SCREEN_FRAC * 0.55) / Math.max(0.05, REFORM_SCREEN_FRAC * 0.45),
        0,
        1
      );
      centerT = u * u * (3 - 2 * u);
    }
    const lateralNow = node.placement.lateral * (1 - centerT);

    _photoWorld
      .copy(frame.pos)
      .addScaledVector(frame.side, lateralNow)
      .addScaledVector(_worldUp, EYE_H * 0.9);
    _delta.copy(_photoWorld).sub(camW).multiplyScalar(PATH_COMPRESS);
    out.planeW = planeW;
    out.planeH = planeH;
    out.lx = _delta.dot(eyeSide);
    out.ly = _delta.dot(eyeUp) * 0.85;
    out.lz = -_delta.dot(eyeTan);
    out.yawNow = node.placement.yawJitter * (1 - centerT);
    out.viewDepth = Math.max(0.15, -out.lz);
    out.coverFrac = screenCoverFrac(planeW, planeH, out.viewDepth);
    return out;
  }

  let layoutStamp = 0;
  let layoutDirty = false;
  let reentryActive = false;
  function updateExploreLayout() {
    layoutDirty = false;
    const nowMs = performance.now();
    const layoutDt = lastLayoutMs ? Math.min(0.1, (nowMs - lastLayoutMs) / 1000) : 0;
    lastLayoutMs = nowMs;
    const snap = snapReentry;
    snapReentry = false;
    reentryActive = false;
    // exploreNodes follow padded dist order — scan forward, no full sort
    const stamp = ++layoutStamp;
    let aheadCount = 0;
    for (const node of exploreNodes) {
      const ahead = node.placement.dist - walkDist;
      if (ahead <= 0) continue;
      if (ahead >= SHOW_AHEAD_M) break;
      if (aheadCount >= MAX_VISIBLE_CARDS) break;
      aheadCount++;
      node.visStamp = stamp;
    }

    // Camera: autoplay uses LUT on the ultra-smooth ribbon; scroll uses explore curve
    eyeAt(walkDist, exploreAutoplay, _eyePos, _eyeTan, _eyeSide, _eyeUp, _camWorld);

    // Keep a fixed camera; place cards in camera-local space (stable scroll/autoplay)
    camera.position.set(0, EYE_H, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, EYE_H, -10);

    const cloudJobs = [];
    const maxClouds = exploreAutoplay ? AUTOPLAY_MAX_CLOUDS : MAX_ACTIVE_CLOUDS;
    // Nearest image that is fully formed (or still dissolving away)
    let formed = null;

    for (const node of exploreNodes) {
      const ahead = node.placement.dist - walkDist;
      const show = mode === "explore" && node.visStamp === stamp;

      if (!show || ahead <= 0 || ahead >= SHOW_AHEAD_M) {
        // Behind the camera = fully dissolved; far ahead = nothing to undo
        node.exitS = ahead <= 0 ? 1 : 0;
        node.group.visible = false;
        node.hiPlane.visible = false;
        node.hiPlane.scale.setScalar(1);
        node.hiPlane.material.opacity = 0;
        stopNodeVideo(node);
        continue;
      }

      // Precomputed frame at padded explore slot → camera-space pose + cover
      const pose = cardPose(node, exploreAutoplay, _eyeTan, _eyeSide, _eyeUp, _camWorld, _pose);
      const { planeW, planeH, lx, ly, lz, yawNow } = pose;
      // Geometry is PHOTO_H×aspect — scale mesh to the viewport-equalized footprint
      const baseScaleX = planeW / Math.max(1e-6, PHOTO_H * node.aspect);
      const baseScaleY = planeH / Math.max(1e-6, PHOTO_H);

      // Path fold this frame only — hide, but scroll-back can show it again
      if (lz > -0.12) {
        node.group.visible = false;
        node.hiPlane.visible = false;
        stopNodeVideo(node);
        continue;
      }

      node.group.visible = true;
      node.group.position.set(lx, EYE_H + ly, lz);
      const faceYaw = Math.atan2(lx, Math.max(0.2, -lz));
      node.group.rotation.set(0, faceYaw * 0.25 + yawNow, 0);
      node.group.renderOrder = Math.round(10 + Math.max(0, 200 - ahead));

      const viewDepth = pose.viewDepth;
      const coverFrac = pose.coverFrac;
      const reformT = reformAmount(coverFrac);
      // Fog opacity (0 far/fogged → 1 clear). Disp peaks at full opacity, then
      // collapses to 0 as the image reforms — driven by camera distance/cover.
      // 1 = fully fogged (far), 0 = clear — same band as shader entrance fog
      const fogT = THREE.MathUtils.clamp(
        (viewDepth - FOG_NEAR_M) / Math.max(1e-3, cloudFogFar - FOG_NEAR_M),
        0,
        1
      );
      const fogSmooth = fogT * fogT * (3 - 2 * fogT);
      const cloudOpacity = 1 - fogSmooth; // 100% when camera has cleared the fog band
      // Max disp at full opacity; collapses to 0 as the image forms
      const dispFactor = cloudOpacity * Math.pow(1 - reformT, 1.15);
      const depthCap = Math.max(0.35, viewDepth * 0.88);
      const disp = Math.min(dispFactor * DISP_MAX, depthCap, DISP_MAX);
      const cloudScale = THREE.MathUtils.lerp(CLOUD_FAR_SCALE, CLOUD_NEAR_SCALE, smooth01(reformT));
      const cloudSpread = THREE.MathUtils.lerp(CLOUD_FAR_SPREAD, 1, smooth01(reformT));

      // Fade in (with cloud) → hold 100% → linear dissolve at original pace
      const holdEnd = REFORM_SCREEN_FRAC + EXIT_HOLD_SPAN;
      let grow = 1;
      let planeOpacity = 0;
      let dissolving = false;
      if (coverFrac < REFORM_SCREEN_FRAC) {
        const u = THREE.MathUtils.clamp(
          (coverFrac - EXIT_FADE_IN_START) /
            Math.max(0.05, REFORM_SCREEN_FRAC - EXIT_FADE_IN_START),
          0,
          1
        );
        planeOpacity = u; // linear crossfade in
      } else if (coverFrac < holdEnd) {
        planeOpacity = 1;
      } else {
        dissolving = true;
        const exitU = THREE.MathUtils.clamp(
          (coverFrac - holdEnd) / Math.max(0.05, EXIT_DISSOLVE_SPAN),
          0,
          1
        );
        planeOpacity = 1 - exitU; // linear, full span like the original exit
        grow = 1 + exitU * 2.4;
      }

      // Re-entry pacing (scrolling back): the dissolve may follow the geometry
      // up instantly (forward), but comes back down at most 1/REENTRY_S per s.
      const exitTarget = dissolving ? 1 - planeOpacity : 0;
      const exitPrev = node.exitS ?? exitTarget;
      node.exitS =
        snap || exitTarget >= exitPrev
          ? exitTarget
          : Math.max(exitTarget, exitPrev - layoutDt / REENTRY_S);
      if (node.exitS > exitTarget + 1e-4) {
        reentryActive = true;
        dissolving = true;
        grow = 1 + node.exitS * 2.4;
        planeOpacity = Math.min(planeOpacity, 1 - node.exitS);
      }

      // Crossfade: keep mist until the real image is mostly opaque
      // Mid-flight, only photos already decoded flash by (no low-res stand-ins)
      const showPlane = planeOpacity > 0.02 && (!winding || node.hiState === HI_READY);
      const showCloud = !!node.dissolveTex && reformT < 0.995 && planeOpacity < 0.92;

      if (showCloud) {
        cloudJobs.push({
          node,
          ahead,
          disp,
          spread: cloudSpread,
          scale: cloudScale,
          planeW,
          planeH,
        });
      }

      const order = Math.round(8 + Math.max(0, 180 - ahead));
      if (showPlane) {
        node.hiPlane.visible = true;
        syncNodeMap(node);
        node.hiPlane.scale.set(baseScaleX * grow, baseScaleY * grow, 1);
        node.hiPlane.material.opacity = planeOpacity;
        node.hiPlane.material.transparent = planeOpacity < 0.99;
        node.hiPlane.material.depthWrite = planeOpacity > 0.9;
        node.hiPlane.renderOrder = order;
        if (node.isVideo) {
          if (planeOpacity > 0.55 && ahead >= 0.35 && grow <= 3.1 && !winding) playNodeVideo(node, planeOpacity);
          else if (dissolving || planeOpacity < 0.4) stopNodeVideo(node);
        }
        // Only cull when truly past the card — not during fade-in (opacity near 0)
        if (ahead < 0.35 || grow > 3.1 || (dissolving && planeOpacity < 0.04)) {
          node.group.visible = false;
          node.hiPlane.visible = false;
          stopNodeVideo(node);
        } else if (dissolving ? planeOpacity > 0.05 : planeOpacity >= 0.95) {
          formed ??= node.placement;
        }
      } else {
        node.hiPlane.visible = false;
        node.hiPlane.scale.set(baseScaleX, baseScaleY, 1);
        node.hiPlane.material.opacity = 0;
        stopNodeVideo(node);
      }
    }

    onExploreProgress?.({
      walkDist,
      // Mid-flight the image info stays hidden (it would flicker through ids)
      formedItem: winding ? null : (formed?.item ?? null),
      formedIndex: winding ? -1 : (formed?.index ?? -1),
      total: countedTotal,
      atEnd: walkDist >= outroRevealDist,
      stats: walkStats(walkDist),
    });

    // Prefer near collapsing clouds + far mist
    cloudJobs.sort((a, b) => a.ahead - b.ahead);
    const nearSlots = Math.min(5, maxClouds);
    const near = cloudJobs.slice(0, nearSlots);
    const far = cloudJobs.slice(nearSlots).sort((a, b) => b.ahead - a.ahead);
    const picked = near.concat(far).slice(0, maxClouds);

    for (let i = 0; i < cloudPool.length; i++) {
      const job = picked[i];
      if (job) {
        applyCloudSlot(cloudPool[i], job.node, job);
        cloudPool[i].pts.renderOrder = 45 + i;
      } else {
        cloudPool[i].pts.visible = false;
      }
    }

    // While winding, decode around the destination, not the photos flashing by
    updateHiStreaming(winding ? winding.to : walkDist);
  }

  function setMode(next, { animate = true, endWalk = 0, pan = true } = {}) {
    const target = next === "explore" ? "explore" : "overview";
    checkpointEnterArmed = false;
    cancelPendingJump();
    cancelWinding();
    setHover(null);
    // Only abort the landing reveal when leaving overview (e.g. Explore CTA)
    if (landingIntro && target !== "overview") finishLandingIntro();
    if (target === "explore" && mode === "overview" && animate && !camTransition) {
      mode = "explore";
      container.dataset.mode = mode;
      beginEnterExplore(endWalk, { pan });
      // Page mode/chrome switches later under black (handoffToExplore → onModeChange)
      return mode;
    }
    if (target === "overview" && mode === "explore" && animate && !camTransition) {
      // Keep explore rendering until black handoff; no camera pan
      beginLeaveExplore();
      return mode;
    }
    cancelCamTransition();
    mode = target;
    container.dataset.mode = mode;
    setExploreAutoplay(false);
    for (const n of exploreNodes) stopNodeVideo(n);
    if (mode === "explore") {
      walkDist = THREE.MathUtils.clamp(endWalk, 0, exploreTotal);
      resetWalkMotion();
      for (const slot of cloudPool) slot.pts.visible = false;
      startHiPrefetch();
      applyExploreCamera();
    } else {
      applyOverviewCamera();
    }
    onModeChange?.(mode);
    return mode;
  }

  // Scroll moves images. Steps accumulate into scrollTarget (trackpads fire
  // several per frame); tick eases walkDist toward it and lays out once.
  function onWheel(e) {
    if (mode !== "explore" || camTransition) return;
    e.preventDefault();
    if (winding) return; // the flight owns the walk until it lands
    if (exploreAutoplay) setExploreAutoplay(false);
    const step = Math.sign(e.deltaY) * Math.min(4.5, Math.abs(e.deltaY) * 0.02);
    scrollTarget = THREE.MathUtils.clamp((scrollTarget ?? walkDist) + step, 0, exploreTotal);
    layoutDirty = true;
  }
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  // Picking + hover coordinate readout (overview) — the readout itself lives
  // in the page UI, we only report which item is under the pointer
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hover = null;
  let downX = 0;
  let downY = 0;

  function setHover(next) {
    if (hover === next) return;
    if (hover && !hover.userData.checkpoint) {
      hover.scale.setScalar(hover.userData.baseScale ?? 1);
    }
    hover = next;
    // Overview photos are not clickable — only unlocked checkpoints are
    const clickableCheckpoint =
      hover?.userData?.checkpoint && isCheckpointUnlocked(hover.userData.checkpointIndex);
    container.style.cursor = clickableCheckpoint
      ? "pointer"
      : mode === "explore"
        ? "default"
        : "grab";
    onHoverItem?.(hover?.userData?.item ?? null);
  }

  // Pointer moves are coalesced: the hover raycast runs once per frame
  let pendingPointer = null;
  const pickables = [];
  function onPointerMove(e) {
    if (mode === "explore" || camTransition || landingIntro) {
      pendingPointer = null;
      setHover(null);
      return;
    }
    pendingPointer ??= { x: 0, y: 0 };
    pendingPointer.x = e.clientX;
    pendingPointer.y = e.clientY;
  }

  function processPendingPointer() {
    if (!pendingPointer) return;
    const { x, y } = pendingPointer;
    pendingPointer = null;
    if (mode === "explore" || camTransition || landingIntro) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((x - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((y - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    pickables.length = 0;
    for (const b of checkpointMarkers) if (b.visible) pickables.push(b);
    for (const b of overviewBillboards) if (b.visible) pickables.push(b);
    const hits = raycaster.intersectObjects(pickables, false);
    setHover(hits[0]?.object || null);
  }

  function onPointerLeave() {
    pendingPointer = null;
    setHover(null);
  }

  function onPointerDown(e) {
    downX = e.clientX;
    downY = e.clientY;
  }

  function onClick(e) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    if (camTransition || landingIntro) return;
    processPendingPointer(); // hover must reflect the latest move
    if (mode === "explore") {
      // pick nearest visible explore plane
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const meshes = exploreNodes.filter((n) => n.hiPlane.visible).map((n) => n.hiPlane);
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits[0]?.object?.userData?.item) onSelect?.(hits[0].object.userData.item);
      return;
    }
    // Overview: checkpoints jump into the walk; photos are not opened from here
    if (hover?.userData?.checkpoint) {
      if (isCheckpointUnlocked(hover.userData.checkpointIndex)) goToCheckpoint(hover.userData.item.id);
    }
  }

  // Page in the background: silence and free the videos (decoders + buffers),
  // pause the prefetch. A light background tab is far less likely to be
  // discarded by the browser — which is what reloaded the page on return.
  function onVisibilityChange() {
    if (document.hidden) {
      setMediaSuspended("hidden", true);
      for (const n of videoNodes) releaseVideo(n);
      return;
    }
    setMediaSuspended("hidden", false);
    streamDirty = true; // re-creates the videos near the walker
    layoutDirty = true;
    for (const resume of prefetchWaiters.splice(0)) resume();
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  // GPU context restored: photos dropped their CPU copy after upload, so they
  // are released and streamed in again
  function onContextRestored() {
    for (const n of exploreNodes) if (n.hiState !== HI_IDLE || n.fallbackTex || n.video) releaseHi(n);
    streamDirty = true;
    layoutDirty = true;
  }
  renderer.domElement.addEventListener("webglcontextrestored", onContextRestored);

  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  renderer.domElement.addEventListener("click", onClick);

  function resize() {
    const w = container.clientWidth;
    const h = Math.max(container.clientHeight, 320);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    const halfH = h * 0.5;
    for (const slot of cloudPool) slot.mat.uniforms.uScale.value = halfH;
    for (const n of overviewNodes) {
      n.group.traverse((obj) => {
        if (obj.isPoints && obj.material?.uniforms?.uScale) {
          obj.material.uniforms.uScale.value = halfH;
        }
      });
    }
    if (camTransition) {
      /* keep frustum; pose driven by transition */
    } else if (mode === "overview") frameOverviewToFit();
    else if (mode === "explore") updateExploreLayout();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const cloudClock = new THREE.Clock();
  let raf = 0;
  let lastTickMs = 0;
  function tick() {
    raf = requestAnimationFrame(tick);
    const tickMs = performance.now();
    const frameDt = lastTickMs ? Math.min(0.1, (tickMs - lastTickMs) / 1000) : 1 / 60;
    lastTickMs = tickMs;
    processPendingPointer();
    if (pendingJump && (pendingJumpReady() || performance.now() >= pendingJump.deadline)) {
      applyPendingJump();
    }
    if (landingIntro) {
      tickLandingIntro(performance.now());
    } else if (camTransition) {
      tickCamTransition(performance.now());
    } else if (mode === "overview") {
      controls.update();
      const t = cloudClock.getElapsedTime();
      for (const mat of overviewCloudMats) mat.uniforms.uTime.value = t;
      for (const m of checkpointMarkers) {
        m.quaternion.copy(camera.quaternion);
      }
    } else if (mode === "explore") {
      const t = cloudClock.getElapsedTime();
      for (const slot of cloudPool) {
        if (!slot.pts.visible) continue;
        slot.mat.uniforms.uTime.value = t;
      }
      if (winding) {
        tickWinding(performance.now());
      } else if (exploreAutoplay) {
        const now = performance.now();
        const dt = Math.min(1 / 30, Math.max(0, (now - autoplayLastMs) / 1000));
        autoplayLastMs = now;
        const speed = exploreAutoplaySpeed();
        autoplayTargetWalk = Math.min(
          exploreTotal,
          autoplayOriginWalk + speed * Math.max(0, (now - autoplayOriginMs) / 1000)
        );
        // Exp damp toward linear target (tau ≈ 0.12s) + hard cap ≈ cruise speed
        const alpha = 1 - Math.exp(-dt / 0.12);
        const desired = walkDist + (autoplayTargetWalk - walkDist) * alpha;
        const maxStep = speed * dt * 1.08;
        const step = THREE.MathUtils.clamp(desired - walkDist, 0, maxStep);
        walkDist = Math.min(exploreTotal, walkDist + step);
        if (autoplayTargetWalk - walkDist > speed * 1.25) {
          autoplayOriginWalk = walkDist;
          autoplayOriginMs = now;
          autoplayTargetWalk = walkDist;
        }
        updateExploreLayout();
        if (walkDist >= exploreTotal - 1e-3) setExploreAutoplay(false);
      } else {
        if (scrollTarget != null) {
          const dt = frameDt;
          walkDist += (scrollTarget - walkDist) * (1 - Math.exp(-dt / SCROLL_EASE_S));
          if (Math.abs(scrollTarget - walkDist) < 0.005) {
            walkDist = scrollTarget;
            scrollTarget = null;
          }
          layoutDirty = true;
        }
        if (layoutDirty || reentryActive) updateExploreLayout();
      }
    }
    tickHiStreaming();
    pumpHiUploads();
    // During level-change, tickCamTransition owns pin visibility
    if (!camTransition) updateCheckpointPins();
    renderer.render(scene, camera);
  }

  // Boot — hold white until media is ready, then play the landing intro
  setViewFade(1);
  applyOverviewCamera();
  controls.enabled = false;
  tick();
  // Upload every cloud map and compile the shaders behind the opaque white
  // veil, so neither the base→peak reveal nor the first explore frame stalls
  // on first use. Nothing is drawn here.
  async function prewarmOverview() {
    for (const n of overviewNodes) {
      const map = n.cloudMat?.uniforms.uColor.value;
      if (map) renderer.initTexture(map);
    }
    // compile() walks the whole scene, visible or not. A temporary fog makes
    // the explore photo planes compile in their final (fogged) variant.
    const fog = scene.fog;
    let compiled = null;
    try {
      scene.fog = new THREE.Fog(0xffffff, FOG_NEAR_M, FOG_FAR_M);
      compiled = renderer.compileAsync(scene, camera);
    } catch {
      /* compile on first use instead */
    } finally {
      scene.fog = fog;
    }
    if (compiled) {
      await Promise.race([compiled.catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    }
  }

  buildMediaVisuals().then(async () => {
    await prewarmOverview();
    try {
      await beforeIntro?.();
    } catch {
      /* never block the landing on the loading screen */
    }
    container.dataset.ready = "true";
    if (mode === "explore") {
      pendingLandingIntro = false;
      setMode("explore", { animate: false });
      resize();
      onIntroComplete?.();
      return;
    }
    // Keep veilLock through setMode so the full mass never paints for a frame
    setMode("overview", { animate: false });
    resize();
    beginLandingIntro();
  });

  window.__PP_DEBUG = () => {
    const visible = exploreNodes
      .filter((n) => n.group.visible)
      .slice(0, 6)
      .map((n) => ({
        id: n.placement.item.id,
        ahead: +(n.placement.dist - walkDist).toFixed(2),
        op: n.hiPlane.visible ? +n.hiPlane.material.opacity.toFixed(3) : 0,
        pos: n.group.position.toArray().map((v) => +v.toFixed(2)),
      }));
    const clouds = cloudPool
      .filter((s) => s.pts.visible)
      .map((s) => ({
        disp: +s.mat.uniforms.uDisp.value.toFixed(2),
        pos: s.pts.position.toArray().map((v) => +v.toFixed(2)),
      }));
    const tight = placements
      .slice(0, -1)
      .map((p, i) => ({
        a: p.item.id,
        b: placements[i + 1].item.id,
        natural: +(placements[i + 1].naturalDist - p.naturalDist).toFixed(2),
        padded: +(placements[i + 1].dist - p.dist).toFixed(2),
      }))
      .filter((g) => g.natural < MIN_EXPLORE_GAP_M)
      .slice(0, 20);
    return {
      mode,
      walkDist,
      exploreTotal,
      compress: PATH_COMPRESS,
      minGap: +MIN_EXPLORE_GAP_M.toFixed(2),
      paddedPairs: tight.length,
      tightSample: tight,
      clouds,
      nodes: exploreNodes.length,
      firstDist: placements[0]?.dist ?? null,
      visible,
    };
  };

  return {
    setMode,
    getMode: () => mode,
    setExploreAutoplay,
    getExploreAutoplay: () => exploreAutoplay,
    setExploreAutoplaySpeed,
    getExploreAutoplaySpeed: () => autoplaySpeedMul,
    getCheckpoints,
    goToCheckpoint,
    setUnlockedCheckpoints,
    setMediaSuspended,
    setNightMode(on) {
      nightMode = !!on;
      applyBackground();
      if (mode === "explore" && scene.fog) {
        scene.fog.color.setHex(nightMode ? 0x000000 : 0xffffff);
      }
      return nightMode;
    },
    getNightMode: () => nightMode,
    dispose() {
      cancelAnimationFrame(raf);
      landingIntro = null;
      cancelCamTransition();
      cancelPendingJump();
      ro.disconnect();
      const el = renderer.domElement;
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("click", onClick);
      el.removeEventListener("webglcontextrestored", onContextRestored);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const n of exploreNodes) releaseHi(n);
      controls.dispose();
      renderer.dispose();
      el.remove();
      fadeEl.remove();
      for (const { pin } of checkpointPins) pin.remove();
    },
  };
}
