// 可复算性与规则引擎测试

import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore, calcSettlement } from '../src/domain/index.mjs';
import { buildScenario, scenarioStore, PERIOD } from '../src/domain/scenario.mjs';
import { getRule } from '../src/domain/rules.mjs';
import { yuan } from '../src/domain/money.mjs';

function settled(ruleVersion = 'v1') {
  const store = buildScenario(scenarioStore());
  return calcSettlement(store, { ruleVersion, periods: [PERIOD], plotIds: ['p-cross'] });
}

test('v1 基线版：有效面积×单价，管护投入不产生系数差异', () => {
  const result = settled('v1');
  const totals = new Map(result.householdTotals.map((r) => [r.householdId, r.totalCents]));
  // 认定面积 920 亩（两份证据就低），按 0.4/0.2/0.25/0.15 分摊，白扣减 40×0.5=20 亩
  assert.equal(yuan(totals.get('h-qin')), '18,400.00'); // 368 亩
  assert.equal(yuan(totals.get('h-bai')), '8,200.00'); // 164 亩
  assert.equal(yuan(totals.get('h-lan')), '11,500.00'); // 230 亩
  assert.equal(yuan(totals.get('h-shi')), '6,900.00'); // 138 亩
  assert.equal(yuan(result.grandTotalCents), '45,000.00');
  for (const entry of result.entries) {
    assert.deepEqual(entry.factors, { commitment: 1, stewardship: 1, evidenceQuality: 1 });
  }
});

test('v2 贡献导向版：长期管护者得到更高系数，管护薄弱者低于基线', () => {
  const result = settled('v2');
  const byHousehold = new Map();
  for (const entry of result.entries) byHousehold.set(entry.householdId, entry);

  // 秦：4/4 承诺 1.1 × 月巡 8 次/9 年管护 1.18 × 两类证据 1.07
  assert.equal(byHousehold.get('h-qin').factors.stewardship, 1.18);
  assert.ok(byHousehold.get('h-qin').amountCents > 1840000);
  // 石：仅 2/4 承诺、月巡 2 次 → 管护系数 0.94，金额低于 v1
  assert.equal(byHousehold.get('h-shi').factors.commitment, 1.0);
  assert.equal(byHousehold.get('h-shi').factors.stewardship, 0.94);
  assert.ok(byHousehold.get('h-shi').amountCents < 690000);
});

test('同一核算重复执行结果完全一致（纯函数可复算）', () => {
  const store = buildScenario(scenarioStore());
  const a = calcSettlement(store, { ruleVersion: 'v2', periods: [PERIOD], plotIds: ['p-cross'] });
  const b = calcSettlement(store, { ruleVersion: 'v2', periods: [PERIOD], plotIds: ['p-cross'] });
  assert.equal(a.inputDigest, b.inputDigest);
  assert.equal(a.grandTotalCents, b.grandTotalCents);
  assert.deepEqual(
    a.entries.map((e) => [e.householdId, e.amountCents]),
    b.entries.map((e) => [e.householdId, e.amountCents]),
  );
});

test('不同时间与机构的多份已确认证据按就低原则采信', () => {
  const result = settled('v1');
  assert.ok(result.allNotices.some((n) => n.code === 'multi_agency_evidence_min_taken'));
  for (const entry of result.entries) {
    if (entry.recognized) {
      // 920 与 932 取 920
      const expected = { 'h-qin': 368, 'h-bai': 184, 'h-lan': 230, 'h-shi': 138 };
      assert.equal(entry.grossAreaMu, expected[entry.householdId]);
    }
  }
});

test('异常证据未经显式豁免不能确认；未经确认不参与核算', async () => {
  const { confirmEvidence, submitEvidence } = await import('../src/domain/index.mjs');
  const store = buildScenario(scenarioStore());
  // ev-iot-03 为 300 亩异常偏低，提交时已带标记
  const anomaly = store.state.evidence.get('ev-iot-03');
  assert.ok(anomaly.anomalyFlags.some((f) => f.code === 'area_implausibly_low'));
  assert.throws(
    () => confirmEvidence(store, { evidenceId: 'ev-iot-03', confirmedAt: '2026-05-12', confirmedBy: '某人' }),
    /须显式豁免确认/,
  );
  // 未确认状态下核算，采信面积仍为 920
  const result = calcSettlement(store, { ruleVersion: 'v1', periods: [PERIOD], plotIds: ['p-cross'] });
  assert.equal(result.entries.find((e) => e.householdId === 'h-qin').grossAreaMu, 368);
  // 石引用了未确认异常证据，结果中出现对应提示
  assert.ok(result.allNotices.some((n) => n.code === 'citation_not_confirmed' && n.evidenceId === 'ev-iot-03'));
});

test('同一证据重复引用只计一次，并给出提示', () => {
  const result = settled('v1');
  const qin = result.entries.find((e) => e.householdId === 'h-qin');
  const unique = new Set(qin.evidenceIds);
  assert.equal(qin.evidenceIds.length, unique.size);
  assert.ok(qin.notices.some((n) => n.code === 'duplicate_citation_ignored'));
});

test('共有林地分摊比例之和不为 1 时拒绝核算', async () => {
  const D = await import('../src/domain/index.mjs');
  const store = scenarioStore();
  D.registerHousehold(store, { householdId: 'a', name: '甲', villageId: 'v' });
  D.registerPlot(store, { plotId: 'p', name: '地块', villageIds: ['v'], nominalAreaMu: 100 });
  assert.throws(
    () => D.agreeShares(store, { plotId: 'p', shares: [{ householdId: 'a', share: 0.9 }], agreedAt: '2026-01-01' }),
    /分摊比例之和必须为 1/,
  );
});

test('缺少有效承诺或证据的条目不予认定但保留留痕', async () => {
  const D = await import('../src/domain/index.mjs');
  const store = scenarioStore();
  D.registerHousehold(store, { householdId: 'x', name: '未承诺户', villageId: '溪口村' });
  D.registerPlot(store, { plotId: 'p2', name: '另一块林', villageIds: ['溪口村'], nominalAreaMu: 50 });
  D.agreeShares(store, { plotId: 'p2', shares: [{ householdId: 'x', share: 1 }], agreedAt: '2026-01-01' });
  const result = calcSettlement(store, { ruleVersion: 'v1', periods: [PERIOD], plotIds: ['p2'] });
  const entry = result.entries[0];
  assert.equal(entry.recognized, false);
  assert.equal(entry.amountCents, 0);
  assert.ok(entry.notices.some((n) => n.code === 'no_active_commitment'));
});

test('规则版本未知时报错而不是静默回退', () => {
  const store = buildScenario(scenarioStore());
  assert.throws(
    () => calcSettlement(store, { ruleVersion: 'v9', periods: [PERIOD], plotIds: ['p-cross'] }),
    /未知规则版本/,
  );
  assert.equal(getRule('v2').label, '贡献导向版');
});
