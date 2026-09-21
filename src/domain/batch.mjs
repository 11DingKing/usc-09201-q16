// 资金批次与核算引擎。
// 批次生命周期：draft（可反复试算换版）→ settled（已定稿待公示）→ published（发布后冻结）→ paid（已拨付）。
// 发布后任何更正都不能改动已发布结果，只能新增「调整批次」（追补/追回，金额可正可负）。

import crypto from 'node:crypto';
import { toCents, yuan, roundMu } from './money.mjs';
import { getRule } from './rules.mjs';

const SHARE_TOLERANCE = 0.0001;

// ---------- 批次事件归约（由 store 调用） ----------

export function reduceBatch(state, event) {
  const { type, payload: p, at } = event;
  switch (type) {
    case 'batch_created': {
      state.batches.set(p.batchId, {
        batchId: p.batchId,
        kind: p.kind ?? 'settlement',
        adjustsBatchId: p.adjustsBatchId ?? null,
        label: p.label,
        periods: [...p.periods],
        ruleVersion: p.ruleVersion,
        scopePlotIds: [...(p.scopePlotIds ?? [])],
        createdAt: at,
        createdBy: event.actor,
        note: p.note ?? '',
        status: 'draft',
        settlements: [],
        current: null,
        publishedAt: null,
        paidAt: null,
        voucherNo: null,
      });
      break;
    }
    case 'batch_settled': {
      const batch = state.batches.get(p.batchId);
      if (!batch) throw new Error(`批次不存在：${p.batchId}`);
      const snapshot = {
        settledAt: p.settledAt ?? at,
        ruleVersion: p.ruleVersion,
        reason: p.reason ?? '',
        entries: p.entries,
        householdTotals: p.householdTotals,
        grandTotalCents: p.grandTotalCents,
        inputDigest: p.inputDigest,
        changeSummary: p.changeSummary ?? [],
      };
      batch.settlements.push(snapshot);
      batch.current = snapshot;
      batch.ruleVersion = p.ruleVersion;
      batch.status = 'settled';
      break;
    }
    case 'batch_rule_switched': {
      const batch = state.batches.get(p.batchId);
      if (!batch) throw new Error(`批次不存在：${p.batchId}`);
      batch.ruleVersion = p.ruleVersion;
      break;
    }
    case 'batch_published': {
      const batch = state.batches.get(p.batchId);
      if (!batch) throw new Error(`批次不存在：${p.batchId}`);
      batch.status = 'published';
      batch.publishedAt = p.publishedAt;
      break;
    }
    case 'batch_paid': {
      const batch = state.batches.get(p.batchId);
      if (!batch) throw new Error(`批次不存在：${p.batchId}`);
      batch.status = 'paid';
      batch.paidAt = p.paidAt;
      batch.voucherNo = p.voucherNo ?? null;
      break;
    }
    default:
  }
}

/** 草稿/已定稿批次切换规则版本（发布后禁止），随后重新定稿即可看到两版差异。 */
export function switchRule(store, batchId, ruleVersion, actor = '生态部门') {
  const batch = store.state.batches.get(batchId);
  if (!batch) throw new Error(`批次不存在：${batchId}`);
  if (batch.status === 'published' || batch.status === 'paid') {
    throw new Error(`批次 ${batchId} 已发布，规则版本冻结；如需按新版核算只能建立调整批次`);
  }
  getRule(ruleVersion);
  store.append('batch_rule_switched', { batchId, ruleVersion }, actor);
}

// ---------- 命令 ----------

export function createBatch(store, { batchId, label, periods, ruleVersion, plotIds = null, note = '' }, actor) {
  if (!periods?.length) throw new Error('批次至少覆盖一个补偿期');
  getRule(ruleVersion); // 未知版本立即报错
  const scopePlotIds = plotIds ?? [...store.state.plots.keys()];
  return store.append(
    'batch_created',
    { batchId, label, periods, ruleVersion, scopePlotIds, note },
    actor,
  );
}

/**
 * 试算/定稿。仅 draft 状态的批次允许反复试算——每次试算都完整追加保存，
 * 因此「切换两版规则、撤销异常监测」的每一步结果与变化说明都留痕且可对比。
 */
