# 山梨県 3D マップ

three.js で描いた山梨県の立体地図です。標高データから地形を作り、高低差を強調して表示します。GitHub Pages で公開します。

## できること

- マウスやタッチで回転・移動・ズーム
- 高さの強調（1〜5 倍）をスライダーで調整
- 太陽の方位と高さを変えて陰影を確認（PC では地形の影も表示）
- 地形をクリックすると、その地点の標高・市町村・緯度経度を表示
- 名所（富士山、北岳、甲斐駒ヶ岳、八ヶ岳、甲府盆地、富士五湖、昇仙峡、清里）へカメラを移動
- 自動回転
- レイヤーの切り替え: 県境・市町村界、河川、湖、県外の減光、市町村名・山名・湖名

## 開発

```sh
npm install
npm run dev       # 開発サーバー
npm run build     # dist/ に出力
```

## 地形データ

`public/data/` のデータは `scripts/build-data.mjs` で生成します。

```sh
npm run data:gsi        # 国土地理院 標高タイルから生成（既定）
npm run data:terrarium  # AWS Terrain Tiles から生成（国土地理院に接続できない環境向け）
```

| ファイル | 内容 |
| --- | --- |
| `dem.bin` | 標高グリッド。Uint16（リトルエンディアン）で標高 × 10 m、北西から行優先。約 75 m 間隔、1225 × 1321 |
| `water.png` | 湖の水面マスク。平坦な水面の検出と、`src/places.js` の湖の代表点からの塗り広げで推定 |
| `municipalities.json` | 市町村界（GeoJSON）。国土数値情報 行政区域データを簡略化 |
| `rivers.json` | 河川（GeoJSON）。標高データから流路を計算し、集水面積 25 km² 以上を抽出 |
| `meta.json` | グリッドの範囲・間隔、出典 |

GitHub Actions のビルドでは、毎回国土地理院の標高タイルからデータを作り直します。取得に失敗した場合は、リポジトリにコミットされたデータをそのまま使います。

## 公開（GitHub Pages）

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. `main` ブランチに push すると `.github/workflows/deploy.yml` がビルドして公開する

## 出典

- 標高: [国土地理院 標高タイル](https://maps.gsi.go.jp/development/ichiran.html)（コミット済みのデータは [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) から生成）
- 行政区域: [国土数値情報（行政区域データ）](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v3_1.html)（国土交通省）を加工。GeoJSON は [niiyz/JapanCityGeoJson](https://github.com/niiyz/JapanCityGeoJson) を利用
- 河川・湖: 上記の標高データから推定
- 描画: [three.js](https://threejs.org/)
