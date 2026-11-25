// 地形に貼る色テクスチャを Canvas に描く。
// 標高の段彩 (季節の色づけ・雪) → 湖 → 河川 → 富士山が見える場所 → 県外の減光 → 市町村界 → 県境 の順に重ねる。
// 夜景の街明かりは別の Canvas (paintLights) に描き、地形の発光マップとして使う。


export const COLOR_STOPS = [
  [0, '#3f7f4f'],
  [300, '#5f9a57'],
  [700, '#94b46a'],
  [1100, '#c9c486'],
  [1600, '#c7a26e'],
  [2100, '#a9805a'],
  [2600, '#8f7562'],
  [3000, '#9d918a'],
  [3400, '#8e847e'],
  [3800, '#8a807a'],
];

// 季節ごとの雪線 (m)。これより高い所を雪で覆う (地形の向き・傾きで多少ばらつかせる)
const SNOW_LINE = { spring: 2300, summer: Infinity, autumn: 3300, winter: 1250 };

// 季節の色 (RGB)
const C = {
  snow: [238, 242, 247],
  blossom: [240, 168, 194], // 春: 桃の花
  freshGreen: [140, 192, 106], // 春: 新緑
  deepGreen: [58, 112, 56], // 夏: 濃い緑
  autumn: [[185, 70, 44], [215, 122, 42], [217, 173, 60], [143, 90, 47]], // 秋: 紅葉 (赤・橙・黄・茶)
  larch: [201, 162, 58], // 秋: 高い所のカラマツの黄葉
  orchardAutumn: [181, 122, 60],
  bareForest: [125, 118, 92], // 冬: 葉を落とした林
  winterField: [168, 154, 120], // 冬: 枯れた畑
  town: [163, 157, 149], // 市街地 (昼)
};

// 0〜1 の擬似乱数 (セルごとに固定)
const hash = (i) => {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
};
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (d, o, c, t) => {
  if (t <= 0) return;
  d[o] += (c[0] - d[o]) * t;
  d[o + 1] += (c[1] - d[o + 1]) * t;
  d[o + 2] += (c[2] - d[o + 2]) * t;
};

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

function buildRamp() {
  const stops = COLOR_STOPS.map(([h, c]) => [h, hex(c)]);
  const lut = new Uint8ClampedArray(4000 * 3);
  for (let h = 0; h < 4000; h++) {
    let k = 0;
    while (k < stops.length - 2 && h > stops[k + 1][0]) k++;
    const [h0, c0] = stops[k];
    const [h1, c1] = stops[k + 1];
    const t = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
    for (let ch = 0; ch < 3; ch++) lut[h * 3 + ch] = c0[ch] + (c1[ch] - c0[ch]) * t;
  }
  return lut;
}

let rampCache = null;
const baseCache = new Map(); // 季節ごと
let fujiCache = null;
let lightsCache = null;

// 富士山が見える場所のマスクを Canvas にする。見えない場所を暗く、見える場所をわずかに明るく塗る
function fujiImage({ cols, rows }, mask) {
  if (fujiCache) return fujiCache;
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (mask[i]) {
      img.data[o] = 255; img.data[o + 1] = 236; img.data[o + 2] = 200; img.data[o + 3] = 46;
    } else {
      img.data[o] = 12; img.data[o + 1] = 18; img.data[o + 2] = 40; img.data[o + 3] = 150;
    }
  }
  ctx.putImageData(img, 0, 0);
  fujiCache = c;
  return c;
}