export function settleBatch(store, batchId, { reason = '' } = {}, actor = '核算员') {
  const batch = store.state.batches.get(batchId);
  if (!batch) throw new Error(`批次不存在：${batchId}`);
  if (batch.status === 'published' || batch.status === 'paid') {
    throw new Error(`批次 ${batchId} 已发布，结果冻结；更正只能通过调整批次追加`);
  }
  const previous = batch.current;
  const result = calcSettlement(store, {
    ruleVersion: batch.ruleVersion,
    periods: batch.periods,
    plotIds: batch.scopePlotIds,
  });
  const changeSummary = previous ? diffSettlements(previous, result) : [];
  store.append(
    'batch_settled',
    {
      batchId,
      ruleVersion: result.ruleVersion,
      reason,
      entries: result.entries,
      householdTotals: result.householdTotals,
      grandTotalCents: result.grandTotalCents,
      inputDigest: result.inputDigest,
      changeSummary,
    },
    actor,
  );
  return { result, changeSummary };
}

export function publishBatch(store, batchId, { publishedAt } = {}, actor = '生态部门') {
  const batch = store.state.batches.get(batchId);
  if (!batch) throw new Error(`批次不存在：${batchId}`);
  if (batch.status !== 'settled') throw new Error(`批次 ${batchId} 未定稿，不能公示发布`);
  store.append('batch_published', { batchId, publishedAt: publishedAt ?? new Date().toISOString().slice(0, 10) }, actor);
  return batch.current;
}

export function markBatchPaid(store, batchId, { paidAt, voucherNo } = {}, actor = '财务') {
  const batch = store.state.batches.get(batchId);
  if (!batch) throw new Error(`批次不存在：${batchId}`);
  if (batch.status !== 'published') throw new Error(`批次 ${batchId} 未发布，不能登记拨付`);
  store.append('batch_paid', { batchId, paidAt: paidAt ?? new Date().toISOString().slice(0, 10), voucherNo }, actor);
}

/**
 * 发布后的跨期追补/追回：以调整批次追加。
 * 按原批次范围与（默认）原规则重新核算当前状态，与「链路上最近一次调整后的全量结果」
 * 逐户逐地块逐期作差，差额为正即追补，为负即追回；多次调整沿链累计，不重复计差。
 * 原批次数字永不改变。
 */
export function createAdjustmentBatch(
  store,
  { adjustmentBatchId, adjustsBatchId, ruleVersion = null, note = '' },
  actor = '生态部门',
) {
  const parent = store.state.batches.get(adjustsBatchId);
  if (!parent) throw new Error(`被调整批次不存在：${adjustsBatchId}`);
  if (parent.status !== 'published' && parent.status !== 'paid') {
    throw new Error('只能对已发布批次建立调整；发布前请直接在原批次重新定稿');
  }
  const effectiveRule = ruleVersion ?? parent.ruleVersion;
  getRule(effectiveRule);
  store.append(
    'batch_created',
    {
      batchId: adjustmentBatchId,
      kind: 'adjustment',
      adjustsBatchId,
      label: `调整：${parent.label}`,
      periods: parent.periods,
      ruleVersion: effectiveRule,
      scopePlotIds: parent.scopePlotIds,
      note,
    },
    actor,
  );
  const reResult = calcSettlement(store, {
    ruleVersion: effectiveRule,
    periods: parent.periods,
    plotIds: parent.scopePlotIds,
  });
  const baseline = effectiveFullResult(store, parent);
  const deltaEntries = buildAdjustmentEntries(baseline, reResult, note);
  const householdTotals = aggregateHouseholds(deltaEntries);
  const grandTotalCents = householdTotals.reduce((sum, row) => sum + row.totalCents, 0);
  store.append(
    'batch_settled',
    {
      batchId: adjustmentBatchId,
      ruleVersion: effectiveRule,
      reason: note,
      entries: deltaEntries,
      householdTotals,
      grandTotalCents,
      inputDigest: reResult.inputDigest,
      changeSummary: [],
    },
    actor,
  );
  return { deltaEntries, householdTotals, grandTotalCents };
}

/**
 * 沿调整链求某批次「截至当时的全量结果」：根批次的全量条目 + 链上各次调整差额逐键累加。
 * 这样第二次及以后的调整只与「最近一次调整后的全量」作差，差额不会重复计。
 */
