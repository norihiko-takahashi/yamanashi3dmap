#!/usr/bin/env node
// 山梨県3Dマップ用のデータを生成するスクリプト
//
//   node scripts/build-data.mjs [--source gsi|terrarium]
//
// 出力 (public/data/):
//   dem.bin               Uint16 リトルエンディアン、標高(m) × 10。北西から行優先
//   water.png             湖・水面マスク (グレースケール, 255 = 水面)
//   municipalities.json   市町村界 (GeoJSON, 国土数値情報 N03 を簡略化)
//   rivers.json           主要河川 (GeoJSON, 標高データから流路を推定)
//   meta.json             グリッド範囲・出典などのメタデータ
//
// 標高の取得元:
//   gsi        国土地理院 標高タイル (dem_png)      … 既定
//   terrarium  AWS Terrain Tiles (Terrarium 形式)   … 国土地理院に接続できない環境向け
//
// 失敗した場合は public/data を変更せずに終了コード 1 で終わる。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { LAKES } from '../src/places.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const CACHE_DIR = path.join(ROOT, '.cache');

// ---------------------------------------------------------------- 設定
const args = process.argv.slice(2);
const argSource = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'gsi';

const BBOX = { west: 138.15, east: 139.17, south: 35.13, north: 36.01 };
const DLON = 1 / 1200; // 約 75 m
const DLAT = 1 / 1500; // 約 74 m
const TILE_ZOOM = 12;

const SOURCES = {
  gsi: {
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`,
    decode(r, g, b) {
      const v = r * 65536 + g * 256 + b;
      if (v === 8388608) return NaN; // 無効値 (海など)
      return (v < 8388608 ? v : v - 16777216) * 0.01;
    },
    missingTileIsSea: true,
    name: '国土地理院 標高タイル',
    attribution: '標高: 国土地理院 標高タイル (DEM10B を加工して作成)',
    attributionUrl: 'https://maps.gsi.go.jp/development/ichiran.html',
  },
  terrarium: {
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    decode: (r, g, b) => r * 256 + g + b / 256 - 32768,
    missingTileIsSea: false,
    name: 'AWS Terrain Tiles',
    attribution: '標高: AWS Terrain Tiles (Mapzen, SRTM ほか) を加工して作成',
    attributionUrl: 'https://registry.opendata.aws/terrain-tiles/',
  },
};

const MUNI_URL = (code) =>
  `https://raw.githubusercontent.com/niiyz/JapanCityGeoJson/master/geojson/19/${code}.json`;
const MUNICIPALITIES = [
  '19201', '19202', '19204', '19205', '19206', '19207', '19208', '19209', '19210',
  '19211', '19212', '19213', '19214', '19346', '19364', '19365', '19366', '19368',
  '19384', '19422', '19423', '19424', '19425', '19429', '19430', '19442', '19443',
];

const source = SOURCES[argSource];
if (!source) {
  console.error(`不明な --source: ${argSource} (gsi か terrarium を指定)`);
  process.exit(1);
}

// ---------------------------------------------------------------- ユーティリティ
async function fetchCached(url, cacheName, { allow404 = false } = {}) {
  const file = path.join(CACHE_DIR, cacheName);
  try {
    return await fs.readFile(file);
  } catch {}
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buf);
      return buf;
    } catch (e) {
      if (attempt === 4) throw new Error(`${url} の取得に失敗: ${e.cause?.message ?? e.message}`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        results[k] = await fn(items[k], k);
      }
    }),
  );
  return results;
}

const lon2tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

