#!/usr/bin/env node
// 夜景の街明かりと季節の表現に使う土地利用データを生成するスクリプト
//
//   node scripts/build-landuse.mjs
//
// 入力: 国土数値情報 土地利用細分メッシュ (L03-b, 2021 年度, 100 m メッシュ, CC BY 4.0)
// 出力: public/data/landuse.png  地形のグリッドと同じ大きさの RGB 画像
//         R = 建物用地の割合、G = その他の農用地 (果樹園など) の割合、B = 森林の割合 (0〜255)
//       public/data/landuse.json 出典
//
// 地形のグリッドの範囲は public/data/meta.json から読む (先に build-data.mjs を実行しておく)。

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'l03b');
const URL = (mesh) => `https://nlftp.mlit.go.jp/ksj/gml/data/L03-b/L03-b-21/L03-b-21_${mesh}-jgd2011_GML.zip`;

// 土地利用の区分コード
const CODE = { building: '0700', orchard: '0200', forest: '0500' };
const SUB = 3; // グリッドの 1 セルを 3×3 点で調べて割合を出す

async function fetchCached(url, file) {
  try {
    return await fs.readFile(file);
  } catch {}
  console.log(`取得: ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
  return buf;
}

// ZIP から 1 ファイルを取り出す (中央ディレクトリを読み、deflate を展開する)
function unzipEntry(zip, predicate) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('ZIP の終端が見つかりません');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!predicate(name)) continue;
    const lNameLen = zip.readUInt16LE(local + 26);
    const lExtraLen = zip.readUInt16LE(local + 28);
    const data = zip.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
    return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
  }
  throw new Error('ZIP に対象のファイルがありません');
}

// DBF から (メッシュコード, 土地利用コード) を読み、コールバックに渡す
function readDbf(buf, onRecord) {
  const n = buf.readUInt32LE(4);
  const hlen = buf.readUInt16LE(8);
  const rlen = buf.readUInt16LE(10);
  const fields = [];
  for (let p = 32; buf[p] !== 0x0d; p += 32) {
    fields.push({ name: buf.toString('ascii', p, p + 11).replace(/\0.*$/, ''), len: buf[p + 16] });
  }
  const offset = (name) => 1 + fields.slice(0, fields.findIndex((f) => f.name === name)).reduce((s, f) => s + f.len, 0);
  const oMesh = offset('L03b_001');
  const oUse = offset('L03b_002');
  for (let i = 0; i < n; i++) {
    const r = hlen + i * rlen;
    onRecord(buf.toString('ascii', r + oMesh, r + oMesh + 10), buf.toString('ascii', r + oUse, r + oUse + 4));
  }
}

// 100 m メッシュ (10 桁) の南西端の緯度・経度
function meshSW(code) {
  const p = +code.slice(0, 2), u = +code.slice(2, 4);
  const q = +code[4], v = +code[5];
  const r = +code[6], w = +code[7];
  const s = +code[8], x = +code[9];
  return [100 + u + v / 8 + w / 80 + x / 800, p / 1.5 + q / 12 + r / 120 + s / 1200];
}

async function main() {
  const meta = JSON.parse(await fs.readFile(path.join(ROOT, 'public/data/meta.json'), 'utf8'));
  const { cols, rows, west, north, dlon, dlat } = meta;
  const east = west + (cols - 1) * dlon;
  const south = north - (rows - 1) * dlat;

  // 範囲にかかる 1 次メッシュ (緯度 40 分 × 経度 1 度)
  const meshes = [];
  for (let p = Math.floor(south * 1.5); p <= Math.floor(north * 1.5); p++)
    for (let u = Math.floor(west) - 100; u <= Math.floor(east) - 100; u++) meshes.push(`${p}${u}`);

  // 100 m メッシュの格子 (緯度 1/1200 度 × 経度 1/800 度) に土地利用コードを並べる
  const lat0 = Math.floor(south * 1200) / 1200;
  const lon0 = Math.floor(west * 800) / 800;
  const nLat = Math.ceil((north - lat0) * 1200) + 1;
  const nLon = Math.ceil((east - lon0) * 800) + 1;
  const grid = new Uint8Array(nLat * nLon); // 0: なし, 1: 建物用地, 2: 果樹園など, 3: 森林
  const kind = { [CODE.building]: 1, [CODE.orchard]: 2, [CODE.forest]: 3 };

  for (const mesh of meshes) {
    const zip = await fetchCached(URL(mesh), path.join(CACHE_DIR, `L03-b-21_${mesh}.zip`));
    const dbf = unzipEntry(zip, (name) => name.endsWith('.dbf'));
    let count = 0;
    readDbf(dbf, (code, use) => {
      const k = kind[use];
      if (!k) return;
      const [lon, lat] = meshSW(code);
      const i = Math.round((lat - lat0) * 1200);
      const j = Math.round((lon - lon0) * 800);
      if (i < 0 || j < 0 || i >= nLat || j >= nLon) return;
      grid[i * nLon + j] = k;
      count++;
    });
    console.log(`  ${mesh}: 対象の区画 ${count.toLocaleString()} 件`);
  }

  // 地形のグリッドの各セルで、3×3 点を調べて割合にする
  const out = Buffer.alloc(cols * rows * 3);
  const totals = [0, 0, 0];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cnt = [0, 0, 0, 0];
      for (let a = 0; a < SUB; a++)
        for (let b = 0; b < SUB; b++) {
          const lat = north - (r + (a + 0.5) / SUB - 0.5) * dlat;
          const lon = west + (c + (b + 0.5) / SUB - 0.5) * dlon;
          const i = Math.floor((lat - lat0) * 1200);
          const j = Math.floor((lon - lon0) * 800);
          if (i >= 0 && j >= 0 && i < nLat && j < nLon) cnt[grid[i * nLon + j]]++;
        }
      const o = (r * cols + c) * 3;
      for (let k = 0; k < 3; k++) {
        out[o + k] = Math.round((cnt[k + 1] / (SUB * SUB)) * 255);
        totals[k] += cnt[k + 1] / (SUB * SUB);
      }
    }
  }
  const km2 = (dlat * 110.95) * (dlon * 111.32 * Math.cos((35.57 * Math.PI) / 180));
  console.log(
    `範囲内の面積: 建物用地 ${(totals[0] * km2).toFixed(0)} km²、その他の農用地 ${(totals[1] * km2).toFixed(0)} km²、` +
      `森林 ${(totals[2] * km2).toFixed(0)} km²`,
  );

  const png = new PNG({ width: cols, height: rows, colorType: 2, inputColorType: 2 });
  png.data = out;
  await fs.writeFile(path.join(ROOT, 'public/data/landuse.png'), PNG.sync.write(png, { colorType: 2, inputColorType: 2 }));
  await fs.writeFile(
    path.join(ROOT, 'public/data/landuse.json'),
    JSON.stringify({
      attribution: {
        text: '土地利用 (夜景・季節): 国土数値情報 (土地利用細分メッシュ L03-b 2021年度) を加工して作成',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-L03-b-2021.html',
      },
    }),
  );
  console.log('public/data/landuse.png を出力しました');
}

main().catch((e) => {
  console.error(`土地利用データの生成に失敗しました: ${e.message}`);
  process.exit(1);
});
