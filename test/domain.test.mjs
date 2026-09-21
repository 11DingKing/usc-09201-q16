import assert from 'node:assert/strict';
import test from 'node:test';
import { Ledger } from '../src/domain/store.mjs';
import { calculate, diffRuns, RULE_VERSIONS } from '../src/domain/rules.mjs';
import { SettlementRegistry } from '../src/domain/settlement.mjs';
import { buildScenarioLedger } from '../src/domain/scenario.mjs';
import { runDemo } from '../scripts/demo.mjs';

// 构造最小可计算台账的辅助函数。
function miniLedger({ observations = [], level = 'full_protection', deductions = [], startDate = '2020-01-01' } = {}) {
  const ledger = new Ledger();
  const A = (type, payload, recordedAt) =>
    ledger.append(type, payload, { recordedAt, appendedAt: recordedAt, actor: 'test' });
  A('plot.registered', {
    plotId: 'P1', villageId: 'V1', areaMu: 100, forestType: 'water_source_forest',
    shares: [{ householdId: 'H1', householdName: '测试户', villageId: 'V1', share: 0.5 }],
  }, '2020-01-01T00:00:00Z');
  A('commitment.signed', { plotId: 'P1', householdId: 'H1', level, startDate, endDate: '2030-01-01' }, `${startDate}T00:00:00Z`);
  A('batch.opened', { batchId: 'B1', name: '测试批次', periodStart: '2025-01-01', periodEnd: '2025-12-31', villageIds: ['V1'] }, '2025-01-01T00:00:00Z');
  A('batch.allocated', { batchId: 'B1', amount: 9999999 }, '2025-01-02T00:00:00Z');
  for (const o of observations) {
    A('observation.recorded', {
      observationId: o.id, plotId: 'P1', indicator: o.indicator, source: o.source || 'station',
      observedAt: o.observedAt || '2025-06-01', value: o.value ?? 1,
    }, o.recordedAt || '2026-01-01T00:00:00Z');
    if (o.status === 'confirmed') {
      A('observation.confirmed', { observationId: o.id, basis: 'test' }, o.confirmedAt || '2026-01-05T00:00:00Z');
    } else if (o.status === 'rejected') {
      A('observation.rejected', { observationId: o.id, reason: 'test reject' }, '2026-01-06T00:00:00Z');
    } else if (o.status === 'revoked') {
      A('observation.confirmed', { observationId: o.id, basis: 'test' }, '2026-01-05T00:00:00Z');
      A('observation.revoked', { observationId: o.id, reason: 'test revoke' }, '2026-03-01T00:00:00Z');
    }
  }
  for (const d of deductions) {
    A('deduction.recorded', { deductionId: d.id, plotId: 'P1', category: d.category, ratio: d.ratio, amount: d.amount, occurredAt: d.occurredAt, scope: d.scope }, '2025-07-01T00:00:00Z');
    A('deduction.confirmed', { deductionId: d.id }, '2025-07-05T00:00:00Z');
  }
  return ledger;
}

const lineOf = (result, householdId, plotId) =>
  result.lines.find((l) => l.householdId === householdId && l.plotId === plotId);

test('监测证据门控：pending、被拒、被撤销的证据都不参与计算', () => {
  const ledger = miniLedger({
    observations: [
      { id: 'O1', indicator: 'forest_cover', status: 'pending' },
      { id: 'O2', indicator: 'water_quality', status: 'rejected' },
      { id: 'O3', indicator: 'biodiversity', status: 'revoked' },
    ],
  });
  const result = calculate(ledger, { batchId: 'B1', ruleVersion: '2025-v2', asOf: '2026-04-01T00:00:00Z' });
  assert.equal(result.lines[0].status, 'ineligible_no_evidence');
  assert.equal(result.total, 0);
});

