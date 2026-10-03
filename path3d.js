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
// Aspect preserved per photo; denser than the old fixed 308×184 (~37% more pts @ 3:2).
const CLOUD_LONG_SIDE = 360;
const MAX_ACTIVE_CLOUDS = 12;
const SHOW_AHEAD_M = 120;
const MAX_VISIBLE_CARDS = 22;
// Soft white fog — cards ease in from the distance
const FOG_NEAR_M = 32;
const FOG_FAR_M = 110;
// Far = fully exploded mist; approaches 0 as the photo reforms
const DISP_MAX = PHOTO_H * 2.475;
// Reform target (limiting side vs viewport) — solid reads clearly around here
const REFORM_SCREEN_FRAC = 0.38;
// Far clouds are oversized mist; they shrink to the photo footprint as they reform
const CLOUD_FAR_SCALE = 5.1;
const CLOUD_NEAR_SCALE = 1;
const CLOUD_FAR_SPREAD = 1.45;
// Light GPS denoise only — keep real bends, just kill harsh spikes
const PATH_SMOOTH_PASSES = 1;
const PATH_SMOOTH_RADIUS = 2;

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

  return { pts, cum, total, atDistance, distanceAtTime };
}

/** Light moving-average denoise for explore POV — preserves path shape */
function buildExploreCurve(pathPts) {
  if (pathPts.length < 2) return null;
  let pts = pathPts.map((p) => p.pos.clone());
  for (let pass = 0; pass < PATH_SMOOTH_PASSES; pass++) {
    const next = pts.map((p) => p.clone());
    for (let i = 0; i < pts.length; i++) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      let wsum = 0;
      for (let k = -PATH_SMOOTH_RADIUS; k <= PATH_SMOOTH_RADIUS; k++) {
        const j = THREE.MathUtils.clamp(i + k, 0, pts.length - 1);
        const w = PATH_SMOOTH_RADIUS + 1 - Math.abs(k);
        ax += pts[j].x * w;
        ay += pts[j].y * w;
        az += pts[j].z * w;
        wsum += w;
      }
      next[i].set(ax / wsum, ay / wsum, az / wsum);
    }
    pts = next;
  }
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.15);
}

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function loadTexture(url, loader, { forCloud = false } = {}) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        if (forCloud) {
          // Display-referred sampling for custom Points shader (no HW sRGB decode).
          // MeshBasic pc plane uses a SRGBColorSpace clone — see buildMediaVisuals.
          tex.colorSpace = THREE.NoColorSpace;
          tex.generateMipmaps = false;
          tex.minFilter = THREE.NearestFilter;
          tex.magFilter = THREE.NearestFilter;
          tex.flipY = true; // same as MeshBasic plane
        } else {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
        }
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
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
      uniform vec2 uPlane;
      varying vec3 vColor;
      varying float vFog;
      void main() {
        vec3 pos = vec3(
          (aUv.x - 0.5) * uPlane.x * uSpread,
          (aUv.y - 0.5) * uPlane.y * uSpread,
          0.0
        );
        vec3 color = texture2D(uColor, aUv).rgb;
        float lum = dot(color, vec3(0.299, 0.587, 0.114));
        pos.z = (lum - 0.5) * uDisp;
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

export function initPath3D({ container, data, onSelect, initialMode = "overview" }) {
  if (!container || !data?.track?.length) return null;

  let mode = initialMode === "explore" ? "explore" : "overview";
  const track = data.track.filter((p) => p.ele != null);
  const media = (data.media || [])
    .filter((m) => m.time && m.lat != null && m.lon != null && m.ele != null)
    .slice()
    .sort((a, b) => a.time.localeCompare(b.time));

  const { toVec3 } = projectFactory(track);
  const path = buildPath(track, toVec3);

  // Heavily smoothed + exaggerated curve for explore POV (overview keeps raw path)
  const exploreCurve = buildExploreCurve(path.pts);
  const exploreCurveLen = exploreCurve?.getLength() || path.total;

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
  function writeFrame(realDist, pos, tan, side, up, useExploreCurve = true) {
    const d = THREE.MathUtils.clamp(realDist, 0, path.total);
    const curve = useExploreCurve ? exploreCurve : null;
    const curveLen = useExploreCurve ? exploreCurveLen : 0;
    if (curve && curveLen > 1e-3) {
      const u = THREE.MathUtils.clamp(d / path.total, 0, 1);
      // Modest tangent blend — softens spikes without flattening bends
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
    side.crossVectors(tan, _worldUp);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    up.crossVectors(side, tan).normalize();
  }

  function exploreToReal(exploreDist) {
    // Lead-in sits before path start; then map compressed explore → real meters
    return Math.max(0, exploreDist - START_LEAD_M) / PATH_COMPRESS;
  }

  // Place each photo at time-accurate path distance, offset off-center (no phone GPS)
  const placements = media.map((item) => {
    const realDist = path.distanceAtTime(item.time);
    const naturalDist = realDist * PATH_COMPRESS + START_LEAD_M;
    // Overview uses raw path; explore framing uses smoothed curve at runtime
    writeFrame(realDist, _pPos, _pTan, _pSide, _pUp, false);
    const pos = _pPos.clone();
    const tangent = _pTan.clone();
    const side = _pSide.clone();

    const h1 = hash01(item.id + ":side");
    const h2 = hash01(item.id + ":mag");
    const lateral = (h1 < 0.5 ? -1 : 1) * (1.4 + h2 * 4.2); // 1.4–5.6 m off path
    const yawJitter = (hash01(item.id + ":yaw") - 0.5) * 0.4; // radians

    const world = pos
      .clone()
      .addScaledVector(side, lateral)
      .add(new THREE.Vector3(0, EYE_H * 0.85, 0));

    return {
      item,
      dist: naturalDist,
      naturalDist,
      realDist,
      world,
      tangent,
      side,
      lateral,
      yawJitter,
    };
  });

  const exploreTotal = Math.max(
    path.total * PATH_COMPRESS + START_LEAD_M,
    (placements[placements.length - 1]?.dist ?? 0) + START_AHEAD_M + 8
  );

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(55, 1, 0.15, 6000);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    // logarithmicDepthBuffer breaks Points / gl_PointSize — keep off for the cloud
  });
  renderer.setClearColor(0xffffff, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.sortObjects = true;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.background = "#fff";

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  const stopAuto = () => {
    controls.autoRotate = false;
  };
  controls.addEventListener("start", stopAuto);

  scene.add(new THREE.AmbientLight(0xffffff, 1));

  // Wikiloc path line (ground-level polyline)
  const pathCurve = new THREE.CatmullRomCurve3(
    path.pts.map((p) => p.pos.clone()),
    false,
    "catmullrom",
    0.05
  );
  const pathTube = new THREE.Mesh(
    new THREE.TubeGeometry(pathCurve, Math.min(1200, path.pts.length * 2), 1.4, 6, false),
    new THREE.MeshBasicMaterial({ color: 0x222222 })
  );
  pathTube.renderOrder = -10;
  pathTube.visible = false; // hidden for now
  scene.add(pathTube);

  // Subtle start / end markers
  const markGeo = new THREE.SphereGeometry(3.2, 16, 16);
  const startMark = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: 0x1f6f5b }));
  const endMark = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: 0x8b3a2f }));
  startMark.position.copy(path.pts[0].pos).y += 1.2;
  endMark.position.copy(path.pts[path.pts.length - 1].pos).y += 1.2;
  scene.add(startMark, endMark);

  // Explore rig: fixed camera looking -Z; images move toward the viewer
  const exploreRoot = new THREE.Group();
  exploreRoot.visible = false;
  scene.add(exploreRoot);

  const explorePathGeo = new THREE.BufferGeometry();
  const explorePathLine = new THREE.Line(
    explorePathGeo,
    new THREE.LineBasicMaterial({ color: 0x222222 })
  );
  explorePathLine.visible = false;
  exploreRoot.add(explorePathLine);

  const loader = new THREE.TextureLoader();
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
  let pointMul = 1;
  // Pool of clouds — several photos can dissolve together
  const cloudPool = Array.from({ length: MAX_ACTIVE_CLOUDS }, (_, i) => {
    const mat = makeCloudMaterial(placeholderTex, 1);
    mat.uniforms.uScale.value = (container.clientHeight || 800) * 0.5;
    mat.uniforms.uPointMul.value = pointMul;
    const pts = new THREE.Points(cloudGeoFor(CLOUD_LONG_SIDE, CLOUD_LONG_SIDE), mat);
    pts.visible = false;
    pts.frustumCulled = false;
    pts.renderOrder = 40 + i;
    exploreRoot.add(pts);
    return { pts, mat };
  });

  function setPointMul(mul) {
    pointMul = THREE.MathUtils.clamp(Number(mul) || 1, 0.25, 3);
    for (const slot of cloudPool) {
      slot.mat.uniforms.uPointMul.value = pointMul;
      slot.mat.uniformsNeedUpdate = true;
    }
    if (mode === "explore") updateExploreLayout();
    return pointMul;
  }

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
    // Match scene fog band; bias far entrance with explore ahead distance
    const fogFar = Math.min(FOG_FAR_M, SHOW_AHEAD_M * 0.95);
    const fogNear = FOG_NEAR_M;
    mat.uniforms.uFogNear.value = fogNear;
    mat.uniforms.uFogFar.value = fogFar;
    // Extra wash when just entering the visible ahead window
    if (ahead != null && ahead > fogNear) {
      const enter = THREE.MathUtils.clamp(
        (ahead - fogNear) / Math.max(1, fogFar - fogNear),
        0,
        1
      );
      // Push effective fog so brand-new clouds read as mist first
      mat.uniforms.uFogNear.value = THREE.MathUtils.lerp(fogNear, fogNear * 0.35, enter);
    }
    mat.uniformsNeedUpdate = true;
  }

  const overviewBillboards = [];
  const exploreNodes = []; // { placement, plane, group, tex, aspect }
  const pickables = [];
  const planeGeoCache = new Map(); // aspect key → geometry

  let walkDist = 0;
  let layoutRaf = 0;

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

  function playNodeVideo(node) {
    const v = node.video;
    if (!v || node.videoPlaying) return;
    const p = v.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        node.videoPlaying = true;
      }).catch(() => {
        node.videoPlaying = false;
      });
    } else {
      node.videoPlaying = true;
    }
  }

  async function buildMediaVisuals() {
    // pc = aspect-correct × CLOUD_LONG_SIDE; photos fade md, videos play after reform
    const jobs = placements.map(async (placement) => {
      const { item } = placement;
      const isVideo = item.kind === "video";
      const cardUrl = item.thumb || item.poster || item.md || item.src;
      const cloudUrl = item.pc || item.poster || item.md || item.thumb || item.src;
      const hiUrl = isVideo ? null : item.md || item.thumb || item.src;

      const texP = loadTexture(cardUrl, loader);
      const cloudP = loadTexture(cloudUrl, loader, { forCloud: true });
      const hiP = hiUrl ? loadTexture(hiUrl, loader) : Promise.resolve(null);
      const [tex, cloudTex, hiTex] = await Promise.all([texP, cloudP, hiP]);

      let video = null;
      let videoTex = null;
      if (isVideo && item.src) {
        video = makeVideoElement(item.src);
        await new Promise((resolve) => {
          const done = () => resolve();
          video.addEventListener("loadeddata", done, { once: true });
          video.addEventListener("error", done, { once: true });
          // Some browsers need an explicit load()
          try {
            video.load();
          } catch {
            /* ignore */
          }
          // Fallback if already cached
          if (video.readyState >= 2) resolve();
        });
        try {
          video.pause();
          video.currentTime = 0;
        } catch {
          /* ignore */
        }
        videoTex = new THREE.VideoTexture(video);
        videoTex.colorSpace = THREE.SRGBColorSpace;
        videoTex.minFilter = THREE.LinearFilter;
        videoTex.magFilter = THREE.LinearFilter;
        videoTex.generateMipmaps = false;
      }

      const dissolveTex = cloudTex || tex;
      const hiMap = videoTex || hiTex || tex;
      // MeshBasic + NoColorSpace + output sRGB = too bright (treated as linear).
      let pcMap = dissolveTex;
      if (dissolveTex && dissolveTex.colorSpace !== THREE.SRGBColorSpace) {
        pcMap = dissolveTex.clone();
        pcMap.colorSpace = THREE.SRGBColorSpace;
        pcMap.needsUpdate = true;
      }
      const aspect = tex?.image
        ? (tex.image.width || 4) / (tex.image.height || 3)
        : item.width && item.height
          ? item.width / item.height
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

      const overviewMat = new THREE.MeshBasicMaterial({
        map: tex,
        color: tex ? 0xffffff : 0x888888,
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        toneMapped: false,
        fog: false,
      });

      const ov = new THREE.Mesh(planeGeoFor(clamped), overviewMat);
      ov.scale.setScalar(8);
      ov.position.copy(placement.world);
      ov.position.y += 2;
      ov.userData.item = item;
      scene.add(ov);
      overviewBillboards.push(ov);
      pickables.push(ov);

      const group = new THREE.Group();
      const pcMat = new THREE.MeshBasicMaterial({
        map: pcMap,
        color: pcMap ? 0xffffff : 0x888888,
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        toneMapped: false,
        fog: true,
      });
      const pcPlane = new THREE.Mesh(planeGeoFor(clamped), pcMat);
      pcPlane.userData.item = item;
      const hiMat = new THREE.MeshBasicMaterial({
        map: hiMap,
        color: hiMap ? 0xffffff : 0x888888,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        toneMapped: false,
        fog: true,
      });
      const hiPlane = new THREE.Mesh(planeGeoFor(clamped), hiMat);
      hiPlane.userData.item = item;
      group.add(pcPlane);
      group.add(hiPlane);
      group.visible = false;
      exploreRoot.add(group);
      exploreNodes.push({
        placement,
        plane: hiPlane,
        pcPlane,
        hiPlane,
        group,
        tex,
        dissolveTex,
        video,
        videoTex,
        videoPlaying: false,
        isVideo,
        cloudW,
        cloudH,
        aspect: clamped,
        cardUrl,
        cloudUrl,
      });
      pickables.push(hiPlane, pcPlane);
    });
    await Promise.all(jobs);
  }

  const box = new THREE.Box3().setFromPoints(placements.map((p) => p.world));
  const overviewCenter = box.getCenter(new THREE.Vector3());
  const overviewSize = box.getSize(new THREE.Vector3());
  const overviewRadius = Math.max(overviewSize.x, overviewSize.y, overviewSize.z, 80) * 0.75;
  const overviewCamPos = new THREE.Vector3(
    overviewCenter.x + overviewRadius * 0.85,
    overviewCenter.y + overviewRadius * 0.45,
    overviewCenter.z + overviewRadius * 0.95
  );

  function applyOverviewCamera() {
    controls.enabled = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    controls.autoRotate = true;
    controls.minDistance = 8;
    controls.maxDistance = 4000;
    camera.fov = 48;
    camera.near = 0.5;
    camera.far = 8000;
    camera.updateProjectionMatrix();
    camera.position.copy(overviewCamPos);
    controls.target.copy(overviewCenter);
    controls.update();
    scene.fog = null;
    pathTube.visible = false;
    startMark.visible = false;
    endMark.visible = false;
    exploreRoot.visible = false;
    for (const b of overviewBillboards) b.visible = true;
    for (const n of exploreNodes) n.group.visible = false;
  }

  function applyExploreCamera() {
    controls.enabled = false;
    controls.autoRotate = false;
    camera.fov = 62;
    camera.near = 0.15;
    camera.far = 220;
    camera.updateProjectionMatrix();
    scene.fog = new THREE.Fog(0xffffff, FOG_NEAR_M, FOG_FAR_M);
    // Fixed POV looking straight ahead (−Z)
    camera.position.set(0, EYE_H, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, EYE_H, -10);
    pathTube.visible = false;
    startMark.visible = false;
    endMark.visible = false;
    for (const b of overviewBillboards) b.visible = false;
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

  function updateExploreLayout() {
    // Bidirectional: ahead>0 visible; scroll back restores images.
    const ranked = [];
    for (const node of exploreNodes) {
      ranked.push({ node, ahead: node.placement.dist - walkDist });
    }
    ranked.sort((a, b) => a.ahead - b.ahead);

    const visibleSet = new Set();
    let aheadCount = 0;
    for (const row of ranked) {
      if (row.ahead <= 0 || row.ahead >= SHOW_AHEAD_M) continue;
      if (aheadCount >= MAX_VISIBLE_CARDS) continue;
      aheadCount++;
      visibleSet.add(row.node);
    }

    // Camera on smoothed explore curve. During lead-in, pull back along the
    // start tangent so cards stay fixed in world space (no Z reshuffle).
    writeFrame(exploreToReal(walkDist), _eyePos, _eyeTan, _eyeSide, _eyeUp, true);
    const leadPad = Math.max(0, START_LEAD_M - walkDist);
    _camWorld
      .copy(_eyePos)
      .addScaledVector(_worldUp, EYE_H)
      .addScaledVector(_eyeTan, -leadPad / Math.max(1e-6, PATH_COMPRESS));

    const cloudJobs = [];

    for (const node of exploreNodes) {
      const ahead = node.placement.dist - walkDist;
      const show = mode === "explore" && visibleSet.has(node);

      if (!show || ahead <= 0) {
        node.group.visible = false;
        node.pcPlane.visible = false;
        node.hiPlane.visible = false;
        node.pcPlane.scale.setScalar(1);
        node.hiPlane.scale.setScalar(1);
        node.hiPlane.material.opacity = 0;
        stopNodeVideo(node);
        continue;
      }

      // Frame at padded explore slot (not raw path dist) so timeline gaps work
      writeFrame(exploreToReal(node.placement.dist), _pPos, _pTan, _pSide, _pUp, true);

      const { w: planeW, h: planeH } = planeSizeForAspect(node.aspect);
      // Geometry is PHOTO_H×aspect — scale mesh to the viewport-equalized footprint
      const baseScaleX = planeW / Math.max(1e-6, PHOTO_H * node.aspect);
      const baseScaleY = planeH / Math.max(1e-6, PHOTO_H);

      // Center as the mist reforms into a readable card
      _photoWorld.copy(_pPos).addScaledVector(_worldUp, EYE_H * 0.9);
      _delta.copy(_photoWorld).sub(_camWorld).multiplyScalar(PATH_COMPRESS);
      const centerDepth = Math.max(0.25, -_delta.dot(_eyeTan));
      const centerCover = screenCoverFrac(planeW, planeH, centerDepth);
      let centerT = 0;
      if (centerCover > REFORM_SCREEN_FRAC * 0.55) {
        const u = THREE.MathUtils.clamp(
          (centerCover - REFORM_SCREEN_FRAC * 0.55) /
            Math.max(0.05, REFORM_SCREEN_FRAC * 0.45),
          0,
          1
        );
        centerT = u * u * (3 - 2 * u);
      }
      const lateralNow = node.placement.lateral * (1 - centerT);
      const yawNow = node.placement.yawJitter * (1 - centerT);

      _photoWorld
        .copy(_pPos)
        .addScaledVector(_pSide, lateralNow)
        .addScaledVector(_worldUp, EYE_H * 0.9);

      _delta.copy(_photoWorld).sub(_camWorld).multiplyScalar(PATH_COMPRESS);
      const lx = _delta.dot(_eyeSide);
      const ly = _delta.dot(_eyeUp) * 0.85;
      const lz = -_delta.dot(_eyeTan);

      // Path fold this frame only — hide, but scroll-back can show it again
      if (lz > -0.12) {
        node.group.visible = false;
        node.pcPlane.visible = false;
        node.hiPlane.visible = false;
        stopNodeVideo(node);
        continue;
      }

      node.group.visible = true;
      node.group.position.set(lx, EYE_H + ly, lz);
      const faceYaw = Math.atan2(lx, Math.max(0.2, -lz));
      node.group.rotation.set(0, faceYaw * 0.25 + yawNow, 0);
      node.group.renderOrder = Math.round(10 + Math.max(0, 200 - ahead));

      const viewDepth = Math.max(0.15, -lz);
      const coverFrac = screenCoverFrac(planeW, planeH, viewDepth);
      const reformT = reformAmount(coverFrac);
      // Collapse mist first; pc plane only once displacement is done
      const dispFactor = Math.pow(1 - reformT, 1.15);
      const depthCap = Math.max(0.35, viewDepth * 0.88);
      const disp = Math.min(dispFactor * DISP_MAX, depthCap, DISP_MAX);
      const cloudScale = THREE.MathUtils.lerp(CLOUD_FAR_SCALE, CLOUD_NEAR_SCALE, smooth01(reformT));
      const cloudSpread = THREE.MathUtils.lerp(CLOUD_FAR_SPREAD, 1, smooth01(reformT));
      const settled = 1 - dispFactor; // 0 exploded → 1 flat
      const showCloud = !!node.dissolveTex && dispFactor > 0.02;
      const showPc = !showCloud;
      // After seamless pc handoff, hi-res fades in with further approach / scroll
      const hiReveal = showPc
        ? smooth01((coverFrac - REFORM_SCREEN_FRAC) / Math.max(0.05, 0.35))
        : 0;

      // Exit: grow out of frame — no opacity fade
      let grow = 1;
      if (settled > 0.92) {
        const exitU = THREE.MathUtils.clamp(
          (coverFrac - REFORM_SCREEN_FRAC) / Math.max(0.05, 0.75),
          0,
          1
        );
        grow = 1 + smooth01(exitU) * 2.4;
      }

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
      if (showPc) {
        node.pcPlane.visible = true;
        node.pcPlane.scale.set(baseScaleX * grow, baseScaleY * grow, 1);
        node.pcPlane.material.opacity = 1;
        node.pcPlane.renderOrder = order;
        node.hiPlane.visible = hiReveal > 0.01;
        node.hiPlane.scale.set(baseScaleX * grow, baseScaleY * grow, 1);
        node.hiPlane.material.opacity = hiReveal;
        node.hiPlane.material.transparent = hiReveal < 0.99;
        node.hiPlane.material.depthWrite = hiReveal > 0.9;
        node.hiPlane.renderOrder = order + 1;
        // Videos: hold first frame until reformed, then autoplay under hi fade-in
        if (node.isVideo) {
          if (hiReveal > 0.2 && ahead >= 0.35 && grow <= 3.1) playNodeVideo(node);
          else stopNodeVideo(node);
        }
        if (ahead < 0.35 || grow > 3.1) {
          node.group.visible = false;
          node.pcPlane.visible = false;
          node.hiPlane.visible = false;
          stopNodeVideo(node);
        }
      } else {
        node.pcPlane.visible = false;
        node.hiPlane.visible = false;
        node.pcPlane.scale.set(baseScaleX, baseScaleY, 1);
        node.hiPlane.scale.set(baseScaleX, baseScaleY, 1);
        node.hiPlane.material.opacity = 0;
        stopNodeVideo(node);
      }
    }

    // Prefer near collapsing clouds + far mist
    cloudJobs.sort((a, b) => a.ahead - b.ahead);
    const nearSlots = Math.min(5, MAX_ACTIVE_CLOUDS);
    const near = cloudJobs.slice(0, nearSlots);
    const far = cloudJobs.slice(nearSlots).sort((a, b) => b.ahead - a.ahead);
    const picked = near.concat(far).slice(0, MAX_ACTIVE_CLOUDS);

    for (let i = 0; i < cloudPool.length; i++) {
      const job = picked[i];
      if (job) {
        applyCloudSlot(cloudPool[i], job.node, job);
        cloudPool[i].pts.renderOrder = 45 + i;
      } else {
        cloudPool[i].pts.visible = false;
      }
    }
  }

  function setMode(next) {
    mode = next === "explore" ? "explore" : "overview";
    container.dataset.mode = mode;
    stopAuto();
    for (const n of exploreNodes) stopNodeVideo(n);
    if (mode === "explore") {
      const first = placements[0]?.dist ?? START_LEAD_M;
      // Start further back so the first cards are clearly visible ahead
      walkDist = Math.max(0, first - START_AHEAD_M);
      for (const slot of cloudPool) slot.pts.visible = false;
      applyExploreCamera();
    } else {
      applyOverviewCamera();
    }
    return mode;
  }

  // Scroll moves images; layout updates once per animation frame
  function onWheel(e) {
    if (mode !== "explore") return;
    e.preventDefault();
    const step = Math.sign(e.deltaY) * Math.min(4.5, Math.abs(e.deltaY) * 0.02);
    walkDist = THREE.MathUtils.clamp(walkDist + step, 0, exploreTotal);
    if (!layoutRaf) {
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        updateExploreLayout();
      });
    }
  }
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  // Picking
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hover = null;
  let downX = 0;
  let downY = 0;

  function setHover(next) {
    if (hover === next) return;
    if (hover) hover.scale.setScalar(1);
    hover = next;
    if (hover && mode === "overview") hover.scale.setScalar(1.05);
    container.style.cursor = hover ? "pointer" : mode === "explore" ? "default" : "grab";
  }

  function onPointerMove(e) {
    if (mode === "explore") {
      setHover(null);
      return;
    }
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      overviewBillboards.filter((b) => b.visible),
      false
    );
    setHover(hits[0]?.object || null);
  }

  function onPointerDown(e) {
    downX = e.clientX;
    downY = e.clientY;
  }

  function onClick(e) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
    if (mode === "explore") {
      // pick nearest visible explore plane
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const meshes = exploreNodes
        .filter((n) => n.hiPlane.visible || n.pcPlane.visible)
        .flatMap((n) => [n.hiPlane, n.pcPlane].filter((m) => m.visible));
      const hits = raycaster.intersectObjects(meshes, false);
      if (hits[0]?.object?.userData?.item) onSelect?.(hits[0].object.userData.item);
      return;
    }
    if (!hover?.userData?.item) return;
    stopAuto();
    onSelect?.(hover.userData.item);
  }

  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("click", onClick);

  function resize() {
    const w = container.clientWidth;
    const h = Math.max(container.clientHeight, 320);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    for (const slot of cloudPool) slot.mat.uniforms.uScale.value = h * 0.5;
    if (mode === "explore") updateExploreLayout();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const _camPos = new THREE.Vector3();
  let raf = 0;
  function tick() {
    raf = requestAnimationFrame(tick);
    if (mode === "overview") {
      controls.update();
      camera.getWorldPosition(_camPos);
      for (const obj of overviewBillboards) {
        obj.quaternion.copy(camera.quaternion);
        obj.renderOrder = -obj.position.distanceToSquared(_camPos);
      }
    }
    renderer.render(scene, camera);
  }

  // Boot
  applyOverviewCamera();
  tick();
  buildMediaVisuals().then(() => {
    container.dataset.ready = "true";
    setMode(mode);
    resize();
  });

  window.__PP_DEBUG = () => {
    const visible = exploreNodes
      .filter((n) => n.group.visible)
      .slice(0, 6)
      .map((n) => ({
        ahead: +(n.placement.dist - walkDist).toFixed(2),
        pos: n.group.position.toArray().map((v) => +v.toFixed(2)),
      }));
    const clouds = cloudPool
      .filter((s) => s.pts.visible)
      .map((s) => ({
        disp: +s.mat.uniforms.uDisp.value.toFixed(2),
        pos: s.pts.position.toArray().map((v) => +v.toFixed(2)),
      }));
    return {
      mode,
      walkDist,
      exploreTotal,
      compress: PATH_COMPRESS,
      clouds,
      nodes: exploreNodes.length,
      firstDist: placements[0]?.dist ?? null,
      visible,
    };
  };

  return {
    setMode,
    getMode: () => mode,
    setPointMul,
    getPointMul: () => pointMul,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("wheel", onWheel);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
