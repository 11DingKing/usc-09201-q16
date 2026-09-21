// 验收剧情夹具：一宗跨村水源涵养林（青石村 × 溪口村共有），4 户林农。
// 覆盖：保护承诺、共有分摊、不同时间与机构的监测、异常值、扣减事件、
//       规则换版（v1→v2）、撤销异常监测、发布冻结、跨期追补、重复引用、调整链。

import { createStore } from './store.mjs';
import * as D from './index.mjs';

export const PERIOD = '2026H1';

export function buildScenario(store) {
  // —— 农户（跨两村）——
  D.registerHousehold(store, { householdId: 'h-qin', name: '秦守林', villageId: '青石村' });
  D.registerHousehold(store, { householdId: 'h-bai', name: '白水根', villageId: '青石村' });
  D.registerHousehold(store, { householdId: 'h-lan', name: '兰九妹', villageId: '溪口村' });
  D.registerHousehold(store, { householdId: 'h-shi', name: '石望山', villageId: '溪口村' });

  // —— 跨村共有水源涵养林，登记面积 1000 亩 ——
  D.registerPlot(store, {
    plotId: 'p-cross',
    name: '青龙凹跨村水源涵养林',
    villageIds: ['青石村', '溪口村'],
    nominalAreaMu: 1000,
  });
  // 分摊协议：秦 0.4 / 白 0.2 / 兰 0.25 / 石 0.15
  D.agreeShares(
    store,
    {
      plotId: 'p-cross',
      shares: [
        { householdId: 'h-qin', villageId: '青石村', share: 0.4 },
        { householdId: 'h-bai', villageId: '青石村', share: 0.2 },
        { householdId: 'h-lan', villageId: '溪口村', share: 0.25 },
        { householdId: 'h-shi', villageId: '溪口村', share: 0.15 },
      ],
      agreedAt: '2026-01-10',
    },
    '青石村、溪口村村委会',
  );

  // —— 保护承诺（放弃高收益经营，逐项事项）——
  const commitmentItems = [
    { id: 'no-logging', text: '不进行商业性采伐' },
    { id: 'no-herbicide', text: '不使用除草剂' },
    { id: 'patrol', text: '承担日常巡护并上报火情病虫害' },
    { id: 'riparian', text: '维护河岸缓冲带' },
  ];
  D.signCommitment(store, {
    commitmentId: 'c-qin', householdId: 'h-qin', plotIds: ['p-cross'],
    periodStart: '2026-01-01', periodEnd: '2026-12-31', signedAt: '2026-01-05', items: commitmentItems,
  });
  D.signCommitment(store, {
    commitmentId: 'c-bai', householdId: 'h-bai', plotIds: ['p-cross'],
    periodStart: '2026-01-01', periodEnd: '2026-12-31', signedAt: '2026-01-06', items: commitmentItems,
  });
  D.signCommitment(store, {
    commitmentId: 'c-lan', householdId: 'h-lan', plotIds: ['p-cross'],
    periodStart: '2026-01-01', periodEnd: '2026-12-31', signedAt: '2026-01-07', items: commitmentItems,
  });
  D.signCommitment(store, {
    commitmentId: 'c-shi', householdId: 'h-shi', plotIds: ['p-cross'],
    periodStart: '2026-01-01', periodEnd: '2026-12-31', signedAt: '2026-01-08', items: commitmentItems,
  });

  // 承诺事项完成情况：秦全部完成（真正长期管护）；白完成 3/4；兰完成 3/4；石仅 2/4。
  for (const itemId of ['no-logging', 'no-herbicide', 'patrol', 'riparian']) {
    D.completeCommitmentItem(store, { commitmentId: 'c-qin', itemId, doneAt: '2026-03-31' });
  }
  for (const itemId of ['no-logging', 'no-herbicide', 'patrol']) {
    D.completeCommitmentItem(store, { commitmentId: 'c-bai', itemId, doneAt: '2026-03-31' });
  }
  for (const itemId of ['no-logging', 'no-herbicide', 'patrol']) {
    D.completeCommitmentItem(store, { commitmentId: 'c-lan', itemId, doneAt: '2026-03-31' });
  }
  for (const itemId of ['no-logging', 'no-herbicide']) {
    D.completeCommitmentItem(store, { commitmentId: 'c-shi', itemId, doneAt: '2026-03-31' });
  }

  // —— 管护强度（巡查频次/月，持续年限）——
  D.recordStewardship(store, { householdId: 'h-qin', period: PERIOD, patrolsPerMonth: 8, years: 9, recordedAt: '2026-04-02' }, '乡林业站');
  D.recordStewardship(store, { householdId: 'h-bai', period: PERIOD, patrolsPerMonth: 4, years: 2, recordedAt: '2026-04-02' }, '乡林业站');
  D.recordStewardship(store, { householdId: 'h-lan', period: PERIOD, patrolsPerMonth: 6, years: 5, recordedAt: '2026-04-03' }, '乡林业站');
  D.recordStewardship(store, { householdId: 'h-shi', period: PERIOD, patrolsPerMonth: 2, years: 1, recordedAt: '2026-04-03' }, '乡林业站');

  // —— 监测证据：不同时间、不同机构 ——
  // 县林业调查队现场记录：有效面积 920 亩（正常）
  D.submitEvidence(store, {
    evidenceId: 'ev-field-01', plotId: 'p-cross', agencyId: 'ag-county', agencyName: '县林业调查队',
    evidenceType: 'field_record', observedAt: '2026-03-20', recordedAt: '2026-03-25', period: PERIOD,
    values: { effectiveAreaMu: 920, canopyRate: 0.72 },
  });
  D.confirmEvidence(store, { evidenceId: 'ev-field-01', confirmedAt: '2026-03-28', confirmedBy: '生态局监测科', note: '现场核查无误' });

  // 省遥感中心 4 月数据：932 亩（正常，第二机构，就低原则不会采信它，但它是独立佐证）
  D.submitEvidence(store, {
    evidenceId: 'ev-rs-02', plotId: 'p-cross', agencyId: 'ag-province', agencyName: '省遥感监测中心',
    evidenceType: 'remote_sensing', observedAt: '2026-04-10', recordedAt: '2026-04-15', period: PERIOD,
    values: { effectiveAreaMu: 932, canopyRate: 0.74 },
  });
  D.confirmEvidence(store, { evidenceId: 'ev-rs-02', confirmedAt: '2026-04-18', confirmedBy: '生态局监测科', note: '遥感解译通过' });

  // 第三方设备 5 月回传：300 亩（异常偏低，疑似设备故障）→ 提交即带异常标记
  D.submitEvidence(store, {
    evidenceId: 'ev-iot-03', plotId: 'p-cross', agencyId: 'ag-iot', agencyName: '环云物联监测点',
    evidenceType: 'field_record', observedAt: '2026-05-08', recordedAt: '2026-05-09', period: PERIOD,
    values: { effectiveAreaMu: 300, canopyRate: 0.71 },
  });

  // 各户引用证据（同一证据可被多户引用；秦对现场证据重复引用两次——只计一次）
  D.recordCitation(store, { citationId: 'cit-1', evidenceId: 'ev-field-01', householdId: 'h-qin', plotId: 'p-cross', period: PERIOD, at: '2026-04-20' });
  D.recordCitation(store, { citationId: 'cit-2', evidenceId: 'ev-field-01', householdId: 'h-qin', plotId: 'p-cross', period: PERIOD, at: '2026-04-20' });
  D.recordCitation(store, { citationId: 'cit-3', evidenceId: 'ev-rs-02', householdId: 'h-qin', plotId: 'p-cross', period: PERIOD, at: '2026-04-21' });
  D.recordCitation(store, { citationId: 'cit-4', evidenceId: 'ev-field-01', householdId: 'h-bai', plotId: 'p-cross', period: PERIOD, at: '2026-04-20' });
  D.recordCitation(store, { citationId: 'cit-5', evidenceId: 'ev-rs-02', householdId: 'h-lan', plotId: 'p-cross', period: PERIOD, at: '2026-04-21' });
  D.recordCitation(store, { citationId: 'cit-6', evidenceId: 'ev-field-01', householdId: 'h-lan', plotId: 'p-cross', period: PERIOD, at: '2026-04-21' });
  D.recordCitation(store, { citationId: 'cit-7', evidenceId: 'ev-field-01', householdId: 'h-shi', plotId: 'p-cross', period: PERIOD, at: '2026-04-22' });
  // 石还引用了那条未确认的异常证据——不参与计算
  D.recordCitation(store, { citationId: 'cit-8', evidenceId: 'ev-iot-03', householdId: 'h-shi', plotId: 'p-cross', period: PERIOD, at: '2026-05-10' });

  // —— 扣减事件：白的管护片区 4 月发生火情，受损 40 亩，严重程度 50% ——
  D.recordDeduction(store, {
    deductionId: 'd-fire-01', plotId: 'p-cross', householdId: 'h-bai', category: '森林火情',
    eventDate: '2026-04-12', recordedAt: '2026-04-16', period: PERIOD,
    areaAffectedMu: 40, severityRate: 0.5, note: '白水根片区过火，按受损程度扣减',
  }, '乡林业执法队');

  return store;
}

/** 固定时钟的 store，保证演示与测试可复算。 */
export function scenarioStore(events = []) {
  const ticks = ['2026-06-01T09:00:00.000Z'];
  return createStore({ now: () => ticks[0], events });
}
