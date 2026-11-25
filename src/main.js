import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOUNTAINS, LAKES, SPOTS } from './places.js';
import { Terrain } from './terrain.js';
import { paintTexture, paintLights, COLOR_STOPS } from './texture.js';
import { Labels } from './labels.js';
import { Railways } from './railways.js';

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

// RGB 画像を読み込み、画素ごとの [R, G, B] を並べた配列にする。読み込めなければ null
async function loadRGB(name, cols, rows) {
  try {
    const img = new Image();
    img.src = `${BASE}data/${name}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = cols;
    c.height = rows;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, cols, rows).data;
    const out = new Uint8Array(cols * rows * 3);
    for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
      out[i] = rgba[j]; out[i + 1] = rgba[j + 1]; out[i + 2] = rgba[j + 2];
    }
    return out;
  } catch {
    return null;
  }
}

// 今日の日付から季節を決める (3〜5 月: 春、6〜8 月: 夏、9〜11 月: 秋、12〜2 月: 冬)
function currentSeason() {
  const m = new Date().getMonth() + 1;
  return m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter';
}

async function main() {
  const meta = await loadJSON('meta.json');
  const [demBuf, municipalities, rivers, water, railData, fujiView, landuse, landuseMeta] = await Promise.all([
    loadBinary('dem.bin'),
    loadJSON('municipalities.json'),
    loadJSON('rivers.json'),
    loadMask('water.png', meta.cols, meta.rows),
    loadJSON('railways.json'),
    loadMask('fuji_view.png', meta.cols, meta.rows),
    loadRGB('landuse.png', meta.cols, meta.rows),
    loadJSON('landuse.json').catch(() => null),
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
  const layers = { boundaries: true, rivers: true, lakes: true, outside: true, fujiView: false };
  const scenery = { night: false, season: currentSeason() };
  const texCanvas = document.createElement('canvas');
  const repaint = () =>
    paintTexture(texCanvas, {
      meta, terrain, water, fujiView, landuse, season: scenery.season, municipalities, rivers, layers, scale: texScale,
    });
  repaint();
  const texture = new THREE.CanvasTexture(texCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;

  // 夜景の街明かり (発光マップ)。昼は発光の強さを 0 にする
  const lightsCanvas = document.createElement('canvas');
  const repaintLights = () =>
    paintLights(lightsCanvas, { meta, landuse, municipalities, dimOutside: layers.outside, scale: texScale });
  repaintLights();
  const lightsTexture = new THREE.CanvasTexture(lightsCanvas);
  lightsTexture.colorSpace = THREE.SRGBColorSpace;
  lightsTexture.anisotropy = texture.anisotropy;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 1,
    metalness: 0,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: lightsTexture,
    emissiveIntensity: 0,
  });
  const mesh = new THREE.Mesh(terrain.geometry, material);
  mesh.castShadow = useShadows;
  mesh.receiveShadow = useShadows;
  scene.add(mesh);

  const skirt = new THREE.Mesh(
    terrain.skirtGeometry,
    new THREE.MeshStandardMaterial({ color: '#5b4a3a', roughness: 1, side: THREE.DoubleSide }),
  );
  scene.add(skirt);

  // ------------------------------------------------------------ 鉄道
  const railways = new Railways(scene, terrain, railData);
  railways.setResolution(window.innerWidth, window.innerHeight);

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

  // 夜空の星 (夜だけ表示)
  const stars = (() => {
    const n = 1800;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const az = Math.random() * Math.PI * 2;
      const el = Math.asin(Math.random()) * 0.95 + 0.03; // 上空ほどまばらに
      pos[i * 3] = Math.cos(el) * Math.sin(az) * 900;
      pos[i * 3 + 1] = Math.sin(el) * 900;
      pos[i * 3 + 2] = -Math.cos(el) * Math.cos(az) * 900;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ color: '#dfe7ff', size: 2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 }));
    p.visible = false;
    p.renderOrder = -1;
    return p;
  })();
  scene.add(stars);

  const DAY = { sky: '#0e1620', hemiSky: '#d6e6ff', hemiGround: '#3a2f24', hemi: 0.7, exposure: 1.05 };
  const NIGHT = { sky: '#04060d', hemiSky: '#2a3a62', hemiGround: '#07070b', hemi: 0.22, exposure: 1.0, moon: '#a9bbe6', moonIntensity: 0.32, lights: 1.25 };

  function updateSun() {
    const az = THREE.MathUtils.degToRad(state.sunAz);
    const alt = THREE.MathUtils.degToRad(state.sunAlt);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    sun.position.copy(dir.multiplyScalar(300));
    sun.target.position.set(0, 0, 0);
    if (scenery.night) {
      // 夜は太陽の代わりに、青白い月明かりにする (向きは「太陽の方位・高さ」のまま)
      sun.color.set(NIGHT.moon);
      sun.intensity = NIGHT.moonIntensity;
    } else {
      // 低い太陽は少し赤く、暗く
      const warm = THREE.MathUtils.clamp(state.sunAlt / 30, 0, 1);
      sun.color.setRGB(1, 0.78 + 0.2 * warm, 0.6 + 0.3 * warm);
      sun.intensity = 1.6 + 1.2 * warm;
    }
    if (useShadows) renderer.shadowMap.needsUpdate = true;
    requestRender();
  }

  // ------------------------------------------------------------ カメラ操作
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minDistance = 0.05;
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
    flyToPose(cameraForSpot(spot));
  }
  function flyToPose(to) {
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
  // 駅名 (複数路線の駅は 1 つにまとめ、どれかの路線の線路が表示中なら表示する)
  const stationLabels = new Map();
  for (const line of railData.lines) {
    for (const st of line.stations) {
      const known = stationLabels.get(st.name);
      if (known) {
        known.groups.push(line.id);
        continue;
      }
      const item = labels.add({ type: 'station', text: st.name, lon: st.lon, lat: st.lat, priority: st.inPref ? 0.6 : 0.4, groups: [line.id] });
      item.el.style.setProperty('--line-color', line.color);
      stationLabels.set(st.name, item);
    }
  }
  labels.setTypeVisible('station', false);
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
    railways.setExaggeration(v);
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
    if (cab) return; // 乗車中のクリック・ドラッグは見回しに使う
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
    const fuji = fujiFrom(lon, lat);
    $('info-body').innerHTML = `
      <div class="elev">標高 ${Math.round(h).toLocaleString()} m</div>
      <div>${muni ? `山梨県 ${muni}` : '山梨県外'}</div>
      <div class="sub">北緯 ${lat.toFixed(4)}° / 東経 ${lon.toFixed(4)}°</div>
      <div class="fuji ${fuji.visible ? 'yes' : ''}">${fuji.visible ? '富士山が見えます' : '富士山は見えません'}
        <span class="sub">（山頂まで ${fuji.km.toFixed(1)} km・${fuji.dir}）</span></div>
      <div class="actions"><button type="button" id="look-fuji">ここから富士山の方を見る</button></div>`;
    $('look-fuji').addEventListener('click', () => lookAtFujiFrom(lon, lat));
    $('info').hidden = false;
    marker.lon = lon;
    marker.lat = lat;
    marker.visible = true;
    placeLabels();
  }
  // ------------------------------------------------------------ 富士山が見える場所
  const [fujiLon, fujiLat] = meta.maxHeightAt;
  const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
  function fujiFrom(lon, lat) {
    const c = Math.round((lon - meta.west) / meta.dlon);
    const r = Math.round((meta.north - lat) / meta.dlat);
    const inside = c >= 0 && r >= 0 && c < meta.cols && r < meta.rows;
    const [x0, z0] = terrain.lonLatToXZ(lon, lat);
    const [x1, z1] = terrain.lonLatToXZ(fujiLon, fujiLat);
    const bearing = (THREE.MathUtils.radToDeg(Math.atan2(x1 - x0, -(z1 - z0))) + 360) % 360;
    return {
      visible: inside && fujiView[r * meta.cols + c] === 1,
      km: Math.hypot(x1 - x0, z1 - z0),
      dir: `${DIRS[Math.round(bearing / 22.5) % 16]}の方角`,
    };
  }
  // 地上 (目の高さより少し上) から富士山の山頂の方向を向く
  function lookAtFujiFrom(lon, lat) {
    const [x, z] = terrain.lonLatToXZ(lon, lat);
    const pos = new THREE.Vector3(x, (terrain.heightAtLonLat(lon, lat) / 1000) * state.exag + 0.03, z);
    const [fx, fz] = terrain.lonLatToXZ(fujiLon, fujiLat);
    const summit = new THREE.Vector3(fx, (terrain.heightAtLonLat(fujiLon, fujiLat) / 1000) * state.exag, fz);
    const target = pos.clone().add(summit.clone().sub(pos).normalize().multiplyScalar(0.5));
    $('info').hidden = true;
    marker.visible = false;
    flyToPose({ pos, target });
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

  // 鉄道: 路線ごとの線路・電車の表示切り替え
  const railList = $('rail-list');
  const railChecks = { track: [], trains: [] };
  const makeCheck = (label, checked, onChange) => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  };
  const allRow = document.createElement('tr');
  allRow.className = 'all';
  const allTrack = makeCheck('すべての線路', true, (v) => railChecks.track.forEach((c) => c.checked !== v && c.click()));
  const allTrains = makeCheck('すべての電車', true, (v) => railChecks.trains.forEach((c) => c.checked !== v && c.click()));
  const syncAll = () => {
    for (const [key, all] of [['track', allTrack], ['trains', allTrains]]) {
      const n = railChecks[key].filter((c) => c.checked).length;
      all.checked = n === railChecks[key].length;
      all.indeterminate = n > 0 && n < railChecks[key].length;
    }
  };
  for (const line of railData.lines) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.innerHTML = `<span class="rail-name"><span class="rail-swatch" style="background:${line.color}"></span>${line.name}</span>`;
    const track = makeCheck(`${line.name} の線路`, true, (v) => {
      railways.setTrackVisible(line.id, v);
      labels.setGroupVisible(line.id, v);
      syncAll();
      requestRender();
    });
    const trains = makeCheck(`${line.name} の電車`, true, (v) => {
      if (!v && cab?.line.id === line.id) exitCab();
      railways.setTrainsVisible(line.id, v);
      syncAll();
      requestRender();
    });
    railChecks.track.push(track);
    railChecks.trains.push(trains);
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    const td3 = document.createElement('td');
    td1.append(track);
    td2.append(trains);
    const ride = document.createElement('button');
    ride.type = 'button';
    ride.textContent = '乗る';
    ride.setAttribute('aria-label', `${line.name} の運転席に乗る`);
    ride.addEventListener('click', () => {
      if (!trains.checked) trains.click();
      enterCab(line);
    });
    td3.append(ride);
    tr.append(name, td1, td2, td3);
    railList.append(tr);
  }
  {
    const name = document.createElement('td');
    name.textContent = 'すべて';
    const td1 = document.createElement('td');
    const td2 = document.createElement('td');
    td1.append(allTrack);
    td2.append(allTrains);
    allRow.append(name, td1, td2, document.createElement('td'));
    railList.append(allRow);
  }
  bindSlider('train-speed', 'trainSpeed', (v) => v.toFixed(1), (v) => { railways.speed = v; });

  // ------------------------------------------------------------ 運転席からの眺め
  let cab = null;
  const cabEye = new THREE.Vector3();
  const cabTarget = new THREE.Vector3();
  let cabHudAt = 0;
  // 乗車中の見回し: 進行方向からの向き (度) と視野角
  const CAB_FOV = { initial: 60, min: 15, max: 90 };
  const look = { yaw: 0, pitch: 0, fov: CAB_FOV.initial };
  const resetLook = () => {
    look.yaw = 0;
    look.pitch = 0;
    look.fov = CAB_FOV.initial;
  };
  const setCabFov = (fov) => {
    look.fov = THREE.MathUtils.clamp(fov, CAB_FOV.min, CAB_FOV.max);
  };
  function enterCab(line) {
    resetLook();
    railways.enterCab(line.id, controls.target);
    cab = { line };
    flight = null;
    controls.enabled = false;
    controls.autoRotate = false;
    $('auto-rotate').checked = false;
    $('cab-line').textContent = line.name;
    $('cab-swatch').style.background = line.color;
    $('cab').hidden = false;
    document.body.classList.add('in-cab');
    camera.fov = 60;
    camera.updateProjectionMatrix();
    requestRender();
  }
  function exitCab() {
    if (!cab) return;
    railways.exitCab();
    cab = null;
    $('cab').hidden = true;
    $('tunnel').hidden = true;
    document.body.classList.remove('in-cab');
    camera.fov = 45;
    camera.updateProjectionMatrix();
    // 少し後ろの上空へ引いて、乗っていた電車を見下ろす
    const back = cabEye.clone().sub(cabTarget).setY(0).normalize();
    const pos = cabEye.clone().addScaledVector(back, 1.2).add(new THREE.Vector3(0, 0.6, 0));
    flyToPose({ pos, target: cabEye.clone() });
  }
  $('cab-exit').addEventListener('click', exitCab);

  // ドラッグで 360 度見回す (スマホは 1 本指)。2 本指はピンチでズーム
  const pointers = new Map();
  let pinchDist = 0;
  let lastTap = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!cab) return;
    // ダブルタップ (タッチ) で正面に戻す。マウスは dblclick で扱う
    if (e.pointerType === 'touch') {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        resetLook();
        lastTap = null;
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cab || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      // 画面の高さ 1 枚分のドラッグで、視野角と同じ角度だけ回る (つかんで動かす感覚)
      const degPerPx = look.fov / canvas.clientHeight;
      look.yaw = (look.yaw - (cur.x - prev.x) * degPerPx + 540) % 360 - 180;
      look.pitch = THREE.MathUtils.clamp(look.pitch + (cur.y - prev.y) * degPerPx, -80, 80);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) setCabFov(look.fov * (pinchDist / d));
      pinchDist = d;
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  // ダブルクリック (ダブルタップ) で正面に戻す
  canvas.addEventListener('dblclick', () => {
    if (cab) resetLook();
  });
  // ホイール: ズーム (望遠・広角)。Ctrl+ホイール (タッチパッドのピンチ) もズーム。Shift+ホイール: 電車の速さ
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!cab) return;
      e.preventDefault();
      const delta = e.deltaY || e.deltaX; // Shift+ホイールは横スクロールとして届くブラウザがある
      if (e.shiftKey) {
        const input = $('train-speed');
        const v = THREE.MathUtils.clamp(parseFloat(input.value) * Math.exp(-delta * 0.002), parseFloat(input.min), parseFloat(input.max));
        input.value = v.toFixed(1);
        input.dispatchEvent(new Event('input'));
        showCabHint(`電車の速さ ${parseFloat(input.value).toFixed(1)} 倍`);
      } else {
        setCabFov(look.fov * Math.exp(delta * (e.ctrlKey ? 0.01 : 0.001)));
      }
    },
    { passive: false },
  );
  let hintTimer = 0;
  function showCabHint(text) {
    const el = $('cab-hint');
    el.textContent = text;
    el.classList.add('flash');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      el.classList.remove('flash');
      el.textContent = 'ドラッグで見回す・ホイールでズーム・Shift+ホイールで速さ・ダブルクリックで正面';
    }, 1500);
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') exitCab();
  });

  // 時間帯 (昼・夜) と季節
  function applyTime() {
    const p = scenery.night ? NIGHT : DAY;
    skyColor.set(p.sky);
    scene.fog.color.copy(skyColor);
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemi;
    renderer.toneMappingExposure = p.exposure;
    material.emissiveIntensity = scenery.night ? NIGHT.lights : 0;
    stars.visible = scenery.night;
    railways.setNight(scenery.night);
    updateSun();
  }
  document.querySelectorAll('input[name=time]').forEach((el) => {
    el.addEventListener('change', () => {
      scenery.night = el.value === 'night' && el.checked;
      applyTime();
    });
  });
  document.querySelectorAll('input[name=season]').forEach((el) => {
    el.checked = el.value === scenery.season;
    el.addEventListener('change', () => {
      if (!el.checked) return;
      scenery.season = el.value;
      repaint();
      texture.needsUpdate = true;
      requestRender();
    });
  });

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
        if (el.dataset.layer === 'outside') {
          repaintLights();
          lightsTexture.needsUpdate = true;
        }
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
    [...meta.attribution, railData.attribution, ...(landuseMeta ? [landuseMeta.attribution] : [])]
      .map((a) => (a.url ? `<a href="${a.url}" target="_blank" rel="noopener">${a.text}</a>` : a.text))
      .join('<br>') + '<br>描画: <a href="https://threejs.org/" target="_blank" rel="noopener">three.js</a>';

  // ------------------------------------------------------------ 描画ループ
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    railways.setResolution(window.innerWidth, window.innerHeight);
    requestRender();
  });

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  let lastNow = performance.now();
  // 近くを見ているときは手前の描画範囲 (near) を小さくして、地面や電車が欠けないようにする
  function updateNear(dist) {
    const near = THREE.MathUtils.clamp(dist * 0.004, 0.0005, 0.05);
    if (Math.abs(near - camera.near) / camera.near > 0.1) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    if (cab) {
      railways.update(dt, camera, renderer.domElement.clientHeight);
      const info = railways.cabView(cabEye, cabTarget);
      camera.position.copy(cabEye);
      // 進行方向を基準に、見回しの向きを足す
      const f = cabTarget.clone().sub(cabEye).normalize();
      const heading = Math.atan2(f.x, -f.z) + THREE.MathUtils.degToRad(look.yaw);
      const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)) + THREE.MathUtils.degToRad(look.pitch), -1.45, 1.45);
      const dir = new THREE.Vector3(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch));
      camera.lookAt(cabEye.clone().add(dir));
      if (Math.abs(camera.fov - look.fov) > 0.01) {
        camera.fov = look.fov;
        camera.updateProjectionMatrix();
      }
      if ($('tunnel').hidden === info.tunnel) $('tunnel').hidden = !info.tunnel;
      updateNear(0.01);
      if (now - cabHudAt > 250) {
        $('cab-speed').textContent = Math.round(info.kmh).toString();
        if ($('cab-status').textContent !== info.status) $('cab-status').textContent = info.status;
        cabHudAt = now;
      }
      renderer.render(scene, camera);
      labels.update(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
      return;
    }
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
    if (railways.update(dt, camera, renderer.domElement.clientHeight)) needsRender = true;
    updateNear(camera.position.distanceTo(controls.target));
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
