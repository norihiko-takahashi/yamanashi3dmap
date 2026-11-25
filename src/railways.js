import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SAMPLE_KM = 0.04; // 線路を地表に沿わせるための点の間隔
const LIFT_KM = 0.006; // 地表から少し浮かせて、地形に埋もれないようにする

// 1 両の寸法 (km)。実寸 (20 m × 2.9 m × 3.6 m) を基準に、画面上で一定以上の大きさに見えるよう拡大する
const CAR = { length: 0.02, width: 0.0029, height: 0.0036, gap: 0.0012 };
const MIN_WIDTH_PX = 6; // 車体の幅が画面上でこれより細くならないようにする
const LENGTH_RATIO = 0.4; // 拡大時は車両を短めにして、編成が長くなりすぎないようにする
const UP = new THREE.Vector3(0, 1, 0);

// 線路 (国土数値情報) を地表に沿わせ、その上を電車の模型が往復するアニメーションを描く
export class Railways {
  constructor(scene, terrain, data) {
    this.scene = scene;
    this.terrain = terrain;
    this.exag = 1;
    this.speed = 1;
    this.lines = data.lines.map((def) => this.#buildLine(def));
    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();
    this.tmpC = new THREE.Vector3();
    this.rot = new THREE.Matrix4();
    this.quat = new THREE.Quaternion();
    this.scl = new THREE.Vector3();
    this.mat = new THREE.Matrix4();
  }

  setResolution(w, h) {
    for (const l of this.lines) for (const m of l.lineMaterials) m.resolution.set(w, h);
  }

  setTrackVisible(id, visible) {
    const l = this.#get(id);
    l.trackVisible = visible;
    l.trackGroup.visible = visible;
  }

  setTrainsVisible(id, visible) {
    const l = this.#get(id);
    l.trainsVisible = visible;
    l.trainMesh.visible = visible;
  }

  get anyTrainVisible() {
    return this.lines.some((l) => l.trainsVisible);
  }

  setExaggeration(exag) {
    this.exag = exag;
    for (const l of this.lines) {
      for (const p of l.paths) {
        const pos = new Float32Array(p.n * 3);
        for (let i = 0; i < p.n; i++) {
          pos[i * 3] = p.x[i];
          pos[i * 3 + 1] = this.#y(p.h[i]);
          pos[i * 3 + 2] = p.z[i];
        }
        p.lineGeometry.setPositions(pos);
        p.outlineGeometry.setPositions(pos);
      }
      const sp = l.stationPoints.geometry.attributes.position;
      l.stations.forEach((s, i) => sp.setY(i, this.#y(s.h) + 0.004));
      sp.needsUpdate = true;
      l.stationPoints.geometry.computeBoundingSphere();
    }
  }

  // 電車の位置を更新する。描き直しが必要なら true を返す
  update(timeSec, camera, viewportHeight) {
    let changed = false;
    // 距離 1 km あたりの 1 画素の大きさ (km)
    const pxPerKm = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight);
    for (const l of this.lines) {
      if (!l.trainsVisible) continue;
      changed = true;
      const path = l.paths[0];
      let k = 0;
      for (let t = 0; t < l.trains; t++) {
        // 編成のおおよその位置からカメラまでの距離で、模型の拡大率を決める
        const est = this.#pointAt(path, l.lastHead?.[t] ?? path.length / 2, this.tmpA);
        const dist = camera.position.distanceTo(est);
        const sw = THREE.MathUtils.clamp((MIN_WIDTH_PX * pxPerKm * dist) / CAR.width, 1, 80);
        let sl = Math.max(1, sw * LENGTH_RATIO);
        if ((CAR.length + CAR.gap) * sl * l.cars > path.length * 0.4) {
          sl = (path.length * 0.4) / ((CAR.length + CAR.gap) * l.cars);
        }
        const sp = (CAR.length + CAR.gap) * sl;
        const tl = sp * l.cars;

        // 往復運動: 終点近くで減速し、少し停車してから折り返す
        const travel = Math.max(0.1, path.length - tl);
        const legSec = travel / (0.35 * this.speed) + 6;
        const phase = (timeSec + (t / l.trains) * 2 * legSec + l.offset) % (2 * legSec);
        const forward = phase < legSec;
        const p = (forward ? phase : phase - legSec) / legSec;
        const u = THREE.MathUtils.smootherstep(THREE.MathUtils.clamp((p - 0.08) / 0.84, 0, 1), 0, 1);
        const along = travel * u;
        // 先頭車両の位置。進行方向の後ろに車両が続く
        const head = forward ? tl + along : path.length - tl - along;
        (l.lastHead ??= [])[t] = head;
        const dir = forward ? 1 : -1;

        for (let c = 0; c < l.cars; c++) {
          const center = head - dir * (c + 0.5) * sp;
          const back = this.#pointAt(path, center - dir * sp * 0.45, this.tmpA);
          const front = this.#pointAt(path, center + dir * sp * 0.45, this.tmpB);
          // +z が進行方向 (front - back) を向く回転
          this.rot.lookAt(front, back, UP);
          this.quat.setFromRotationMatrix(this.rot);
          this.scl.set(sw, sw, sl);
          this.mat.compose(this.tmpC.addVectors(back, front).multiplyScalar(0.5), this.quat, this.scl);
          l.trainMesh.setMatrixAt(k++, this.mat);
        }
      }
      l.trainMesh.instanceMatrix.needsUpdate = true;
    }
    return changed;
  }

  #get(id) {
    return this.lines.find((l) => l.id === id);
  }

  #y(hMeters) {
    return (hMeters / 1000) * this.exag + LIFT_KM;
  }

