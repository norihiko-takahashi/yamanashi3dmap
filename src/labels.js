import * as THREE from 'three';

// HTML 要素によるラベル。毎フレーム画面座標へ投影し、優先度の高い順に
// 重なりを避けて配置する。
export class Labels {
  constructor(container, camera) {
    this.container = container;
    this.camera = camera;
    this.items = [];
    this.hiddenTypes = new Set();
    this.v = new THREE.Vector3();
  }

  add({ type, text, html, lon, lat, priority = 0, anchorBottom = false }) {
    const el = document.createElement('div');
    el.className = `label ${type}`;
    if (html) el.innerHTML = html;
    else el.textContent = text;
    this.container.append(el);
    const item = { type, el, lon, lat, priority, anchorBottom, position: new THREE.Vector3(), visible: true, w: 0, h: 0 };
    this.items.push(item);
    this.sorted = null;
    return item;
  }

  setTypeVisible(type, visible) {
    if (visible) this.hiddenTypes.delete(type);
    else this.hiddenTypes.add(type);
  }

  update(width, height) {
    this.sorted ??= [...this.items].sort((a, b) => b.priority - a.priority);
    const placed = [];
    const cam = this.camera;
    for (const item of this.sorted) {
      const show = item.visible && !this.hiddenTypes.has(item.type);
      if (!show) {
        item.el.style.display = 'none';
        continue;
      }
      if (!item.w) {
        item.el.style.display = '';
        item.w = item.el.offsetWidth;
        item.h = item.el.offsetHeight;
      }
      this.v.copy(item.position).project(cam);
      const dist = cam.position.distanceTo(item.position);
      if (this.v.z > 1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1 || dist > 260) {
        item.el.style.display = 'none';
        continue;
      }
      const x = (this.v.x * 0.5 + 0.5) * width - item.w / 2;
      const y = (-this.v.y * 0.5 + 0.5) * height - (item.anchorBottom ? item.h : item.h / 2);
      const box = [x - 2, y - 1, x + item.w + 2, y + item.h + 1];
      const overlaps = item.type !== 'marker' && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      if (overlaps) {
        item.el.style.display = 'none';
        continue;
      }
      placed.push(box);
      item.el.style.display = '';
      item.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
