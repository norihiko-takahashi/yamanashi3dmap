#!/usr/bin/env node
// 山梨県3Dマップ用のデータを生成するスクリプト
//
//   node scripts/build-data.mjs [--source gsi|terrarium]
//
// 出力 (public/data/):
//   dem.bin               Uint16 リトルエンディアン、標高(m) × 10。北西から行優先
//   water.png             湖・水面マスク (グレースケール, 255 = 水面)
//   fuji_view.png         富士山の山頂が見える場所 (グレースケール, 255 = 見える)
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

// ---------------------------------------------------------------- 湖 (水平な水面の検出)
// 湖面は標高データ上で「ほぼ同じ高さ」が広く続く。ただし甲府盆地のような平野も
// 隣どうしの差は小さいため、隣との差ではなく、領域の基準の高さとの差で判定する。
const WATER = {
  flatTol: 0.15, // 湖面とみなす高さの許容差 (m)。基準の高さとの差で判定する
  maxSd: 0.1, // 湖面の高さのばらつき (標準偏差, m) の上限
  minCells: 60, // 最小面積 (セル数, 約 0.33 km²)
  matchKm: 2, // 名前の分かっている湖の代表点と、湖面の重心との最大距離
  // 湖は周りを湖面より高い土地に囲まれているので、湖面の高さ (+ 余裕) まで水を満たしても
  // ほぼ同じ範囲にとどまる。平野の平らな部分は下流側へ水があふれて際限なく広がる
  fillTol: 0.6, // 湖面からこの高さまで水を満たして確かめる (m)
  maxFillRatio: 3, // 満たした範囲が核の何倍を超えたら「水がたまらない」とみなすか
  maxFillExtra: 3000, // 核が小さいときに許す増分 (セル数)
  minLevel: 10, // これより低い水平な土地は海沿いの低地とみなす (海は標高 0 m の色で表示している)
};

