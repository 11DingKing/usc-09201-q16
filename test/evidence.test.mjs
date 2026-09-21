// 监测证据更正（supersede 链）、跨期数据隔离、扣减回退测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScenario, scenarioStore, PERIOD } from '../src/domain/scenario.mjs';
import * as D from '../src/domain/index.mjs';
import { yuan } from '../src/domain/money.mjs';

function settle(store, period = PERIOD, ruleVersion = 'v1') {
  return D.calcSettlement(store, { ruleVersion, periods: [period], plotIds: ['p-cross'] });
}

test('监测更正：新证据替代旧证据，旧证据留痕但不再参与核算', () => {
  const store = buildScenario(scenarioStore());
  const before = settle(store);
  assert.equal(before.entries.find((e) => e.householdId === 'h-qin').grossAreaMu, 368);

  // 县调查队复核后提交更正：有效面积由 920 修正为 905
  D.submitEvidence(store, {
    evidenceId: 'ev-field-01-rev', plotId: 'p-cross', agencyId: 'ag-county', agencyName: '县林业调查队',
    evidenceType: 'inspection_report', observedAt: '2026-03-20', recordedAt: '2026-06-02', period: PERIOD,
    values: { effectiveAreaMu: 905, canopyRate: 0.72 }, supersedes: 'ev-field-01',
  });
  D.confirmEvidence(store, {
    evidenceId: 'ev-field-01-rev', confirmedAt: '2026-06-03', confirmedBy: '生态局监测科', note: '复核修正',
  });

  // 旧证据状态变为 superseded；地块就低改为 905（905 < 932）
  assert.equal(store.state.evidence.get('ev-field-01').status, 'superseded');
  assert.equal(store.state.evidence.get('ev-field-01').supersededBy, 'ev-field-01-rev');
  const after = settle(store);
  assert.equal(after.entries.find((e) => e.householdId === 'h-qin').grossAreaMu, 362); // 905×0.4

  // 更正被否决：旧证据恢复，金额随之恢复
  D.rejectCorrectionAndReinstate(store, {
    correctionEvidenceId: 'ev-field-01-rev', rejectedAt: '2026-06-08',
    rejectedBy: '生态局监测科', reason: '修正计算有误，维持原读数', restoreStatus: 'confirmed',
  });
  assert.equal(store.state.evidence.get('ev-field-01-rev').status, 'rejected');
  assert.equal(store.state.evidence.get('ev-field-01').status, 'confirmed');
  const restored = settle(store);
  assert.equal(restored.entries.find((e) => e.householdId === 'h-qin').grossAreaMu, 368);
});

test('期别隔离：2026H2 的证据与承诺不串入 2026H1 核算', () => {
  const store = buildScenario(scenarioStore());
  // 在 H2 提交一条异常高值且被确认的证据
  D.submitEvidence(store, {
    evidenceId: 'ev-h2', plotId: 'p-cross', agencyId: 'ag-county', agencyName: '县林业调查队',
    evidenceType: 'field_record', observedAt: '2026-09-15', recordedAt: '2026-09-20', period: '2026H2',
    values: { effectiveAreaMu: 950, canopyRate: 0.75 },
  });
  D.confirmEvidence(store, { evidenceId: 'ev-h2', confirmedAt: '2026-09-22', confirmedBy: '生态局监测科' });
  D.recordCitation(store, {
    citationId: 'cit-h2', evidenceId: 'ev-h2', householdId: 'h-qin',
    plotId: 'p-cross', period: '2026H2', at: '2026-09-25',
  });
  // H1 结果不变
  const h1 = settle(store, '2026H1');
  assert.equal(h1.entries.find((e) => e.householdId === 'h-qin').grossAreaMu, 368);
  // H2：秦有证据（950 就低采信），其余户无引用证据不予认定
  const h2 = settle(store, '2026H2');
  const qinH2 = h2.entries.find((e) => e.householdId === 'h-qin');
  assert.equal(qinH2.grossAreaMu, 380); // 950×0.4
  const others = h2.entries.filter((e) => e.householdId !== 'h-qin');
  assert.ok(others.every((e) => e.recognized === false));
  assert.ok(others.every((e) => e.notices.some((n) => n.code === 'no_confirmed_evidence')));
});

test('承诺期不覆盖核算期时不予认定', () => {
  const store = buildScenario(scenarioStore());
  // 秦只承诺到 2025 年（剧情里登记为 2026 年，这里以撤换方式模拟：撤回后无承诺）
  D.withdrawCommitment(store, { commitmentId: 'c-qin', at: '2026-02-01' });
  const result = settle(store);
  const qin = result.entries.find((e) => e.householdId === 'h-qin');
  assert.equal(qin.recognized, false);
  assert.equal(qin.amountCents, 0);
  assert.ok(qin.notices.some((n) => n.code === 'no_active_commitment'));
});

test('扣减事件回退（申诉撤销）后即不再影响核算', () => {
  const store = buildScenario(scenarioStore());
  const before = settle(store);
  assert.equal(before.entries.find((e) => e.householdId === 'h-bai').deductionAreaMu, 20);
  D.reverseDeduction(store, { deductionId: 'd-fire-01', reversedAt: '2026-07-05', reason: '申诉成立' });
  const after = settle(store);
  const bai = after.entries.find((e) => e.householdId === 'h-bai');
  assert.equal(bai.deductionAreaMu, 0);
  assert.equal(yuan(bai.amountCents), '9,200.00'); // 184 亩全额
  // 旧扣减事件仍保留在账本中，仅状态改变
  assert.equal(store.state.deductions.get('d-fire-01').status, 'reversed');
});

test('已被更正替代的证据不能撤销（只能通过否决更正来恢复）', () => {
  const store = buildScenario(scenarioStore());
  D.submitEvidence(store, {
    evidenceId: 'ev-rev-x', plotId: 'p-cross', agencyId: 'ag-county', agencyName: '县林业调查队',
    evidenceType: 'inspection_report', observedAt: '2026-03-20', recordedAt: '2026-06-02', period: PERIOD,
    values: { effectiveAreaMu: 905 }, supersedes: 'ev-field-01',
  });
  assert.throws(
    () => D.rejectEvidence(store, {
      evidenceId: 'ev-field-01', rejectedAt: '2026-06-03', rejectedBy: 'x', reason: '误操作',
    }),
    /已被更正证据替代，不能撤销/,
  );
});
