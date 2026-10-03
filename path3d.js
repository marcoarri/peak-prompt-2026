/**
 * 3D Wikiloc path with media billboards at lat / lon / elevation.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const DEG = Math.PI / 180;
const EARTH_R = 6378137;
const V_EXAG = 1.35;

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
    const y = ((ele ?? ele0) - ele0) * V_EXAG;
    return new THREE.Vector3(x, y, z);
  }

  return { toVec3, ele0, lat0, lon0 };
}

function makePathCurve(track, toVec3) {
  const pts = track
    .filter((p) => p.ele != null)
    .map((p) => toVec3(p.lat, p.lon, p.ele));
  return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.1);
}

function loadTexture(url, loader) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
}

export function initPath3D({ container, data, onSelect }) {
  if (!container || !data?.track?.length) return null;

  const track = data.track.filter((p) => p.ele != null);
  const media = (data.media || []).filter((m) => m.lat != null && m.lon != null && m.ele != null);
  const { toVec3 } = projectFactory(track);
  const curve = makePathCurve(track, toVec3);
  const pathPoints = curve.getPoints(Math.min(800, track.length * 2));

  const scene = new THREE.Scene();
  scene.background = null; // let the page's white show through

  const camera = new THREE.PerspectiveCamera(48, 1, 0.5, 8000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0xffffff, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.background = "#fff";

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = true;
  controls.screenSpacePanning = true; // pan on X + Y (screen space)
  controls.panSpeed = 1.1;
  controls.minDistance = 8;
  controls.maxDistance = 4000;
  controls.maxPolarAngle = Math.PI; // full orbit, including below
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  const stopAuto = () => {
    controls.autoRotate = false;
  };
  controls.addEventListener("start", stopAuto);

  // Keyboard fly: move camera + target on X / Y / Z
  const keys = new Set();
  const move = {
    KeyW: "fwd",
    ArrowUp: "fwd",
    KeyS: "back",
    ArrowDown: "back",
    KeyA: "left",
    ArrowLeft: "left",
    KeyD: "right",
    ArrowRight: "right",
    KeyE: "up",
    KeyR: "up",
    KeyQ: "down",
    KeyF: "down",
  };
  const worldUp = new THREE.Vector3(0, 1, 0);
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _delta = new THREE.Vector3();

  function onKeyDown(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
      keys.add(e.code);
      return;
    }
    if (!(e.code in move)) return;
    keys.add(e.code);
    stopAuto();
    e.preventDefault();
  }
  function onKeyUp(e) {
    keys.delete(e.code);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function applyAxisMove(dt) {
    if (!keys.size) return;
    const fast = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const speed = (fast ? 220 : 90) * dt;
    _fwd.subVectors(controls.target, camera.position);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, worldUp).normalize();

    _delta.set(0, 0, 0);
    for (const code of keys) {
      const dir = move[code];
      if (dir === "fwd") _delta.addScaledVector(_fwd, speed);
      else if (dir === "back") _delta.addScaledVector(_fwd, -speed);
      else if (dir === "right") _delta.addScaledVector(_right, speed);
      else if (dir === "left") _delta.addScaledVector(_right, -speed);
      else if (dir === "up") _delta.y += speed;
      else if (dir === "down") _delta.y -= speed;
    }
    if (_delta.lengthSq() === 0) return;
    camera.position.add(_delta);
    controls.target.add(_delta);
  }

  // Lights (neutral, no sky tint)
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(220, 480, 160);
  scene.add(sun);

  // Media billboards (path used only for placement, not drawn)
  const loader = new THREE.TextureLoader();
  const pickables = [];
  const frameMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  const videoEdge = new THREE.MeshBasicMaterial({
    color: 0x8b3a2f,
    side: THREE.DoubleSide,
  });

  const cluster = new Map();
  for (const item of media) {
    const key = `${item.lat.toFixed(5)},${item.lon.toFixed(5)},${Math.round(item.ele)}`;
    if (!cluster.has(key)) cluster.set(key, []);
    cluster.get(key).push(item);
  }

  async function placeItem(item, slotIndex, slotCount) {
    const base = toVec3(item.lat, item.lon, item.ele);
    // Nearest path tangent for offset
    let nearestT = 0;
    let best = Infinity;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const d = curve.getPointAt(t).distanceToSquared(base);
      if (d < best) {
        best = d;
        nearestT = t;
      }
    }
    const tan = curve.getTangentAt(nearestT).normalize();
    const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();

    const sideSign = slotIndex % 2 === 0 ? 1 : -1;
    const row = Math.floor(slotIndex / 2);
    const pos = base
      .clone()
      .addScaledVector(side, sideSign * (70 + row * 15))
      .add(new THREE.Vector3(0, 50 + row * 40 + (item.kind === "video" ? 10 : 0), 0))
      .addScaledVector(tan, (slotIndex - (slotCount - 1) / 2) * 12.5);

    const thumb = item.md || item.thumb || item.src;
    const tex = await loadTexture(thumb, loader);
    const aspect = tex?.image
      ? (tex.image.width || 4) / (tex.image.height || 3)
      : item.width && item.height
        ? item.width / item.height
        : 4 / 3;
    const h = 60; // 5× previous size (12)
    const w = h * Math.min(Math.max(aspect, 0.7), 1.7);

    const group = new THREE.Group();
    group.position.copy(pos);

    const frame = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 3.5, h + 3.5),
      item.kind === "video" ? videoEdge : frameMat
    );
    frame.position.z = -0.25;
    group.add(frame);

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: tex ? 0xffffff : item.kind === "video" ? 0x8b3a2f : 0x6b7c84,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    plane.userData.item = item;
    group.add(plane);

    // Face roughly outward from path center
    group.lookAt(pos.clone().add(side.clone().multiplyScalar(sideSign * 20)));
    group.rotateY(Math.PI);

    scene.add(group);
    pickables.push(plane);
  }

  const jobs = [];
  for (const items of cluster.values()) {
    items.forEach((item, i) => jobs.push(placeItem(item, i, items.length)));
  }

  // Fit camera
  const box = new THREE.Box3().setFromPoints(pathPoints);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.65;
  camera.position.set(center.x + radius * 0.85, center.y + radius * 0.55, center.z + radius * 0.95);
  controls.target.copy(center);
  controls.update();

  // Picking
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hover = null;

  function setHover(next) {
    if (hover === next) return;
    if (hover) hover.scale.setScalar(1);
    hover = next;
    if (hover) hover.scale.setScalar(1.08);
    container.style.cursor = hover ? "pointer" : "grab";
  }

  let downX = 0;
  let downY = 0;

  function onPointerMove(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    setHover(hits[0]?.object || null);
  }

  function onPointerDown(e) {
    downX = e.clientX;
    downY = e.clientY;
  }

  function onClick(e) {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
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
  }

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let raf = 0;
  let lastT = performance.now();
  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    applyAxisMove(dt);
    controls.update();
    // Soft billboard yaw toward camera for readability
    for (const plane of pickables) {
      const g = plane.parent;
      if (!g) continue;
      const p = g.position;
      const cam = camera.position;
      const flat = new THREE.Vector3(cam.x - p.x, 0, cam.z - p.z);
      if (flat.lengthSq() > 1) {
        const yaw = Math.atan2(flat.x, flat.z);
        g.rotation.y = yaw + Math.PI;
      }
    }
    renderer.render(scene, camera);
  }
  tick(performance.now());

  Promise.all(jobs).then(() => {
    container.dataset.ready = "true";
  });

  return {
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
