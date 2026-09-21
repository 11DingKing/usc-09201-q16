// 只追加（append-only）事件账本。
// 所有业务变更都以事件形式追加，当前状态由事件归约得到；事件一旦写入不可修改、不可删除。
// 监测更正、撤销、扣减回退也都是「新增事件」，旧记录保留，形成完整审计轨迹。

import { roundMu } from './money.mjs';
import { reduceBatch } from './batch.mjs';

let clockSeq = 0;

/** 可注入时钟，默认取当前 UTC 日期；同一毫秒内序号自增保证严格有序。 */
export function createEventId(at) {
  clockSeq += 1;
  return `${at.replace(/[-:]/g, '')}-${String(clockSeq).padStart(4, '0')}`;
}

export function createStore({ now = () => new Date().toISOString(), events = [] } = {}) {
  const ledger = [];
  const listeners = [];

  const state = {
    households: new Map(), // householdId -> { householdId, name, villageId }
    plots: new Map(), // plotId -> { plotId, name, villageIds, nominalAreaMu, forestType, shares:[] }
    commitments: new Map(), // commitmentId -> {...}
    stewardships: [], // [{ householdId, period, patrolsPerMonth, years, recordedAt }]
    evidence: new Map(), // evidenceId -> {...}
    citations: new Map(), // citationId -> { evidenceId, householdId, plotId, period, at }
    deductions: new Map(), // deductionId -> {...}
    batches: new Map(), // batchId -> batch（结算生命周期见 batch.mjs）
  };

  function append(type, payload, actor = '系统') {
    const at = now();
    const event = { seq: ledger.length + 1, id: createEventId(at), at, actor, type, payload };
    reduce(state, event);
    ledger.push(event);
    for (const listener of listeners) listener(event);
    return event;
  }

  // 回放历史事件（用于从 JSONL 恢复）。
  for (const event of events) {
    reduce(state, event);
    ledger.push(event);
  }

  return {
    state,
    append,
    events: () => ledger.slice(),
    onEvent: (listener) => listeners.push(listener),
    snapshot: () => structuredClone({ ledger }),
  };
}

/** 提交监测证据时的异常初筛：异常不等于作废，但必须经人工确认（必要时显式豁免）才能参与计算。 */
export function detectEvidenceAnomaly(evidence, plot) {
  const flags = [];
  const { effectiveAreaMu, canopyRate } = evidence.values ?? {};
  if (typeof effectiveAreaMu !== 'number' || Number.isNaN(effectiveAreaMu) || effectiveAreaMu < 0) {
    flags.push({ code: 'invalid_area', detail: `有效面积取值非法：${effectiveAreaMu}` });
  } else if (plot && effectiveAreaMu > plot.nominalAreaMu * 1.1 + 1e-9) {
    flags.push({
      code: 'area_exceeds_nominal',
      detail: `有效面积 ${roundMu(effectiveAreaMu)} 亩超过登记面积 ${plot.nominalAreaMu} 亩的 110%`,
    });
  } else if (plot && effectiveAreaMu < plot.nominalAreaMu * 0.5 - 1e-9) {
    flags.push({
      code: 'area_implausibly_low',
      detail: `有效面积 ${roundMu(effectiveAreaMu)} 亩不足登记面积 ${plot.nominalAreaMu} 亩的 50%，疑似设备误报`,
    });
  }
  if (canopyRate !== undefined && (canopyRate < 0 || canopyRate > 1)) {
    flags.push({ code: 'canopy_out_of_range', detail: `郁闭度越界：${canopyRate}` });
  }
  return flags;
}

