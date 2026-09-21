// 公示前验收演示：挑选一宗跨村水源涵养林，
// 切换两版规则、撤销一条异常监测，逐户核对金额与变化说明。
//
// 运行：node scripts/acceptance-demo.mjs

import {
  buildScenario,
  scenarioStore,
  PERIOD,
} from '../src/domain/scenario.mjs';
import * as D from '../src/domain/index.mjs';
import { formatSettlement, formatChangeSummary, formatAdjustment, formatNotices } from '../src/domain/report.mjs';
import { yuan } from '../src/domain/money.mjs';

const line = '='.repeat(78);

function print(...parts) {
  console.log(parts.join('\n'));
}

const store = buildScenario(scenarioStore());

print(line, '步骤 0｜核算提示（异常监测已被自动标记，等待人工处置）', line);
const preview = D.calcSettlement(store, { ruleVersion: 'v1', periods: [PERIOD], plotIds: ['p-cross'] });
print(formatNotices(preview));

print('\n' + line, '步骤 1｜建立 2026H1 资金批次，按 v1（基线面积版）定稿', line);
D.createBatch(store, {
  batchId: 'b-2026h1',
  label: '2026 年上半年青龙凹跨村水源涵养林补偿',
  periods: [PERIOD],
  ruleVersion: 'v1',
  plotIds: ['p-cross'],
}, '生态局');
const first = D.settleBatch(store, 'b-2026h1', { reason: '初次核算' });
print(formatSettlement(first.result));

print('\n' + line, '步骤 2｜切换到 v2（贡献导向版）并重新定稿，查看各户变化说明', line);
D.switchRule(store, 'b-2026h1', 'v2', '生态局');
const switched = D.settleBatch(store, 'b-2026h1', { reason: '公示前切换贡献导向版规则' });
print(formatSettlement(switched.result));
print('');
print(formatChangeSummary(switched.changeSummary));

print('\n' + line, '步骤 3｜值班员误将异常物联监测（300 亩）豁免确认并重新定稿', line);
D.confirmEvidence(store, {
  evidenceId: 'ev-iot-03',
  confirmedAt: '2026-05-12',
  confirmedBy: '县分局值班员',
  overrideAnomaly: true,
  note: '设备回传，先采信后核查',
});
const polluted = D.settleBatch(store, 'b-2026h1', { reason: '误采信异常物联监测' });
print(formatSettlement(polluted.result, { title: '被异常值污染的核算结果（不予公示）' }));
print('');
print(formatChangeSummary(polluted.changeSummary, { title: '异常值导致的变化' }));

print('\n' + line, '步骤 4｜核查确认设备故障，撤销异常监测并重新定稿，金额恢复', line);
D.rejectEvidence(store, {
  evidenceId: 'ev-iot-03',
  rejectedAt: '2026-05-20',
  rejectedBy: '生态局监测科',
  reason: '设备标定故障，读数失真，予以撤销',
});
const restored = D.settleBatch(store, 'b-2026h1', { reason: '撤销异常监测 ev-iot-03' });
print(formatChangeSummary(restored.changeSummary, { title: '撤销异常监测后的恢复说明' }));

// 验收断言：恢复后的各户金额必须与步骤 2 完全一致
const a = switched.result.householdTotals.map((r) => [r.householdId, r.totalCents]);
const b = restored.result.householdTotals.map((r) => [r.householdId, r.totalCents]);
const symmetric = JSON.stringify(a) === JSON.stringify(b);
print(
  '',
  symmetric
    ? '✓ 验收通过：撤销异常监测后各户金额与换版后结果完全一致，变化说明与金额一一对应。'
    : '✗ 验收失败：金额未恢复，禁止公示。',
);

print('\n' + line, '步骤 5｜公示发布并登记拨付——结果冻结', line);
D.publishBatch(store, 'b-2026h1', { publishedAt: '2026-06-10' });
D.markBatchPaid(store, 'b-2026h1', { paidAt: '2026-06-20', voucherNo: 'PAY-2026H1-001' });
print(`批次状态：${store.state.batches.get('b-2026h1').status}，冻结金额：${yuan(restored.result.grandTotalCents)} 元`);
try {
  D.settleBatch(store, 'b-2026h1');
  print('✗ 发布后竟能改算，冻结失败');
} catch (error) {
  print(`✓ 发布后改算被拒绝：${error.message}`);
}

print('\n' + line, '步骤 6｜拨付后申诉成立（火情非管护责任），跨期追补只能追加调整批次', line);
D.reverseDeduction(store, { deductionId: 'd-fire-01', reversedAt: '2026-07-05', reason: '申诉成立，非管护责任' });
D.createAdjustmentBatch(store, {
  adjustmentBatchId: 'b-2026h1-adj1',
  adjustsBatchId: 'b-2026h1',
  note: '火情扣减申诉成立，跨期追补',
});
D.publishBatch(store, 'b-2026h1-adj1', { publishedAt: '2026-07-15' });
print(formatAdjustment(store.state.batches.get('b-2026h1-adj1')));
print('');
print(`原批次金额保持不变：${yuan(store.state.batches.get('b-2026h1').current.grandTotalCents)} 元`);