test('同一证据重复引用（跨系统重传）只计一次，且产生告警', () => {
  const ledger = miniLedger({
    observations: [
      { id: 'O1', indicator: 'forest_cover', status: 'confirmed' },
      { id: 'O1-DUP', indicator: 'forest_cover', status: 'confirmed', source: 'station', recordedAt: '2026-01-02T00:00:00Z' },
    ],
  });
  const result = calculate(ledger, { batchId: 'B1', ruleVersion: '2025-v2', asOf: '2026-02-01T00:00:00Z' });
  const line = lineOf(result, 'H1', 'P1');
  assert.equal(line.indicatorsConfirmed.length, 1);
  assert.ok(line.excluded.some((e) => e.observationId === 'O1-DUP' && e.reason === 'duplicate_reference'));
  assert.ok(result.warnings.some((w) => w.includes('重复引用')));
  // 只有一项指标 → 权重 0.7；有效面积 100*0.5*0.7=35 亩。
  assert.equal(line.effectiveAreaMu, 35);
});

test('同指标多份不同证据只采信最新确认的一份，不重复计效', () => {
  const ledger = miniLedger({
    observations: [
      { id: 'O1', indicator: 'forest_cover', status: 'confirmed', confirmedAt: '2026-01-05T00:00:00Z', observedAt: '2025-05-01' },
      { id: 'O2', indicator: 'forest_cover', status: 'confirmed', confirmedAt: '2026-01-20T00:00:00Z', source: 'other-station', observedAt: '2025-09-01', recordedAt: '2026-01-18T00:00:00Z' },
    ],
  });
  const result = calculate(ledger, { batchId: 'B1', ruleVersion: '2025-v2', asOf: '2026-02-01T00:00:00Z' });
  const line = lineOf(result, 'H1', 'P1');
  assert.deepEqual(line.indicatorsConfirmed, ['forest_cover']);
  assert.equal(line.acceptedEvidence[0].observationId, 'O2');
  assert.ok(line.excluded.some((e) => e.observationId === 'O1' && e.reason === 'superseded_within_indicator'));
});

test('可复算：同台账+同 asOf+同规则版本，重复计算结果逐字段一致', () => {
  const demo1 = runDemo();
  const demo2 = runDemo();
  for (const [a, b] of [
    [demo1.runV1, demo2.runV1],
    [demo1.runV2, demo2.runV2],
    [demo1.runAfterRevoke, demo2.runAfterRevoke],
    [demo1.runAfterLateConfirm, demo2.runAfterLateConfirm],
  ]) {
    assert.deepEqual(a.lines, b.lines);
    assert.equal(a.total, b.total);
  }
});

test('asOf 截止口径：早于截止点不可见的证据不得影响结果（异常数据不确认不计算）', () => {
  const ledger = buildScenarioLedger();
  // 2026-02-10 第一版公示时：OBS-WQ-99 仍 pending，P100 按 v1 规则只凭森林覆盖率即可受偿。
  const atV1 = calculate(ledger, { batchId: 'B2025', ruleVersion: '2024-v1', asOf: '2026-02-10T00:00:00Z' });
  assert.equal(atV1.total, 25272);
  // 异常值在 02-12 被拒后，金额不变。
  const afterReject = calculate(ledger, { batchId: 'B2025', ruleVersion: '2024-v1', asOf: '2026-02-15T00:00:00Z' });
  assert.equal(afterReject.total, 25272);
});

test('规则换版：v1→v2 差异逐户可归因，总额变化等于各户 delta 之和', () => {
  const ledger = buildScenarioLedger();
  const v1 = calculate(ledger, { batchId: 'B2025', ruleVersion: '2024-v1', asOf: '2026-02-15T00:00:00Z' });
  const v2 = calculate(ledger, { batchId: 'B2025', ruleVersion: '2025-v2', asOf: '2026-02-15T00:00:00Z' });
  const diff = diffRuns(v1, v2);
  const deltaSum = Math.round(diff.changes.reduce((a, c) => a + c.delta, 0) * 100) / 100;
  assert.equal(deltaSum, diff.totalDelta);
  // 长期管护者（H01 2018 年承诺）在 v2 拿到 5 年档津贴；晚承诺的 H04 没有津贴。
  const h01 = diff.changes.find((c) => c.householdId === 'H01');
  const h04 = diff.changes.find((c) => c.householdId === 'H04');
  assert.ok(h01.reasons.some((r) => r.includes('长期管护津贴')));
  assert.ok(h01.delta > 0 && h04.delta < 0); // 按效计偿：高承诺者涨、一般管护者降
});

