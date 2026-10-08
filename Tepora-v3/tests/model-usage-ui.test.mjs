import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the actual pure summary formatter without booting UI or providers.
const source = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
const formatter = source.match(/^function usageSummary\(\).*$/m)?.[0];
assert.ok(formatter, 'usage formatter must be available');
function summary(usage) {
  return runInNewContext(`${formatter}; usageSummary()`, {
    state: { agent: { usage } },
    agentSettings: () => ({ budget: {} }),
    money: n => `$${Number(n || 0).toFixed(2)}`,
  });
}

test('usage summary keeps unknown-only native costs distinct from free', () => {
  const text = summary({ modelCalls: { today: { calls: 2, input: 0, cost: 0, unknownCostCalls: 2, unknownUsageCalls: 1 } } });
  assert.match(text, /費用不明 2件/);
  assert.match(text, /使用量不明あり/);
  assert.match(text, /今日の計測分/);
  assert.doesNotMatch(text, /\$0\.00/);
});
test('usage summary shows known subtotal alongside unknown calls', () => {
  const text = summary({ modelCalls: { today: { calls: 3, input: 100, cost: 1.25, unknownCostCalls: 1 } } });
  assert.match(text, /\$1\.25 ＋ 費用不明 1件/);
  assert.match(text, /100トークン/);
});
test('usage summary preserves compatibility totals and reported zero', () => {
  assert.equal(summary({ today: { calls: 1, input: 20, cost: 0 } }), '今日 $0.00・20トークン');
  assert.equal(summary({ today: null }), '今日はまだ使っていません');
});
test('budget help no longer claims all local models are free', () => {
  assert.doesNotMatch(source, /このPCとLANのモデルは0/);
  assert.match(source, /上限の判定対象は通常の応答/);
});