function effectiveFullResult(store, batch) {
  const chain = [];
  let cursor = batch;
  while (cursor.kind === 'adjustment') {
    chain.unshift(cursor);
    cursor = store.state.batches.get(cursor.adjustsBatchId);
  }
  const root = cursor;
  const byKey = new Map(root.current.entries.map((e) => [fullKey(e), { ...e }]));
  for (const adj of chain) {
    for (const delta of adj.current.entries) {
      const key = fullKey(delta);
      const existing = byKey.get(key);
      if (existing) {
        existing.amountCents = delta.afterAmountCents ?? existing.amountCents + delta.amountCents;
      } else {
        byKey.set(key, { ...delta, amountCents: delta.afterAmountCents ?? delta.amountCents });
      }
    }
  }
  const entries = [...byKey.values()];
  const householdTotals = aggregateHouseholds(entries);
  return { entries, householdTotals, ruleVersion: root.current.ruleVersion, periods: root.periods };
}

function fullKey(e) {
  return `${e.householdId}|${e.plotId}|${e.period}`;
}

// ---------- 核算引擎（纯函数：相同账本状态 + 相同规则 => 相同结果） ----------

export function calcSettlement(store, { ruleVersion, periods, plotIds = null }) {
  const rule = getRule(ruleVersion);
  const { plots, households, commitments, stewardships, evidence, citations, deductions } = store.state;
  const scopePlotIds = plotIds ?? [...plots.keys()];
  const notices = [];
  const entries = [];

  for (const plotId of scopePlotIds) {
    const plot = plots.get(plotId);
    if (!plot) throw new Error(`地块不存在：${plotId}`);
    if (Math.abs(plot.shares.reduce((s, x) => s + x.share, 0) - 1) > SHARE_TOLERANCE) {
      throw new Error(`地块 ${plotId} 共有分摊比例之和不为 1，不能核算`);
    }

    for (const period of periods) {
      // 该地块该期已确认的监测证据（被替代/已撤销/仅提交未确认者一律不参与）。
      const confirmedEvidence = [...evidence.values()]
        .filter((e) => e.plotId === plotId && e.period === period && e.status === 'confirmed')
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt));

      // 不同机构/不同时间的多份证据同时成立时，按就低原则采信有效面积。
      let adoptedAreaMu = null;
      let adoptedEvidenceIds = [];
      if (confirmedEvidence.length > 0) {
        adoptedEvidenceIds = confirmedEvidence.map((e) => e.evidenceId);
        adoptedAreaMu = Math.min(...confirmedEvidence.map((e) => e.values.effectiveAreaMu));
        if (confirmedEvidence.length > 1) {
          notices.push({
            level: 'info',
            code: 'multi_agency_evidence_min_taken',
            plotId,
            period,
            message: `地块 ${plot.name} 在 ${period} 期有 ${confirmedEvidence.length} 份已确认证据（${adoptedEvidenceIds.join('、')}），按就低原则采信 ${roundMu(adoptedAreaMu)} 亩`,
          });
        }
      }

      for (const share of plot.shares) {
        const household = households.get(share.householdId);
        if (!household) throw new Error(`农户不存在：${share.householdId}`);

        const entry = {
          ruleVersion,
          householdId: share.householdId,
          householdName: household.name,
          villageId: household.villageId,
          plotId,
          plotName: plot.name,
          period,
          share,
          commitmentId: null,
          recognized: false,
          grossAreaMu: 0,
          deductionAreaMu: 0,
          effectiveAreaMu: 0,
          factors: { commitment: 1, stewardship: 1, evidenceQuality: 1 },
          rateYuanPerMu: rule.baseRateYuanPerMu,
          amountCents: 0,
          evidenceIds: [],
          adoptedEvidenceIds: [],
          notices: [],
        };

        // 1) 承诺门槛：该户须对该地块签有覆盖当期且未撤回的保护承诺。
        const commitment = [...commitments.values()]
          .filter(
            (c) =>
              c.householdId === share.householdId &&
              c.plotIds.includes(plotId) &&
              c.status === 'active' &&
              coversPeriod(c, period),
          )
          .sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0];
        if (!commitment) {
          entry.notices.push({
            level: 'warn',
            code: 'no_active_commitment',
            message: `${household.name} 对 ${plot.name} 无覆盖 ${period} 期的有效保护承诺，本期不予核算`,
          });
          entries.push(entry);
          continue;
        }
        entry.commitmentId = commitment.commitmentId;

        // 2) 证据引用门槛：证据须被该户显式引用，重复引用只计一次。
        //    引用沿「更正链」自动跟进：旧证据被新证据替代后，引用视同指向最新更正证据。
        const cited = citationsFor(citations, share.householdId, plotId, period);
        const uniqueEvidenceIds = [...new Set(cited.map((c) => c.evidenceId))];
        if (cited.length > uniqueEvidenceIds.length) {
          const dupes = cited.length - uniqueEvidenceIds.length;
          entry.notices.push({
            level: 'warn',
            code: 'duplicate_citation_ignored',
            message: `${household.name} 对同一证据重复引用 ${dupes} 次，重复引用不重复计补`,
          });
        }
        const resolveToLatest = (id) => {
          let current = evidence.get(id);
          while (current?.supersededBy) {
            const successor = evidence.get(current.supersededBy);
            if (!successor) break;
            current = successor;
          }
          return current;
        };
        const usableEvidence = [...new Map(
          uniqueEvidenceIds
            .map((id) => resolveToLatest(id))
            .filter((e) => e && e.plotId === plotId && e.period === period)
            .map((e) => [e.evidenceId, e]),
        ).values()];
        const unconfirmed = usableEvidence.filter((e) => e.status !== 'confirmed');
        for (const e of unconfirmed) {
          entry.notices.push({
            level: 'warn',
            code: 'citation_not_confirmed',
            evidenceId: e.evidenceId,
            message: `证据 ${e.evidenceId} 当前状态为「${statusLabel(e.status)}」，未经确认不参与 ${household.name} 的核算`,
          });
        }
        const confirmedCited = usableEvidence.filter((e) => e.status === 'confirmed');

        if (adoptedAreaMu === null || confirmedCited.length === 0) {
          entry.notices.push({
            level: 'warn',
            code: 'no_confirmed_evidence',
            message: `${household.name} 在 ${plot.name} 的 ${period} 期缺少已确认且引用的监测证据，有效面积不予认定`,
          });
          entries.push(entry);
          continue;
        }

        // 3) 共有林地按分摊比例认定面积；该户实际引用到的证据集合参与质量系数。
        const grossAreaMu = roundMu(adoptedAreaMu * share.share);
        entry.grossAreaMu = grossAreaMu;
        entry.evidenceIds = confirmedCited.map((e) => e.evidenceId);
        entry.adoptedEvidenceIds = [...adoptedEvidenceIds];

        // 4) 扣减事件：指明户的全摊，未指明户的按分摊比例摊；仅 active 状态生效。
        const deductionAreaMu = roundMu(
          [...deductions.values()]
            .filter((d) => d.plotId === plotId && d.period === period && d.status === 'active')
            .reduce((sum, d) => {
              if (d.householdId && d.householdId !== share.householdId) return sum;
              return sum + d.areaAffectedMu * d.severityRate * (d.householdId ? 1 : share.share);
            }, 0),
        );
        entry.deductionAreaMu = Math.min(deductionAreaMu, grossAreaMu);
        entry.effectiveAreaMu = roundMu(Math.max(0, grossAreaMu - entry.deductionAreaMu));

        // 5) 规则系数（v1 全部为 1；v2 采信承诺履行、管护强度、证据质量）。
        const stewardship = [...stewardships]
          .filter((s) => s.householdId === share.householdId && s.period === period)
          .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
        entry.factors = {
          commitment: rule.commitmentFactor(commitment),
          stewardship: rule.stewardshipFactor(stewardship ?? {}),
          evidenceQuality: rule.evidenceQualityFactor(confirmedCited),
        };
        const factorProduct = entry.factors.commitment * entry.factors.stewardship * entry.factors.evidenceQuality;
        entry.amountCents = toCents(entry.effectiveAreaMu * rule.baseRateYuanPerMu * factorProduct);
        entry.recognized = true;
        entries.push(entry);
      }
    }
  }

  const householdTotals = aggregateHouseholds(entries);
  const grandTotalCents = householdTotals.reduce((sum, row) => sum + row.totalCents, 0);
  return {
    ruleVersion,
    periods,
    entries,
    householdTotals,
    grandTotalCents,
    allNotices: notices.concat(entries.flatMap((e) => e.notices.map((n) => ({ ...n, householdId: e.householdId })))),
    inputDigest: digestInputs(store, ruleVersion, periods, scopePlotIds),
  };
}