function baseImage({ cols, rows }, terrain, water, season, landuse) {
  const key = `${season}:${landuse ? 1 : 0}`;
  if (baseCache.has(key)) return baseCache.get(key);
  rampCache ??= buildRamp();
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  const d = new Float32Array(cols * rows * 3);
  const H = terrain.heights;
  const cellX = terrain.cellX * 1000, cellZ = terrain.cellZ * 1000; // m
  const snowLine = SNOW_LINE[season] ?? Infinity;
  for (let i = 0; i < H.length; i++) {
    const h = H[i];
    const o = i * 3;
    if (h <= 0.5) {
      // 海
      d[o] = 52; d[o + 1] = 96; d[o + 2] = 140;
      continue;
    }
    const k = Math.min(3999, Math.round(h)) * 3;
    d[o] = rampCache[k]; d[o + 1] = rampCache[k + 1]; d[o + 2] = rampCache[k + 2];

    const r = (i / cols) | 0, col = i - r * cols;
    const n = hash(i);
    // ゆるやかに変わるばらつき (-1〜1)。雪線や色づきの境目を自然にする
    const wave = (Math.sin(col * 0.11) + Math.sin(r * 0.13 + 1.7) + Math.sin((col + r) * 0.05 + 0.4)) / 3;
    const f = landuse ? landuse[o + 2] / 255 : 0; // 森林
    const orch = landuse ? landuse[o + 1] / 255 : 0; // 果樹園など
    const town = landuse ? landuse[o] / 255 : 0; // 建物用地

    if (season === 'spring') {
      if (h < 900) mix(d, o, C.blossom, orch * (0.45 + 0.4 * n) * (1 - smooth(650, 900, h)));
      mix(d, o, C.freshGreen, f * 0.3 * (1 - smooth(900, 1600, h)));
    } else if (season === 'summer') {
      mix(d, o, C.deepGreen, f * 0.32 * (1 - smooth(1800, 2600, h)));
    } else if (season === 'autumn') {
      const band = smooth(350, 700, h + wave * 80) * (1 - smooth(1700, 2000, h + wave * 100));
      const pal = C.autumn[n < 0.3 ? 0 : n < 0.62 ? 1 : n < 0.88 ? 2 : 3];
      mix(d, o, pal, f * 0.58 * band);
      mix(d, o, C.larch, f * 0.6 * smooth(1600, 1900, h) * (1 - smooth(2300, 2600, h)));
      mix(d, o, C.orchardAutumn, orch * 0.35);
    } else if (season === 'winter') {
      mix(d, o, C.bareForest, f * 0.45 * (1 - smooth(1000, 1400, h)));
      mix(d, o, C.winterField, orch * 0.5);
    }
    mix(d, o, C.town, town * 0.5);

    if (h + wave * 150 > snowLine - 250) {
      // 急な斜面ほど雪が付きにくい
      const gx = (H[i + (col < cols - 1 ? 1 : 0)] - H[i - (col > 0 ? 1 : 0)]) / (2 * cellX);
      const gz = (H[i + (r < rows - 1 ? cols : 0)] - H[i - (r > 0 ? cols : 0)]) / (2 * cellZ);
      const steep = smooth(0.7, 1.5, Math.hypot(gx, gz));
      const amount = smooth(snowLine - 250, snowLine + 250, h + wave * 150 + (n - 0.5) * 80) * (1 - steep * 0.55);
      mix(d, o, C.snow, amount);
    }
  }
  for (let i = 0, j = 0; i < d.length; i += 3, j += 4) {
    img.data[j] = d[i]; img.data[j + 1] = d[i + 1]; img.data[j + 2] = d[i + 2]; img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const wc = document.createElement('canvas');
  wc.width = cols;
  wc.height = rows;
  const wctx = wc.getContext('2d');
  const wimg = wctx.createImageData(cols, rows);
  // 冬は湖面を少し白っぽく (結氷・雪の反射)
  const lake = season === 'winter' ? [120, 156, 190] : [58, 120, 178];
  for (let i = 0; i < water.length; i++) {
    if (!water[i]) continue;
    const o = i * 4;
    wimg.data[o] = lake[0]; wimg.data[o + 1] = lake[1]; wimg.data[o + 2] = lake[2]; wimg.data[o + 3] = 255;
  }
  wctx.putImageData(wimg, 0, 0);
  const result = { land: c, water: wc };
  baseCache.set(key, result);
  return result;
}

// 夜景の街明かり (建物用地の割合に応じた暖かい光) を、地形の発光マップ用の Canvas に描く
export function paintLights(canvas, { meta, landuse, municipalities, dimOutside, scale }) {
  const { cols, rows } = meta;
  const W = Math.round(cols * scale);
  const H = Math.round(rows * scale);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!landuse) return;
  if (!lightsCache) {
    lightsCache = document.createElement('canvas');
    lightsCache.width = cols;
    lightsCache.height = rows;
    const lctx = lightsCache.getContext('2d');
    const img = lctx.createImageData(cols, rows);
    for (let i = 0; i < cols * rows; i++) {
      const b = landuse[i * 3] / 255;
      if (b <= 0) continue;
      // 明かりの粒をばらつかせる (市街地の中心ほど明るい)
      const v = Math.min(1, b * (0.35 + 0.65 * hash(i + 7)) ** 1.3) * 255;
      const o = i * 4;
      img.data[o] = v; img.data[o + 1] = v * 0.7; img.data[o + 2] = v * 0.36; img.data[o + 3] = 255;
    }
    lctx.putImageData(img, 0, 0);
  }
  ctx.imageSmoothingEnabled = true;
  // にじんだ光 (ぼかし) と、くっきりした光を重ねる
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${2.5 * scale}px)`;
  ctx.globalAlpha = 0.6;
  ctx.drawImage(lightsCache, 0, 0, W, H);
  ctx.filter = 'none';
  ctx.globalAlpha = 0.55;
  ctx.drawImage(lightsCache, 0, 0, W, H);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (dimOutside && municipalities) {
    // 地形の色と同じく、県外の明かりも暗くする (範囲全体の四角形と県内の多角形を偶奇規則で塗る)
    const px = (lon) => ((lon - meta.west) / meta.dlon / (cols - 1)) * W;
    const py = (lat) => ((meta.north - lat) / meta.dlat / (rows - 1)) * H;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    for (const f of municipalities.features)
      for (const poly of f.geometry.coordinates)
        for (const ring of poly) {
          ring.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
          ctx.closePath();
        }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fill('evenodd');
  }
}

export function paintTexture(canvas, { meta, terrain, water, fujiView, landuse, season, municipalities, rivers, layers, scale }) {
  const { cols, rows } = meta;
  const W = Math.round(cols * scale);
  const H = Math.round(rows * scale);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  const base = baseImage(meta, terrain, water, season, landuse);

  const px = (lon) => ((lon - meta.west) / meta.dlon / (cols - 1)) * W;
  const py = (lat) => ((meta.north - lat) / meta.dlat / (rows - 1)) * H;
  const tracePolys = (c) => {
    c.beginPath();
    for (const f of municipalities.features) {
      for (const poly of f.geometry.coordinates) {
        for (const ring of poly) {
          ring.forEach(([x, y], i) => (i ? c.lineTo(px(x), py(y)) : c.moveTo(px(x), py(y))));
          c.closePath();
        }
      }
    }
  };

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base.land, 0, 0, W, H);
  if (layers.lakes) ctx.drawImage(base.water, 0, 0, W, H);

  if (layers.rivers) {
    ctx.strokeStyle = 'rgb(62, 126, 186)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of rivers.features) {
      const a = f.properties.area;
      ctx.lineWidth = (0.7 + 0.9 * Math.log10(Math.max(1, a / 25))) * scale * 0.75;
      ctx.beginPath();
      f.geometry.coordinates.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))));
      ctx.stroke();
    }
  }

  if (layers.fujiView && fujiView) {
    ctx.drawImage(fujiImage(meta, fujiView), 0, 0, W, H);
  }

  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const t = tmp.getContext('2d');

  if (layers.outside) {
    // 県内をくり抜いた暗幕
    t.fillStyle = 'rgba(8, 14, 24, 0.58)';
    t.fillRect(0, 0, W, H);
    t.globalCompositeOperation = 'destination-out';
    t.fillStyle = '#000';
    tracePolys(t);
    t.fill('evenodd');
    t.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, 0, 0);
  }

  if (layers.boundaries) {
    // 市町村界 (細線)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 0.9 * scale;
    ctx.setLineDash([4 * scale, 2.5 * scale]);
    tracePolys(ctx);
    ctx.stroke();
    ctx.setLineDash([]);

    // 県境 (太線): 全市町村の輪郭を太く描き、県内側を消して外周だけ残す
    t.clearRect(0, 0, W, H);
    t.strokeStyle = 'rgb(255, 214, 92)';
    t.lineWidth = 3.2 * scale;
    t.lineJoin = 'round';
    tracePolys(t);
    t.stroke();
    t.globalCompositeOperation = 'destination-out';
    tracePolys(t);
    t.fill('evenodd');
    t.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmp, 0, 0);
  }
}
