// HTTP 只读接口测试：规则列表、台账、只读试算。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';
import { buildScenario, scenarioStore, PERIOD } from '../src/domain/scenario.mjs';

async function listen(context, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  return server.address().port;
}

test('GET /health 返回可用状态', async (context) => {
  const server = createServer();
  const port = await listen(context, server);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('GET /rules 列出已发布规则版本', async (context) => {
  const server = createServer();
  const port = await listen(context, server);
  const body = await (await fetch(`http://127.0.0.1:${port}/rules`)).json();
  assert.deepEqual(body.rules.map((r) => r.version), ['v1', 'v2']);
  assert.ok(body.rules[1].formula.includes('承诺履行系数'));
});

test('GET /plots 返回共有分摊协议', async (context) => {
  const store = buildScenario(scenarioStore());
  const server = createServer({ store });
  const port = await listen(context, server);
  const body = await (await fetch(`http://127.0.0.1:${port}/plots`)).json();
  const plot = body.plots.find((p) => p.plotId === 'p-cross');
  assert.deepEqual(plot.villages, ['青石村', '溪口村']);
  assert.equal(plot.shares.reduce((s, x) => s + x.share, 0), 1);
});

test('GET /evidence 可见证据状态与异常标记', async (context) => {
  const store = buildScenario(scenarioStore());
  const server = createServer({ store });
  const port = await listen(context, server);
  const body = await (await fetch(`http://127.0.0.1:${port}/evidence?plotId=p-cross`)).json();
  const iot = body.evidence.find((e) => e.evidenceId === 'ev-iot-03');
  assert.equal(iot.status, 'submitted');
  assert.ok(iot.anomalyFlags.some((f) => f.code === 'area_implausibly_low'));
});

test('POST /settle/preview 只读试算不改变账本', async (context) => {
  const store = buildScenario(scenarioStore());
  const server = createServer({ store });
  const port = await listen(context, server);
  const response = await fetch(`http://127.0.0.1:${port}/settle/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruleVersion: 'v2', periods: [PERIOD], plotIds: ['p-cross'] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.grandTotalCents > 0);
  assert.equal(result.entries.length, 4);
  // 只读：没有产生任何批次或事件
  assert.equal(store.state.batches.size, 0);
});

test('POST /settle/preview 参数错误返回 400', async (context) => {
  const store = buildScenario(scenarioStore());
  const server = createServer({ store });
  const port = await listen(context, server);
  const response = await fetch(`http://127.0.0.1:${port}/settle/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruleVersion: 'v9', periods: [PERIOD] }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.message, /未知规则版本/);
});
