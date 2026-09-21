// 核算结果与差异的可读呈现，用于公示材料与验收核对。
// 每份公示都带规则版本、输入指纹与逐条变化说明，保证「各户金额与变化说明完全对应」。

import { yuan, signed } from './money.mjs';
import { getRule } from './rules.mjs';

export function formatSettlement(result, { title = '生态补偿核算结果' } = {}) {
  const lines = [];
  lines.push(`【${title}】`);
  lines.push(`规则版本：${result.ruleVersion}（${getRule(result.ruleVersion).label}）`);
  lines.push(`补偿期：${result.periods.join('、')}`);
  lines.push(`输入指纹：${result.inputDigest.slice(0, 16)}…`);
  lines.push('');
  lines.push('农户\t村组\t地块\t期\t分摊\t认定面积(亩)\t扣减(亩)\t有效面积(亩)\t系数(承诺/管护/证据)\t金额(元)');
  for (const e of result.entries) {
    lines.push(
      [
        e.householdName,
        e.villageId,
        e.plotName,
        e.period,
        e.share.share,
        e.grossAreaMu.toFixed(2),
        e.deductionAreaMu.toFixed(2),
        e.effectiveAreaMu.toFixed(2),
        `${e.factors.commitment}/${e.factors.stewardship}/${e.factors.evidenceQuality}`,
        yuan(e.amountCents),
      ].join('\t'),
    );
  }
  lines.push('');
  lines.push('各户合计：');
  for (const row of result.householdTotals) {
    lines.push(`  ${row.householdName}（${row.villageId}）：${yuan(row.totalCents)} 元`);
  }
  lines.push(`总计：${yuan(result.grandTotalCents)} 元`);
  return lines.join('\n');
}

export function formatChangeSummary(changeSummary, { title = '本次重新定稿的变化说明' } = {}) {
  const lines = [`【${title}】`];
  for (const row of changeSummary) {
    lines.push(
      `· ${row.householdName}：${yuan(row.beforeCents)} → ${yuan(row.afterCents)} 元（${signed(row.deltaCents)} 元）`,
    );
    if (row.reasons.length === 0) {
      lines.push('    金额无变化');
    } else {
      for (const reason of row.reasons) lines.push(`    - ${reason}`);
    }
  }
  return lines.join('\n');
}

export function formatAdjustment(batch, { title = '跨期追补/追回调整' } = {}) {
  const lines = [`【${title}】`];
  lines.push(`调整批次：${batch.batchId}，原批次：${batch.adjustsBatchId}，规则版本：${batch.ruleVersion}`);
  lines.push('');
  for (const e of batch.current.entries.filter((x) => x.amountCents !== 0)) {
    lines.push(
      `· ${e.householdName} ${e.plotName} ${e.period} 期：${signed(e.amountCents)} 元（原 ${yuan(e.beforeAmountCents)} → 新 ${yuan(e.afterAmountCents)}）`,
    );
    for (const reason of e.adjustmentReasons) lines.push(`    - ${reason}`);
  }
  const zero = batch.current.entries.filter((x) => x.amountCents === 0);
  if (zero.length) lines.push(`· 另有 ${zero.length} 条无差额条目，列出原因但不产生资金：`);
  for (const e of zero) {
    lines.push(`    - ${e.householdName} ${e.plotName}：${e.adjustmentReasons.join('；') || '无变化'}`);
  }
  lines.push('');
  lines.push('各户调整净额：');
  for (const row of batch.current.householdTotals) {
    lines.push(`  ${row.householdName}：${signed(row.totalCents)} 元`);
  }
  lines.push(`调整净额合计：${signed(batch.current.grandTotalCents)} 元`);
  return lines.join('\n');
}

export function formatNotices(result) {
  const lines = ['【核算提示与异议线索】'];
  if (result.allNotices.length === 0) {
    lines.push('无提示。');
    return lines.join('\n');
  }
  for (const notice of result.allNotices) {
    lines.push(`[${notice.level === 'warn' ? '注意' : '信息'}] ${notice.message}`);
  }
  return lines.join('\n');
}