  #buildLine(def) {
    const color = new THREE.Color(def.color);
    const trackGroup = new THREE.Group();
    trackGroup.name = `track-${def.id}`;
    this.scene.add(trackGroup);
    const lineMaterials = [];
    // 縁取りは深度を書き込まず、同じ位置に重ねる色付きの線が必ず上に描かれるようにする
    const outlineMat = new LineMaterial({ color: 0x15191f, linewidth: 5.5, depthWrite: false });
    const lineMat = new LineMaterial({ color, linewidth: 3 });
    lineMaterials.push(outlineMat, lineMat);

    const paths = def.paths.map((coords) => {
      const p = this.#densify(coords);
      p.outlineGeometry = new LineGeometry();
      p.lineGeometry = new LineGeometry();
      // 初期位置 (高さは setExaggeration で入れ直す)
      const pos = [];
      for (let i = 0; i < p.n; i++) pos.push(p.x[i], this.#y(p.h[i]), p.z[i]);
      p.outlineGeometry.setPositions(pos);
      p.lineGeometry.setPositions(pos);
      const outline = new Line2(p.outlineGeometry, outlineMat);
      const line = new Line2(p.lineGeometry, lineMat);
      outline.renderOrder = 1;
      line.renderOrder = 2;
      trackGroup.add(outline, line);
      return p;
    });

    // 駅
    const stations = def.stations.map((s) => {
      const [x, z] = this.terrain.lonLatToXZ(s.lon, s.lat);
      return { ...s, x, z, h: this.terrain.surfaceHeightAtXZ(x, z) };
    });
    const sGeom = new THREE.BufferGeometry();
    sGeom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(stations.flatMap((s) => [s.x, this.#y(s.h), s.z]), 3),
    );
    const stationPoints = new THREE.Points(
      sGeom,
      new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, map: dotTexture(def.color), transparent: true, alphaTest: 0.3 }),
    );
    stationPoints.renderOrder = 3;
    trackGroup.add(stationPoints);

    // 電車 (全車両を 1 つの InstancedMesh で描く)
    const trainMesh = new THREE.InstancedMesh(
      carGeometry(color),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 }),
      def.trains * def.cars,
    );
    trainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    trainMesh.frustumCulled = false;
    trainMesh.name = `trains-${def.id}`;
    this.scene.add(trainMesh);

    return {
      ...def,
      paths,
      stations,
      stationPoints,
      trackGroup,
      lineMaterials,
      trainMesh,
      trackVisible: true,
      trainsVisible: true,
      offset: Math.random() * 30,
    };
  }

  // 線路を細かい間隔の点列にし、各点の地表の高さを求める
  #densify(coords) {
    const xs = [], zs = [];
    const xz = coords.map(([lon, lat]) => this.terrain.lonLatToXZ(lon, lat));
    xs.push(xz[0][0]);
    zs.push(xz[0][1]);
    for (let i = 1; i < xz.length; i++) {
      const [x0, z0] = xz[i - 1];
      const [x1, z1] = xz[i];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.ceil(len / SAMPLE_KM));
      for (let k = 1; k <= n; k++) {
        xs.push(x0 + ((x1 - x0) * k) / n);
        zs.push(z0 + ((z1 - z0) * k) / n);
      }
    }
    const n = xs.length;
    const surface = new Float32Array(n);
    for (let i = 0; i < n; i++) surface[i] = this.terrain.surfaceHeightAtXZ(xs[i], zs[i]);
    // 地形の細かい凹凸で線路が波打たないよう平滑化し、地表より下には潜らせない
    const h = new Float32Array(n);
    const W = 4;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) { s += surface[k]; c++; }
      h[i] = Math.max(surface[i], s / c);
    }
    const dist = new Float32Array(n);
    for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    return { n, x: Float32Array.from(xs), z: Float32Array.from(zs), h, dist, length: dist[n - 1] };
  }

  // 線路の始点から s km の位置 (ワールド座標)
  #pointAt(p, s, out) {
    s = THREE.MathUtils.clamp(s, 0, p.length);
    let lo = 0, hi = p.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.dist[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = p.dist[hi] - p.dist[lo] || 1;
    const t = (s - p.dist[lo]) / seg;
    const h = p.h[lo] + (p.h[hi] - p.h[lo]) * t;
    return out.set(p.x[lo] + (p.x[hi] - p.x[lo]) * t, this.#y(h), p.z[lo] + (p.z[hi] - p.z[lo]) * t);
  }
}

