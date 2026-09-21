import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from './domain/store.mjs';
import { loadStore, appendEvent } from './domain/persistence.mjs';
import { createHttpApp } from './http/app.mjs';

export function createServer({ store = createStore() } = {}) {
  return http.createServer(createHttpApp(store));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  const ledgerFile = process.env.LEDGER_FILE || 'data/ledger.jsonl';
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const store = await loadStore(ledgerFile);
  // 启动后产生的新事件实时追加到账本（只追加，不覆盖）。
  store.onEvent((event) => appendEvent(ledgerFile, event));
  createServer({ store }).listen(port, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${port}（账本：${ledgerFile}，已重放 ${store.events().length} 个事件）`);
  });
}
