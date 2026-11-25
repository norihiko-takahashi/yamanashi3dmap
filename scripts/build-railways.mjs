#!/usr/bin/env node
// 山梨県内を通る鉄道路線と駅のデータを生成するスクリプト
//
//   node scripts/build-railways.mjs
//
// 入力: 国土数値情報 鉄道データ (N02-24) の GeoJSON
//   公式の配布元 (nlftp.mlit.go.jp) は ZIP 形式のため、同じファイルを GeoJSON のまま
//   置いている GitHub 上の複製から取得し、SHA-256 で元ファイルと同一であることを確認する。
// 出力: public/data/railways.json

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'railways.json');
const CACHE_DIR = path.join(ROOT, '.cache', 'n02');

const MIRROR = 'https://media.githubusercontent.com/media/UZH-Network-Science/final-project/main/datasets/japan/N02-24_GML/UTF-8';
const SOURCES = {
  section: {
    url: `${MIRROR}/N02-24_RailroadSection.geojson`,
    sha256: 'c9e2a157224ba258d84c9ee5e5bb15a0911d4d2b93e422e403a2b722c2252780',
  },
  station: {
    url: `${MIRROR}/N02-24_Station.geojson`,
    sha256: 'f88168b3a9199a632705df445209c02456005574c1b28e6d78d62171f42c450a',
  },
};

// 表示名・色・編成両数 (路線の色は見分けやすさで選んだもので、各社の公式色ではない)
const LINES = [
  { operator: '東日本旅客鉄道', line: '中央線', id: 'chuo', name: 'JR 中央線', color: '#ff7a1a', cars: 6, trains: 6 },
  { operator: '東海旅客鉄道', line: '身延線', id: 'minobu', name: 'JR 身延線', color: '#2f9bdc', cars: 3, trains: 4 },
  { operator: '東日本旅客鉄道', line: '小海線', id: 'koumi', name: 'JR 小海線', color: '#7cc843', cars: 2, trains: 2 },
  { operator: '富士山麓電気鉄道', line: '大月線', id: 'otsuki', name: '富士急 大月線', color: '#e8457f', cars: 3, trains: 3 },
  { operator: '富士山麓電気鉄道', line: '河口湖線', id: 'kawaguchiko', name: '富士急 河口湖線', color: '#a368e8', cars: 3, trains: 1 },
];

