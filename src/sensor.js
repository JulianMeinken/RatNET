'use strict';
// Sensor-Knoten auf einer Ratte: misst selbst und arbeitet gleichzeitig als Relay.

const fs = require('fs');
const path = require('path');
const { createReceiver, listen } = require('./server');
const { Outbox } = require('./outbox');
const { DemoSensor } = require('./demodata');
const { msgKey } = require('./protocol');
const { makeLogger } = require('./log');

// Laufende Nummer, die nur hochzaehlen kann - auch ueber Neustarts hinweg.
// Der neue Wert wird gespeichert, BEVOR er verwendet wird.
class SeqCounter {
  constructor(file) {
    this.file = file;
    this.value = 0;
    if (file && fs.existsSync(file)) {
      try {
        this.value = JSON.parse(fs.readFileSync(file, 'utf8')).seq || 0;
      } catch {
        throw new Error(`Zustandsdatei ${file} ist beschaedigt - bitte pruefen`);
      }
    }
  }

  next() {
    this.value += 1;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ seq: this.value }));
    }
    return this.value;
  }
}

class SensorNode {
  constructor({
    id,
    port,
    host = '0.0.0.0',
    nextHops,
    intervalMs = 2000,
    ttlMs = 60000,
    retryMs = 2000,
    dedup = false,
    allow = [],
    stateDir = '.ratnet-state',
    quiet = false,
  }) {
    if (!id) throw new Error('Sensor braucht eine --id');
    if (!nextHops || nextHops.length === 0) throw new Error('Sensor braucht mindestens einen --next');
    this.id = id;
    this.port = port;
    this.host = host;
    this.intervalMs = intervalMs;
    this.dedup = dedup;
    this.allow = allow;
    this.log = makeLogger(id, { quiet });
    this.counter = new SeqCounter(stateDir ? path.join(stateDir, `seq-${id}.json`) : null);
    this.sensor = new DemoSensor();
    this.seen = new Set();
    this.stats = { generated: 0, relayed: 0, dropped: 0 };
    this.outboxes = nextHops.map(
      (peer) => new Outbox({ peer, nodeId: id, ttlMs, retryMs, log: this.log })
    );
  }

  async start() {
    this.server = createReceiver({
      allow: this.allow,
      onMessage: (msg, from) => this.receive(msg, from),
      log: this.log,
    });
    this.port = await listen(this.server, this.port, this.host);
    this.outboxes.forEach((o) => o.start());
    this.timer = setInterval(() => this.measure(), this.intervalMs);
    this.log(
      `Sensor gestartet auf Port ${this.port}, sendet an: ${this.outboxes.map((o) => o.name).join(', ')}` +
        ` (Startnummer ${this.counter.value + 1})`
    );
  }

  stop() {
    clearInterval(this.timer);
    this.outboxes.forEach((o) => o.stop());
    if (this.server) this.server.close();
  }

  measure() {
    const msg = {
      rat_id: this.id,
      seq: this.counter.next(),
      ts: Math.floor(Date.now() / 1000),
      data: this.sensor.read(),
      path: [this.id],
    };
    this.seen.add(msgKey(msg));
    this.stats.generated++;
    this.outboxes.forEach((o) => o.put(msg));
    this.log(`MESSUNG  ${msgKey(msg)}  ${JSON.stringify(msg.data)}`);
  }

  receive(msg, from) {
    const key = msgKey(msg);
    // Schleifenschutz: Nachricht war schon einmal hier
    if (msg.path.includes(this.id) || msg.rat_id === this.id) {
      this.stats.dropped++;
      return;
    }
    if (this.dedup) {
      if (this.seen.has(key)) {
        this.stats.dropped++;
        this.log(`DUPLIKAT ${key} von ${from} - nicht erneut weitergeleitet`);
        return;
      }
      this.seen.add(key);
    }
    const fwd = { ...msg, path: [...msg.path, this.id] };
    this.outboxes.forEach((o) => o.put(fwd));
    this.stats.relayed++;
    this.log(`RELAY    ${key}  von ${from}  Weg ${fwd.path.join('>')}`);
  }

  status() {
    const lines = [
      `Sensor ${this.id}  Port ${this.port}  letzte Nr ${this.counter.value}  ` +
        `gemessen ${this.stats.generated}  weitergeleitet ${this.stats.relayed}  verworfen ${this.stats.dropped}`,
    ];
    this.outboxes.forEach((o, i) => {
      const state = !o.linkUp ? 'DOWN (manuell)' : o.failing ? 'gestoert' : o.connected ? 'verbunden' : 'bereit';
      lines.push(
        `  [${i + 1}] -> ${o.name}  ${state}  Puffer ${o.size}  gesendet ${o.stats.sent}  Timeout-verworfen ${o.stats.expired}`
      );
    });
    return lines.join('\n');
  }
}

module.exports = { SensorNode, SeqCounter };
