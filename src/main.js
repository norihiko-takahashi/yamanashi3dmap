import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOUNTAINS, LAKES, SPOTS } from './places.js';
import { Terrain } from './terrain.js';
import { paintTexture, COLOR_STOPS } from './texture.js';
import { Labels } from './labels.js';

const BASE = import.meta.env.BASE_URL;
const isMobile = matchMedia('(max-width: 720px), (pointer: coarse)').matches;

const $ = (id) => document.getElementById(id);

async function loadJSON(name) {
  const res = await fetch(`${BASE}data/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

async function loadBinary(name) {
  const res = await fetch(`${BASE}data/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function loadMask(name, cols, rows) {
  const img = new Image();
  img.src = `${BASE}data/${name}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, cols, rows).data;
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4] > 127 ? 1 : 0;
  return out;
}

async function main() {
  const meta = await loadJSON('meta.json');
  const [demBuf, municipalities, rivers, water] = await Promise.all([
    loadBinary('dem.bin'),
    loadJSON('municipalities.json'),
    loadJSON('rivers.json'),
    loadMask('water.png', meta.cols, meta.rows),
  ]);
  $('loading-text').textContent = '地形を生成中…';
  await new Promise((r) => requestAnimationFrame(r));

  let needsRender = true;
  const requestRender = () => {
    needsRender = true;
  };

  // ------------------------------------------------------------ レンダラー・シーン
  const canvas = $('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 2 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const useShadows = !isMobile;
  if (useShadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
  }

  const scene = new THREE.Scene();
  const skyColor = new THREE.Color('#0e1620');
  scene.background = skyColor;
  scene.fog = new THREE.Fog(skyColor, 220, 520);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 2000);

  // ------------------------------------------------------------ 地形
  const terrain = new Terrain(meta, new Uint16Array(demBuf), {
    step: isMobile ? 2 : 1,
  });
  const texScale = !isMobile && renderer.capabilities.maxTextureSize >= meta.cols * 2 ? 2 : 1;
  const layers = { boundaries: true, rivers: true, lakes: true, outside: true };
  const texCanvas = document.createElement('canvas');
  const repaint = () =>
    paintTexture(texCanvas, { meta, terrain, water, municipalities, rivers, layers, scale: texScale });
  repaint();
  const texture = new THREE.CanvasTexture(texCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(terrain.geometry, material);
  mesh.castShadow = useShadows;
  mesh.receiveShadow = useShadows;
  scene.add(mesh);

  const skirt = new THREE.Mesh(
    terrain.skirtGeometry,
    new THREE.MeshStandardMaterial({ color: '#5b4a3a', roughness: 1, side: THREE.DoubleSide }),
  );
  scene.add(skirt);

  // ------------------------------------------------------------ ライト
  const hemi = new THREE.HemisphereLight('#d6e6ff', '#3a2f24', 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff4e0', 2.6);
  scene.add(sun, sun.target);
  if (useShadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const half = Math.hypot(terrain.width, terrain.depth) / 2;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 600 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.05;
  }

  const state = { exag: 2, sunAz: 135, sunAlt: 40 };

  function updateSun() {
    const az = THREE.MathUtils.degToRad(state.sunAz);
    const alt = THREE.MathUtils.degToRad(state.sunAlt);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    sun.position.copy(dir.multiplyScalar(300));
    sun.target.position.set(0, 0, 0);
    // 低い太陽は少し赤く、暗く
    const warm = THREE.MathUtils.clamp(state.sunAlt / 30, 0, 1);
    sun.color.setRGB(1, 0.78 + 0.2 * warm, 0.6 + 0.3 * warm);
    sun.intensity = 1.6 + 1.2 * warm;
    if (useShadows) renderer.shadowMap.needsUpdate = true;
    requestRender();
  }

  // ------------------------------------------------------------ カメラ操作
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 320;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
  controls.autoRotateSpeed = 0.6;
  controls.zoomToCursor = true;

  const clampTarget = () => {
    const t = controls.target;
    t.x = THREE.MathUtils.clamp(t.x, -terrain.width / 2, terrain.width / 2);
    t.z = THREE.MathUtils.clamp(t.z, -terrain.depth / 2, terrain.depth / 2);
  };
  controls.addEventListener('change', () => {
    clampTarget();
    requestRender();
  });

  function cameraForSpot(spot) {
    const [x, z] = terrain.lonLatToXZ(spot.lon, spot.lat);
    const y = (terrain.heightAtLonLat(spot.lon, spot.lat) / 1000) * state.exag;
    const target = new THREE.Vector3(x, y, z);
    const pitch = THREE.MathUtils.degToRad(spot.pitch);
    const heading = THREE.MathUtils.degToRad(spot.heading);
    const horiz = spot.distance * Math.cos(pitch);
    const pos = new THREE.Vector3(
      x - Math.sin(heading) * horiz,
      y + spot.distance * Math.sin(pitch),
      z + Math.cos(heading) * horiz,
    );
    return { target, pos };
  }

  let flight = null;
  function flyTo(spot) {
    const to = cameraForSpot(spot);
    flight = {
      t0: performance.now(),
      dur: 1600,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      ...to,
    };
    controls.enabled = false;
  }

  const initial = cameraForSpot(SPOTS[0]);
  camera.position.copy(initial.pos);
  controls.target.copy(initial.target);
  controls.update();

  // ------------------------------------------------------------ ラベル
  const labels = new Labels($('labels'), camera);
  for (const f of municipalities.features) {
    labels.add({ type: 'municipality', text: f.properties.name, lon: f.properties.label[0], lat: f.properties.label[1], priority: 1 });
  }
  for (const m of MOUNTAINS) {
    labels.add({ type: 'mountain', html: `${m.name}<small>${m.elev.toLocaleString()}m</small>`, lon: m.lon, lat: m.lat, priority: 3 + m.elev / 4000 });
  }
  for (const l of LAKES) labels.add({ type: 'lake', text: l.name, lon: l.lon, lat: l.lat, priority: 2 });
  const marker = labels.add({ type: 'marker', text: '▼', lon: 0, lat: 0, priority: 100, anchorBottom: true });
  marker.visible = false;

  function placeLabels() {
    for (const l of labels.items) {
      const [x, z] = terrain.lonLatToXZ(l.lon, l.lat);
      const h = l.type === 'mountain' ? Math.max(terrain.heightAtLonLat(l.lon, l.lat), 0) : terrain.heightAtLonLat(l.lon, l.lat);
      l.position.set(x, (h / 1000) * state.exag + 0.08, z);
    }
    requestRender();
  }

  // ------------------------------------------------------------ 高さの強調
  function setExaggeration(v) {
    const prev = state.exag;
    state.exag = v;
    mesh.scale.y = v;
    skirt.scale.y = v;
    controls.target.y *= v / prev;
    camera.position.y = Math.max(camera.position.y, controls.target.y + 0.5);
    placeLabels();
    if (useShadows) renderer.shadowMap.needsUpdate = true;
    controls.update();
  }

  // ------------------------------------------------------------ 地点クリック
  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || !e.isPrimary) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 500;
    downAt = null;
    if (moved > 6 || !quick) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = terrain.raycast(raycaster.ray, state.exag);
    if (hit) showInfo(hit);
  });

  function showInfo({ x, z }) {
    const [lon, lat] = terrain.xzToLonLat(x, z);
    const h = terrain.heightAtLonLat(lon, lat);
    const muni = findMunicipality(municipalities, lon, lat);
    $('info-body').innerHTML = `
      <div class="elev">標高 ${Math.round(h).toLocaleString()} m</div>
      <div>${muni ? `山梨県 ${muni}` : '山梨県外'}</div>
      <div class="sub">北緯 ${lat.toFixed(4)}° / 東経 ${lon.toFixed(4)}°</div>`;
    $('info').hidden = false;
    marker.lon = lon;
    marker.lat = lat;
    marker.visible = true;
    placeLabels();
  }
  $('info-close').addEventListener('click', () => {
    $('info').hidden = true;
    marker.visible = false;
    requestRender();
  });

  // ------------------------------------------------------------ UI
  const spotsEl = $('spots');
  for (const spot of SPOTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = spot.name;
    b.addEventListener('click', () => {
      flyTo(spot);
      if (isMobile) setPanel(false);
    });
    spotsEl.append(b);
  }

  const bindSlider = (id, key, fmt, onChange) => {
    const input = $(id);
    const out = $(`${id}-value`);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      out.textContent = fmt(v);
      onChange(v);
    });
    state[key] = parseFloat(input.value);
    out.textContent = fmt(state[key]);
  };
  bindSlider('exag', 'exag', (v) => v.toFixed(1), setExaggeration);
  bindSlider('sun-az', 'sunAz', (v) => String(v), (v) => { state.sunAz = v; updateSun(); });
  bindSlider('sun-alt', 'sunAlt', (v) => String(v), (v) => { state.sunAlt = v; updateSun(); });

  $('auto-rotate').addEventListener('change', (e) => {
    controls.autoRotate = e.target.checked;
    requestRender();
  });

  let repaintTimer = 0;
  document.querySelectorAll('[data-layer]').forEach((el) => {
    el.addEventListener('change', () => {
      layers[el.dataset.layer] = el.checked;
      clearTimeout(repaintTimer);
      repaintTimer = setTimeout(() => {
        repaint();
        texture.needsUpdate = true;
        requestRender();
      }, 30);
    });
  });
  document.querySelectorAll('[data-labels]').forEach((el) => {
    el.addEventListener('change', () => {
      labels.setTypeVisible(el.dataset.labels, el.checked);
      requestRender();
    });
  });

  const panel = $('panel');
  const toggle = $('panel-toggle');
  function setPanel(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '閉じる' : '設定';
  }
  toggle.addEventListener('click', () => setPanel(panel.hidden));
  if (isMobile) setPanel(false);

  // 凡例
  const legend = $('legend');
  const maxH = 3800;
  legend.style.background = `linear-gradient(to right, ${COLOR_STOPS.map(
    ([h, c]) => `${c} ${((h / maxH) * 100).toFixed(1)}%`,
  ).join(', ')})`;
  for (const h of [0, 1000, 2000, 3000]) {
    const s = document.createElement('span');
    s.style.left = `${(h / maxH) * 100}%`;
    s.textContent = `${h.toLocaleString()}m`;
    legend.append(s);
  }

  // 出典
  $('attribution').innerHTML =
    meta.attribution
      .map((a) => (a.url ? `<a href="${a.url}" target="_blank" rel="noopener">${a.text}</a>` : a.text))
      .join('<br>') + '<br>描画: <a href="https://threejs.org/" target="_blank" rel="noopener">three.js</a>';

  // ------------------------------------------------------------ 描画ループ
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    requestRender();
  });

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  function frame(now) {
    requestAnimationFrame(frame);
    if (flight) {
      const t = Math.min(1, (now - flight.t0) / flight.dur);
      const k = ease(t);
      camera.position.lerpVectors(flight.fromPos, flight.pos, k);
      // 移動中は少し高く持ち上げて、山に潜らないようにする
      camera.position.y += Math.sin(Math.PI * t) * flight.fromPos.distanceTo(flight.pos) * 0.25;
      controls.target.lerpVectors(flight.fromTarget, flight.target, k);
      camera.lookAt(controls.target);
      needsRender = true;
      if (t >= 1) {
        flight = null;
        controls.enabled = true;
        controls.update();
      }
    } else if (controls.update()) {
      needsRender = true;
    }
    if (controls.autoRotate) needsRender = true;
    if (!needsRender) return;
    needsRender = false;
    renderer.render(scene, camera);
    labels.update(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  }

  setExaggeration(state.exag);
  updateSun();
  placeLabels();
  requestAnimationFrame(frame);
  $('loading').classList.add('done');
}

function findMunicipality(fc, lon, lat) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const f of fc.features) {
    for (const poly of f.geometry.coordinates) {
      if (inRing(poly[0]) && !poly.slice(1).some(inRing)) return f.properties.name;
    }
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  const el = $('loading');
  el.classList.add('error');
  $('loading-text').textContent = `読み込みに失敗しました: ${e.message}`;
});
