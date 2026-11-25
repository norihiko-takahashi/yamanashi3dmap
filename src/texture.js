// 地形に貼る色テクスチャを Canvas に描く。
// 標高の段彩 → 湖 → 河川 → 富士山が見える場所 → 県外の減光 → 市町村界 → 県境 の順に重ねる。


export const COLOR_STOPS = [
  [0, '#3f7f4f'],
  [300, '#5f9a57'],
  [700, '#94b46a'],
  [1100, '#c9c486'],
  [1600, '#c7a26e'],
  [2100, '#a9805a'],
  [2600, '#8f7562'],
  [3000, '#b3aaa4'],
  [3400, '#e6e4e2'],
  [3800, '#ffffff'],
];

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
let baseCache = null;
let fujiCache = null;

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

function baseImage({ cols, rows }, terrain, water) {
  if (baseCache) return baseCache;
  rampCache ??= buildRamp();
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  const d = img.data;
  const H = terrain.heights;
  for (let i = 0; i < H.length; i++) {
    const h = H[i];
    const o = i * 4;
    if (h <= 0.5) {
      // 海
      d[o] = 52; d[o + 1] = 96; d[o + 2] = 140;
    } else {
      const k = Math.min(3999, Math.round(h)) * 3;
      d[o] = rampCache[k]; d[o + 1] = rampCache[k + 1]; d[o + 2] = rampCache[k + 2];
    }
    d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const wc = document.createElement('canvas');
  wc.width = cols;
  wc.height = rows;
  const wctx = wc.getContext('2d');
  const wimg = wctx.createImageData(cols, rows);
  for (let i = 0; i < water.length; i++) {
    if (!water[i]) continue;
    const o = i * 4;
    wimg.data[o] = 58; wimg.data[o + 1] = 120; wimg.data[o + 2] = 178; wimg.data[o + 3] = 255;
  }
  wctx.putImageData(wimg, 0, 0);
  baseCache = { land: c, water: wc };
  return baseCache;
}

export function paintTexture(canvas, { meta, terrain, water, fujiView, municipalities, rivers, layers, scale }) {
  const { cols, rows } = meta;
  const W = Math.round(cols * scale);
  const H = Math.round(rows * scale);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  const base = baseImage(meta, terrain, water);

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