// ---------- 差异说明 ----------

function diffSettlements(previous, next) {
  const rows = [];
  const householdIds = new Set([...previous.householdTotals.map((r) => r.householdId), ...next.householdTotals.map((r) => r.householdId)]);
  for (const householdId of householdIds) {
    const before = previous.householdTotals.find((r) => r.householdId === householdId)?.totalCents ?? 0;
    const after = next.householdTotals.find((r) => r.householdId === householdId)?.totalCents ?? 0;
    const entryReasons = explainEntryChanges(previous.entries, next.entries, householdId);
    rows.push({
      householdId,
      householdName: (next.householdTotals.find((r) => r.householdId === householdId)
        ?? previous.householdTotals.find((r) => r.householdId === householdId))?.householdName,
      beforeCents: before,
      afterCents: after,
      deltaCents: after - before,
      reasons: entryReasons,
    });
  }
  return rows;
}

function explainEntryChanges(prevEntries, nextEntries, householdId) {
  const reasons = [];
  const keyOf = (e) => `${e.plotId}@${e.period}`;
  const prevMap = new Map(prevEntries.filter((e) => e.householdId === householdId).map((e) => [keyOf(e), e]));
  const nextMap = new Map(nextEntries.filter((e) => e.householdId === householdId).map((e) => [keyOf(e), e]));
  for (const [key, next] of nextMap) {
    const prev = prevMap.get(key);
    if (!prev) continue;
    const prefix = `${next.plotName} ${next.period} 期：`;
    if (prev.ruleVersion !== next.ruleVersion) {
      reasons.push(`${prefix}规则版本 ${prev.ruleVersion} → ${next.ruleVersion}（${getRule(next.ruleVersion).label}）`);
    }
    if (roundMu(prev.grossAreaMu) !== roundMu(next.grossAreaMu)) {
      reasons.push(`${prefix}认定面积 ${roundMu(prev.grossAreaMu)} → ${roundMu(next.grossAreaMu)} 亩`);
    }
    if (roundMu(prev.deductionAreaMu) !== roundMu(next.deductionAreaMu)) {
      reasons.push(`${prefix}扣减面积 ${roundMu(prev.deductionAreaMu)} → ${roundMu(next.deductionAreaMu)} 亩`);
    }
    for (const factorName of ['commitment', 'stewardship', 'evidenceQuality']) {
      const a = prev.factors[factorName];
      const b = next.factors[factorName];
      if (a !== b) reasons.push(`${prefix}${FACTOR_LABELS[factorName]}系数 ${a} → ${b}`);
    }
    const removedEvidence = prev.evidenceIds.filter((id) => !next.evidenceIds.includes(id));
    const addedEvidence = next.evidenceIds.filter((id) => !prev.evidenceIds.includes(id));
    if (removedEvidence.length) reasons.push(`${prefix}退出引用的证据：${removedEvidence.join('、')}`);
    if (addedEvidence.length) reasons.push(`${prefix}新引用的证据：${addedEvidence.join('、')}`);
    // 地块级面积采信集合变化（即使该户未直接引用，也会通过就低面积影响其金额）。
    const removedAdopted = (prev.adoptedEvidenceIds ?? []).filter((id) => !(next.adoptedEvidenceIds ?? []).includes(id));
    const addedAdopted = (next.adoptedEvidenceIds ?? []).filter((id) => !(prev.adoptedEvidenceIds ?? []).includes(id));
    if (removedAdopted.length) reasons.push(`${prefix}退出面积采信的证据：${removedAdopted.join('、')}`);
    if (addedAdopted.length) reasons.push(`${prefix}新纳入面积采信的证据：${addedAdopted.join('、')}`);
    const newRejectNotice = next.notices.find((n) => !prev.notices.some((o) => o.code === n.code && o.evidenceId === n.evidenceId));
    if (newRejectNotice) reasons.push(`${prefix}${newRejectNotice.message}`);
  }
  return reasons;
}

