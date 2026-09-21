// 核算规则与计算引擎。
// 同一份事件台账 + 同一个 asOf 截止点 + 同一版规则 => 必然得到同一份结果（可复算）。
// 规则以纯数据 + 纯函数表达，两版规则的每一处差异都能逐户归因。

import { roundMoney, sumMoney, compareDate } from './util.mjs';

// ---- 规则版本 -------------------------------------------------------------
// v1：2024 版「按粗略面积」补偿——统一单价、只要求一条任意监测证据。
// v2：2025 版「按效计偿」——按承诺等级差别单价、三项指标加权、长期管护津贴、扣减上限放宽。
export const RULE_VERSIONS = {
  '2024-v1': {
    version: '2024-v1',
    publishedName: '水源涵养林生态补偿规则（2024 试行版）',
    flatRate: 36, // 元/亩，不区分承诺等级
    requiredIndicators: [], // 任意一条证据即可
    evidenceWeights: null, // 不做指标加权
    eligibilityMinEvidence: 1,
    deductionCap: 0.5,
    stewardshipBonus: null,
  },
  '2025-v2': {
    version: '2025-v2',
    publishedName: '水源涵养林生态补偿规则（2025 按效计偿版）',
    ratesByLevel: {
      full_protection: 48, // 全面保护（禁伐/放弃经营性利用）
      restricted_use: 38, // 限制利用
      general_management: 30, // 一般管护
    },
    indicators: ['forest_cover', 'water_quality', 'biodiversity'],
    // 每多一项经确认的指标，证据权重上浮；至少 1 项才具备受偿资格。
    evidenceWeights: { 1: 0.7, 2: 0.85, 3: 1.0 },
    eligibilityMinEvidence: 1,
    deductionCap: 0.6,
    // 长期连续管护津贴：承诺持续年限达标者，按有效面积额外计发（元/亩）。
    stewardshipBonus: [{ years: 5, bonus: 8 }, { years: 3, bonus: 5 }],
  },
};

// ---- 台账重放为当前状态 -----------------------------------------------------
export function buildState(events) {
  const plots = new Map();
  const commitments = new Map(); // key: plotId|householdId
  const observations = new Map(); // observationId -> 汇总状态
  const deductions = [];
  const batches = new Map();
  const activeRules = new Map(); // batchId -> version
  const ruleOrder = [];

  for (const e of events) {
    switch (e.type) {
      case 'plot.registered': {
        plots.set(e.payload.plotId, { ...e.payload });
        break;
      }
      case 'commitment.signed': {
        commitments.set(`${e.payload.plotId}|${e.payload.householdId}`, { ...e.payload });
        break;
      }
      case 'observation.recorded': {
        observations.set(e.payload.observationId, {
          ...e.payload,
          status: 'pending',
          statusHistory: [{ status: 'pending', at: e.appendedAt, by: e.actor }],
        });
        break;
      }
      case 'observation.confirmed': {
        const o = observations.get(e.payload.observationId);
        if (o) {
          o.status = 'confirmed';
          o.confirmedAt = e.payload.confirmedAt || e.appendedAt;
          o.confirmationBasis = e.payload.basis || '';
          o.statusHistory.push({ status: 'confirmed', at: e.appendedAt, by: e.actor });
        }
        break;
      }
      case 'observation.rejected': {
        const o = observations.get(e.payload.observationId);
        if (o) {
          o.status = 'rejected';
          o.rejectReason = e.payload.reason;
          o.statusHistory.push({ status: 'rejected', at: e.appendedAt, by: e.actor });
        }
        break;
      }
      case 'observation.revoked': {
        const o = observations.get(e.payload.observationId);
        if (o) {
          o.status = 'revoked';
          o.revokeReason = e.payload.reason;
          o.revokedAt = e.appendedAt;
          o.statusHistory.push({ status: 'revoked', at: e.appendedAt, by: e.actor });
        }
        break;
      }
      case 'deduction.recorded': {
        deductions.push({ ...e.payload, status: 'pending' });
        break;
      }
      case 'deduction.confirmed': {
        const d = deductions.find((x) => x.deductionId === e.payload.deductionId);
        if (d) {
          d.status = 'confirmed';
          d.confirmedAt = e.appendedAt;
        }
        break;
      }
      case 'batch.opened': {
        batches.set(e.payload.batchId, { ...e.payload, allocated: 0 });
        break;
      }
      case 'batch.allocated': {
        const b = batches.get(e.payload.batchId);
        if (b) b.allocated = sumMoney([b.allocated, e.payload.amount]);
        break;
      }
      case 'rule.published': {
        ruleOrder.push(e.payload.version);
        break;
      }
      case 'rule.activated': {
        activeRules.set(e.payload.batchId, e.payload.version);
        break;
      }
      default:
        break;
    }
  }

  return { plots, commitments, observations, deductions, batches, activeRules, ruleOrder };
}

