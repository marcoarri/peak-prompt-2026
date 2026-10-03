/**
 * Peak Prompt — low-poly "broken" terrain corridor (Passo 2).
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import GUI from "https://cdn.jsdelivr.net/npm/lil-gui@0.19.2/+esm";

// --- project constants ---
const TERRAIN_URL = "assets/terrain/terrain.json";
const PHOTO_HEIGHT_M = 25;
const PHOTO_W_M = 18;
const PHOTO_H_M = 13.5;
const LAZY_LOAD_DIST_M = 180;
const LAZY_UNLOAD_DIST_M = 320;
const MAX_LOADED_TEXTURES = 80;
const THREE_BG = 0xf2efe8;

const params = {
  breakByDistance: 0.55,
  breakByPhotoAbsence: 0.45,
  breakByGap: 0.7,
  dropRatio: 0.08,
  verticalExaggeration: 1.0,
};

let renderer;
let labelRenderer;
let scene;
let camera;
let controls;
let breakUniforms;
let trackGroup;
let lineMat;
let mediaItems = [];
const textureLoader = new THREE.TextureLoader();

export async function initTerrain(container) {
  const data = await fetch(TERRAIN_URL).then((r) => {
    if (!r.ok) throw new Error(`Failed to load ${TERRAIN_URL}`);
    return r.json();
  });

  scene = new THREE.Scene();
  scene.background = new THREE.Color(THREE_BG);

  camera = new THREE.PerspectiveCamera(50, 1, 0.5, 8000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = "label-layer";
  container.appendChild(labelRenderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.15);
  sun.position.set(180, 220, 90);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdde6f0, 0.35);
  fill.position.set(-120, 80, -160);
  scene.add(fill);

  scene.add(buildTerrain(data));
  trackGroup = buildTrack(data.track);
  scene.add(trackGroup);

  mediaItems = buildMedia(data.media || []);
  for (const m of mediaItems) {
    scene.add(m.group);
    scene.add(m.stem);
  }

  fitCamera(data);
  applyExaggeration();

  const gui = new GUI({ title: "Terrain break" });
  gui.add(params, "breakByDistance", 0, 1, 0.01).onChange(syncBreak);
  gui.add(params, "breakByPhotoAbsence", 0, 1, 0.01).onChange(syncBreak);
  gui.add(params, "breakByGap", 0, 1, 0.01).onChange(syncBreak);
  gui.add(params, "dropRatio", 0, 0.5, 0.01).onChange(syncBreak);
  gui.add(params, "verticalExaggeration", 0.5, 2.5, 0.05).onChange(() => {
    syncBreak();
    applyExaggeration();
  });
  syncBreak();

  const ro = new ResizeObserver(() => resize(container));
  ro.observe(container);
  resize(container);

  function tick() {
    requestAnimationFrame(tick);
    controls.update();
    updateLazyTextures();
    updateLabelVisibility();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  tick();

  window.__terrain = { scene, camera, controls, params, data };
  return { data, params };
}

function syncBreak() {
  if (!breakUniforms) return;
  breakUniforms.uBreakDist.value = params.breakByDistance;
  breakUniforms.uBreakPhoto.value = params.breakByPhotoAbsence;
  breakUniforms.uBreakGap.value = params.breakByGap;
  breakUniforms.uDropRatio.value = params.dropRatio;
  breakUniforms.uVExag.value = params.verticalExaggeration;
}

function applyExaggeration() {
  const v = params.verticalExaggeration;
  if (trackGroup) trackGroup.scale.y = v;
  for (const m of mediaItems) {
    const groundY = m.yGround * v;
    const topY = groundY + PHOTO_HEIGHT_M;
    m.group.position.y = topY;
    const h = Math.max(0.1, topY - groundY);
    m.stem.position.y = groundY + h * 0.5;
    m.stem.scale.y = h;
  }
}

function buildTerrain(data) {
  const pos = data.positions;
  const nTri = data.triAttr.dist.length;
  const attr = data.triAttr;

  const positions = new Float32Array(pos);
  const aCentroid = new Float32Array(nTri * 9);
  const aDist = new Float32Array(nTri * 3);
  const aPhoto = new Float32Array(nTri * 3);
  const aGap = new Float32Array(nTri * 3);
  const aSeed = new Float32Array(nTri * 3);

  for (let t = 0; t < nTri; t++) {
    const i0 = t * 9;
    const mx = (pos[i0] + pos[i0 + 3] + pos[i0 + 6]) / 3;
    const my = (pos[i0 + 1] + pos[i0 + 4] + pos[i0 + 7]) / 3;
    const mz = (pos[i0 + 2] + pos[i0 + 5] + pos[i0 + 8]) / 3;
    for (let v = 0; v < 3; v++) {
      const o = t * 9 + v * 3;
      aCentroid[o] = mx;
      aCentroid[o + 1] = my;
      aCentroid[o + 2] = mz;
      aDist[t * 3 + v] = attr.dist[t];
      aPhoto[t * 3 + v] = attr.photoDensity[t];
      aGap[t * 3 + v] = attr.gap[t];
      aSeed[t * 3 + v] = attr.seed[t];
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aCentroid", new THREE.BufferAttribute(aCentroid, 3));
  geo.setAttribute("aDist", new THREE.BufferAttribute(aDist, 1));
  geo.setAttribute("aPhoto", new THREE.BufferAttribute(aPhoto, 1));
  geo.setAttribute("aGap", new THREE.BufferAttribute(aGap, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(aSeed, 1));
  geo.computeVertexNormals();

  const corridorHalf = data.params?.CORRIDOR_HALF_WIDTH_M ?? 100;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x9a9184,
    roughness: 0.92,
    metalness: 0.02,
    flatShading: true,
    side: THREE.DoubleSide,
  });

  breakUniforms = {
    uBreakDist: { value: params.breakByDistance },
    uBreakPhoto: { value: params.breakByPhotoAbsence },
    uBreakGap: { value: params.breakByGap },
    uDropRatio: { value: params.dropRatio },
    uVExag: { value: params.verticalExaggeration },
    uCorridorHalf: { value: corridorHalf },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, breakUniforms);
    // Inject attrs/uniforms once after precision / definitions
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      /* glsl */ `
      attribute vec3 aCentroid;
      attribute float aDist;
      attribute float aPhoto;
      attribute float aGap;
      attribute float aSeed;
      uniform float uBreakDist;
      uniform float uBreakPhoto;
      uniform float uBreakGap;
      uniform float uDropRatio;
      uniform float uVExag;
      uniform float uCorridorHalf;

      mat2 rot2(float a) {
        float c = cos(a), s = sin(a);
        return mat2(c, -s, s, c);
      }

      void main() {
      `
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      /* glsl */ `
      #include <begin_vertex>

      // vertical exaggeration
      transformed.y *= uVExag;
      vec3 c0 = vec3(aCentroid.x, aCentroid.y * uVExag, aCentroid.z);

      float edge = clamp(aDist / max(uCorridorHalf, 1.0), 0.0, 1.0);
      float photoAbsence = 1.0 - clamp(aPhoto, 0.0, 1.0);
      float intensity = edge * uBreakDist + photoAbsence * uBreakPhoto + aGap * uBreakGap;
      intensity = clamp(intensity, 0.0, 1.35);

      // dropRatio: shrink triangle to centroid (invisible)
      float keep = 1.0 - step(aSeed, uDropRatio);

      vec3 toC = transformed - c0;
      // scale toward centroid
      toC *= mix(1.0, 0.5, intensity * 0.9) * keep;
      // small yaw break in XZ
      float ang = (aSeed - 0.5) * 1.1 * intensity;
      vec2 xz = rot2(ang) * toC.xz;
      toC = vec3(xz.x, toC.y, xz.y);
      // translate along up
      float lift = (aSeed * 2.2 - 0.5) * 5.0 * intensity * keep;
      transformed = c0 + toC + vec3(0.0, lift, 0.0);
      `
    );
  };
  mat.customProgramCacheKey = () => "peak-broken-terrain-v3";

  return new THREE.Mesh(geo, mat);
}