// 1 両分の形 (+z が進行方向)。車体・窓の帯・屋根・前面窓・台車を頂点色で塗り分けて 1 つにまとめる
function carGeometry(bodyColor) {
  const { length: L, width: W, height: H } = CAR;
  const parts = [];
  const add = (w, h, l, x, y, z, color) => {
    const g = new THREE.BoxGeometry(w, h, l);
    g.translate(x, y, z);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(col, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  const base = H * 0.18; // 台車の高さ分だけ浮かせる
  add(W, H * 0.78, L, 0, base + H * 0.39, 0, bodyColor); // 車体
  add(W * 1.02, H * 0.2, L * 0.9, 0, base + H * 0.52, 0, '#1d2733'); // 側面の窓
  // 屋根は路線の色を明るくしたもの (上から見ても路線が分かるように)
  add(W * 0.9, H * 0.08, L * 0.96, 0, base + H * 0.82, 0, new THREE.Color(bodyColor).lerp(new THREE.Color('#ffffff'), 0.35));
  add(W * 0.8, H * 0.22, L * 0.02, 0, base + H * 0.55, L * 0.5, '#111820'); // 前面の窓
  add(W * 0.8, H * 0.22, L * 0.02, 0, base + H * 0.55, -L * 0.5, '#111820');
  add(W * 0.7, base, L * 0.18, 0, base / 2, L * 0.32, '#2b2b2b'); // 台車
  add(W * 0.7, base, L * 0.18, 0, base / 2, -L * 0.32, '#2b2b2b');
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

function dotTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(16, 16, 12, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = color;
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
