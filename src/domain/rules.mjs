// 核算规则版本。规则是纯函数集合：同一版本号、同一输入，永远得到同一结果（可复算）。
// 规则一经发布（被批次引用）即冻结，只能新增版本，不能修改旧版本。

export const RULE_VERSIONS = {
  // v1：基线版——按有效面积 × 单价，管护强度与证据质量仅作记录，不参与计算。
  'v1': {
    version: 'v1',
    label: '基线面积版',
    publishedAt: '2026-01-01',
    baseRateYuanPerMu: 50, // 元/亩·年
    // 承诺履行系数：v1 不区分，一律 1.0
    commitmentFactor() {
      return 1;
    },
    // 管护强度系数：v1 不采信
    stewardshipFactor() {
      return 1;
    },
    // 证据质量系数：v1 不采信
    evidenceQualityFactor() {
      return 1;
    },
    describe() {
      return '有效面积×50元/亩；管护强度与证据质量不参与计算';
    },
  },

  // v2：贡献导向版——把长期管护投入和证据质量纳入系数，让真正管护的人可被核算识别。
  'v2': {
    version: 'v2',
    label: '贡献导向版',
    publishedAt: '2026-04-01',
    baseRateYuanPerMu: 50,
    // 承诺履行：按承诺事项完成度。承诺为逐项事项，完成率即系数（0.8~1.2 封顶）。
    commitmentFactor(commitment = {}) {
      const items = commitment.items ?? [];
      if (items.length === 0) return 1;
      const done = items.filter((item) => item.done).length;
      const rate = done / items.length;
      // 完成率 100% -> 1.1；0% -> 0.9；线性映射到 [0.9, 1.1]
      return Math.round((0.9 + 0.2 * rate) * 1000) / 1000;
    },
    // 管护强度：巡查频次/月与持续年限的组合，采信区间 [0.9, 1.25]。
    stewardshipFactor(stewardship = {}) {
      const patrolsPerMonth = stewardship.patrolsPerMonth ?? 0;
      const years = stewardship.years ?? 0;
      // 每月 4 次巡查为基准 1.0；每多 1 次 +0.03，每少 1 次 -0.05；管护每满 3 年 +0.02
      const patrolPart = (patrolsPerMonth - 4) * 0.03 + Math.floor(years / 3) * 0.02;
      const factor = 1 + patrolPart;
      return Math.round(Math.min(1.25, Math.max(0.9, factor)) * 1000) / 1000;
    },
    // 证据质量：仅采信「已确认」证据。完整核查报告优于现场记录优于遥感。
    evidenceQualityFactor(evidence) {
      const confirmed = evidence.filter((e) => e.status === 'confirmed');
      if (confirmed.length === 0) return 1; // 无已确认证据时不在此项上扣减（缺失由有效面积环节把关）
      const weight = { remote_sensing: 0.02, field_record: 0.05, inspection_report: 0.08 };
      const bonus = confirmed.reduce((sum, e) => sum + (weight[e.evidenceType] ?? 0), 0);
      return Math.round(Math.min(1.15, 1 + bonus) * 1000) / 1000;
    },
    describe() {
      return '有效面积×50元/亩 × 承诺履行系数(0.9~1.1) × 管护强度系数(0.9~1.25) × 证据质量系数(≤1.15)';
    },
  },
};

export function getRule(version) {
  const rule = RULE_VERSIONS[version];
  if (!rule) {
    const versions = Object.keys(RULE_VERSIONS).join('、');
    throw new Error(`未知规则版本：${version}，可用版本：${versions}`);
  }
  return rule;
}

/** 规则的生效顺序，便于展示「切换两版规则」的差异方向。 */
export function listRules() {
  return Object.values(RULE_VERSIONS).map(({ version, label, publishedAt, describe }) => ({
    version,
    label,
    publishedAt,
    formula: describe(),
  }));
}
