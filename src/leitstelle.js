'use strict';
// Zentrale Leitstelle: empfaengt Sensordaten, registriert jede Nachricht genau
// einmal (Deduplizierung ueber RattenID + laufende Nummer) und stellt sie in
// einem Web-Dashboard dar.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createReceiver, listen } = require('./server');
const { msgKey, msgLabel } = require('./protocol');
const { makeLogger } = require('./log');

const HISTORY = 120;
const EVENTS = 200;

class Leitstelle {
  constructor({ port, host = '0.0.0.0', webPort = 8080, allow = [], quiet = false }) {
    this.port = port;
    this.host = host;
    this.webPort = webPort;
    this.allow = allow;
    this.log = makeLogger('LEITSTELLE', { quiet });
    this.rats = new Map(); // rat_id -> state
    this.events = [];
    this.totals = { registered: 0, duplicates: 0 };
  }

  async start() {
    this.server = createReceiver({
      allow: this.allow,
      onMessage: (msg, from) => this.receive(msg, from),
      log: this.log,
    });
    this.port = await listen(this.server, this.port, this.host);
    this.log(`Empfang auf Port ${this.port}`);
    if (this.webPort !== null) {
      this.web = http.createServer((req, res) => this._http(req, res));
      this.webPort = await listen(this.web, this.webPort, this.host);
      this.log(`Dashboard: http://localhost:${this.webPort}/`);
    }
  }

  stop() {
    if (this.server) this.server.close();
    if (this.web) this.web.close();
  }

  _rat(id) {
    let r = this.rats.get(id);
    if (!r) {
      r = {
        id,
        seen: new Set(), // Zeitstempel bereits registrierter Nachrichten (Duplikaterkennung)
        seqs: new Set(), // nur fuer die Anzeige fehlender Nummern
        minSeq: Infinity,
        maxSeq: 0,
        count: 0,
        duplicates: 0,
        last: null,
        lastSeen: 0,
        history: [],
      };
      this.rats.set(id, r);
    }
    return r;
  }

  receive(msg, from) {
    const r = this._rat(msg.rat_id);
    const key = msgKey(msg);
    const label = msgLabel(msg);
    const now = Date.now();
    // Duplikat = gleiche RattenID und gleicher Zeitstempel
    const duplicate = r.seen.has(msg.ts);
    const event = {
      key,
      rat_id: msg.rat_id,
      seq: msg.seq,
      ts: msg.ts,
      received: now,
      path: msg.path,
      from,
      duplicate,
    };
    this.events.unshift(event);
    if (this.events.length > EVENTS) this.events.pop();

    if (duplicate) {
      r.duplicates++;
      this.totals.duplicates++;
      this.log(`DUPLIKAT ${label} (${key})  Weg ${msg.path.join('>')}  -> ignoriert`);
      return;
    }

    r.seen.add(msg.ts);
    r.seqs.add(msg.seq);
    r.minSeq = Math.min(r.minSeq, msg.seq);
    r.maxSeq = Math.max(r.maxSeq, msg.seq);
    r.count++;
    r.lastSeen = now;
    if (!r.last || msg.ts > r.last.ts) r.last = msg;
    r.history.push({ seq: msg.seq, ts: msg.ts, data: msg.data });
    r.history.sort((a, b) => a.ts - b.ts);
    if (r.history.length > HISTORY) r.history.shift();
    this.totals.registered++;
    const delay = Math.max(0, Math.round((now - msg.ts) / 1000));
    this.log(
      `NEU      ${label}  Weg ${msg.path.join('>')}  Verzoegerung ~${delay}s  ${JSON.stringify(msg.data)}`
    );
  }

  _missing(r) {
    const missing = [];
    if (r.count === 0) return { count: 0, list: missing };
    const count = Math.max(0, r.maxSeq - r.minSeq + 1 - r.seqs.size);
    for (let s = r.minSeq; s <= r.maxSeq && missing.length < 20; s++) if (!r.seqs.has(s)) missing.push(s);
    return { count, list: missing };
  }

  state() {
    return {
      now: Date.now(),
      totals: this.totals,
      rats: [...this.rats.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => ({
          id: r.id,
          count: r.count,
          duplicates: r.duplicates,
          firstSeq: r.count ? r.minSeq : null,
          lastSeq: r.count ? r.maxSeq : null,
          missing: this._missing(r),
          lastSeen: r.lastSeen,
          last: r.last,
          history: r.history,
        })),
      events: this.events.slice(0, 60),
    };
  }

  status() {
    const lines = [
      `Leitstelle  registriert ${this.totals.registered}  Duplikate ignoriert ${this.totals.duplicates}`,
    ];
    for (const r of this.rats.values()) {
      const m = this._missing(r);
      lines.push(
        `  Ratte ${r.id}: ${r.count} Nachrichten (Nr ${r.minSeq}..${r.maxSeq}), Duplikate ${r.duplicates}, fehlend ${m.count}`
      );
    }
    return lines.join('\n');
  }

  _http(req, res) {
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.state()));
    } else if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }
}

module.exports = { Leitstelle };
