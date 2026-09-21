// 金额与面积的舍入工具：内部金额一律使用整数「分」，避免浮点误差。

/** 四舍五入到分（支持负值，用于追补/追回的差额）。 */
export function toCents(yuanValue) {
  return Math.sign(yuanValue) * Math.round(Math.abs(yuanValue) * 100);
}

/** 分 -> 元，保留两位小数字符串，仅用于展示。 */
export function yuan(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100).toLocaleString('zh-CN')}.${String(abs % 100).padStart(2, '0')}`;
}

/** 面积保留 0.01 亩。 */
export function roundMu(mu) {
  return Math.round(mu * 100) / 100;
}

/** 差额带符号的中文前缀，用于变化说明。 */
export function signed(cents) {
  if (cents > 0) return `+${yuan(cents)}`;
  if (cents < 0) return `-${yuan(Math.abs(cents))}`;
  return yuan(0);
}