function reduce(state, event) {
  const { type, payload: p } = event;
  switch (type) {
    case 'household_registered': {
      state.households.set(p.householdId, {
        householdId: p.householdId,
        name: p.name,
        villageId: p.villageId,
      });
      break;
    }
    case 'plot_registered': {
      state.plots.set(p.plotId, {
        plotId: p.plotId,
        name: p.name,
        villageIds: [...new Set(p.villageIds ?? [])],
        nominalAreaMu: p.nominalAreaMu,
        forestType: p.forestType ?? '水源涵养林',
        shares: [],
      });
      break;
    }
    case 'share_agreed': {
      const plot = state.plots.get(p.plotId);
      if (!plot) throw new Error(`地块不存在：${p.plotId}`);
      // 共有林地分摊比例以最新协议为准；旧协议保留在账本事件中。
      plot.shares = p.shares.map((s) => ({ ...s }));
      for (const villageId of p.shares.map((s) => s.villageId).filter(Boolean)) {
        if (!plot.villageIds.includes(villageId)) plot.villageIds.push(villageId);
      }
      break;
    }
    case 'commitment_signed': {
      state.commitments.set(p.commitmentId, {
        commitmentId: p.commitmentId,
        householdId: p.householdId,
        plotIds: [...p.plotIds],
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        signedAt: p.signedAt,
        status: 'active',
        items: (p.items ?? []).map((item) => ({ ...item, done: false, doneAt: null })),
      });
      break;
    }
    case 'commitment_item_done': {
      const commitment = state.commitments.get(p.commitmentId);
      const item = commitment?.items.find((candidate) => candidate.id === p.itemId);
      if (!item) throw new Error(`承诺事项不存在：${p.commitmentId}/${p.itemId}`);
      item.done = true;
      item.doneAt = p.doneAt;
      break;
    }
    case 'commitment_withdrawn': {
      const commitment = state.commitments.get(p.commitmentId);
      if (!commitment) throw new Error(`承诺不存在：${p.commitmentId}`);
      commitment.status = 'withdrawn';
      commitment.withdrawnAt = p.at;
      break;
    }
    case 'stewardship_recorded': {
      state.stewardships.push({
        householdId: p.householdId,
        period: p.period,
        patrolsPerMonth: p.patrolsPerMonth,
        years: p.years,
        recordedAt: p.recordedAt,
      });
      break;
    }
    case 'evidence_submitted': {
      const plot = state.plots.get(p.plotId);
      if (!plot) throw new Error(`地块不存在：${p.plotId}`);
      const anomalyFlags = detectEvidenceAnomaly(p, plot);
      if (p.supersedes) {
        const previous = state.evidence.get(p.supersedes);
        if (!previous) throw new Error(`被更正的证据不存在：${p.supersedes}`);
        previous.status = 'superseded';
        previous.supersededBy = p.evidenceId;
        previous.supersededAt = p.recordedAt;
      }
      state.evidence.set(p.evidenceId, {
        evidenceId: p.evidenceId,
        plotId: p.plotId,
        agencyId: p.agencyId,
        agencyName: p.agencyName,
        evidenceType: p.evidenceType,
        observedAt: p.observedAt,
        recordedAt: p.recordedAt,
        period: p.period,
        coverageStart: p.coverageStart,
        coverageEnd: p.coverageEnd,
        values: { ...p.values },
        supersedes: p.supersedes ?? null,
        status: 'submitted',
        anomalyFlags,
        confirmedAt: null,
        confirmedBy: null,
        overrideAnomaly: false,
      });
      break;
    }
    case 'evidence_confirmed': {
      const evidence = state.evidence.get(p.evidenceId);
      if (!evidence) throw new Error(`证据不存在：${p.evidenceId}`);
      if (evidence.status === 'rejected') throw new Error('已撤销的证据不能确认，须重新提交更正证据');
      if (evidence.anomalyFlags.length > 0 && !p.overrideAnomaly) {
        throw new Error(`证据存在异常标记（${evidence.anomalyFlags.map((f) => f.code).join('、')}），须显式豁免确认`);
      }
      evidence.status = 'confirmed';
      evidence.confirmedAt = p.confirmedAt;
      evidence.confirmedBy = p.confirmedBy;
      evidence.overrideAnomaly = Boolean(p.overrideAnomaly);
      evidence.confirmNote = p.note ?? null;
      break;
    }
    case 'evidence_rejected': {
      const evidence = state.evidence.get(p.evidenceId);
      if (!evidence) throw new Error(`证据不存在：${p.evidenceId}`);
      if (evidence.status === 'superseded') throw new Error('已被更正证据替代，不能撤销');
      evidence.status = 'rejected';
      evidence.rejectedAt = p.rejectedAt;
      evidence.rejectedBy = p.rejectedBy;
      evidence.rejectReason = p.reason;
      break;
    }
    case 'evidence_reinstated': {
      // 更正证据被否决后，经复核恢复此前被替代的证据（恢复为何种状态由命令决定）。
      const evidence = state.evidence.get(p.evidenceId);
      if (!evidence) throw new Error(`证据不存在：${p.evidenceId}`);
      evidence.status = p.status;
      evidence.supersededBy = null;
      evidence.supersededAt = null;
      evidence.reinstatedAt = p.reinstatedAt;
      evidence.reinstatedBy = p.reinstatedBy;
      break;
    }
    case 'citation_recorded': {
      if (!state.evidence.has(p.evidenceId)) throw new Error(`证据不存在：${p.evidenceId}`);
      state.citations.set(p.citationId, {
        citationId: p.citationId,
        evidenceId: p.evidenceId,
        householdId: p.householdId,
        plotId: p.plotId,
        period: p.period,
        at: p.at,
      });
      break;
    }
    case 'deduction_recorded': {
      state.deductions.set(p.deductionId, {
        deductionId: p.deductionId,
        plotId: p.plotId,
        householdId: p.householdId ?? null,
        category: p.category,
        eventDate: p.eventDate,
        recordedAt: p.recordedAt,
        period: p.period,
        areaAffectedMu: p.areaAffectedMu,
        severityRate: p.severityRate,
        note: p.note ?? '',
        status: 'active',
        reversedAt: null,
        reverseReason: null,
      });
      break;
    }
    case 'deduction_reversed': {
      const deduction = state.deductions.get(p.deductionId);
      if (!deduction) throw new Error(`扣减事件不存在：${p.deductionId}`);
      deduction.status = 'reversed';
      deduction.reversedAt = p.reversedAt;
      deduction.reverseReason = p.reason;
      break;
    }
    default:
      // 批次相关事件交给 batch.mjs 归约。
      reduceBatch(state, event);
  }
}
