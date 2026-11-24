// 地図上のラベル・ジャンプ先の定義 (経度, 緯度)
// 標高はラベル表示時に標高データから読み取るため、ここでは持たない。

export const MOUNTAINS = [
  { name: '富士山', lon: 138.7274, lat: 35.3606, elev: 3776 },
  { name: '北岳', lon: 138.2386, lat: 35.6745, elev: 3193 },
  { name: '間ノ岳', lon: 138.228, lat: 35.6464, elev: 3190 },
  { name: '農鳥岳', lon: 138.2283, lat: 35.6292, elev: 3026 },
  { name: '甲斐駒ヶ岳', lon: 138.2366, lat: 35.758, elev: 2967 },
  { name: '鳳凰山', lon: 138.3053, lat: 35.7008, elev: 2841 },
  { name: '赤岳', lon: 138.3703, lat: 35.9708, elev: 2899 },
  { name: '金峰山', lon: 138.6253, lat: 35.8714, elev: 2599 },
  { name: '大菩薩嶺', lon: 138.845, lat: 35.7486, elev: 2057 },
  { name: '雲取山', lon: 138.9439, lat: 35.8553, elev: 2017 },
  { name: '三ツ峠山', lon: 138.8167, lat: 35.5487, elev: 1785 },
];

export const LAKES = [
  { name: '山中湖', lon: 138.875, lat: 35.418 },
  { name: '河口湖', lon: 138.755, lat: 35.516 },
  { name: '西湖', lon: 138.683, lat: 35.499 },
  { name: '精進湖', lon: 138.6117, lat: 35.4717 },
  { name: '本栖湖', lon: 138.592, lat: 35.462 },
];

// ジャンプ先: distance はカメラから注視点までの距離 (km)、pitch は見下ろし角 (度)
export const SPOTS = [
  { name: '県全体', lon: 138.62, lat: 35.6, distance: 120, pitch: 50, heading: 0 },
  { name: '富士山', lon: 138.7274, lat: 35.3606, distance: 30, pitch: 28, heading: 20 },
  { name: '北岳', lon: 138.2386, lat: 35.6745, distance: 22, pitch: 30, heading: 250 },
  { name: '甲斐駒ヶ岳', lon: 138.2366, lat: 35.758, distance: 20, pitch: 30, heading: 290 },
  { name: '八ヶ岳 (赤岳)', lon: 138.3703, lat: 35.9708, distance: 24, pitch: 30, heading: 340 },
  { name: '甲府盆地', lon: 138.57, lat: 35.64, distance: 40, pitch: 40, heading: 0 },
  { name: '富士五湖', lon: 138.73, lat: 35.47, distance: 32, pitch: 38, heading: 160 },
  { name: '昇仙峡', lon: 138.566, lat: 35.733, distance: 12, pitch: 35, heading: 0 },
  { name: '清里', lon: 138.437, lat: 35.907, distance: 18, pitch: 30, heading: 320 },
];