// 承诺在补偿期内是否持续有效。
function commitmentActive(commitment, periodStart, periodEnd) {
  return (
    compareDate(commitment.startDate, periodEnd) <= 0 &&
    (!commitment.endDate || compareDate(commitment.endDate, periodStart) >= 0)
  );
}

function commitmentYearsAt(commitment, asOfDate) {
  const end = asOfDate.slice(0, 10);
  let years = 0;
  if (compareDate(commitment.startDate, end) <= 0) {
    const start = new Date(commitment.startDate);
    const at = new Date(end);
    years = Math.max(0, (at - start) / (365.25 * 24 * 3600 * 1000));
  }
  return years;
}

// ---- 证据门控与查重 ---------------------------------------------------------
// 规则：
//  1) 只有 status=confirmed 且观测时间落在补偿期内的证据才能计入；
//  2) 同一证据重复引用：同机构、同指标、同观测日期的多条记录视为同一份证据
//     （跨系统重传的典型形态），只保留最早登记的一条，其余剔除并逐条告警；
//  3) 同一宗地、同一指标、同一期内多份「不同」确认证据，只采信确认时间最晚的一份，其余列告警；
//  4) pending / rejected / revoked 的证据不参与计算，但全部在审计清单中留痕。
function evaluateEvidence(state, plotId, rule, periodStart, periodEnd, warnings) {
  const records = [...state.observations.values()].filter((o) => o.plotId === plotId);
  const excluded = [];

  // (2) 同一证据去重：按 机构|指标|观测日期 归并，保留最早登记（statusHistory 首条时间）。
  const sameEvidenceKey = (o) => `${o.source}|${o.indicator}|${String(o.observedAt).slice(0, 10)}`;
  const canonicalMap = new Map();
  for (const o of records) {
    const key = sameEvidenceKey(o);
    const existing = canonicalMap.get(key);
    if (!existing) {
      canonicalMap.set(key, o);
    } else {
      const firstAt = existing.statusHistory[0]?.at || '';
      const thisAt = o.statusHistory[0]?.at || '';
      if (String(thisAt) < String(firstAt)) {
        excluded.push({ observationId: existing.observationId, reason: 'duplicate_reference' });
        warnings.push(
          `证据 ${existing.observationId} 与更早登记的 ${o.observationId} 系同一证据（${o.source} ${o.indicator} ${String(o.observedAt).slice(0, 10)}），重复引用已剔除`
        );
        canonicalMap.set(key, o);
      } else {
        excluded.push({ observationId: o.observationId, reason: 'duplicate_reference' });
        warnings.push(
          `证据 ${o.observationId} 与已登记的 ${existing.observationId} 系同一证据（${o.source} ${o.indicator} ${String(o.observedAt).slice(0, 10)}），重复引用已剔除`
        );
      }
    }
  }

  // (1)(4) 状态与期间门控。
  const confirmed = [];
  for (const o of canonicalMap.values()) {
    const observedDay = String(o.observedAt).slice(0, 10);
    const inPeriod = compareDate(observedDay, periodStart) >= 0 && compareDate(observedDay, periodEnd) <= 0;

    if (o.status !== 'confirmed') {
      excluded.push({ observationId: o.observationId, reason: `status_${o.status}` });
      if (o.status === 'pending') {
        warnings.push(`宗地 ${plotId} 的证据 ${o.observationId}（${o.indicator}）尚未确认，按门控规则不计入`);
      }
      continue;
    }
    if (!inPeriod) {
      excluded.push({ observationId: o.observationId, reason: 'out_of_period' });
      continue;
    }
    confirmed.push(o);
  }

  // (3) 同宗地同指标：不同证据多份确认时保留确认时间最晚者。
  const byIndicator = new Map();
  for (const o of confirmed) {
    const list = byIndicator.get(o.indicator) || [];
    list.push(o);
    byIndicator.set(o.indicator, list);
  }
  const accepted = [];
  for (const [indicator, list] of byIndicator) {
    list.sort((a, b) => String(b.confirmedAt).localeCompare(String(a.confirmedAt)));
    accepted.push(list[0]);
    for (const dup of list.slice(1)) {
      warnings.push(
        `宗地 ${plotId} 的指标 ${indicator} 存在多份确认证据，仅采信最新确认的 ${list[0].observationId}，${dup.observationId} 不重复计效`
      );
      excluded.push({ observationId: dup.observationId, reason: 'superseded_within_indicator' });
    }
  }

  if (accepted.length < rule.eligibilityMinEvidence) {
    return { eligible: false, weight: 0, accepted, excluded, indicatorsConfirmed: [] };
  }

  let weight = 1;
  if (rule.evidenceWeights) {
    weight = rule.evidenceWeights[Math.min(accepted.length, 3)] ?? 0.7;
  }
  return { eligible: true, weight, accepted, excluded, indicatorsConfirmed: accepted.map((o) => o.indicator) };
}