// ---------------------------------------------------------------- 標高
async function buildDem() {
  const z = TILE_ZOOM;
  const x0 = Math.floor(lon2tileX(BBOX.west, z));
  const x1 = Math.floor(lon2tileX(BBOX.east, z));
  const y0 = Math.floor(lat2tileY(BBOX.north, z));
  const y1 = Math.floor(lat2tileY(BBOX.south, z));
  const tw = x1 - x0 + 1;
  const th = y1 - y0 + 1;
  const W = tw * 256;
  const H = th * 256;
  const mosaic = new Float32Array(W * H).fill(NaN);

  const tiles = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) tiles.push([tx, ty]);
  console.log(`標高タイル ${tiles.length} 枚を取得 (${source.name}, z${z})`);

  await pool(tiles, 8, async ([tx, ty]) => {
    const buf = await fetchCached(source.url(z, tx, ty), `${argSource}/${z}/${tx}/${ty}.png`, {
      allow404: source.missingTileIsSea,
    });
    if (!buf) return; // タイルなし = 海
    const png = PNG.sync.read(buf);
    const ox = (tx - x0) * 256;
    const oy = (ty - y0) * 256;
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const i = (py * 256 + px) * 4;
        mosaic[(oy + py) * W + ox + px] = source.decode(png.data[i], png.data[i + 1], png.data[i + 2]);
      }
    }
  });

  // 等緯度経度グリッドへ再サンプリング (双一次補間)
  const cols = Math.round((BBOX.east - BBOX.west) / DLON) + 1;
  const rows = Math.round((BBOX.north - BBOX.south) / DLAT) + 1;
  const heights = new Float32Array(cols * rows);
  const sample = (x, y) => {
    const v = mosaic[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    return Number.isNaN(v) ? 0 : v;
  };
  for (let r = 0; r < rows; r++) {
    const lat = BBOX.north - r * DLAT;
    const fy = (lat2tileY(lat, z) - y0) * 256 - 0.5;
    const iy = Math.floor(fy);
    const ty = fy - iy;
    for (let c = 0; c < cols; c++) {
      const lon = BBOX.west + c * DLON;
      const fx = (lon2tileX(lon, z) - x0) * 256 - 0.5;
      const ix = Math.floor(fx);
      const tx = fx - ix;
      const h =
        sample(ix, iy) * (1 - tx) * (1 - ty) +
        sample(ix + 1, iy) * tx * (1 - ty) +
        sample(ix, iy + 1) * (1 - tx) * ty +
        sample(ix + 1, iy + 1) * tx * ty;
      heights[r * cols + c] = Math.max(0, h);
    }
  }
  return { cols, rows, heights };
}

