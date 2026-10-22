'use strict';
// End-to-end-Tests auf localhost: alle Knoten laufen im selben Prozess auf
// verschiedenen Ports.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SensorNode, SeqCounter } = require('../src/sensor');
const { Leitstelle } = require('../src/leitstelle');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hop = (port) => ({ host: '127.0.0.1', port });

async function waitFor(cond, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error('Bedingung nicht erreicht');
}

// Baut A -> B -> C -> Leitstelle auf, optional mit Zusatzkante A -> C.
async function buildChain({ shortcut = false, ttlMs = 60000, intervalMs = 100 } = {}) {
  const ls = new Leitstelle({ port: 0, host: '127.0.0.1', webPort: null, quiet: true });
  await ls.start();
  const common = { host: '127.0.0.1', port: 0, intervalMs, ttlMs, retryMs: 100, stateDir: null, quiet: true };
  const c = new SensorNode({ ...common, id: 'C', nextHops: [hop(ls.port)] });
  await c.start();
  const b = new SensorNode({ ...common, id: 'B', nextHops: [hop(c.port)] });
  await b.start();
  const aHops = shortcut ? [hop(b.port), hop(c.port)] : [hop(b.port)];
  const a = new SensorNode({ ...common, id: 'A', nextHops: aHops });
  await a.start();
  const nodes = [a, b, c];
  return {
    ls, a, b, c,
    stopMeasuring: () => nodes.forEach((n) => clearInterval(n.timer)),
    stop: () => { nodes.forEach((n) => n.stop()); ls.stop(); },
  };
}

const rat = (ls, id) => ls.rats.get(id);
const allDelivered = (net) =>
  [net.a, net.b, net.c].every((n) => rat(net.ls, n.id) && rat(net.ls, n.id).count === n.counter.value);

test('Demo 1: Kette A -> B -> C -> Leitstelle liefert alle Nachrichten', async () => {
  const net = await buildChain();
  try {
    await sleep(800);
    net.stopMeasuring();
    await waitFor(() => allDelivered(net));
    for (const id of ['A', 'B', 'C']) {
      const r = rat(net.ls, id);
      assert.strictEqual(r.duplicates, 0);
      assert.strictEqual(r.maxSeq - r.minSeq + 1, r.count, 'keine Luecken');
    }
    assert.deepStrictEqual(rat(net.ls, 'A').last.path, ['A', 'B', 'C']);
  } finally {
    net.stop();
  }
});

test('Demo 2: zwei Wege, trotzdem jede Nachricht nur einmal registriert', async () => {
  const net = await buildChain({ shortcut: true });
  try {
    await sleep(800);
    net.stopMeasuring();
    await waitFor(() => allDelivered(net) && rat(net.ls, 'A').duplicates === net.a.counter.value);
    const a = rat(net.ls, 'A');
    assert.strictEqual(a.count, net.a.counter.value, 'jede Nachricht von A genau einmal registriert');
    assert.strictEqual(a.duplicates, net.a.counter.value, 'zweiter Weg erzeugt je ein Duplikat');
    assert.strictEqual(net.ls.totals.registered, net.a.counter.value + net.b.counter.value + net.c.counter.value);
  } finally {
    net.stop();
  }
});

test('Demo 2 mit --dedup: Relay C verwirft Duplikate schon selbst', async () => {
  const net = await buildChain({ shortcut: true });
  net.c.dedup = true;
  try {
    await sleep(800);
    net.stopMeasuring();
    await waitFor(() => allDelivered(net));
    await sleep(300);
    assert.strictEqual(rat(net.ls, 'A').count, net.a.counter.value);
    assert.ok(net.c.stats.dropped > 0);
  } finally {
    net.stop();
  }
});

test('Demo 2: faellt B aus, kommt alles ueber A -> C an', async () => {
  const net = await buildChain({ shortcut: true });
  try {
    net.b.stop();
    await sleep(600);
    net.stopMeasuring();
    await waitFor(() => rat(net.ls, 'A') && rat(net.ls, 'A').count === net.a.counter.value);
    assert.deepStrictEqual(rat(net.ls, 'A').last.path, ['A', 'C']);
  } finally {
    net.stop();
  }
});

test('Verbindungsausfall: Nachrichten werden gepuffert und spaeter zugestellt', async () => {
  const net = await buildChain();
  try {
    await sleep(300);
    net.c.outboxes[0].setLink(false); // C -> Leitstelle faellt aus
    await sleep(800);
    const registeredBefore = net.ls.totals.registered;
    assert.ok(net.c.outboxes[0].size > 0, 'C puffert');
    await sleep(300);
    assert.strictEqual(net.ls.totals.registered, registeredBefore, 'waehrend Ausfall kommt nichts an');
    net.c.outboxes[0].setLink(true);
    net.stopMeasuring();
    await waitFor(() => allDelivered(net));
    assert.strictEqual(net.ls.totals.duplicates, 0);
  } finally {
    net.stop();
  }
});

test('Timeout: Nachrichten aelter als TTL werden verworfen', async () => {
  const net = await buildChain({ ttlMs: 500 });
  try {
    net.c.outboxes[0].setLink(false);
    await sleep(1500);
    net.stopMeasuring();
    assert.ok(net.c.outboxes[0].stats.expired > 0, 'abgelaufene Nachrichten verworfen');
    net.c.outboxes[0].setLink(true);
    await sleep(500);
    assert.ok(net.ls.totals.registered < net.a.counter.value + net.b.counter.value + net.c.counter.value);
  } finally {
    net.stop();
  }
});

test('Duplikaterkennung ueber RattenID + Zeitstempel', () => {
  const ls = new Leitstelle({ port: 0, webPort: null, quiet: true });
  const msg = (rat_id, seq, ts) => ({ rat_id, seq, ts, data: {}, path: [rat_id] });
  ls.receive(msg('A', 1, 1000), 'A');
  ls.receive(msg('A', 1, 1000), 'B'); // gleiche Nachricht auf zweitem Weg
  ls.receive(msg('A', 1, 2000), 'A'); // gleiche Nummer (z.B. nach Reset), anderer Zeitstempel
  ls.receive(msg('B', 1, 1000), 'B'); // gleicher Zeitstempel, andere Ratte
  assert.strictEqual(rat(ls, 'A').count, 2);
  assert.strictEqual(rat(ls, 'A').duplicates, 1);
  assert.strictEqual(rat(ls, 'B').count, 1);
  assert.strictEqual(ls.totals.duplicates, 1);
});

test('Zeitstempel einer Ratte sind eindeutig, auch bei schnellen Messungen', () => {
  const s = new SensorNode({ id: 'T', port: 0, nextHops: [hop(1)], stateDir: null, quiet: true });
  const ts = Array.from({ length: 1000 }, () => s.nextTimestamp());
  assert.strictEqual(new Set(ts).size, ts.length);
  ts.forEach((t, i) => i && assert.ok(t > ts[i - 1]));
});

test('Laufende Nummer zaehlt ueber Neustarts weiter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratnet-'));
  const file = path.join(dir, 'seq-X.json');
  const c1 = new SeqCounter(file);
  assert.strictEqual(c1.next(), 1);
  assert.strictEqual(c1.next(), 2);
  const c2 = new SeqCounter(file);
  assert.strictEqual(c2.next(), 3);
  fs.rmSync(dir, { recursive: true });
});
