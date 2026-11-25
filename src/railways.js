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
const BASE_SPEED = 0.35; // 俯瞰で眺めるときの基準の速さ (km/秒、実際よりかなり速い)
const CAB_EYE = { ahead: 0.004, height: 0.004, lookAhead: 0.35 }; // 運転席の目の位置と視線の先 (km)
const MAX_GRADE = 0.04; // 線路の勾配の上限 (40‰)。これより急な地形はトンネル・橋とみなす

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
    this.cab = null; // 運転席に乗っている電車 { line, train }
  }

  // 運転席に乗る。カメラに最も近い電車を選び、その電車はそのままの速さで走り続ける
  enterCab(id, near) {
    const l = this.#get(id);
    if (!l.trainsVisible) this.setTrainsVisible(id, true);
    let best = 0, bd = Infinity;
    for (let t = 0; t < l.trains; t++) {
      const d = this.#pointAt(l.paths[0], l.state[t].head, this.tmpA).distanceTo(near);
      if (d < bd) { bd = d; best = t; }
    }
    this.cab = { line: l, train: best };
    return l;
  }

  exitCab() {
    this.cab = null;
  }

  // 進行方向で次の駅 (なければ終点)
  #nextStation(l, st) {
    let best = null;
    for (const s of l.stops) {
      const ahead = (s.at - st.head) * st.dir;
      if (ahead > 0.05 && (!best || ahead < (best.at - st.head) * st.dir)) best = s;
    }
    return best ? best.name : '終点';
  }

  // 運転席の目の位置・視線の先・速さ (km/h) を返す
  cabView(eye, target) {
    const { line, train } = this.cab;
    const st = line.state[train];
    const path = line.paths[0];
    this.#pointAt(path, st.head + st.dir * CAB_EYE.ahead, eye);
    eye.y += CAB_EYE.height * Math.max(1, this.exag * 0.5);
    this.#pointAt(path, st.head + st.dir * CAB_EYE.lookAhead, target);
    target.y += CAB_EYE.height * Math.max(1, this.exag * 0.5);
    // 目の位置が地表より下ならトンネルの中
    const tunnel = this.terrain.surfaceHeightAtXZ(eye.x, eye.z) / 1000 * this.exag > eye.y;
    return { kmh: st.kmh, name: line.name, tunnel, status: `次は ${this.#nextStation(line, st)}` };
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
  // dt: 前回からの経過秒数。各編成は自分の時計を持ち、速さを変えても位置が飛ばないようにする
  update(dt, camera, viewportHeight) {
    let changed = false;
    // 距離 1 km あたりの 1 画素の大きさ (km)
    const pxPerKm = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight);
    for (const l of this.lines) {
      if (!l.trainsVisible) continue;
      changed = true;
      const path = l.paths[0];
      // 往復 1 回分の時間 (速さ 1 倍のとき)。終点では少し停車してから折り返す
      const legSec = path.length / BASE_SPEED + 6;
      let k = 0;
      for (let t = 0; t < l.trains; t++) {
        const st = l.state[t];
        const inCab = this.cab && this.cab.line === l && this.cab.train === t;

        // 運転席に乗っている間は、すべての編成を実寸で描く (前方の電車が巨大に見えないように)。
        // それ以外はカメラからの距離に応じて拡大する
        const est = this.#pointAt(path, st.head, this.tmpA);
        const dist = camera.position.distanceTo(est);
        const sw = this.cab ? 1 : THREE.MathUtils.clamp((MIN_WIDTH_PX * pxPerKm * dist) / CAR.width, 1, 80);
        let sl = this.cab ? 1 : Math.max(1, sw * LENGTH_RATIO);
        if ((CAR.length + CAR.gap) * sl * l.cars > path.length * 0.4) {
          sl = (path.length * 0.4) / ((CAR.length + CAR.gap) * l.cars);
        }
        const sp = (CAR.length + CAR.gap) * sl;

        // 位置は実寸の編成の長さで決める (拡大率が変わっても、乗った瞬間に位置が飛ばないように)
        const realLen = (CAR.length + CAR.gap) * l.cars;
        st.clock += dt * this.speed;
        const travel = Math.max(0.1, path.length - realLen);
        const phase = (st.clock + (t / l.trains) * 2 * legSec + l.offset) % (2 * legSec);
        const forward = phase < legSec;
        const p = (forward ? phase : phase - legSec) / legSec;
        const u = THREE.MathUtils.smootherstep(THREE.MathUtils.clamp((p - 0.08) / 0.84, 0, 1), 0, 1);
        const along = travel * u;
        // 先頭車両の位置。進行方向の後ろに車両が続く
        const nextHead = forward ? realLen + along : path.length - realLen - along;
        // 運転席に表示する速さ (km/h)。折り返しの瞬間などの飛びは無視して平滑化する
        const moved = Math.abs(nextHead - st.head);
        if (inCab && dt > 0 && moved < 5) st.kmh += ((moved / dt) * 3600 - st.kmh) * (1 - Math.exp(-dt / 0.5));
        st.head = nextHead;
        st.dir = forward ? 1 : -1;
        const head = st.head;
        const dir = st.dir;

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

    // 運転席の電車が止まる駅 (本線上の、駅に最も近い位置)
    const main = paths[0];
    const stops = [];
    for (const s of stations) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < main.n; i++) {
        const d = (main.x[i] - s.x) ** 2 + (main.z[i] - s.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      if (Math.sqrt(bd) < 0.3) stops.push({ name: s.name, at: main.dist[best] });
    }

    return {
      ...def,
      paths,
      stops,
      stations,
      stationPoints,
      trackGroup,
      lineMaterials,
      trainMesh,
      trackVisible: true,
      trainsVisible: true,
      offset: Math.random() * 30,
      state: Array.from({ length: def.trains }, () => ({ clock: 0, head: 0, dir: 1, kmh: 0 })),
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
    const dist = new Float32Array(n);
    for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    // 地形の細かい凹凸で線路が波打たないよう平滑化する
    const smooth = new Float32Array(n);
    const W = 4;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) { s += surface[k]; c++; }
      smooth[i] = s / c;
    }
    // 勾配を MAX_GRADE 以内に抑える。地表の下側に沿う線 (尾根はトンネルで抜ける) と
    // 上側に沿う線 (谷は橋で渡る) を作り、その中間を線路の高さにする
    const lower = Float32Array.from(smooth);
    const upper = Float32Array.from(smooth);
    const dh = (i) => (dist[i] - dist[i - 1]) * 1000 * MAX_GRADE; // 区間で許される高低差 (m)
    for (let i = 1; i < n; i++) {
      lower[i] = Math.min(lower[i], lower[i - 1] + dh(i));
      upper[i] = Math.max(upper[i], upper[i - 1] - dh(i));
    }
    for (let i = n - 2; i >= 0; i--) {
      lower[i] = Math.min(lower[i], lower[i + 1] + dh(i + 1));
      upper[i] = Math.max(upper[i], upper[i + 1] - dh(i + 1));
    }
    const h = new Float32Array(n);
    for (let i = 0; i < n; i++) h[i] = (lower[i] + upper[i]) / 2;
    return { n, x: Float32Array.from(xs), z: Float32Array.from(zs), h, surface, dist, length: dist[n - 1] };
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