// ---------------------------------------------------------------- 湖 (平坦な水面の検出)
// 標高データでは湖面がほぼ一定の高さになるため、広く平坦な連結領域を湖とみなす。
function detectWater({ cols, rows, heights }, report = []) {
  const describe = (cells, method, name = '') => {
    let sx = 0, sy = 0, sh = 0, sh2 = 0;
    for (const i of cells) {
      const r = (i / cols) | 0, c = i - r * cols;
      sx += c; sy += r; sh += heights[i]; sh2 += heights[i] ** 2;
    }
    const n = cells.length;
    const mean = sh / n;
    report.push({
      method,
      name,
      cells: n,
      km2: n * (DLAT * 110.95) * (DLON * 111.32 * Math.cos((35.57 * Math.PI) / 180)),
      lon: BBOX.west + (sx / n) * DLON,
      lat: BBOX.north - (sy / n) * DLAT,
      height: mean,
      sd: Math.sqrt(Math.max(0, sh2 / n - mean * mean)),
    });
  };
  const flat = new Uint8Array(cols * rows);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      const h = heights[i];
      if (h < 1) continue;
      let ok = true;
      for (let dr = -1; dr <= 1 && ok; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if (Math.abs(heights[i + dr * cols + dc] - h) > 0.25) { ok = false; break; }
      if (ok) flat[i] = 1;
    }
  }
  // 連結成分ごとに面積を集計し、小さいものは捨てる
  const mask = new Uint8Array(cols * rows);
  const seen = new Uint8Array(cols * rows);
  const stack = [];
  const MIN_CELLS = 60; // 約 0.33 km²
  for (let s = 0; s < flat.length; s++) {
    if (!flat[s] || seen[s]) continue;
    const comp = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const r = (i / cols) | 0;
      const c = i - r * cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        if (flat[j] && !seen[j] && Math.abs(heights[j] - heights[i]) < 0.25) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (comp.length >= MIN_CELLS) {
      describe(comp, '平坦判定');
      for (const i of comp) {
        mask[i] = 255;
        // 縁 (平坦判定から外れた湖岸のセル) も含める
        const r = (i / cols) | 0, c = i - r * cols;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr, cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) {
              const j = rr * cols + cc;
              if (Math.abs(heights[j] - heights[i]) < 1.5) mask[j] = 255;
            }
          }
      }
    }
  }
  // 名前の分かっている湖は代表点から塗り広げる (平坦判定で取りこぼした湖面を補う)
  for (const lake of LAKES) {
    const c0 = Math.round((lake.lon - BBOX.west) / DLON);
    const r0 = Math.round((BBOX.north - lake.lat) / DLAT);
    // 代表点付近 (半径約 500 m) で最も多い標高 (0.5 m 単位) を湖面とみなす
    const hist = new Map();
    for (let dr = -7; dr <= 7; dr++)
      for (let dc = -6; dc <= 6; dc++) {
        const k = Math.round(heights[(r0 + dr) * cols + c0 + dc] * 2);
        hist.set(k, (hist.get(k) ?? 0) + 1);
      }
    const level = [...hist.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0] / 2;
    let seed = -1, bestD = Infinity;
    for (let dr = -7; dr <= 7; dr++)
      for (let dc = -6; dc <= 6; dc++) {
        const j = (r0 + dr) * cols + c0 + dc;
        if (Math.abs(heights[j] - level) <= 0.5 && dr * dr + dc * dc < bestD) { bestD = dr * dr + dc * dc; seed = j; }
      }
    const surface = level + 1.5;
    const maxR = 60; // 約 4.5 km 以内
    const filled = [];
    const seenL = new Set([seed]);
    stack.push(seed);
    while (stack.length && filled.length < 20000) {
      const i = stack.pop();
      filled.push(i);
      const r = (i / cols) | 0, c = i - r * cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (Math.abs(rr - r0) > maxR || Math.abs(cc - c0) > maxR) continue;
        const j = rr * cols + cc;
        if (!seenL.has(j) && heights[j] <= surface) {
          seenL.add(j);
          stack.push(j);
        }
      }
    }
    if (filled.length >= 20000) {
      console.warn(`  ${lake.name}: 湖面が広がりすぎたため除外`);
      continue;
    }
    for (const i of filled) mask[i] = 255;
    describe(filled, '代表点から塗り広げ', lake.name);
    console.log(`  ${lake.name}: 湖面 ${level.toFixed(1)} m, ${(filled.length * 0.0046).toFixed(1)} km²`);
  }
  return mask;
}

// ---------------------------------------------------------------- 河川 (流路の推定)
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= n) break;
        if (m + 1 < n && k[m + 1] < k[m]) m++;
        if (k[m] >= lk) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