// ---- 主计算 -----------------------------------------------------------------
export function calculate(ledger, { batchId, ruleVersion, asOf, fundsScaleDown = false }) {
  const state = buildState(ledger.events.filter((e) => e.appendedAt <= asOf));
  const rule = RULE_VERSIONS[ruleVersion];
  if (!rule) throw new Error(`未知规则版本：${ruleVersion}`);
  const batch = state.batches.get(batchId);
  if (!batch) throw new Error(`未知资金批次：${batchId}`);

  const warnings = [];
  const lines = [];
  const periodStart = batch.periodStart;
  const periodEnd = batch.periodEnd;
  const asOfDate = asOf.slice(0, 10);

  for (const plot of state.plots.values()) {
    if (batch.villageIds && batch.villageIds.length) {
      const touchedVillages = new Set([plot.villageId, ...(plot.shares || []).map((s) => s.villageId).filter(Boolean)]);
      if ([...touchedVillages].every((v) => !batch.villageIds.includes(v))) continue;
    }

    // 监测证据是宗地级事实：每宗地只做一次门控/查重，各份额共享评估结果，避免重复告警。
    const evidence = evaluateEvidence(state, plot.plotId, rule, periodStart, periodEnd, warnings);

    const shares = plot.shares || [];
    for (const share of shares) {
      const commitment = state.commitments.get(`${plot.plotId}|${share.householdId}`);
      if (!commitment) {
        warnings.push(`宗地 ${plot.plotId} 农户 ${share.householdId} 未签保护承诺，不计发补偿`);
        continue;
      }
      if (!commitmentActive(commitment, periodStart, periodEnd)) {
        warnings.push(`农户 ${share.householdId} 对宗地 ${plot.plotId} 的承诺不在 ${periodStart}~${periodEnd} 有效期内`);
        continue;
      }

      if (!evidence.eligible) {
        lines.push({
          householdId: share.householdId,
          householdName: share.householdName,
          villageId: share.villageId || plot.villageId,
          plotId: plot.plotId,
          areaMu: plot.areaMu,
          share: share.share,
          effectiveAreaMu: 0,
          evidenceWeight: 0,
          indicatorsConfirmed: [],
          rate: 0,
          gross: 0,
          stewardshipBonus: 0,
          deductionRatio: 0,
          appliedDeductions: [],
          net: 0,
          excluded: evidence.excluded,
          status: 'ineligible_no_evidence',
          changeNotes: ['补偿期内无经确认的监测证据，本期不计发'],
        });
        continue;
      }

      // 有效面积 = 登记面积 × 共有份额 × 证据权重
      const effectiveAreaMu = roundMoney(plot.areaMu * share.share * evidence.weight, 4);

      // 单价
      let rate;
      if (rule.flatRate) {
        rate = rule.flatRate;
      } else {
        rate = rule.ratesByLevel[commitment.level];
        if (rate == null) throw new Error(`未知承诺等级：${commitment.level}`);
      }

      let gross = roundMoney(effectiveAreaMu * rate);

      // 长期管护津贴（仅 v2）
      let stewardshipBonus = 0;
      if (rule.stewardshipBonus) {
        const years = commitmentYearsAt(commitment, asOfDate);
        const tier = rule.stewardshipBonus.find((t) => years >= t.years);
        if (tier) stewardshipBonus = roundMoney(effectiveAreaMu * tier.bonus);
      }

      // 扣减：只对责任份额生效（scope.householdId 定位具体责任人；无 scope 视为全宗地共担）。
      // 比率扣减按规则版上限封顶，固定金额扣减按份额分摊。
      const plotDeductions = state.deductions.filter(
        (d) => d.plotId === plot.plotId && d.status === 'confirmed' &&
          (!d.scope || !d.scope.householdId || d.scope.householdId === share.householdId) &&
          compareDate(d.occurredAt, periodStart) >= 0 && compareDate(d.occurredAt, periodEnd) <= 0
      );
      let ratioSum = 0;
      const appliedDeductions = [];
      let fixedAmountShare = 0;
      for (const d of plotDeductions) {
        if (d.ratio) {
          ratioSum += d.ratio;
          appliedDeductions.push({ deductionId: d.deductionId, category: d.category, ratio: d.ratio });
        } else if (d.amount) {
          const part = roundMoney(d.amount * share.share);
          fixedAmountShare = sumMoney([fixedAmountShare, part]);
          appliedDeductions.push({ deductionId: d.deductionId, category: d.category, amountShare: part });
        }
      }
      const cappedRatio = Math.min(ratioSum, rule.deductionCap);
      if (ratioSum > rule.deductionCap) {
        warnings.push(
          `宗地 ${plot.plotId} 扣减比率合计 ${(ratioSum * 100).toFixed(0)}% 超过 ${rule.version} 上限 ${rule.deductionCap * 100}%，按上限封顶`
        );
      }

      const net = roundMoney(gross + stewardshipBonus - gross * cappedRatio - fixedAmountShare);

      lines.push({
        householdId: share.householdId,
        householdName: share.householdName,
        villageId: share.villageId || plot.villageId,
        plotId: plot.plotId,
        areaMu: plot.areaMu,
        share: share.share,
        effectiveAreaMu,
        evidenceWeight: evidence.weight,
        indicatorsConfirmed: evidence.indicatorsConfirmed,
        missingIndicators: rule.indicators
          ? rule.indicators.filter((i) => !evidence.indicatorsConfirmed.includes(i))
          : [],
        rate,
        commitmentLevel: commitment.level,
        gross,
        stewardshipBonus,
        deductionRatio: cappedRatio,
        appliedDeductions,
        fixedAmountShare,
        net,
        acceptedEvidence: evidence.accepted.map((o) => ({
          observationId: o.observationId,
          indicator: o.indicator,
          source: o.source,
          confirmedAt: o.confirmedAt,
        })),
        excluded: evidence.excluded,
        status: 'payable',
      });
    }
  }

  // 按户汇总（跨村、跨宗地）。
  const householdMap = new Map();
  for (const line of lines) {
    const cur = householdMap.get(line.householdId) || {
      householdId: line.householdId,
      householdName: line.householdName,
      villageIds: new Set(),
      amount: 0,
      plotLines: [],
    };
    cur.amount = sumMoney([cur.amount, line.net]);
    cur.villageIds.add(line.villageId);
    cur.plotLines.push(line);
    householdMap.set(line.householdId, cur);
  }
  const householdTotals = [...householdMap.values()].map((h) => ({
    householdId: h.householdId,
    householdName: h.householdName,
    villageIds: [...h.villageIds],
    amount: h.amount,
  }));

  let total = roundMoney(householdTotals.reduce((a, h) => a + h.amount, 0));

  // 批次资金不足时按户同比例缩放（演示中批次资金充足，缩放系数为 1）。
  let fundFactor = 1;
  if (batch.allocated > 0 && total > batch.allocated) {
    fundFactor = roundMoney(batch.allocated / total, 4);
    if (!fundsScaleDown) {
      warnings.push(`批次 ${batchId} 申报金额 ${total} 元超出到账资金 ${batch.allocated} 元，需追加资金或启用缩放`);
    } else {
      total = 0;
      for (const h of householdTotals) h.amount = roundMoney(h.amount * fundFactor);
      for (const line of lines) line.net = roundMoney(line.net * fundFactor);
      total = roundMoney(householdTotals.reduce((a, h) => a + h.amount, 0));
      warnings.push(`批次资金不足，已按系数 ${fundFactor} 同比例缩放`);
    }
  }

  return {
    batchId,
    batchName: batch.name,
    period: `${periodStart}~${periodEnd}`,
    ruleVersion,
    ruleName: rule.publishedName,
    asOf,
    lines,
    householdTotals,
    total,
    fundFactor,
    warnings,
  };
}

