// 批次生命周期：规则换版、异常监测确认/撤销、发布冻结、跨期追补、调整链、账本重放。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildScenario,
  scenarioStore,
  PERIOD,
} from '../src/domain/scenario.mjs';
import * as D from '../src/domain/index.mjs';
import { yuan } from '../src/domain/money.mjs';
import { exportLedger, loadStore } from '../src/domain/persistence.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function totalsMap(result) {
  return new Map(result.householdTotals.map((r) => [r.householdId, r.totalCents]));
}

test('验收剧情：v1 定稿 → 换版 v2 → 异常证据误确认 → 撤销后恢复，金额与变化说明逐项对应', () => {
  const store = buildScenario(scenarioStore());

  // 1) v1 建批次并定稿
  D.createBatch(store, {
    batchId: 'b-2026h1', label: '2026 年上半年水源涵养林补偿',
    periods: [PERIOD], ruleVersion: 'v1', plotIds: ['p-cross'],
  }, '生态局');
  const v1 = D.settleBatch(store, 'b-2026h1', { reason: '初次核算' });
  assert.equal(yuan(v1.result.grandTotalCents), '45,000.00');

  // 2) 切换 v2 重新定稿：差异来自系数
  D.switchRule(store, 'b-2026h1', 'v2', '生态局');
  const switched = D.settleBatch(store, 'b-2026h1', { reason: '公示前切换贡献导向版规则' });
  const qinChange = switched.changeSummary.find((r) => r.householdId === 'h-qin');
  assert.ok(qinChange.deltaCents > 0);
  assert.ok(qinChange.reasons.some((r) => r.includes('规则版本 v1 → v2')));
  assert.ok(qinChange.reasons.some((r) => r.includes('管护强度系数 1 → 1.18')));
  const shiChange = switched.changeSummary.find((r) => r.householdId === 'h-shi');
  assert.ok(shiChange.deltaCents < 0, '管护薄弱户在 v2 下金额下降');

  // 3) 异常证据被显式豁免确认（一次错误的人工确认）：就低面积掉到 300 亩，四户全受影响
  D.confirmEvidence(store, {
    evidenceId: 'ev-iot-03', confirmedAt: '2026-05-12',
    confirmedBy: '县分局值班员', overrideAnomaly: true, note: '设备回传，先采信后核查',
  });
  const polluted = D.settleBatch(store, 'b-2026h1', { reason: '误采信异常物联监测' });
  const qinPolluted = totalsMap(polluted.result).get('h-qin');
  assert.ok(qinPolluted < 1000000, '异常低值拉低全部金额');
  assert.ok(
    polluted.changeSummary
      .find((r) => r.householdId === 'h-qin')
      .reasons.some((r) => r.includes('新纳入面积采信的证据：ev-iot-03')),
  );

  // 4) 核查确认设备故障，撤销异常监测并重新定稿：金额恢复，变化说明逐项对称
  D.rejectEvidence(store, {
    evidenceId: 'ev-iot-03', rejectedAt: '2026-05-20',
    rejectedBy: '生态局监测科', reason: '设备标定故障，读数失真，予以撤销',
  });
  const restored = D.settleBatch(store, 'b-2026h1', { reason: '撤销异常监测 ev-iot-03' });
  assert.deepEqual(
    restored.result.householdTotals.map((r) => r.totalCents),
    switched.result.householdTotals.map((r) => r.totalCents),
  );
  const qinRestoreReason = restored.changeSummary.find((r) => r.householdId === 'h-qin').reasons;
  assert.ok(qinRestoreReason.some((r) => r.includes('退出面积采信的证据：ev-iot-03')));
  assert.ok(qinRestoreReason.some((r) => r.includes('认定面积 120 → 368 亩')));
  // 被撤销的证据不能重新确认
  assert.throws(
    () => D.confirmEvidence(store, { evidenceId: 'ev-iot-03', confirmedAt: '2026-05-21', confirmedBy: 'x' }),
    /已撤销的证据不能确认/,
  );

  // 5) 批次留痕：三次定稿全部可回溯
  const batch = store.state.batches.get('b-2026h1');
  assert.equal(batch.settlements.length, 4);
  assert.equal(yuan(batch.settlements[0].grandTotalCents), '45,000.00');
});

test('发布后结果冻结：不能重新定稿、不能换版，只能追加调整批次', () => {
  const store = buildScenario(scenarioStore());
  D.createBatch(store, { batchId: 'b1', label: '批次', periods: [PERIOD], ruleVersion: 'v1', plotIds: ['p-cross'] });
  D.settleBatch(store, 'b1');
  D.publishBatch(store, 'b1', { publishedAt: '2026-06-10' });

  assert.throws(() => D.settleBatch(store, 'b1'), /已发布，结果冻结/);
  assert.throws(() => D.switchRule(store, 'b1', 'v2'), /规则版本冻结/);
  assert.throws(() => D.publishBatch(store, 'b1'), /未定稿|已发布/);

  // 已发布金额是不可变的数字
  const frozen = store.state.batches.get('b1').current.grandTotalCents;
  assert.equal(yuan(frozen), '45,000.00');
});

