// 事件台账：所有业务事实只以追加事件（append-only event log）的形式存在。
// 任何更正都不是「改掉旧值」，而是追加一条反向/撤销事件，因此每条金额都能还原到证据。
//
// 事件分类：
//   plot.registered       林地登记（含共有份额）
//   commitment.signed     农户保护承诺（承诺等级、承诺期）
//   observation.recorded  监测证据登记（进入 pending，不直接参与计算）
//   observation.confirmed 监测证据被采信（confirmedAt）
//   observation.rejected  监测证据被拒绝（异常值，记录原因）
//   observation.revoked   已采信证据被事后撤销（规则发布后更正走这条，保留痕迹）
//   deduction.recorded    扣减事件登记（pending）
//   deduction.confirmed   扣减事件确认
//   batch.opened          资金批次开设
//   batch.allocated       批次资金到账
//   rule.published        规则版本发布
//   rule.activated        规则版本在某批次激活
//   run.published         核算结果发布（冻结快照）
//   run.adjustment        发布后追加调整（追补/追回）

export const EVENT_TYPES = new Set([
  'plot.registered',
  'commitment.signed',
  'observation.recorded',
  'observation.confirmed',
  'observation.rejected',
  'observation.revoked',
  'deduction.recorded',
  'deduction.confirmed',
  'batch.opened',
  'batch.allocated',
  'rule.published',
  'rule.activated',
  'run.published',
  'run.adjustment',
]);

export class Ledger {
  constructor() {
    this.events = [];
    this._seq = 0;
  }

  // recordedAt 表示事件在业务上发生的时间（监测时间、签字时间等），
  // appendedAt 由台账统一赋值，表示「进入账本」的真实先后；
  // 监测数据来自不同机构、不同时间，复算时以 recordedAt 判定归属期，以 appendedAt 保证顺序可追溯。
  append(type, payload, { appendedAt = new Date().toISOString(), recordedAt = appendedAt, actor = 'system', note = '' } = {}) {
    if (!EVENT_TYPES.has(type)) {
      throw new Error(`未知事件类型：${type}`);
    }
    this._seq += 1;
    const event = {
      seq: this._seq,
      id: `E${String(this._seq).padStart(5, '0')}`,
      type,
      payload: structuredClone(payload),
      recordedAt,
      appendedAt,
      actor,
      note,
    };
    this.events.push(event);
    return event;
  }

  // 按事件类型与可选谓词取出不可变视图。
  select(type, predicate = null) {
    let list = this.events.filter((e) => e.type === type);
    if (predicate) list = list.filter(predicate);
    return list.map((e) => e.payload);
  }

  eventsOf(type, predicate = null) {
    let list = this.events.filter((e) => e.type === type);
    if (predicate) list = list.filter(predicate);
    return list;
  }
}

// 在某批次的「截止口径」下重放台账：只看 appendedAt 早于 asOf 的事件。
// 规则换版、监测撤销由此变成「同一份台账在不同时间点的两次确定性重放」。
export function replay(ledger, asOf = new Date().toISOString()) {
  return ledger.events.filter((e) => e.appendedAt <= asOf);
}
