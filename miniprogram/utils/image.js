/**
 * 图片压缩工具（目前只服务于头像上传）
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * 头像在各页面的最大显示尺寸是 140rpx（用户中心），其余位置 56~120rpx。
 * 140rpx 换算成物理像素，最苛刻也不过 ~290px（768pt 平板 / 2x）：
 *   iPhone SE   (375pt/2x) → 140px
 *   iPhone 15   (393pt/3x) → 220px
 *   Pro Max     (430pt/3x) → 241px
 *   平板        (768pt/2x) → 287px
 * 所以按 512px 上传已有一倍余量。再往上没有画质收益，只白耗云存储和
 * CDN 流量 —— 流量才是真正的成本大头：同样 5GB 流量，200KB 的图能撑
 * 约 2.6 万次加载，2MB 只能撑 2500 次，差一个数量级。
 *
 * ── 为什么不用 canvas 重绘 ────────────────────────────────────
 * canvas 能精确控制尺寸，但要引入页面 canvas 节点或离屏 canvas，且有几处
 * 已知风险：PNG 转 JPEG 丢透明通道（透明区变黑/白）、canvasToTempFilePath
 * 的 width 与 destWidth 不 1:1 时二次插值导致变糊、部分机型离屏 canvas
 * 导出失败。头像显示尺寸只有 140rpx，这点收益不值得承担上述风险，
 * 因此走微信原生的 wx.compressImage。
 *
 * ── 降级策略（任何一步失败都不阻断上传）──────────────────────
 * 1. PNG / GIF / WEBP 直接跳过：compressImage 对 PNG 基本无效（原样返回），
 *    而 PNG 恰恰可能是带透明通道的抠图，转 JPEG 会让透明区变黑；
 * 2. compressedWidth/compressedHeight 需基础库 2.26.0+，低版本会忽略该参数，
 *    自动退化为「只压质量、不缩尺寸」，仍有收益；
 * 3. 压缩后体积反而变大（小图常见），一律回退原图；
 * 4. 原图本来就小于 skipBelow，直接跳过（压了可能反而更糊）。
 */

/** 最长边上限（px）。512 对 140rpx 的显示尺寸有 1.7 倍以上余量 */
export const MAX_EDGE = 512;

/** 压缩质量 0~100。80 在缩略图上肉眼不可辨 */
export const QUALITY = 80;

/** 原图小于该值（字节）直接跳过压缩 */
const SKIP_BELOW_BYTES = 60 * 1024;

/** 这些格式不压：compressImage 对 PNG 无效，且转 JPEG 会丢透明通道 */
const SKIP_EXTS = ['png', 'gif', 'webp', 'bmp'];

/** 取小写扩展名；无扩展名返回 '' */
function getExt(filePath) {
  const m = String(filePath || '').match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
  return m ? m[1].toLowerCase() : '';
}

/** wx.getImageInfo 的 Promise 包装，失败返回 null */
function getImageInfo(src) {
  return new Promise(resolve => {
    wx.getImageInfo({
      src,
      success: res => resolve(res),
      fail: () => resolve(null)
    });
  });
}

/** 取文件字节数，失败返回 0 */
function getFileSize(filePath) {
  return new Promise(resolve => {
    try {
      wx.getFileSystemManager().getFileInfo({
        filePath,
        success: res => resolve(res && res.size ? res.size : 0),
        fail: () => resolve(0)
      });
    } catch (e) {
      resolve(0);
    }
  });
}

/** wx.compressImage 的 Promise 包装，失败返回 null */
function doCompress(src, target) {
  return new Promise(resolve => {
    const params = {
      src,
      quality: QUALITY,
      success: res => resolve(res && res.tempFilePath ? res.tempFilePath : null),
      fail: () => resolve(null)
    };
    // 低版本基础库会忽略这两个参数，退化为只压质量
    if (target && target.compressedWidth) {
      params.compressedWidth = target.compressedWidth;
      params.compressedHeight = target.compressedHeight;
    }
    wx.compressImage(params);
  });
}

/**
 * 压缩一张图片
 *
 * @param {string} tempPath  本地临时文件路径（wxfile://...）
 * @param {object} [options]
 * @param {number} [options.maxEdge=512]      最长边上限
 * @param {number} [options.skipBelow=61440]  小于该字节数直接跳过
 * @returns {Promise<{path:string, changed:boolean, sizeFrom:number, sizeTo:number}>}
 *          无论成功失败，path 一定是**可用**的路径；changed 表示是否真的换了文件
 */
export async function compressImage(tempPath, options) {
  const opts = options || {};
  const maxEdge = opts.maxEdge || MAX_EDGE;
  const skipBelow = opts.skipBelow || SKIP_BELOW_BYTES;

  const result = { path: tempPath, changed: false, sizeFrom: 0, sizeTo: 0 };

  if (!tempPath) return result;
  // 基础库 < 2.4.0 没有这个接口
  if (typeof wx.compressImage !== 'function') return result;
  if (SKIP_EXTS.indexOf(getExt(tempPath)) >= 0) return result;

  // 兜底：本函数承诺「永不抛错、path 永远可用」。
  // 调用方（登录页）在 await 之前就开了 showLoading，这里一旦抛出去，
  // loading 不会被关，整个页面就卡住了。
  try {
    const sizeFrom = await getFileSize(tempPath);
    result.sizeFrom = sizeFrom;
    result.sizeTo = sizeFrom;

    // 本来就不大，没必要压
    if (sizeFrom > 0 && sizeFrom <= skipBelow) return result;

    // 算等比目标尺寸；拿不到原图尺寸就只压质量
    const target = {};
    const info = await getImageInfo(tempPath);
    if (info && info.width > 0 && info.height > 0) {
      const longEdge = Math.max(info.width, info.height);
      if (longEdge > maxEdge) {
        const scale = maxEdge / longEdge;
        target.compressedWidth = Math.max(1, Math.round(info.width * scale));
        target.compressedHeight = Math.max(1, Math.round(info.height * scale));
      }
    }

    const out = await doCompress(tempPath, target);
    if (!out) return result;

    const sizeTo = await getFileSize(out);
    // 没变小或取不到大小：回退原图，别为了"压缩"反而变大
    if (sizeTo <= 0 || (sizeFrom > 0 && sizeTo >= sizeFrom)) return result;

    result.path = out;
    result.changed = true;
    result.sizeTo = sizeTo;
    return result;
  } catch (e) {
    console.warn('[image] 压缩异常，使用原图:', e);
    return result;
  }
}

export default { compressImage, MAX_EDGE, QUALITY };
