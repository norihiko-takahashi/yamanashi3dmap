#!/usr/bin/env node
// 調査用: OpenStreetMap に成田国際空港のデータがどこまで入っているかを集計する (#3)
// 地図の実装には使わない。結果は標準出力に表 (Markdown) で出す。
// Overpass API に接続できる環境 (手元の PC など) で、Node.js 22 以降で実行する。
//
//   node research/osm-narita.mjs

import fs from 'node:fs/promises';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// 成田国際空港の敷地 (aeroway=aerodrome, iata=NRT) の範囲で集計する
const AREA = 'area["aeroway"="aerodrome"]["iata"="NRT"]->.a;';

async function overpass(query) {
  const body = `[out:json][timeout:180];${AREA}${query}`;
  let lastErr;
  for (const url of ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(body)}`,
          signal: AbortSignal.timeout(200000),
        });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return (await res.json()).elements;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      }
    }
  }
  throw lastErr;
}

const out = [];
const log = (s = '') => {
  console.log(s);
  out.push(s);
};
const table = (head, rows) => {
  log(`| ${head.join(' | ')} |`);
  log(`| ${head.map(() => '---').join(' | ')} |`);
  for (const r of rows) log(`| ${r.map((v) => String(v ?? '').replace(/\|/g, '/')).join(' | ')} |`);
  log();
};
const count = (arr, fn) => arr.reduce((m, e) => {
  const k = fn(e) ?? '(なし)';
  m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}, new Map());
const year = (e) => (e.timestamp ? e.timestamp.slice(0, 4) : null);

async function main() {
  log('## OpenStreetMap 成田国際空港 収録状況 (#3 調査)');
  log();
  log(`取得日時: ${new Date().toISOString()}`);
  log();

  // 1. 外観: 滑走路・誘導路・エプロン・ターミナル・建物
  const outside = await overpass(
    'way["aeroway"~"^(runway|taxiway|apron|terminal|gate|hangar)$"](area.a);out tags;' +
      'way["building"](area.a);out tags;',
  );
  log('### 外観');
  const aero = count(outside.filter((e) => e.tags.aeroway), (e) => e.tags.aeroway);
  table(['種類', '件数'], [...aero.entries()]);
  log(`建物 (building=*): ${outside.filter((e) => e.tags.building).length} 件`);
  log();
  table(
    ['滑走路 ref', '長さ', '幅', '舗装'],
    outside.filter((e) => e.tags.aeroway === 'runway').map((e) => [e.tags.ref, e.tags.length, e.tags.width, e.tags.surface]),
  );
  table(['ターミナル名', 'building', 'building:levels'], outside
    .filter((e) => e.tags.aeroway === 'terminal')
    .map((e) => [e.tags.name ?? e.tags['name:ja'], e.tags.building, e.tags['building:levels']]));

  // 2. 店舗・飲食店
  const shops = await overpass(
    '(nwr["shop"](area.a);nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream)$"](area.a););out tags meta;',
  );
  log('### 店舗・飲食店');
  log(`合計 ${shops.length} 件 (name あり ${shops.filter((e) => e.tags.name).length} 件、level あり ${shops.filter((e) => e.tags.level).length} 件、` +
    `check_date あり ${shops.filter((e) => e.tags.check_date).length} 件)`);
  log();
  table(['最終更新年 (OSM の編集日時)', '件数'], [...count(shops, year).entries()].sort());
  table(['level', '件数'], [...count(shops, (e) => e.tags.level).entries()].sort());
  const sorted = [...shops].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  log('<details><summary>店舗・飲食店の一覧 (新しく編集された順)</summary>');
  log();
  table(['名前', '種類', 'level', 'check_date', '最終編集'], sorted.map((e) => [
    e.tags.name ?? e.tags['name:ja'] ?? e.tags['name:en'],
    e.tags.shop ? `shop=${e.tags.shop}` : `amenity=${e.tags.amenity}`,
    e.tags.level,
    e.tags.check_date,
    e.timestamp?.slice(0, 10),
  ]));
  log('</details>');
  log();

  // 3. 屋内の移動設備
  const vertical = await overpass(
    '(nwr["highway"="elevator"](area.a);way["highway"="steps"](area.a);way["conveying"](area.a);' +
      'nwr["indoor"](area.a);nwr["level"]["shop"!~"."]["amenity"!~"."](area.a););out tags;',
  );
  log('### 屋内の設備・屋内地図のタグ');
  table(['種類', '件数', 'うち level あり'], [
    ['エレベーター (highway=elevator)', ...pair(vertical, (e) => e.tags.highway === 'elevator')],
    ['エスカレーター (conveying=*)', ...pair(vertical, (e) => e.tags.conveying)],
    ['階段 (highway=steps)', ...pair(vertical, (e) => e.tags.highway === 'steps' && !e.tags.conveying)],
    ['屋内地図の要素 (indoor=*)', ...pair(vertical, (e) => e.tags.indoor)],
  ]);

  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
}

function pair(arr, pred) {
  const xs = arr.filter(pred);
  return [xs.length, xs.filter((e) => e.tags.level).length];
}

main().catch((e) => {
  console.error(`調査に失敗しました: ${e.message}`);
  process.exit(1);
});
