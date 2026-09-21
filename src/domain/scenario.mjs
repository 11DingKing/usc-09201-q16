// 公示演练场景：一宗跨村水源涵养林，覆盖两个行政村、六户林农，
// 含共有林地分摊、三项监测指标、异常值先记 pending 后被拒、
// 发布后撤销一条已采信证据并跨期追补等全部关键情节。
//
// 时间线：
//   2018-03  各户签订保护承诺（含 2018 年起连续管护的老护林员）
//   2025 补偿期 2025-01-01 ~ 2025-12-31
//   2026-01  各机构监测数据陆续上报（时间/机构不同）
//   2026-02-10 按 2024-v1 规则核算并公示（第一版；此前异常值保持 pending，不参与计算）
//   2026-02-12 异常值复核后正式拒绝
//   2026-02-20 切换 2025-v2 规则重新核算并公示（第二版，逐户差异说明）
//   2026-03-05 发现一条已采信证据所用探头属召回批次，撤销该证据 → 已发布金额冻结，差额追加追回
//   2026-03-10 一条跨期监测证据补正确认 → 不重开旧批次，追加追补

import { Ledger } from './store.mjs';

export function buildScenarioLedger() {
  const ledger = new Ledger();
  // 历史补录事件：进入账本时间（appendedAt）与业务发生时间（recordedAt）保持一致，
  // 这样按 asOf 重放时，不同机构、不同时间上报的数据归属正确。
  const A = (type, payload, meta) =>
    ledger.append(type, payload, { appendedAt: meta.recordedAt, ...meta });

  // ---- 林地登记 ----------------------------------------------------------
  // P100 为跨村共有水源涵养林：物理面积 600 亩， shares 为各户份额（合计为 1）。
  A('plot.registered', {
    plotId: 'P100',
    name: '青溪源头水源涵养林（跨村共有）',
    villageId: 'V-QINGXI',
    areaMu: 600,
    forestType: 'water_source_forest',
    shares: [
      { householdId: 'H01', householdName: '周延龄', villageId: 'V-QINGXI', share: 0.30 },
      { householdId: 'H02', householdName: '林秀姑', villageId: 'V-QINGXI', share: 0.25 },
      { householdId: 'H03', householdName: '吴石根', villageId: 'V-QINGXI', share: 0.20 },
      { householdId: 'H04', householdName: '罗守山', villageId: 'V-LINGJIAO', share: 0.15 },
      { householdId: 'H05', householdName: '陈阿满', villageId: 'V-LINGJIAO', share: 0.10 },
    ],
  }, { recordedAt: '2018-01-15T09:00:00Z', actor: 'forestry-station', note: '确权登记，跨 QINGXI/LINGJIAO 两村' });

  // P200：岭脚村单户林地，120 亩。
  A('plot.registered', {
    plotId: 'P200',
    name: '岭脚西坡涵养林',
    villageId: 'V-LINGJIAO',
    areaMu: 120,
    forestType: 'water_source_forest',
    shares: [
      { householdId: 'H06', householdName: '赵东来', villageId: 'V-LINGJIAO', share: 1.0 },
    ],
  }, { recordedAt: '2018-01-16T09:00:00Z', actor: 'forestry-station' });

  // ---- 保护承诺 ----------------------------------------------------------
  // 周延龄：2018 年起全面禁伐（放弃林下高收益经营），连续管护年限最长。
  A('commitment.signed', {
    plotId: 'P100', householdId: 'H01', level: 'full_protection',
    startDate: '2018-03-01', endDate: '2028-02-28',
  }, { recordedAt: '2018-03-01T10:00:00Z', actor: 'H01', note: '承诺放弃商品林皆伐与林下高强度经营' });

  A('commitment.signed', {
    plotId: 'P100', householdId: 'H02', level: 'full_protection',
    startDate: '2019-06-01', endDate: '2027-05-31',
  }, { recordedAt: '2019-06-01T10:00:00Z', actor: 'H02' });

  // 吴石根：限制利用，连续管护 4 年余（达到 v2 的 3 年津贴档）。
  A('commitment.signed', {
    plotId: 'P100', householdId: 'H03', level: 'restricted_use',
    startDate: '2021-09-01', endDate: '2027-08-31',
  }, { recordedAt: '2021-09-01T10:00:00Z', actor: 'H03' });

  A('commitment.signed', {
    plotId: 'P100', householdId: 'H04', level: 'general_management',
    startDate: '2024-01-01', endDate: '2026-12-31',
  }, { recordedAt: '2024-01-01T10:00:00Z', actor: 'H04' });

  // 陈阿满：一般管护，承诺较晚。
  A('commitment.signed', {
    plotId: 'P100', householdId: 'H05', level: 'general_management',
    startDate: '2024-06-01', endDate: '2026-05-31',
  }, { recordedAt: '2024-06-01T10:00:00Z', actor: 'H05' });

  // 赵东来：全面保护，2020 年起（达 5 年津贴档）。
  A('commitment.signed', {
    plotId: 'P200', householdId: 'H06', level: 'full_protection',
    startDate: '2020-04-01', endDate: '2028-03-31',
  }, { recordedAt: '2020-04-01T10:00:00Z', actor: 'H06' });

  // ---- 监测证据（来自不同机构、不同时间，先进 pending） -------------------
  const O = (observationId, plotId, indicator, source, observedAt, recordedAt, value, note = '') =>
    A('observation.recorded', { observationId, plotId, indicator, source, observedAt, value, unit: indicator === 'water_quality' ? 'grade' : '%' },
      { recordedAt, actor: source, note });
  const C = (observationId, recordedAt, basis, actor = 'ecology-dept') =>
    A('observation.confirmed', { observationId, basis }, { recordedAt, actor });
  const R = (observationId, recordedAt, reason, actor = 'ecology-dept') =>
    A('observation.rejected', { observationId, reason }, { recordedAt, actor });

  // 森林覆盖率：林业站 2025-11 航片复核
  O('OBS-FC-01', 'P100', 'forest_cover', 'forestry-station', '2025-11-05', '2026-01-08T03:20:00Z', 92.4, '航片+样地复核');
  C('OBS-FC-01', '2026-01-12T02:00:00Z', '航片判读与地面样地一致');

  // 生物多样性：生态局红外相机
  O('OBS-BD-01', 'P100', 'biodiversity', 'ecology-bureau', '2025-09-18', '2026-01-15T06:40:00Z', 0.81, '兽类/鸟类 Shannon 指数折算');
  C('OBS-BD-01', '2026-01-18T02:00:00Z', '红外相机数据通过质控');

  // 水质：水文站例行监测（正常，III 类水）
  O('OBS-WQ-01', 'P100', 'water_quality', 'hydro-station', '2025-10-02', '2026-01-20T01:10:00Z', 3, '例行采样 III 类');
  C('OBS-WQ-01', '2026-01-22T02:00:00Z', '水样平行样合格');

  // 水质异常值：第三方巡检设备故障，读数异常（I 类，明显偏离历史序列）——先进 pending。
  O('OBS-WQ-99', 'P100', 'water_quality', 'third-party-inspection', '2025-12-28', '2026-02-05T08:00:00Z', 1, '读数与近 3 年序列严重偏离，疑似仪器故障');
  // 公示前复核：异常值未经确认 → 保持 pending；v1 公示后（2026-02-12）正式拒绝。
  R('OBS-WQ-99', '2026-02-12T03:00:00Z', '仪器校准证书过期且平行样无法复现，不予采信');

  // 同一证据被错误重复上报（第三方系统重传）——用于验证重复引用剔除。
  O('OBS-FC-01-DUP', 'P100', 'forest_cover', 'forestry-station', '2025-11-05', '2026-01-09T03:20:00Z', 92.4, '系统重传，与 OBS-FC-01 系同一观测');
  // 该重复件也被确认（模拟经办失误），引擎必须只保留同指标最新确认的一条、且不重复计效。
  A('observation.confirmed', { observationId: 'OBS-FC-01-DUP', basis: '重复确认（经办失误）' },
    { recordedAt: '2026-01-12T02:05:00Z', actor: 'forestry-station' });

  // P200 赵东来：森林覆盖 + 水质两项确认，缺生物多样性。
  O('OBS-FC-02', 'P200', 'forest_cover', 'forestry-station', '2025-10-20', '2026-01-10T03:20:00Z', 89.0);
  C('OBS-FC-02', '2026-01-12T02:00:00Z', '样地复核通过');
  O('OBS-WQ-02', 'P200', 'water_quality', 'hydro-station', '2025-11-11', '2026-01-21T01:10:00Z', 2);
  C('OBS-WQ-02', '2026-01-23T02:00:00Z', '平行样合格');

  // 一条监测上报后始终未确认（P200 生物多样性，材料不全）——演示 pending 门控。
  O('OBS-BD-02', 'P200', 'biodiversity', 'third-party-inspection', '2025-12-01', '2026-02-08T08:00:00Z', 0.0, '影像材料不足，待补正');

  // ---- 扣减事件 ----------------------------------------------------------
  // P100：2025-08 吴石根份额区域内违规修筑集材道（按面积定位的扰动），扣 15%。
  A('deduction.recorded', {
    deductionId: 'DED-01', plotId: 'P100', category: 'illegal_road',
    ratio: 0.15, occurredAt: '2025-08-14', scope: { householdId: 'H03' },
  }, { recordedAt: '2025-09-01T02:00:00Z', actor: 'patrol-team', note: '整改已完成，按事件扣减' });
  // 该扣减作用于具体责任人：在 payload 上标注 scope；确认后计算时仅对 H03 生效。
  A('deduction.confirmed', { deductionId: 'DED-01', basis: '现场笔录+复查整改照片' },
    { recordedAt: '2025-09-20T02:00:00Z', actor: 'ecology-dept' });

  // ---- 资金批次 ----------------------------------------------------------
  A('batch.opened', {
    batchId: 'B2025',
    name: '2025 年度水源涵养林生态补偿资金',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    villageIds: ['V-QINGXI', 'V-LINGJIAO'],
  }, { recordedAt: '2026-01-05T00:00:00Z', actor: 'finance-dept' });
  A('batch.allocated', { batchId: 'B2025', amount: 120000 },
    { recordedAt: '2026-01-06T00:00:00Z', actor: 'finance-dept' });

  // ---- 规则发布 ----------------------------------------------------------
  A('rule.published', { version: '2024-v1', name: '水源涵养林生态补偿规则（2024 试行版）' },
    { recordedAt: '2024-03-01T00:00:00Z', actor: 'ecology-dept' });
  A('rule.published', { version: '2025-v2', name: '水源涵养林生态补偿规则（2025 按效计偿版）' },
    { recordedAt: '2026-01-01T00:00:00Z', actor: 'ecology-dept', note: '差别单价+三项指标加权+长期管护津贴' });
  A('rule.activated', { batchId: 'B2025', version: '2024-v1' },
    { recordedAt: '2026-01-06T00:00:00Z', actor: 'ecology-dept' });

  return ledger;
}