test('共有林地按份额分摊；责任 scope 的扣减不殃及其他共有人', () => {
  const ledger = buildScenarioLedger();
  const v1 = calculate(ledger, { batchId: 'B2025', ruleVersion: '2024-v1', asOf: '2026-02-15T00:00:00Z' });
  // H03 有效面积 600*0.20=120 亩，36 元/亩，承担 15% 扣减：120*36*0.85=3672。
  assert.equal(lineOf(v1, 'H03', 'P100').net, 3672);
  // H01 同宗地但无责任，不被扣减。
  assert.equal(lineOf(v1, 'H01', 'P100').deductionRatio, 0);
  assert.equal(lineOf(v1, 'H01', 'P100').net, 6480);
});

test('扣减比率受规则版上限封顶', () => {
  const ledger = miniLedger({
    observations: [{ id: 'O1', indicator: 'forest_cover', status: 'confirmed' }],
    deductions: [
      { id: 'D1', category: 'a', ratio: 0.4, occurredAt: '2025-03-01' },
      { id: 'D2', category: 'b', ratio: 0.35, occurredAt: '2025-04-01' },
    ],
  });
  const result = calculate(ledger, { batchId: 'B1', ruleVersion: '2025-v2', asOf: '2026-02-01T00:00:00Z' });
  const line = lineOf(result, 'H1', 'P1');
  assert.equal(line.deductionRatio, RULE_VERSIONS['2025-v2'].deductionCap); // 0.6 封顶
  assert.ok(result.warnings.some((w) => w.includes('封顶')));
});

test('发布冻结：已发布结果不被后续重算覆盖，同批次同版同日不可重复发布', () => {
  const registry = new SettlementRegistry();
  const ledger = buildScenarioLedger();
  const v1 = calculate(ledger, { batchId: 'B2025', ruleVersion: '2024-v1', asOf: '2026-02-15T00:00:00Z' });
  const pub = registry.publish(v1, { ledgerEventCount: ledger.events.length, publishedAt: '2026-02-15T00:00:00Z' });
  assert.throws(
    () => registry.publish(v1, { ledgerEventCount: ledger.events.length, publishedAt: '2026-02-15T00:00:00Z' }),
    /已发布/
  );
  // 冻结快照不受原对象后续修改影响。
  v1.total = -1;
  assert.notEqual(registry.runs.get(pub.runId).result.total, -1);
});

test('发布后只能追加调整：撤销证据→追回，跨期补证→追补，且逐户对账闭合', () => {
  const demo = runDemo();
  // 撤销 OBS-WQ-01 对 P100 五户均为负向追回。
  assert.equal(demo.revokeAdjustments.length, 5);
  assert.ok(demo.revokeAdjustments.every((a) => a.kind === 'clawback' && a.signedAmount < 0));
  // 跨期补正确认 OBS-BD-02 仅利好 H06。
  assert.equal(demo.topupAdjustments.length, 1);
  assert.equal(demo.topupAdjustments[0].householdId, 'H06');
  assert.ok(demo.topupAdjustments[0].reason.includes('跨期追补'));
  // 所有农户：发布金额+调整金额 = 按最新台账重算金额。
  assert.ok(demo.reconciliation.every((r) => r.closed));
});

test('调整必须针对已发布结果，金额与方向受校验', () => {
  const registry = new SettlementRegistry();
  assert.throws(() => registry.addAdjustment({ runId: 'NOPE', householdId: 'H1', amount: 1, kind: 'topup' }), /已发布/);
});

test('场景不变量：两版规则参数本身满足文档化差异', () => {
  assert.equal(RULE_VERSIONS['2024-v1'].flatRate, 36);
  assert.equal(RULE_VERSIONS['2024-v1'].stewardshipBonus, null);
  assert.equal(RULE_VERSIONS['2025-v2'].ratesByLevel.full_protection, 48);
  assert.equal(RULE_VERSIONS['2025-v2'].deductionCap, 0.6);
});
