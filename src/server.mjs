import http from 'node:http';
import { runDemo } from '../scripts/demo.mjs';

// 只读核算/公示接口：每次请求都从同一份场景台账确定性重算，
// 任何外部核查者拿到的金额与规则版本、截止时点、变化说明完全一致。
function demoSummary() {
  const d = runDemo();
  return {
    generatedAt: new Date().toISOString(),
    note: '结果由事件台账按规则版本与截止时点确定性重算，可复算、可追溯',
    publications: [
      {
        runId: d.pubV1.runId,
        ruleVersion: d.runV1.ruleVersion,
        ruleName: d.runV1.ruleName,
        asOf: d.runV1.asOf,
        total: d.runV1.total,
        householdTotals: d.runV1.householdTotals,
        status: 'superseded',
      },
      {
        runId: d.pubV2.runId,
        ruleVersion: d.runV2.ruleVersion,
        ruleName: d.runV2.ruleName,
        asOf: d.runAfterLateConfirm.asOf,
        total: d.runAfterLateConfirm.total,
        householdTotals: d.runAfterLateConfirm.householdTotals,
        status: 'current',
      },
    ],
    ruleSwitch: d.switchDiff,
    adjustments: [...d.revokeAdjustments, ...d.topupAdjustments],
    cumulative: d.cumulative.map(({ history, adjustmentList, ...rest }) => rest),
    reconciliation: d.reconciliation,
  };
}

export function createServer() {
  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/accounting/demo') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(demoSummary(), null, 2));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}`);
  });
}