test('跨期追补：发布后扣减事件申诉成立被撤销，调整批次只产生差额', () => {
  const store = buildScenario(scenarioStore());
  D.createBatch(store, { batchId: 'b1', label: '批次', periods: [PERIOD], ruleVersion: 'v2', plotIds: ['p-cross'] });
  const settled = D.settleBatch(store, 'b1');
  const baiBefore = totalsMap(settled.result).get('h-bai');
  D.publishBatch(store, 'b1', { publishedAt: '2026-06-10' });
  D.markBatchPaid(store, 'b1', { paidAt: '2026-06-20', voucherNo: 'PAY-2026-001' });

  // 公示后查明火情系外村人员纵火，白水根申诉成立，撤回扣减
  D.reverseDeduction(store, { deductionId: 'd-fire-01', reversedAt: '2026-07-05', reason: '申诉成立，非管护责任' });
  const adj = D.createAdjustmentBatch(store, {
    adjustmentBatchId: 'b1-adj1', adjustsBatchId: 'b1',
    note: '火情扣减申诉成立，跨期追补',
  });

  // 只有白的金额变化（v2 下补回 20 亩：20×50×1.05×1.0×1.05）
  const adjTotals = new Map(adj.householdTotals.map((r) => [r.householdId, r.totalCents]));
  assert.equal(yuan(adjTotals.get('h-bai')), '1,102.50');
  for (const id of ['h-qin', 'h-lan', 'h-shi']) assert.equal(adjTotals.get(id), 0);
  // 原批次分文未动
  assert.equal(totalsMap(store.state.batches.get('b1').current).get('h-bai'), baiBefore);
  // 调整条目保留前后金额与原因
  const baiEntry = adj.deltaEntries.find((e) => e.householdId === 'h-bai');
  assert.equal(baiEntry.beforeAmountCents, baiBefore);
  assert.ok(baiEntry.adjustmentReasons.some((r) => r.includes('扣减面积 20 → 0 亩')));
});

test('调整链：第二次调整以前一次调整后的全量为基线，差额不重复计', () => {
  const store = buildScenario(scenarioStore());
  D.createBatch(store, { batchId: 'b1', label: '批次', periods: [PERIOD], ruleVersion: 'v2', plotIds: ['p-cross'] });
  D.settleBatch(store, 'b1');
  D.publishBatch(store, 'b1', { publishedAt: '2026-06-10' });

  // 调整一：撤扣减
  D.reverseDeduction(store, { deductionId: 'd-fire-01', reversedAt: '2026-07-05', reason: '申诉成立' });
  D.createAdjustmentBatch(store, { adjustmentBatchId: 'b1-adj1', adjustsBatchId: 'b1' });
  D.publishBatch(store, 'b1-adj1', { publishedAt: '2026-07-15' });

  // 调整二：石望山承诺撤回（不再履行管护），全额追回；白在调整二中差额应为 0
  D.withdrawCommitment(store, { commitmentId: 'c-shi', at: '2026-08-02' });
  const adj2 = D.createAdjustmentBatch(store, {
    adjustmentBatchId: 'b1-adj2', adjustsBatchId: 'b1-adj1',
    note: '石望山撤回保护承诺，追回已发补偿',
  });
  const adj2Totals = new Map(adj2.householdTotals.map((r) => [r.householdId, r.totalCents]));
  assert.equal(adj2Totals.get('h-bai'), 0, '第一次调整已补的金额不在第二次重复计算');
  const shi = adj2.deltaEntries.find((e) => e.householdId === 'h-shi');
  assert.ok(shi.amountCents < 0);
  assert.equal(shi.afterAmountCents, 0);
  assert.ok(shi.adjustmentReasons.some((r) => r.includes('退出引用的证据')));

  // 链上累计：石的净额为负，白只补过一次
  assert.equal(store.state.batches.get('b1').status, 'published');
});

test('已发布批次不能直接调整；未发布批次应在原批次重新定稿', () => {
  const store = buildScenario(scenarioStore());
  D.createBatch(store, { batchId: 'b1', label: '批次', periods: [PERIOD], ruleVersion: 'v1', plotIds: ['p-cross'] });
  D.settleBatch(store, 'b1');
  assert.throws(
    () => D.createAdjustmentBatch(store, { adjustmentBatchId: 'x', adjustsBatchId: 'b1' }),
    /只能对已发布批次建立调整/,
  );
});

test('账本 JSONL 导出与重放：重放后核算指纹和金额完全一致', async () => {
  const store = buildScenario(scenarioStore());
  D.createBatch(store, { batchId: 'b1', label: '批次', periods: [PERIOD], ruleVersion: 'v2', plotIds: ['p-cross'] });
  D.settleBatch(store, 'b1');
  D.publishBatch(store, 'b1', { publishedAt: '2026-06-10' });
  D.reverseDeduction(store, { deductionId: 'd-fire-01', reversedAt: '2026-07-05', reason: '申诉成立' });
  D.createAdjustmentBatch(store, { adjustmentBatchId: 'b1-adj1', adjustsBatchId: 'b1' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-ledger-'));
  const file = path.join(dir, 'ledger.jsonl');
  exportLedger(file, store);

  const restored = await loadStore(file);
  assert.equal(restored.events().length, store.events().length);
  const a = D.calcSettlement(store, { ruleVersion: 'v2', periods: [PERIOD], plotIds: ['p-cross'] });
  const b = D.calcSettlement(restored, { ruleVersion: 'v2', periods: [PERIOD], plotIds: ['p-cross'] });
  assert.equal(a.inputDigest, b.inputDigest);
  assert.equal(a.grandTotalCents, b.grandTotalCents);
  // 批次状态与调整链一并恢复
  assert.equal(restored.state.batches.get('b1').status, 'published');
  assert.equal(restored.state.batches.get('b1-adj1').adjustsBatchId, 'b1');
  assert.equal(restored.state.evidence.get('ev-iot-03').status, 'submitted');
});
