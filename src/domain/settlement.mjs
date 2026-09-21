// 发布与结算：核算结果一经发布即冻结，之后只能追加调整，绝不允许覆盖旧金额。
// 跨期追补/追回 = 针对已发布批次新开一条 adjustment（说明原因、关联依据事件），
// 农户最终「应得累计」= 历次发布金额 + 历次调整金额，链路完整可查。

import { roundMoney, sumMoney } from './util.mjs';

export class SettlementRegistry {
  constructor() {
    this.runs = new Map(); // runId -> 冻结结果（含版本、asOf、逐户金额）
    this.adjustments = []; // 发布后的追加调整
  }

  // 发布：把一次计算结果连同输入指纹（规则版本 + asOf + 批次 + 事件数）固化。
  publish(result, { ledgerEventCount, publishedAt = new Date().toISOString(), operator = 'ecology-dept' }) {
    const runId = `RUN-${result.batchId}-${result.ruleVersion}-${publishedAt.slice(0, 10).replaceAll('-', '')}`;
    if (this.runs.has(runId)) {
      throw new Error(`同一批次同一规则版本当日已发布：${runId}；如需变更请走追加调整或新日期重发`);
    }
    const frozen = structuredClone(result);
    const record = {
      runId,
      batchId: result.batchId,
      ruleVersion: result.ruleVersion,
      asOf: result.asOf,
      publishedAt,
      operator,
      ledgerEventCount,
      inputFingerprint: `${result.batchId}|${result.ruleVersion}|${result.asOf}|${ledgerEventCount}`,
      result: frozen,
      status: 'published',
    };
    this.runs.set(runId, record);
    return record;
  }

  // 发布后追加调整（跨期追补、监测更正后的补发/追回均走此入口）。
  // kind: 'topup' 追补（+） | 'clawback' 追回（-）
  addAdjustment({ runId, householdId, amount, kind, reason, evidenceEventIds = [], at = new Date().toISOString(), operator = 'ecology-dept' }) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`调整必须针对已发布结果，未找到：${runId}`);
    if (!['topup', 'clawback'].includes(kind)) throw new Error(`未知调整类型：${kind}`);
    if (!(amount > 0)) throw new Error('调整金额必须为正数，方向由 kind 决定');

    const adj = {
      adjustmentId: `ADJ-${String(this.adjustments.length + 1).padStart(4, '0')}`,
      runId,
      batchId: run.batchId,
      householdId,
      amount,
      signedAmount: kind === 'topup' ? amount : -amount,
      kind,
      reason,
      evidenceEventIds,
      at,
      operator,
    };
    this.adjustments.push(adj); // 仅追加
    return adj;
  }

  // 农户在某批次的累计应得：
  // 同一批次的多次发布是「换版替代」关系（公示换版在资金兑付前完成），
  // 以最新一次发布为当前基数，旧发布仅作历史留痕、不重复计入；
  // 发布后的追加调整（追补/追回）才在基数之上累加。
  householdCumulative(batchId) {
    const runRecords = [...this.runs.values()]
      .filter((r) => r.batchId === batchId)
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    if (runRecords.length === 0) return [];
    const current = runRecords[runRecords.length - 1];
    const superseded = runRecords.slice(0, -1);

    const map = new Map();
    for (const h of current.result.householdTotals) {
      map.set(h.householdId, {
        householdId: h.householdId,
        householdName: h.householdName,
        currentRunId: current.runId,
        currentRuleVersion: current.ruleVersion,
        published: h.amount,
        adjustments: 0,
        adjustmentList: [],
        history: [
          ...superseded.map((r) => ({
            kind: 'superseded_publication',
            runId: r.runId,
            ruleVersion: r.ruleVersion,
            amount: r.result.householdTotals.find((x) => x.householdId === h.householdId)?.amount ?? 0,
          })),
          { kind: 'current_publication', runId: current.runId, ruleVersion: current.ruleVersion, amount: h.amount },
        ],
      });
    }

    for (const adj of this.adjustments.filter((a) => a.batchId === batchId)) {
      const cur = map.get(adj.householdId) || {
        householdId: adj.householdId,
        householdName: adj.householdId,
        currentRunId: current.runId,
        currentRuleVersion: current.ruleVersion,
        published: 0,
        adjustments: 0,
        adjustmentList: [],
        history: [],
      };
      cur.adjustments = sumMoney([cur.adjustments, adj.signedAmount]);
      cur.adjustmentList.push(adj);
      map.set(adj.householdId, cur);
    }

    return [...map.values()].map((c) => ({
      ...c,
      cumulative: roundMoney(c.published + c.adjustments),
    }));
  }

  adjustmentsOfRun(runId) {
    return this.adjustments.filter((a) => a.runId === runId);
  }
}