function detectWater({ cols, rows, heights }, report = []) {
  const N = cols * rows;
  const rc = (i) => [(i / cols) | 0, i % cols];
  const stats = (cells) => {
    let sx = 0, sy = 0, sh = 0, sh2 = 0;
    for (const i of cells) {
      const [r, c] = rc(i);
      sx += c; sy += r; sh += heights[i]; sh2 += heights[i] ** 2;
    }
    const n = cells.length;
    const mean = sh / n;
    return {
      count: n,
      km2: n * (DLAT * 110.95) * (DLON * 111.32 * Math.cos((35.57 * Math.PI) / 180)),
      lon: BBOX.west + (sx / n) * DLON,
      lat: BBOX.north - (sy / n) * DLAT,
      height: mean,
      sd: Math.sqrt(Math.max(0, sh2 / n - mean * mean)),
    };
  };
  // cells からつながっている、高さが top 以下のセルをすべて集める。limit を超えたら null
  const fillBelow = (cells, top, limit) => {
    const inside = new Set(cells);
    const out = [...cells];
    const st = [...cells];
    while (st.length) {
      const i = st.pop();
      const [r, c] = rc(i);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) return null; // 範囲の端まで広がった
        const j = rr * cols + cc;
        if (!inside.has(j) && heights[j] <= top) {
          inside.add(j);
          out.push(j);
          st.push(j);
          if (out.length > limit) return null;
        }
      }
    }
    return out;
  };
  const rejected = [];
  const distKm = (a, lon, lat) =>
    Math.hypot((a.lon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180), (a.lat - lat) * 110.95);

  // 1. 周囲 8 セルとの差がすべて許容差以内のセル
  const flat = new Uint8Array(N);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      const h = heights[i];
      if (h < 1) continue; // 海
      let ok = true;
      for (let dr = -1; dr <= 1 && ok; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if (Math.abs(heights[i + dr * cols + dc] - h) > WATER.flatTol) { ok = false; break; }
      if (ok) flat[i] = 1;
    }
  }

  // 2. 基準の高さ (最初のセル) との差が許容差以内の範囲だけをつなぐ。
  //    隣との差でつなぐと、緩やかな傾斜の平野が少しずつ高さを変えながら 1 つにつながってしまう
  const seen = new Uint8Array(N);
  const stack = [];
  const regions = [];
  for (let s = 0; s < N; s++) {
    if (!flat[s] || seen[s]) continue;
    const level = heights[s];
    const cells = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const [r, c] = rc(i);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const j = rr * cols + cc;
        if (flat[j] && !seen[j] && Math.abs(heights[j] - level) <= WATER.flatTol) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (cells.length < WATER.minCells) continue;
    const core = stats(cells);
    if (core.sd > WATER.maxSd) continue;
    if (core.height < WATER.minLevel) {
      for (const i of cells) seen[i] = 1;
      rejected.push({ ...core, method: '除外 (海沿いの低地)', name: '' });
      continue;
    }
    // 水平な部分を核として、湖面の高さ (+ fillTol) まで水を満たす。
    // 湖ならほぼ核の範囲にとどまり、平野ならあふれて広がるので除外する
    const lv = core.height;
    const limit = Math.max(cells.length * WATER.maxFillRatio, cells.length + WATER.maxFillExtra);
    const grown = fillBelow(cells, lv + WATER.fillTol, limit);
    for (const i of cells) seen[i] = 1;
    const st = stats(grown ?? cells);
    if (!grown) {
      rejected.push({ ...st, method: '除外 (水がたまらない平らな土地)', name: '' });
      continue;
    }
    regions.push({ cells: grown, level: lv, ...st, method: '水平な湖面', name: '' });
  }

  // 3. 名前の分かっている湖を、近くの水平な湖面と対応づける。
  //    見つからない場合だけ、代表点から同じ高さの範囲を塗り広げる (結果が水平なときだけ採用)
  for (const lake of LAKES) {
    const near = regions
      .filter((g) => !g.name && distKm(g, lake.lon, lake.lat) <= WATER.matchKm)
      .sort((a, b) => distKm(a, lake.lon, lake.lat) - distKm(b, lake.lon, lake.lat))[0];
    if (near) {
      near.name = lake.name;
      continue;
    }
    const c0 = Math.round((lake.lon - BBOX.west) / DLON);
    const r0 = Math.round((BBOX.north - lake.lat) / DLAT);
    const hist = new Map();
    for (let dr = -7; dr <= 7; dr++)
      for (let dc = -6; dc <= 6; dc++) {
        const k = Math.round(heights[(r0 + dr) * cols + c0 + dc] * 2);
        hist.set(k, (hist.get(k) ?? 0) + 1);
      }
    const level = [...hist.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0] / 2;
    // 代表点の付近で湖面と同じ高さのセルを核にして、同じく水がたまるかを確かめる
    const coreCells = [];
    for (let dr = -7; dr <= 7; dr++)
      for (let dc = -6; dc <= 6; dc++) {
        const j = (r0 + dr) * cols + c0 + dc;
        if (Math.abs(heights[j] - level) <= 0.25) coreCells.push(j);
      }
    const cells = fillBelow(coreCells, level + WATER.fillTol, Math.max(coreCells.length * WATER.maxFillRatio, 600)) ?? [];
    const st = cells.length ? stats(cells) : { km2: 0 };
    if (cells.length >= 20) {
      regions.push({ cells, level, ...st, method: '代表点から塗り広げ', name: lake.name });
    } else {
      console.warn(
        `  ${lake.name}: 代表点の付近に水がたまる湖面が見つからないため表示しない (湖面の推定 ${level.toFixed(1)} m)`,
      );
    }
  }

  // 4. マスクを作る。湖岸 (水平判定から外れた縁のセル) も 1 セル分含める
  const mask = new Uint8Array(N);
  for (const g of regions) {
    for (const i of g.cells) {
      mask[i] = 255;
      const [r, c] = rc(i);
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const j = rr * cols + cc;
          if (Math.abs(heights[j] - g.level) <= 1) mask[j] = 255;
        }
    }
    const { cells, ...rest } = g;
    report.push(rest);
  }
  // 除外した領域も確認できるように一覧に含める (表示はしない)
  report.push(...rejected.filter((g) => g.km2 >= 0.5));
  return mask;
}

