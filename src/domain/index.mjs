// 领域命令门面：所有写操作都转为只追加事件。日期显式传入，保证跨机构数据可复算。

import { createStore } from './store.mjs';
import {
  createBatch,
  settleBatch,
  publishBatch,
  markBatchPaid,
  switchRule,
  createAdjustmentBatch,
  calcSettlement,
} from './batch.mjs';

export * as rules from './rules.mjs';
export { createStore } from './store.mjs';
export {
  createBatch,
  settleBatch,
  publishBatch,
  markBatchPaid,
  switchRule,
  createAdjustmentBatch,
  calcSettlement,
};

let idCounter = 0;
export function newId(prefix) {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(4, '0')}`;
}

export function registerHousehold(store, { householdId, name, villageId }, actor = '生态部门') {
  return store.append('household_registered', { householdId, name, villageId }, actor);
}

export function registerPlot(
  store,
  { plotId, name, villageIds, nominalAreaMu, forestType = '水源涵养林' },
  actor = '生态部门',
) {
  return store.append('plot_registered', { plotId, name, villageIds, nominalAreaMu, forestType }, actor);
}

/** 共有林地分摊协议。shares: [{ householdId, villageId?, share }]，比例之和必须为 1。 */
export function agreeShares(store, { plotId, shares, agreedAt }, actor = '村委会') {
  const total = shares.reduce((sum, s) => sum + s.share, 0);
  if (Math.abs(total - 1) > 0.0001) throw new Error(`分摊比例之和必须为 1，当前为 ${total}`);
  return store.append('share_agreed', { plotId, shares, agreedAt }, actor);
}

export function signCommitment(
  store,
  { commitmentId, householdId, plotIds, periodStart, periodEnd, signedAt, items = [] },
  actor = '林农',
) {
  return store.append(
    'commitment_signed',
    {
      commitmentId,
      householdId,
      plotIds,
      periodStart,
      periodEnd,
      signedAt,
      items: items.map((item, index) => ({
        id: item.id ?? `item-${index + 1}`,
        text: item.text,
      })),
    },
    actor,
  );
}

export function completeCommitmentItem(store, { commitmentId, itemId, doneAt }, actor = '林农') {
  return store.append('commitment_item_done', { commitmentId, itemId, doneAt }, actor);
}

export function withdrawCommitment(store, { commitmentId, at }, actor = '林农') {
  return store.append('commitment_withdrawn', { commitmentId, at }, actor);
}

export function recordStewardship(
  store,
  { householdId, period, patrolsPerMonth, years, recordedAt },
  actor = '林业站',
) {
  return store.append(
    'stewardship_recorded',
    { householdId, period, patrolsPerMonth, years, recordedAt },
    actor,
  );
}

/**
 * 提交监测证据。异常初筛自动打标：
 *  - 面积超过登记面积 110%、郁闭度越界等都会标 anomaly
 *  - 异常证据可以提交，但未经「显式豁免确认」不能参与核算
 * supersedes 用于监测更正：新证据提交后旧证据自动变为 superseded。
 */
export function submitEvidence(
  store,
  {
    evidenceId,
    plotId,
    agencyId,
    agencyName,
    evidenceType, // remote_sensing | field_record | inspection_report
    observedAt,
    recordedAt,
    period,
    coverageStart = null,
    coverageEnd = null,
    values,
    supersedes = null,
  },
  actor = agencyName ?? '监测机构',
) {
  return store.append(
    'evidence_submitted',
    {
      evidenceId,
      plotId,
      agencyId,
      agencyName,
      evidenceType,
      observedAt,
      recordedAt,
      period,
      coverageStart,
      coverageEnd,
      values,
      supersedes,
    },
    actor,
  );
}

export function confirmEvidence(
  store,
  { evidenceId, confirmedAt, confirmedBy, overrideAnomaly = false, note = '' },
  actor = confirmedBy ?? '生态部门',
) {
  return store.append(
    'evidence_confirmed',
    { evidenceId, confirmedAt, confirmedBy, overrideAnomaly, note },
    actor,
  );
}

/** 撤销一条异常/错误监测。已撤销证据永不参与核算，事件保留可追溯。 */
export function rejectEvidence(store, { evidenceId, rejectedAt, rejectedBy, reason }, actor = rejectedBy ?? '生态部门') {
  return store.append('evidence_rejected', { evidenceId, rejectedAt, rejectedBy, reason }, actor);
}

/**
 * 否决一条「更正证据」并恢复其替代的旧证据：
 * 适用于更正经复核不成立的情形。旧证据恢复为原状态（默认 submitted，需重新确认）。
 */
export function rejectCorrectionAndReinstate(
  store,
  { correctionEvidenceId, rejectedAt, rejectedBy, reason, restoreStatus = 'submitted' },
  actor = rejectedBy ?? '生态部门',
) {
  const correction = store.state.evidence.get(correctionEvidenceId);
  if (!correction) throw new Error(`证据不存在：${correctionEvidenceId}`);
  if (!correction.supersedes) throw new Error(`${correctionEvidenceId} 不是更正证据，不能恢复旧证据`);
  store.append('evidence_rejected', { evidenceId: correctionEvidenceId, rejectedAt, rejectedBy, reason }, actor);
  store.append(
    'evidence_reinstated',
    { evidenceId: correction.supersedes, status: restoreStatus, reinstatedAt: rejectedAt, reinstatedBy: rejectedBy },
    actor,
  );
}

/** 记录「某户引用某证据支撑某地块某期承诺」。同一证据可被多户引用；同一户重复引用只计一次。 */
export function recordCitation(
  store,
  { citationId, evidenceId, householdId, plotId, period, at },
  actor = '林农',
) {
  return store.append('citation_recorded', { citationId, evidenceId, householdId, plotId, period, at }, actor);
}

export function recordDeduction(
  store,
  {
    deductionId,
    plotId,
    householdId = null,
    category,
    eventDate,
    recordedAt,
    period,
    areaAffectedMu,
    severityRate,
    note = '',
  },
  actor = '执法队',
) {
  return store.append(
    'deduction_recorded',
    { deductionId, plotId, householdId, category, eventDate, recordedAt, period, areaAffectedMu, severityRate, note },
    actor,
  );
}

/** 扣减事件事后被撤销（如申诉成立）：旧事件保留，仅状态转为 reversed。 */
export function reverseDeduction(store, { deductionId, reversedAt, reason }, actor = '生态部门') {
  return store.append('deduction_reversed', { deductionId, reversedAt, reason }, actor);
}