function buildTrack(track) {
  const positions = [];
  for (const p of track) positions.push(p[0], p[1], p[2]);

  const geo = new LineGeometry();
  geo.setPositions(positions);
  lineMat = new LineMaterial({
    color: 0x1a1a1a,
    linewidth: 2.4,
    worldUnits: false,
  });
  const line = new Line2(geo, lineMat);
  line.computeLineDistances();

  const group = new THREE.Group();
  group.add(line);
  return group;
}

function buildMedia(media) {
  const items = [];
  for (const m of media) {
    const group = new THREE.Group();
    group.position.set(m.x, m.y_ground + PHOTO_HEIGHT_M, m.z);
    group.rotation.y = THREE.MathUtils.degToRad(-(m.heading_deg ?? 0));

    const frame = new THREE.Mesh(
      new THREE.PlaneGeometry(PHOTO_W_M + 0.55, PHOTO_H_M + 0.55),
      new THREE.MeshBasicMaterial({ color: m.kind === "video" ? 0x8b3a2f : 0x2a2a2a })
    );
    frame.position.z = -0.04;
    group.add(frame);

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(PHOTO_W_M, PHOTO_H_M),
      new THREE.MeshBasicMaterial({
        color: 0x9a958c,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
    );
    group.add(plane);

    const label = document.createElement("div");
    label.className = "media-label";
    label.textContent = m.id + (m.kind === "video" ? " · video" : "");
    const labelObj = new CSS2DObject(label);
    labelObj.position.set(0, -PHOTO_H_M * 0.58, 0);
    group.add(labelObj);

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1, 5),
      new THREE.MeshBasicMaterial({ color: m.kind === "video" ? 0x8b3a2f : 0x444444 })
    );
    stem.position.set(m.x, m.y_ground + PHOTO_HEIGHT_M * 0.5, m.z);
    stem.scale.y = PHOTO_HEIGHT_M;

    items.push({
      group,
      stem,
      plane,
      label: labelObj,
      thumb: m.thumb,
      yGround: m.y_ground,
      loaded: false,
      loading: false,
      texture: null,
    });
  }
  return items;
}

