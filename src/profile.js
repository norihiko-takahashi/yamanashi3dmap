// 線路の縦断面 (高さ) を求める。
// 勾配を maxGrade 以内に保ちながら、地表との高低差 (橋で浮く分・トンネルで潜る分) の合計が
// 最も小さくなる高さを、高さを res (m) 刻みにした動的計画法で求める。
// 潜る分は buryCap (m) より深くても同じ扱いにする。深いトンネルは見えないので、
// 尾根の下はどれだけ深くても抜けてよく、谷の上で高く浮かないようにするため。
export function fitProfile(surface, dist, { maxGrade = 0.04, res = 0.5, costAbove = 1.5, costBelow = 1, buryCap = 15 } = {}) {
  const n = surface.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, surface[i]);
    hi = Math.max(hi, surface[i]);
  }
  const L = Math.max(1, Math.ceil((hi - lo) / res) + 1);
  const level = (j) => lo + j * res;
  const local = (i, j) => {
    const d = level(j) - surface[i];
    return d > 0 ? d * costAbove : Math.min(-d, buryCap) * costBelow;
  };

  let cost = new Float64Array(L);
  let next = new Float64Array(L);
  for (let j = 0; j < L; j++) cost[j] = local(0, j);
  // 区間ごとに動ける高さの段数。from[i * L + j] には、点 i の高さ j に来たときの
  // 点 i-1 の高さとの差を +K して保存する (Uint8 に収めるため K は 127 まで)
  const steps = new Int32Array(n);
  let K = 0;
  for (let i = 1; i < n; i++) {
    steps[i] = Math.min(127, Math.floor(((dist[i] - dist[i - 1]) * 1000 * maxGrade) / res));
    K = Math.max(K, steps[i]);
  }
  const from = new Uint8Array(n * L);
  const dq = new Int32Array(L);
  for (let i = 1; i < n; i++) {
    const k = steps[i];
    // next[j] = min(cost[j-k..j+k]) + local(i, j)。窓の最小値を両端キューで求める
    let head = 0, tail = 0, right = 0;
    for (let j = 0; j < L; j++) {
      const r = Math.min(L - 1, j + k);
      while (right <= r) {
        while (tail > head && cost[dq[tail - 1]] >= cost[right]) tail--;
        dq[tail++] = right++;
      }
      while (dq[head] < j - k) head++;
      const m = dq[head];
      next[j] = cost[m] + local(i, j);
      from[i * L + j] = m - j + K;
    }
    [cost, next] = [next, cost];
  }
  let j = 0;
  for (let t = 1; t < L; t++) if (cost[t] < cost[j]) j = t;
  const h = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    h[i] = level(j);
    if (i > 0) j += from[i * L + j] - K;
  }
  return h;
}