// ---------------------------------------------------------------- 富士山が見える場所
// 山頂付近の点から全方位へ視線を伸ばし、途中の地形に遮られずに届くセルを「見える」とする。
// 見通しは両端で対称なので、各地点 (目の高さ 1.6 m) から山頂付近が見えるかと同じになる。
// 山頂には火口があり、最高点 (剣ヶ峰) は南西側の縁にあるため、北東側からは手前の
// 火口の縁しか見えない。そこで火口の縁を囲む複数の点を対象にし、どれか 1 点でも見えれば
// 「富士山 (の山頂付近) が見える」とする。地球の丸みと大気による光の屈折 (屈折係数 0.13) を考慮する。
const VIEW = {
  eyeHeight: 1.6, // 観測者の目の高さ (m)
  earthRadius: 6371000, // m
  refraction: 0.13,
  rays: 12000, // 視線の本数 (最も遠い範囲でもセルの間隔とほぼ同じ細かさになる数)
  stepKm: 0.035, // 視線に沿って調べる間隔
  rimRadiusKm: 1.2, // 最高点からこの範囲で火口の縁の点を選ぶ
  rimDrop: 150, // 最高点からこの高さ (m) 以内の点だけを山頂付近とみなす
  rimSectors: 12, // 縁の点を選ぶ方位の数
};

// 山頂付近 (火口の縁) の点を方位ごとに 1 つずつ選ぶ
function summitRimPoints({ cols, rows, heights }, summitIndex) {
  const cellX = DLON * 111.32 * Math.cos((35.57 * Math.PI) / 180);
  const cellZ = DLAT * 110.95;
  const sc = summitIndex % cols, sr = (summitIndex / cols) | 0;
  const top = heights[summitIndex];
  const R = Math.ceil(VIEW.rimRadiusKm / cellZ);
  // 山頂付近の点の重心 (おおよその火口の中心) を基準に方位を分ける
  const near = [];
  for (let r = sr - R; r <= sr + R; r++)
    for (let c = sc - R; c <= sc + R; c++) {
      const i = r * cols + c;
      if (Math.hypot((c - sc) * cellX, (r - sr) * cellZ) <= VIEW.rimRadiusKm && heights[i] >= top - VIEW.rimDrop) near.push(i);
    }
  const cx = near.reduce((s, i) => s + (i % cols), 0) / near.length;
  const cz = near.reduce((s, i) => s + ((i / cols) | 0), 0) / near.length;
  const best = new Map();
  for (const i of near) {
    const ang = Math.atan2(((i / cols) | 0) - cz, (i % cols) - cx);
    const sec = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * VIEW.rimSectors) % VIEW.rimSectors;
    if (!best.has(sec) || heights[i] > heights[best.get(sec)]) best.set(sec, i);
  }
  return [...best.values()];
}

function fujiViewshed(dem, summitIndex) {
  const vis = new Uint8Array(dem.cols * dem.rows);
  const points = summitRimPoints(dem, summitIndex);
  for (const p of points) viewshedFrom(dem, p, vis);
  return { vis, points };
}