const FACTOR_LABELS = { commitment: '承诺履行', stewardship: '管护强度', evidenceQuality: '证据质量' };

function buildAdjustmentEntries(originalResult, reResult, topReason) {
  const keyOf = (e) => `${e.householdId}|${e.plotId}|${e.period}`;
  const oldMap = new Map(originalResult.entries.map((e) => [keyOf(e), e]));
  const deltaEntries = [];
  for (const next of reResult.entries) {
    const prev = oldMap.get(keyOf(next));
    const before = prev?.amountCents ?? 0;
    const delta = next.amountCents - before;
    const reasons = explainEntryChanges(prev ? [prev] : [], [next], next.householdId);
    // 总原因只挂在真正产生差额的条目上；零差额条目保持原因列表为空，避免公示误导。
    if (topReason && delta !== 0) reasons.unshift(topReason);
    deltaEntries.push({
      ...next,
      amountCents: delta, // 调整条目金额即差额：正数追补，负数追回
      beforeAmountCents: before,
      afterAmountCents: next.amountCents,
      adjustmentReasons: reasons,
    });
  }
  // 原批次有、重算后消失的条目（例如承诺撤回导致整户不再认定）。
  const newKeys = new Set(reResult.entries.map(keyOf));
  for (const prev of originalResult.entries) {
    if (!newKeys.has(keyOf(prev))) {
      deltaEntries.push({
        ...prev,
        amountCents: -prev.amountCents,
        beforeAmountCents: prev.amountCents,
        afterAmountCents: 0,
        adjustmentReasons: [topReason ? `${topReason}；该条目重算后不再符合认定条件，全额追回` : '该条目重算后不再符合认定条件，全额追回'],
      });
    }
  }
  return deltaEntries;
}

