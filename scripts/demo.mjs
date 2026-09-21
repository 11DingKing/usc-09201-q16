// 公示演练运行器：把场景台账按时间线推进三个节点，
// 证明「同一台账 + 规则版本 + 截止时点 → 同一结果」，且发布后只能追加调整。
//
// 运行：node scripts/demo.mjs            （输出中文对账报告）
//      node scripts/demo.mjs --json      （输出结构化 JSON）

import { buildScenarioLedger } from '../src/domain/scenario.mjs';
import { calculate, diffRuns } from '../src/domain/rules.mjs';
import { SettlementRegistry } from '../src/domain/settlement.mjs';
import { roundMoney } from '../src/domain/util.mjs';

const T_V1 = '2026-02-10T00:00:00Z'; // 第一版公示
const T_V2 = '2026-02-20T00:00:00Z'; // 换版公示
const T_REVOKE = '2026-03-05T03:00:00Z'; // 撤销异常证据
const T_LATE_CONFIRM = '2026-03-10T02:00:00Z'; // 跨期补正确认

function money(n) {
  return `${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 元`;
}

export function runDemo() {
  const ledger = buildScenarioLedger();
  const registry = new SettlementRegistry();

  // ---- 节点 1：按 2024-v1 核算并发布 -------------------------------------
  const runV1 = calculate(ledger, { batchId: 'B2025', ruleVersion: '2024-v1', asOf: T_V1 });
  const pubV1 = registry.publish(runV1, { ledgerEventCount: ledger.events.length, publishedAt: T_V1 });

  // ---- 节点 2：切换 2025-v2，重新核算并发布（旧发布保留） ------------------
  ledger.append('rule.activated', { batchId: 'B2025', version: '2025-v2' },
    { recordedAt: T_V2, appendedAt: T_V2, actor: 'ecology-dept', note: '经公示听证后换用按效计偿版' });
  const runV2 = calculate(ledger, { batchId: 'B2025', ruleVersion: '2025-v2', asOf: T_V2 });
  const pubV2 = registry.publish(runV2, { ledgerEventCount: ledger.events.length, publishedAt: T_V2 });
  const switchDiff = diffRuns(runV1, runV2);

  // ---- 节点 3a：发布后撤销一条已采信的异常水质证据 -------------------------
  // OBS-WQ-01 所用探头属被召回批次，读数不可信；撤销是追加事件，不改写历史。
  ledger.append('observation.revoked',
    { observationId: 'OBS-WQ-01', reason: '探头属厂家召回批次，历次读数整体偏差，撤销采信' },
    { recordedAt: T_REVOKE, appendedAt: T_REVOKE, actor: 'hydro-station', note: '发布后监测更正' });
  const runAfterRevoke = calculate(ledger, { batchId: 'B2025', ruleVersion: '2025-v2', asOf: T_REVOKE });
  const revokeDiff = diffRuns(runV2, runAfterRevoke);
  const revokeAdjustments = [];
  for (const chg of revokeDiff.changes.filter((c) => c.delta < 0)) {
    revokeAdjustments.push(registry.addAdjustment({
      runId: pubV2.runId,
      householdId: chg.householdId,
      amount: roundMoney(-chg.delta),
      kind: 'clawback',
      reason: `撤销异常监测 OBS-WQ-01（探头召回）：${chg.reasons.join('；')}`,
      evidenceEventIds: ['OBS-WQ-01'],
      at: T_REVOKE,
    }));
  }

  // ---- 节点 3b：跨期追补——赵东来的生物多样性证据补正确认 -----------------
  // 观测发生在 2025 补偿期内，确认材料 2026-03 才补齐：不重开旧批次，按追补追加。
  ledger.append('observation.confirmed',
    { observationId: 'OBS-BD-02', basis: '影像材料补正齐全，经复核通过' },
    { recordedAt: T_LATE_CONFIRM, appendedAt: T_LATE_CONFIRM, actor: 'ecology-dept', note: '跨期补正确认' });
  const runAfterLateConfirm = calculate(ledger, { batchId: 'B2025', ruleVersion: '2025-v2', asOf: T_LATE_CONFIRM });
  const lateDiff = diffRuns(runAfterRevoke, runAfterLateConfirm);
  const topupAdjustments = [];
  for (const chg of lateDiff.changes.filter((c) => c.delta > 0)) {
    topupAdjustments.push(registry.addAdjustment({
      runId: pubV2.runId,
      householdId: chg.householdId,
      amount: chg.delta,
      kind: 'topup',
      reason: `跨期追补：证据 OBS-BD-02 观测于 2025-12-01，材料 ${T_LATE_CONFIRM.slice(0, 10)} 补正确认；${chg.reasons.join('；')}`,
      evidenceEventIds: ['OBS-BD-02'],
      at: T_LATE_CONFIRM,
    }));
  }

  const cumulative = registry.householdCumulative('B2025');

  // 对账闭合校验：累计应得必须等于按当前台账重算的金额。
  const recomputedMap = new Map(runAfterLateConfirm.householdTotals.map((h) => [h.householdId, h.amount]));
  const reconciliation = cumulative.map((c) => ({
    householdId: c.householdId,
    householdName: c.householdName,
    cumulative: c.cumulative,
    recomputed: recomputedMap.get(c.householdId) ?? 0,
    closed: roundMoney(c.cumulative - (recomputedMap.get(c.householdId) ?? 0)) === 0,
  }));

  return {
    ledger,
    registry,
    runV1, pubV1,
    runV2, pubV2,
    switchDiff,
    runAfterRevoke, revokeDiff, revokeAdjustments,
    runAfterLateConfirm, lateDiff, topupAdjustments,
    cumulative,
    reconciliation,
  };
}

