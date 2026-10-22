// 像素画放大：Scale2x（EPX）做两次 = Scale4x。
// 每个像素按上下左右邻居的走向拆成 2×2：斜线、曲线边缘变平滑，不产生原图没有的颜色（不会糊）。
// 画面设置选「平滑放大」时，地形、单位图标、头像在载入时用它放大 4 倍。

// pixels：RGBA 按 32 位整数排列（同一颜色同一个值），返回放大 2 倍后的数组
export function scale2x(pixels: Uint32Array, w: number, h: number): Uint32Array {
  const out = new Uint32Array(w * 2 * h * 2);
  const at = (x: number, y: number) => pixels[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const ow = w * 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      const a = at(x, y - 1); // 上
      const b = at(x + 1, y); // 右
      const c = at(x - 1, y); // 左
      const d = at(x, y + 1); // 下
      const i = y * 2 * ow + x * 2;
      out[i] = c === a && c !== d && a !== b ? a : p;
      out[i + 1] = a === b && a !== c && b !== d ? b : p;
      out[i + ow] = d === c && d !== b && c !== a ? c : p;
      out[i + ow + 1] = b === d && b !== a && d !== c ? d : p;
    }
  }
  return out;
}

export function scale4x(pixels: Uint32Array, w: number, h: number): Uint32Array {
  return scale2x(scale2x(pixels, w, h), w * 2, h * 2);
}

// 把一张图（canvas / image）放大 4 倍，返回新的 canvas
export function smoothCanvas(src: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d")!;
  tctx.drawImage(src, 0, 0);
  const data = tctx.getImageData(0, 0, w, h);
  const big = scale4x(new Uint32Array(data.data.buffer), w, h);
  const out = document.createElement("canvas");
  out.width = w * 4;
  out.height = h * 4;
  const img = out.getContext("2d")!.createImageData(w * 4, h * 4);
  img.data.set(new Uint8ClampedArray(big.buffer));
  out.getContext("2d")!.putImageData(img, 0, 0);
  return out;
}

// 头像等 <img> 用：返回放大后的 data URL（按原 URL 缓存）
const urlCache = new Map<string, Promise<string>>();
export function smoothUrl(url: string): Promise<string> {
  let p = urlCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(smoothCanvas(img).toDataURL());
      img.onerror = reject;
      img.src = url;
    });
    urlCache.set(url, p);
  }
  return p;
}