function buildRivers({ cols, rows, heights }) {
  const N = cols * rows;
  // Priority-Flood (+ε) で窪地を埋めつつ、各セルの流下方向を決める
  const filled = new Float64Array(heights);
  const down = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new MinHeap();
  const order = new Int32Array(N);
  let n = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) {
        const i = r * cols + c;
        done[i] = 1;
        heap.push(filled[i], i);
      }
  const D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  while (heap.size) {
    const i = heap.pop();
    order[n++] = i;
    const r = (i / cols) | 0, c = i - r * cols;
    for (const [dr, dc] of D) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const j = rr * cols + cc;
      if (done[j]) continue;
      done[j] = 1;
      if (filled[j] <= filled[i]) filled[j] = filled[i] + 1e-4;
      down[j] = i;
      heap.push(filled[j], j);
    }
  }
  // 集水面積 (セル数) を下流へ積算 — 処理順の逆が上流→下流
  const acc = new Float32Array(N).fill(1);
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k];
    if (down[i] >= 0) acc[down[i]] += acc[i];
  }
  const cellKm2 = (DLAT * 111.32) * (DLON * 111.32 * Math.cos((35.57 * Math.PI) / 180));
  const MIN_KM2 = 25;
  const minCells = MIN_KM2 / cellKm2;

  // 河道セルを上流端からたどってポリラインにする
  const isStream = (i) => acc[i] >= minCells;
  const hasStreamUpstream = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (isStream(i) && down[i] >= 0) hasStreamUpstream[down[i]] = 1;
  const visited = new Uint8Array(N);
  const lonOf = (i) => BBOX.west + (i % cols) * DLON;
  const latOf = (i) => BBOX.north + -((i / cols) | 0) * DLAT;
  const features = [];
  for (let s = 0; s < N; s++) {
    if (!isStream(s) || hasStreamUpstream[s]) continue;
    // 上流端から下流へ。合流点で既存の線に接続したら終了
    let line = [s];
    let i = s;
    visited[i] = 1;
    const segments = [];
    while (down[i] >= 0) {
      const j = down[i];
      line.push(j);
      if (visited[j]) break;
      visited[j] = 1;
      // 集水面積の段階が変わったら線を分ける (太さを変えるため)
      if (Math.floor(Math.log2(acc[j] / minCells)) !== Math.floor(Math.log2(acc[i] / minCells))) {
        segments.push(line);
        line = [j];
      }
      i = j;
    }
    segments.push(line);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      const km2 = acc[seg[0]] * cellKm2;
      const coords = simplify(seg.map((k) => [lonOf(k), latOf(k)]), 0.0004).map(([x, y]) => [
        +x.toFixed(5),
        +y.toFixed(5),
      ]);
      features.push({
        type: 'Feature',
        properties: { area: Math.round(km2) },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------- 市町村界
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > best) { best = d; bi = i; }
    }
    if (best > t2) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return s / 2;
}

function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 重心がポリゴン外に落ちたときのラベル位置 (内部の格子点で最も中心寄りのもの)
function labelPoint(ring) {
  const c = ringCentroid(ring);
  if (pointInRing(c, ring)) return c;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  let best = null, bd = Infinity;
  for (let i = 1; i < 30; i++)
    for (let j = 1; j < 30; j++) {
      const p = [minX + ((maxX - minX) * i) / 30, minY + ((maxY - minY) * j) / 30];
      if (!pointInRing(p, ring)) continue;
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
  return best ?? c;
}

async function buildMunicipalities() {
  console.log(`市町村界 ${MUNICIPALITIES.length} 件を取得`);
  const features = await pool(MUNICIPALITIES, 6, async (code) => {
    const buf = await fetchCached(MUNI_URL(code), `municipalities/${code}.json`);
    const fc = JSON.parse(buf.toString('utf8'));
    const polys = [];
    let name = '';
    for (const f of fc.features) {
      name = (f.properties.N03_004 || f.properties.N03_003 || '').trim();
      const g = f.geometry;
      const list = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const poly of list) {
        const rings = poly
          .map((ring) => simplify(ring, 0.00015).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]))
          .filter((ring) => ring.length >= 4);
        if (rings.length) polys.push(rings);
      }
    }
    // 最大の島の内部にラベルを置く
    const main = polys.reduce((a, b) => (Math.abs(ringArea(b[0])) > Math.abs(ringArea(a[0])) ? b : a));
    const [lx, ly] = labelPoint(main[0]);
    return {
      type: 'Feature',
      properties: { code, name, label: [+lx.toFixed(5), +ly.toFixed(5)] },
      geometry: { type: 'MultiPolygon', coordinates: polys },
    };
  });
  return { type: 'FeatureCollection', features };
}