function fitCamera(data) {
  const track = data.track;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of track) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]);
    maxZ = Math.max(maxZ, p[2]);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxZ - minZ, maxY - minY, 200);
  controls.target.set(cx, cy * 0.55, cz);
  // Oblique from south-east, high enough to read the corridor width
  camera.position.set(cx + span * 0.75, cy + span * 0.85, cz + span * 0.9);
  controls.update();
}

function resize(container) {
  const w = container.clientWidth;
  const h = Math.max(container.clientHeight, 1);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  if (lineMat) lineMat.resolution.set(w, h);
}

function updateLabelVisibility() {
  const cam = camera.position;
  const near2 = 220 * 220;
  for (const m of mediaItems) {
    const d2 = cam.distanceToSquared(m.group.position);
    if (m.label) m.label.visible = d2 < near2;
  }
}

function updateLazyTextures() {
  const cam = camera.position;
  const ranked = mediaItems
    .map((m) => ({ m, d: cam.distanceToSquared(m.group.position) }))
    .sort((a, b) => a.d - b.d);

  let loadedCount = 0;
  for (const m of mediaItems) if (m.loaded) loadedCount++;

  const loadR2 = LAZY_LOAD_DIST_M * LAZY_LOAD_DIST_M;
  const unloadR2 = LAZY_UNLOAD_DIST_M * LAZY_UNLOAD_DIST_M;

  for (const { m, d } of ranked) {
    if (!m.loaded && d < loadR2 && loadedCount < MAX_LOADED_TEXTURES) {
      loadThumb(m);
      loadedCount++;
    } else if (m.loaded && d > unloadR2) {
      unloadThumb(m);
      loadedCount--;
    }
  }
}

function loadThumb(m) {
  if (m.loaded || m.loading) return;
  m.loading = true;
  textureLoader.load(
    m.thumb,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      if (m.texture) m.texture.dispose();
      m.texture = tex;
      m.plane.material.map = tex;
      m.plane.material.color.set(0xffffff);
      m.plane.material.needsUpdate = true;
      m.loaded = true;
      m.loading = false;
    },
    undefined,
    () => {
      m.loading = false;
    }
  );
}

function unloadThumb(m) {
  if (!m.loaded) return;
  m.plane.material.map = null;
  m.plane.material.color.set(0x9a958c);
  m.plane.material.needsUpdate = true;
  if (m.texture) {
    m.texture.dispose();
    m.texture = null;
  }
  m.loaded = false;
}
