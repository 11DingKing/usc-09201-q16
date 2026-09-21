// 只读 HTTP 接口：健康检查、规则版本、台账查询、核算试算。
// 试算接口不写账本（calcSettlement 为纯函数），便于公示前比对不同规则版本。

import { calcSettlement, rules } from '../domain/index.mjs';

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('请求体过大'));
    });
    request.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    request.on('error', reject);
  });
}

export function createHttpApp(store) {
  return async function app(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const { pathname, searchParams } = url;

    if (request.method === 'GET' && pathname === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }

    if (request.method === 'GET' && pathname === '/rules') {
      return sendJson(response, 200, { rules: rules.listRules() });
    }

    if (request.method === 'GET' && pathname === '/plots') {
      return sendJson(response, 200, {
        plots: [...store.state.plots.values()].map((plot) => ({
          plotId: plot.plotId,
          name: plot.name,
          villages: plot.villageIds,
          nominalAreaMu: plot.nominalAreaMu,
          shares: plot.shares,
        })),
      });
    }

    if (request.method === 'GET' && pathname === '/evidence') {
      const plotId = searchParams.get('plotId');
      const list = [...store.state.evidence.values()]
        .filter((e) => !plotId || e.plotId === plotId)
        .map((e) => ({
          evidenceId: e.evidenceId,
          plotId: e.plotId,
          agencyName: e.agencyName,
          evidenceType: e.evidenceType,
          observedAt: e.observedAt,
          period: e.period,
          values: e.values,
          status: e.status,
          supersedes: e.supersedes,
          anomalyFlags: e.anomalyFlags,
          overrideAnomaly: e.overrideAnomaly,
        }));
      return sendJson(response, 200, { evidence: list });
    }

    if (request.method === 'GET' && pathname === '/batches') {
      return sendJson(response, 200, {
        batches: [...store.state.batches.values()].map((b) => ({
          batchId: b.batchId,
          label: b.label,
          kind: b.kind,
          adjustsBatchId: b.adjustsBatchId,
          periods: b.periods,
          ruleVersion: b.ruleVersion,
          status: b.status,
          settlementRounds: b.settlements.length,
          publishedAt: b.publishedAt,
        })),
      });
    }

    const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
    if (request.method === 'GET' && batchMatch) {
      const batch = store.state.batches.get(batchMatch[1]);
      if (!batch) return sendJson(response, 404, { error: 'batch_not_found' });
      return sendJson(response, 200, {
        batchId: batch.batchId,
        label: batch.label,
        kind: batch.kind,
        adjustsBatchId: batch.adjustsBatchId,
        periods: batch.periods,
        ruleVersion: batch.ruleVersion,
        status: batch.status,
        publishedAt: batch.publishedAt,
        paidAt: batch.paidAt,
        rounds: batch.settlements.map((s, index) => ({
          round: index + 1,
          settledAt: s.settledAt,
          ruleVersion: s.ruleVersion,
          reason: s.reason,
          grandTotalCents: s.grandTotalCents,
          inputDigest: s.inputDigest,
          changeSummary: s.changeSummary,
        })),
        current: batch.current && {
          ruleVersion: batch.current.ruleVersion,
          householdTotals: batch.current.householdTotals,
          grandTotalCents: batch.current.grandTotalCents,
          entries: batch.current.entries,
          inputDigest: batch.current.inputDigest,
        },
      });
    }

    // 只读试算：POST /settle/preview  body: { ruleVersion, periods, plotIds? }
    if (request.method === 'POST' && pathname === '/settle/preview') {
      try {
        const body = await readBody(request);
        if (!body.ruleVersion || !Array.isArray(body.periods) || body.periods.length === 0) {
          return sendJson(response, 400, { error: 'ruleVersion 与 periods 必填' });
        }
        const result = calcSettlement(store, {
          ruleVersion: body.ruleVersion,
          periods: body.periods,
          plotIds: body.plotIds ?? null,
        });
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 400, { error: 'settle_failed', message: error.message });
      }
    }

    return sendJson(response, 404, { error: 'not_found' });
  };
}