// 湖として判定した領域の一覧 (場所・面積・判定方法) を表示する。
// GitHub Actions ではジョブの概要 (GITHUB_STEP_SUMMARY) にも書き出す。
async function printWaterReport(report, municipalities) {
  const muniOf = (lon, lat) => {
    for (const f of municipalities.features)
      for (const poly of f.geometry.coordinates) if (pointInRing([lon, lat], poly[0])) return f.properties.name;
    return '県外';
  };
  const rows = [...report].sort((a, b) => b.cells - a.cells);
  const lines = rows.map(
    (w) =>
      `| ${w.method} | ${w.name || '-'} | ${muniOf(w.lon, w.lat)} | ${w.lon.toFixed(3)}, ${w.lat.toFixed(3)} | ` +
      `${w.km2.toFixed(2)} | ${w.height.toFixed(1)} | ${w.sd.toFixed(2)} |`,
  );
  const table = [
    `湖として判定した領域: ${rows.length} か所`,
    '',
    '| 判定方法 | 湖名 | 場所 | 経度, 緯度 | 面積 (km²) | 平均標高 (m) | 標高のばらつき (m) |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
    ...lines,
  ].join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### 湖の判定結果 (${source.name})\n\n${table}\n\n`);
  }
}

// ---------------------------------------------------------------- メイン
async function main() {
  const t0 = Date.now();
  const dem = await buildDem();
  const municipalities = await buildMunicipalities();
  console.log(`グリッド ${dem.cols} × ${dem.rows}`);

  const waterReport = [];
  const water = detectWater(dem, waterReport);
  const rivers = buildRivers(dem);

  let maxH = 0, maxI = 0;
  for (let i = 0; i < dem.heights.length; i++) if (dem.heights[i] > maxH) { maxH = dem.heights[i]; maxI = i; }

  const bin = new Uint16Array(dem.heights.length);
  for (let i = 0; i < bin.length; i++) bin[i] = Math.min(65535, Math.round(dem.heights[i] * 10));

  const png = new PNG({ width: dem.cols, height: dem.rows, colorType: 0, inputColorType: 0, bitDepth: 8 });
  png.data = Buffer.from(water);

  const meta = {
    generated: new Date().toISOString(),
    source: argSource,
    sourceName: source.name,
    cols: dem.cols,
    rows: dem.rows,
    west: BBOX.west,
    north: BBOX.north,
    dlon: DLON,
    dlat: DLAT,
    heightScale: 0.1,
    maxHeight: Math.round(maxH),
    maxHeightAt: [
      +(BBOX.west + (maxI % dem.cols) * DLON).toFixed(5),
      +(BBOX.north - Math.floor(maxI / dem.cols) * DLAT).toFixed(5),
    ],
    attribution: [
      { text: source.attribution, url: source.attributionUrl },
      {
        text: '行政区域: 国土数値情報 (行政区域データ N03) を加工して作成',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v3_1.html',
      },
      { text: '河川・湖: 上記の標高データから推定' },
    ],
  };

  // 一時ディレクトリに書き出してから置き換える
  const tmp = `${OUT_DIR}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, 'dem.bin'), Buffer.from(bin.buffer));
  await fs.writeFile(path.join(tmp, 'water.png'), PNG.sync.write(png, { colorType: 0, inputColorType: 0 }));
  await fs.writeFile(path.join(tmp, 'municipalities.json'), JSON.stringify(municipalities));
  await fs.writeFile(path.join(tmp, 'rivers.json'), JSON.stringify(rivers));
  await fs.writeFile(path.join(tmp, 'meta.json'), JSON.stringify(meta, null, 2));
  // このスクリプトが作るファイルだけを置き換える (railways.json など他のデータは残す)
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const name of await fs.readdir(tmp)) await fs.rename(path.join(tmp, name), path.join(OUT_DIR, name));
  await fs.rm(tmp, { recursive: true, force: true });

  const waterCells = water.reduce((s, v) => s + (v ? 1 : 0), 0);
  await printWaterReport(waterReport, municipalities);
  console.log(
    `完了 (${((Date.now() - t0) / 1000).toFixed(1)} 秒): 最高点 ${meta.maxHeight} m @ ${meta.maxHeightAt}, ` +
      `河川 ${rivers.features.length} 本, 水面 ${waterCells} セル`,
  );
}

main().catch((e) => {
  console.error(`データ生成に失敗しました: ${e.message}`);
  process.exit(1);
});
