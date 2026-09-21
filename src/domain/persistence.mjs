// 事件账本的 JSONL 持久化与重放。
// 账本文件只追加；恢复时逐行读入并归约，结果与写入时严格一致。

import fs from 'node:fs';
import readline from 'node:readline';
import { createStore } from './store.mjs';

export function appendEvent(filePath, event) {
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'encoding=utf8');
}

/** 从 JSONL 重放重建 store。重放只做归约，不触发副作用。 */
export async function loadStore(filePath, { now } = {}) {
  const events = [];
  if (fs.existsSync(filePath)) {
    const reader = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      const trimmed = line.trim();
      if (trimmed) events.push(JSON.parse(trimmed));
    }
  }
  return createStore({ now, events });
}

/** 把整个账本导出为 JSONL（首次建账或归档用）。 */
export function exportLedger(filePath, store) {
  fs.writeFileSync(filePath, store.events().map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}
