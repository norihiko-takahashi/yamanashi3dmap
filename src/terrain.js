import * as THREE from 'three';

const KM_PER_DEG_LAT = 110.95;

// 標高グリッドから地形メッシュを作る。
// ワールド座標の単位は km。x が東、z が南、y が標高 (強調前)。
export class Terrain {
  constructor(meta, raw, { step = 1 } = {}) {
    this.meta = meta;
    const { cols, rows } = meta;
    this.cols = cols;
    this.rows = rows;
    this.heights = new Float32Array(cols * rows);
    let max = 0;
    for (let i = 0; i < raw.length; i++) {
      const h = raw[i] * meta.heightScale;
      this.heights[i] = h;
      if (h > max) max = h;
    }
    this.maxHeight = max;

    this.lonC = meta.west + ((cols - 1) * meta.dlon) / 2;
    this.latC = meta.north - ((rows - 1) * meta.dlat) / 2;
    this.kmPerLon = 111.32 * Math.cos((this.latC * Math.PI) / 180);
    this.kmPerLat = KM_PER_DEG_LAT;
    this.cellX = meta.dlon * this.kmPerLon;
    this.cellZ = meta.dlat * this.kmPerLat;
    this.width = (cols - 1) * this.cellX;
    this.depth = (rows - 1) * this.cellZ;

    this.geometry = this.#buildGeometry(step);
    this.skirtGeometry = this.#buildSkirt(step);
  }

  lonLatToXZ(lon, lat) {
    return [(lon - this.lonC) * this.kmPerLon, (this.latC - lat) * this.kmPerLat];
  }

  xzToLonLat(x, z) {
    return [this.lonC + x / this.kmPerLon, this.latC - z / this.kmPerLat];
  }

  // グリッド座標 (小数) での双一次補間
  heightAtGrid(c, r) {
    const { cols, rows, heights } = this;
    c = Math.min(cols - 1, Math.max(0, c));
    r = Math.min(rows - 1, Math.max(0, r));
    const c0 = Math.min(cols - 2, Math.floor(c));
    const r0 = Math.min(rows - 2, Math.floor(r));
    const tx = c - c0;
    const ty = r - r0;
    const i = r0 * cols + c0;
    return (
      heights[i] * (1 - tx) * (1 - ty) +
      heights[i + 1] * tx * (1 - ty) +
      heights[i + cols] * (1 - tx) * ty +
      heights[i + cols + 1] * tx * ty
    );
  }

  heightAtLonLat(lon, lat) {
    return this.heightAtGrid((lon - this.meta.west) / this.meta.dlon, (this.meta.north - lat) / this.meta.dlat);
  }

  heightAtXZ(x, z) {
    return this.heightAtGrid((x + this.width / 2) / this.cellX, (z + this.depth / 2) / this.cellZ);
  }

  inside(x, z) {
    return Math.abs(x) <= this.width / 2 && Math.abs(z) <= this.depth / 2;
  }

  // 高さ場に対するレイマーチング。三角形ごとの判定より速く、標高も正確。
  raycast(ray, exag) {
    const top = (this.maxHeight / 1000) * exag + 0.01;
    const o = ray.origin;
    const d = ray.direction;
    let t = 0;
    // 地形の最高点より上にいる場合は、そこまで一気に進める
    if (o.y > top) {
      if (d.y >= 0) return null;
      t = (o.y - top) / -d.y;
    }
    const above = (tt) => {
      const x = o.x + d.x * tt;
      const z = o.z + d.z * tt;
      return o.y + d.y * tt - (this.heightAtXZ(x, z) / 1000) * exag;
    };
    const maxT = t + 800;
    let prev = t;
    let prevAbove = above(t);
    if (prevAbove < 0) return null;
    while (t < maxT) {
      const step = Math.max(0.015, t * 0.0015);
      t += step;
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      const y = o.y + d.y * t;
      if (y < -1) return null;
      if (!this.inside(x, z)) {
        if (d.y >= 0 || (Math.sign(x) * d.x > 0 && Math.abs(x) > this.width / 2) || (Math.sign(z) * d.z > 0 && Math.abs(z) > this.depth / 2)) {
          return null;
        }
      }
      const a = above(t);
      if (a <= 0) {
        let lo = prev;
        let hi = t;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        const hx = o.x + d.x * hi;
        const hz = o.z + d.z * hi;
        if (!this.inside(hx, hz)) return null;
        return { x: hx, z: hz };
      }
      prev = t;
      prevAbove = a;
    }
    return null;
  }

  #buildGeometry(step) {
    const { cols, rows } = this;
    const nc = Math.floor((cols - 1) / step) + 1;
    const nr = Math.floor((rows - 1) / step) + 1;
    const pos = new Float32Array(nc * nr * 3);
    const uv = new Float32Array(nc * nr * 2);
    let p = 0;
    let q = 0;
    for (let j = 0; j < nr; j++) {
      const r = j * step;
      for (let i = 0; i < nc; i++) {
        const c = i * step;
        pos[p++] = c * this.cellX - this.width / 2;
        pos[p++] = this.heights[r * cols + c] / 1000;
        pos[p++] = r * this.cellZ - this.depth / 2;
        uv[q++] = c / (cols - 1);
        uv[q++] = 1 - r / (rows - 1);
      }
    }
    const idx = new Uint32Array((nc - 1) * (nr - 1) * 6);
    let k = 0;
    for (let j = 0; j < nr - 1; j++) {
      for (let i = 0; i < nc - 1; i++) {
        const a = j * nc + i;
        const b = a + 1;
        const c = a + nc;
        const d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  // 地形の四辺に側面 (断面) を付けて、模型のように見せる
  #buildSkirt(step) {
    const { cols, rows } = this;
    const edges = [];
    const pushEdge = (list) => edges.push(list);
    const top = [], right = [], bottom = [], left = [];
    for (let c = 0; c < cols; c += step) top.push([c, 0]);
    for (let r = 0; r < rows; r += step) right.push([cols - 1 - ((cols - 1) % step), r]);
    for (let c = cols - 1 - ((cols - 1) % step); c >= 0; c -= step) bottom.push([c, rows - 1 - ((rows - 1) % step)]);
    for (let r = rows - 1 - ((rows - 1) % step); r >= 0; r -= step) left.push([0, r]);
    pushEdge(top);
    pushEdge(right);
    pushEdge(bottom);
    pushEdge(left);
    const pos = [];
    const base = -0.4;
    for (const e of edges) {
      for (let i = 0; i < e.length - 1; i++) {
        const [c1, r1] = e[i];
        const [c2, r2] = e[i + 1];
        const x1 = c1 * this.cellX - this.width / 2, z1 = r1 * this.cellZ - this.depth / 2;
        const x2 = c2 * this.cellX - this.width / 2, z2 = r2 * this.cellZ - this.depth / 2;
        const h1 = this.heights[r1 * cols + c1] / 1000, h2 = this.heights[r2 * cols + c2] / 1000;
        pos.push(x1, h1, z1, x1, base, z1, x2, h2, z2);
        pos.push(x2, h2, z2, x1, base, z1, x2, base, z2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }
}