async function load(key) {
  const { url, sha256 } = SOURCES[key];
  const file = path.join(CACHE_DIR, path.basename(url));
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch {
    console.log(`取得: ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(file, buf);
  }
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (hash !== sha256) throw new Error(`${path.basename(url)} のハッシュが一致しません (${hash})`);
  return JSON.parse(buf.toString('utf8'));
}

const lines = (g) => (g.type === 'LineString' ? [g.coordinates] : g.coordinates);
const key = ([x, y]) => `${x.toFixed(5)},${y.toFixed(5)}`;

function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
      const d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol * tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function lengthKm(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i][0] - pts[i - 1][0]) * 111.32 * Math.cos((pts[i][1] * Math.PI) / 180);
    const dy = (pts[i][1] - pts[i - 1][1]) * 110.95;
    s += Math.hypot(dx, dy);
  }
  return s;
}

// 細切れの区間を端点でつなぎ、できるだけ長い連続した線にする
function chain(segments) {
  const ends = new Map();
  const addEnd = (k, i) => (ends.get(k) ?? ends.set(k, []).get(k)).push(i);
  segments.forEach((s, i) => {
    addEnd(key(s[0]), i);
    addEnd(key(s[s.length - 1]), i);
  });
  const used = new Uint8Array(segments.length);
  const segKm = segments.map(lengthKm);
  const farEnd = (i, k) => (key(segments[i][0]) === k ? key(segments[i][segments[i].length - 1]) : key(segments[i][0]));
  // 端点 k からつなげる区間を選ぶ。すでに通った地点へ戻る区間 (複線の別線形など) は使わない
  const takeAt = (k, visited) => {
    const cand = (ends.get(k) ?? []).filter((i) => !used[i] && !visited.has(farEnd(i, k)));
    if (!cand.length) return null;
    cand.sort((a, b) => segKm[b] - segKm[a]);
    return cand[0];
  };
  const chains = [];
  // 長い区間から始めると本線が 1 本につながりやすい
  const order = segments.map((_, i) => i).sort((a, b) => segKm[b] - segKm[a]);
  for (const start of order) {
    if (used[start]) continue;
    used[start] = 1;
    let pts = [...segments[start]];
    const visited = new Set([key(pts[0]), key(pts[pts.length - 1])]);
    for (const atEnd of [true, false]) {
      for (;;) {
        const k = key(atEnd ? pts[pts.length - 1] : pts[0]);
        const i = takeAt(k, visited);
        if (i === null) break;
        used[i] = 1;
        visited.add(farEnd(i, k));
        let s = segments[i];
        if (atEnd) {
          if (key(s[0]) !== k) s = [...s].reverse();
          pts = pts.concat(s.slice(1));
        } else {
          if (key(s[s.length - 1]) !== k) s = [...s].reverse();
          pts = s.slice(0, -1).concat(pts);
        }
      }
    }
    chains.push(pts);
  }
  return joinNearby(chains);
}

// 端点がわずかにずれている線どうしを、近いものから順につなぐ
function joinNearby(chains, tolKm = 0.12) {
  const d = (a, b) =>
    Math.hypot((a[0] - b[0]) * 111.32 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110.95);
  chains = chains.filter((c) => c.length >= 2);
  for (;;) {
    let best = null;
    for (let i = 0; i < chains.length; i++) {
      for (let j = i + 1; j < chains.length; j++) {
        const a = chains[i], b = chains[j];
        const opts = [
          [d(a[a.length - 1], b[0]), 'ae-bs'],
          [d(a[a.length - 1], b[b.length - 1]), 'ae-be'],
          [d(a[0], b[b.length - 1]), 'as-be'],
          [d(a[0], b[0]), 'as-bs'],
        ];
        for (const [dist, how] of opts) if (dist < tolKm && (!best || dist < best.dist)) best = { dist, how, i, j };
      }
    }
    if (!best) return chains;
    const a = chains[best.i], b = chains[best.j];
    const merged = {
      'ae-bs': () => a.concat(b),
      'ae-be': () => a.concat([...b].reverse()),
      'as-be': () => b.concat(a),
      'as-bs': () => [...b].reverse().concat(a),
    }[best.how]();
    chains = chains.filter((_, k) => k !== best.i && k !== best.j);
    chains.push(merged);
  }
}

// 地形の範囲外を切り落とし、範囲内の連続部分ごとに分ける
function clip(pts, b) {
  const inside = ([x, y]) => x >= b.west && x <= b.east && y >= b.south && y <= b.north;
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (inside(p)) cur.push(p);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

function pointInPolys([x, y], fc) {
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  return fc.features.some((f) => f.geometry.coordinates.some((poly) => inRing(poly[0])));
}

async function main() {
  const meta = JSON.parse(await fs.readFile(path.join(ROOT, 'public/data/meta.json'), 'utf8'));
  const munis = JSON.parse(await fs.readFile(path.join(ROOT, 'public/data/municipalities.json'), 'utf8'));
  const inset = 0.002;
  const bbox = {
    west: meta.west + inset,
    north: meta.north - inset,
    east: meta.west + (meta.cols - 1) * meta.dlon - inset,
    south: meta.north - (meta.rows - 1) * meta.dlat + inset,
  };
  const [sections, stations] = await Promise.all([load('section'), load('station')]);

  const result = [];
  for (const def of LINES) {
    const segs = sections.features
      .filter((f) => f.properties.N02_004 === def.operator && f.properties.N02_003 === def.line)
      .flatMap((f) => lines(f.geometry));
    if (!segs.length) throw new Error(`${def.operator} ${def.line} が見つかりません`);
    const paths = chain(segs)
      .flatMap((c) => clip(c, bbox))
      .map((c) => simplify(c, 0.00004))
      .filter((c) => lengthKm(c) >= 1)
      .sort((a, b) => lengthKm(b) - lengthKm(a))
      .map((c) => c.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]));
    if (!paths.length) throw new Error(`${def.name}: 範囲内の線路がありません`);
    if (!paths.some((p) => p.some((q) => pointInPolys(q, munis)))) {
      throw new Error(`${def.name}: 山梨県内を通っていません`);
    }

    const seen = new Set();
    const sts = [];
    for (const f of stations.features) {
      const p = f.properties;
      if (p.N02_004 !== def.operator || p.N02_003 !== def.line || seen.has(p.N02_005)) continue;
      const cs = lines(f.geometry).flat();
      const c = cs[Math.floor(cs.length / 2)];
      if (c[0] < bbox.west || c[0] > bbox.east || c[1] < bbox.south || c[1] > bbox.north) continue;
      seen.add(p.N02_005);
      sts.push({ name: p.N02_005, lon: +c[0].toFixed(5), lat: +c[1].toFixed(5), inPref: pointInPolys(c, munis) });
    }

    const km = paths.reduce((s, p) => s + lengthKm(p), 0);
    console.log(`${def.name}: 線 ${paths.length} 本 (計 ${km.toFixed(1)} km, 最長 ${lengthKm(paths[0]).toFixed(1)} km), 駅 ${sts.length}`);
    const { operator, line, ...rest } = def;
    result.push({ ...rest, operator, line, paths, stations: sts });
  }

  const out = {
    source: '国土数値情報 (鉄道データ N02-24)',
    attribution: {
      text: '鉄道: 国土数値情報 (鉄道データ N02-24) を加工して作成',
      url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2024.html',
    },
    lines: result,
  };
  await fs.writeFile(OUT, JSON.stringify(out));
  console.log(`${path.relative(ROOT, OUT)} (${((await fs.stat(OUT)).size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(`鉄道データの生成に失敗しました: ${e.message}`);
  process.exit(1);
});