function viewshedFrom({ cols, rows, heights }, summitIndex, vis) {
  const cellX = DLON * 111.32 * Math.cos((35.57 * Math.PI) / 180); // km
  const cellZ = DLAT * 110.95;
  const sc = summitIndex % cols, sr = (summitIndex / cols) | 0;
  const h0 = heights[summitIndex];
  const sample = (c, r) => {
    const c0 = Math.floor(c), r0 = Math.floor(r);
    if (c0 < 0 || r0 < 0 || c0 >= cols - 1 || r0 >= rows - 1) return NaN;
    const tx = c - c0, ty = r - r0, i = r0 * cols + c0;
    return (
      heights[i] * (1 - tx) * (1 - ty) + heights[i + 1] * tx * (1 - ty) +
      heights[i + cols] * (1 - tx) * ty + heights[i + cols + 1] * tx * ty
    );
  };
  vis[summitIndex] = 255;
  const k = (1 - VIEW.refraction) / (2 * VIEW.earthRadius);
  for (let a = 0; a < VIEW.rays; a++) {
    const th = (a / VIEW.rays) * Math.PI * 2;
    const dx = Math.cos(th), dz = Math.sin(th);
    let maxSlope = -Infinity;
    for (let d = VIEW.stepKm; ; d += VIEW.stepKm) {
      const c = sc + (dx * d) / cellX, r = sr + (dz * d) / cellZ;
      const h = sample(c, r);
      if (Number.isNaN(h)) break;
      const dm = d * 1000;
      const drop = dm * dm * k; // 地球の丸みで下がる高さ (m)
      const ground = (h - drop - h0) / dm; // 山頂から見た地表の傾き
      const eye = (h + VIEW.eyeHeight - drop - h0) / dm;
      if (eye >= maxSlope) vis[Math.round(r) * cols + Math.round(c)] = 255;
      if (ground > maxSlope) maxSlope = ground;
    }
  }
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
  const rows = [...report].sort((a, b) => b.km2 - a.km2);
  const lines = rows.map(
    (w) =>
      `| ${w.method} | ${w.name || '-'} | ${muniOf(w.lon, w.lat)} | ${w.lon.toFixed(3)}, ${w.lat.toFixed(3)} | ` +
      `${w.km2.toFixed(2)} | ${w.height.toFixed(1)} |`,
  );
  const table = [
    `湖として判定した領域: ${rows.filter((w) => !w.method.startsWith('除外')).length} か所` +
      ` (除外した平らな土地 ${rows.filter((w) => w.method.startsWith('除外')).length} か所)`,
    '',
    '| 判定方法 | 湖名 | 場所 | 経度, 緯度 | 面積 (km²) | 平均標高 (m) |',
    '| --- | --- | --- | --- | ---: | ---: |',
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

  // 富士山の山頂 (グリッド内の最高点) が見える場所
  const { vis: view, points: rimPoints } = fujiViewshed(dem, maxI);
  console.log(`富士山の山頂付近の点: ${rimPoints.length} 点 (標高 ${Math.min(...rimPoints.map((i) => dem.heights[i])).toFixed(0)}〜${maxH.toFixed(0)} m)`);
  const viewPng = new PNG({ width: dem.cols, height: dem.rows, colorType: 0, inputColorType: 0, bitDepth: 8 });
  viewPng.data = Buffer.from(view);
  {
    let all = 0, pref = 0, prefAll = 0;
    const inPref = (i) => {
      const lon = BBOX.west + (i % dem.cols) * DLON, lat = BBOX.north - Math.floor(i / dem.cols) * DLAT;
      return municipalities.features.some((f) => f.geometry.coordinates.some((poly) => pointInRing([lon, lat], poly[0])));
    };
    // 県内の割合は 10 セルおきの間引きで見積もる (全セルの判定は時間がかかるため)
    for (let i = 0; i < view.length; i++) if (view[i]) all++;
    for (let i = 0; i < view.length; i += 10) if (inPref(i)) { prefAll++; if (view[i]) pref++; }
    console.log(`富士山が見える場所: グリッド全体の ${((all / view.length) * 100).toFixed(1)}%、山梨県内の約 ${((pref / prefAll) * 100).toFixed(1)}%`);
  }

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
      { text: '富士山が見える場所: 上記の標高データから計算 (目の高さ 1.6 m、地球の丸みと大気の屈折を考慮、建物や樹木は考慮しない)' },
    ],
  };

  // 一時ディレクトリに書き出してから置き換える
  const tmp = `${OUT_DIR}.tmp`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, 'dem.bin'), Buffer.from(bin.buffer));
  await fs.writeFile(path.join(tmp, 'water.png'), PNG.sync.write(png, { colorType: 0, inputColorType: 0 }));
  await fs.writeFile(path.join(tmp, 'fuji_view.png'), PNG.sync.write(viewPng, { colorType: 0, inputColorType: 0 }));
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