// ---- 两版结果逐户差异 -------------------------------------------------------
export function diffRuns(runA, runB) {
  const mapA = new Map(runA.householdTotals.map((h) => [h.householdId, h]));
  const mapB = new Map(runB.householdTotals.map((h) => [h.householdId, h]));
  const ids = new Set([...mapA.keys(), ...mapB.keys()]);
  const changes = [];

  for (const id of [...ids].sort()) {
    const a = mapA.get(id);
    const b = mapB.get(id);
    const before = a ? a.amount : 0;
    const after = b ? b.amount : 0;
    const delta = roundMoney(after - before);
    if (delta === 0 && a && b) continue;

    const reasons = [];
    const lineA = new Map((a ? runA.lines : []).filter((l) => l.householdId === id).map((l) => [l.plotId, l]));
    const lineB = new Map((b ? runB.lines : []).filter((l) => l.householdId === id).map((l) => [l.plotId, l]));
    for (const plotId of new Set([...lineA.keys(), ...lineB.keys()])) {
      const x = lineA.get(plotId);
      const y = lineB.get(plotId);
      if (!x && y) { reasons.push(`宗地 ${plotId}：新增计发 ${y.net} 元`); continue; }
      if (x && !y) { reasons.push(`宗地 ${plotId}：不再计发（原 ${x.net} 元）`); continue; }
      if (x.rate !== y.rate) reasons.push(`宗地 ${plotId}：单价 ${x.rate}→${y.rate} 元/亩`);
      if (x.evidenceWeight !== y.evidenceWeight) {
        reasons.push(
          `宗地 ${plotId}：证据权重 ${x.evidenceWeight}→${y.evidenceWeight}（确认指标 ${x.indicatorsConfirmed.length}→${y.indicatorsConfirmed.length} 项）`
        );
      }
      if (x.stewardshipBonus !== y.stewardshipBonus) {
        reasons.push(`宗地 ${plotId}：长期管护津贴 ${x.stewardshipBonus}→${y.stewardshipBonus} 元`);
      }
      if (x.deductionRatio !== y.deductionRatio) {
        reasons.push(`宗地 ${plotId}：扣减比率 ${(x.deductionRatio * 100).toFixed(0)}%→${(y.deductionRatio * 100).toFixed(0)}%`);
      }
      if (x.status !== y.status) reasons.push(`宗地 ${plotId}：资格状态 ${x.status}→${y.status}`);
      if (
        x.rate === y.rate && x.evidenceWeight === y.evidenceWeight &&
        x.stewardshipBonus === y.stewardshipBonus && x.deductionRatio === y.deductionRatio &&
        x.status === y.status && delta !== 0
      ) {
        reasons.push(`宗地 ${plotId}：金额随计算口径变化 ${x.net}→${y.net} 元`);
      }
    }

    changes.push({
      householdId: id,
      householdName: (b || a).householdName,
      before,
      after,
      delta,
      reasons,
    });
  }

  return {
    fromRule: runA.ruleVersion,
    toRule: runB.ruleVersion,
    totalBefore: runA.total,
    totalAfter: runB.total,
    totalDelta: roundMoney(runB.total - runA.total),
    changes,
  };
}
