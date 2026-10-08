import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const inventory = JSON.parse(await readFile(new URL('../docs/rust-route-parity.json', import.meta.url), 'utf8'));
const markdown = await readFile(new URL('../docs/RUST-ROUTE-PARITY.md', import.meta.url), 'utf8');
const rows = markdown.split(/\r?\n/).filter(line => /^\| R\d{3} \|/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
const byId = new Map(rows.map(row => [row[0], row]));
const labels = {implemented: 'YES', partial: 'PARTIAL', unavailable: 'ABSENT'};

test('Rust route machine totals and Markdown summary agree with non-static inventory', () => {
  const counts = {implemented: 0, partial: 0, unavailable: 0};
  const application = inventory.routes.filter(route => !route.static);
  for (const route of application) {
    assert.ok(Object.hasOwn(counts, route.agent), `Unknown route state for ${route.id}`);
    counts[route.agent]++;
  }
  assert.deepEqual(inventory.counting, counts);
  const summary = markdown.match(/\*\*(\d+) are substantially matched, (\d+) are partial and (\d+) are absent\*\*/);
  assert.ok(summary, 'Markdown route summary is missing');
  assert.deepEqual(summary.slice(1).map(Number), [counts.implemented, counts.partial, counts.unavailable]);
  const totals = markdown.match(/contains (\d+) application method\/path variants and (\d+) separately grouped static rows/);
  assert.ok(totals, 'Markdown application/static totals are missing');
  assert.deepEqual(totals.slice(1).map(Number), [application.length, inventory.routes.length - application.length]);
  const handled = markdown.match(/Thus (\d+) have handlers/);
  assert.ok(handled, 'Markdown handler count is missing');
  assert.equal(Number(handled[1]), counts.implemented + counts.partial);
});

test('Every Rust route has matching machine and Markdown method, path, state and status', () => {
  assert.equal(byId.size, rows.length, 'Duplicate Markdown route IDs');
  assert.equal(new Set(inventory.routes.map(route => route.id)).size, inventory.routes.length, 'Duplicate machine route IDs');
  assert.equal(rows.length, inventory.routes.length);
  for (const route of inventory.routes) {
    const row = byId.get(route.id);
    assert.ok(row, `Missing Markdown route ${route.id}`);
    assert.equal(row[1], `\`${route.method} ${route.path}\``, route.id);
    assert.equal(row[2], labels[route.agent], route.id);
    assert.equal(row[3], String(route.success_status), route.id);
  }
});

test('Weather and news machine boundaries match the documented connector scope', () => {
  for (const id of ['R119', 'R120']) {
    const route = inventory.routes.find(route => route.id === id);
    assert.equal(route.agent, 'implemented', id);
    assert.equal(route.family, 'feeds', id);
    assert.equal(route.static, false, id);
    assert.equal(route.limit, byId.get(id)[4], id);
  }
});