// ---------- 辅助 ----------

function aggregateHouseholds(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!map.has(entry.householdId)) {
      map.set(entry.householdId, {
        householdId: entry.householdId,
        householdName: entry.householdName,
        villageId: entry.villageId,
        totalCents: 0,
      });
    }
    map.get(entry.householdId).totalCents += entry.amountCents;
  }
  return [...map.values()].sort((a, b) => a.householdId.localeCompare(b.householdId));
}

function coversPeriod(commitment, period) {
  const startYear = Number(commitment.periodStart.slice(0, 4));
  const endYear = Number(commitment.periodEnd.slice(0, 4));
  const year = Number(String(period).slice(0, 4));
  return year >= startYear && year <= endYear;
}

function citationsFor(citations, householdId, plotId, period) {
  return [...citations.values()].filter(
    (c) => c.householdId === householdId && c.plotId === plotId && c.period === period,
  );
}

function statusLabel(status) {
  return { submitted: '待确认', confirmed: '已确认', rejected: '已撤销', superseded: '已被更正替代' }[status] ?? status;
}

/** 输入指纹：把参与核算的关键事实规范化后哈希；指纹相同意味着输入完全一致。 */
function digestInputs(store, ruleVersion, periods, plotIds) {
  const { evidence, citations, deductions, commitments, stewardships, plots, households } = store.state;
  const payload = {
    ruleVersion,
    periods: [...periods].sort(),
    plots: plotIds.sort().map((id) => {
      const plot = plots.get(id);
      return { id, shares: plot.shares.map((s) => ({ householdId: s.householdId, share: s.share })) };
    }),
    households: [...households.keys()].sort(),
    commitments: [...commitments.values()].map((c) => ({
      id: c.commitmentId,
      householdId: c.householdId,
      plotIds: [...c.plotIds].sort(),
      status: c.status,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      items: c.items.map((i) => ({ id: i.id, done: i.done })),
    })),
    stewardships: [...stewardships].map((s) => ({ ...s })),
    evidence: [...evidence.values()].map((e) => ({
      id: e.evidenceId,
      plotId: e.plotId,
      period: e.period,
      status: e.status,
      observedAt: e.observedAt,
      values: e.values,
      overrideAnomaly: e.overrideAnomaly,
    })),
    citations: [...citations.values()].map((c) => ({ ...c })),
    deductions: [...deductions.values()].map((d) => ({
      id: d.deductionId,
      plotId: d.plotId,
      householdId: d.householdId,
      period: d.period,
      eventDate: d.eventDate,
      areaAffectedMu: d.areaAffectedMu,
      severityRate: d.severityRate,
      status: d.status,
    })),
  };
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export { yuan };