function printReport(d) {
  const line = '='.repeat(72);
  console.log(line);
  console.log('跨村水源涵养林生态补偿核算 · 公示演练对账报告');
  console.log(line);

  console.log('\n【一】第一版公示：2024-v1（统一单价 36 元/亩，按粗略面积）');
  console.log(`  批次 ${d.runV1.batchId}（${d.runV1.period}） 截止口径 asOf=${d.runV1.asOf}`);
  console.log(`  发布编号：${d.pubV1.runId}  输入指纹：${d.pubV1.inputFingerprint}`);
  for (const h of d.runV1.householdTotals) {
    console.log(`  - ${h.householdName}（${h.householdId}，${h.villageIds.join('/')}）：${money(h.amount)}`);
  }
  console.log(`  合计：${money(d.runV1.total)}`);
  console.log('  门控提示：');
  for (const w of d.runV1.warnings) console.log(`    · ${w}`);

  console.log('\n【二】换版公示：切换 2025-v2（差别单价＋三项指标加权＋长期管护津贴）');
  console.log(`  发布编号：${d.pubV2.runId}（第一版 ${d.pubV1.runId} 原样保留，未被覆盖）`);
  for (const h of d.runV2.householdTotals) {
    console.log(`  - ${h.householdName}：${money(h.amount)}`);
  }
  console.log(`  合计：${money(d.runV2.total)}（较第一版 ${d.switchDiff.totalDelta >= 0 ? '+' : ''}${money(d.switchDiff.totalDelta)}）`);
  console.log('  逐户变化说明：');
  for (const c of d.switchDiff.changes) {
    console.log(`  - ${c.householdName}：${money(c.before)} → ${money(c.after)}（${c.delta >= 0 ? '+' : ''}${money(c.delta)}）`);
    for (const r of c.reasons) console.log(`      ${r}`);
  }
  console.log('  门控提示：');
  for (const w of d.runV2.warnings) console.log(`    · ${w}`);

  console.log('\n【三】发布后监测更正（2026-03-05 撤销异常证据 OBS-WQ-01）');
  console.log('  已冻结的第二版公示金额不变，差额以追加调整入账：');
  for (const a of d.revokeAdjustments) {
    console.log(`  - 追回单 ${a.adjustmentId}：${a.householdId} ${money(a.amount)}`);
    console.log(`      原因：${a.reason}`);
  }

  console.log('\n【四】跨期追补（证据补正确认，不重开旧批次）');
  for (const a of d.topupAdjustments) {
    console.log(`  - 追补单 ${a.adjustmentId}：${a.householdId} +${money(a.amount)}`);
    console.log(`      原因：${a.reason}`);
  }

  console.log('\n【五】各户累计应得 = 当前发布（换版后）＋ 发布后追加调整');
  for (const c of d.cumulative) {
    const supersededNote = c.history.length > 1
      ? `（含被替代的旧版公示 ${c.history.slice(0, -1).map((h) => `${h.runId.split('-').slice(-1)}=${money(h.amount)}`).join('、')}，仅留痕不重复计）`
      : '';
    const adj = c.adjustmentList.length
      ? `追加调整 ${c.adjustments > 0 ? '+' : ''}${money(c.adjustments)}（${c.adjustmentList.map((a) => a.adjustmentId).join('、')}）`
      : '无追加调整';
    console.log(`  - ${c.householdName}：当前发布 ${money(c.published)} ${supersededNote}`);
    console.log(`      ${adj} → 累计 ${money(c.cumulative)}`);
  }

  console.log('\n【六】对账闭合：累计应得 vs 按当前台账重算');
  let allClosed = true;
  for (const r of d.reconciliation) {
    if (!r.closed) allClosed = false;
    console.log(`  - ${r.householdName}：累计 ${money(r.cumulative)} / 重算 ${money(r.recomputed)} ${r.closed ? '✓ 闭合' : '✗ 不闭合'}`);
  }
  console.log(line);
  console.log(allClosed ? '结论：全部农户金额闭合，规则换版、监测更正、跨期追补均可复算、可追溯。' : '结论：存在不闭合项！');
  console.log(line);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const demo = runDemo();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      runV1: { runId: demo.pubV1.runId, totals: demo.runV1.householdTotals, total: demo.runV1.total },
      runV2: { runId: demo.pubV2.runId, totals: demo.runV2.householdTotals, total: demo.runV2.total },
      switchDiff: demo.switchDiff,
      adjustments: [...demo.revokeAdjustments, ...demo.topupAdjustments],
      cumulative: demo.cumulative,
      reconciliation: demo.reconciliation,
    }, null, 2));
  } else {
    printReport(demo);
  }
}
