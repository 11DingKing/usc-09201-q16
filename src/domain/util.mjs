// 通用工具：金额取整、编号生成、断言。
// 金额全程以「元」为单位的整数或定点数运算，最后按规则精度（默认 2 位小数）四舍五入，
// 避免浮点累加误差让两版规则的差异无法复算。

export function roundMoney(value, precision = 2) {
  if (!Number.isFinite(value)) {
    throw new Error(`金额不是有效数字：${value}`);
  }
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function sumMoney(values, precision = 2) {
  return roundMoney(values.reduce((acc, v) => acc + v, 0), precision);
}

// 日期按天比较；入参为 YYYY-MM-DD。
export function compareDate(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function todayOf(date) {
  return date.slice(0, 10);
}

let counter = 0;
export function nextId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}
