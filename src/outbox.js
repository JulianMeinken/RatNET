'use strict';
// Ausgangspuffer fuer genau einen Nachbarn (next hop).
//
// Nachrichten bleiben im Puffer, bis der Nachbar sie per ACK bestaetigt hat.
// Ist der Nachbar nicht erreichbar, wird periodisch neu verbunden. Nachrichten,
// die laenger als ttlMs im Puffer liegen, werden verworfen.

const net = require('net');
const { encode, attachLineReader, msgKey } = require('./protocol');

class Outbox {
  constructor({ peer, nodeId, ttlMs = 60000, retryMs = 2000, ackTimeoutMs = 3000, log = () => {} }) {
    this.peer = peer; // {host, port}
    this.name = `${peer.host}:${peer.port}`;
    this.nodeId = nodeId;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.log = log;

    this.items = new Map(); // key -> {msg, enqueuedAt}  (Map behaelt Einfuegereihenfolge)
    this.linkUp = true; // manuell per "down"/"up" schaltbar (Ausfall simulieren)
    this.connected = false;
    this.failing = false;
    this.stats = { sent: 0, expired: 0 };

    this.sock = null;
    this.pending = null;
    this.stopped = false;
    this._wake = null;
  }

  start() {
    this._loop();
  }

  stop() {
    this.stopped = true;
    if (this._wake) this._wake();
    this._closeSocket();
  }

  put(msg) {
    // Gleiche Nachricht ueber verschiedene Wege = verschiedene Eintraege;
    // die Deduplizierung ist Aufgabe der Leitstelle (oder des Relays mit --dedup).
    const id = `${msgKey(msg)}@${msg.path.join('>')}`;
    if (this.items.has(id)) return;
    this.items.set(id, { msg, enqueuedAt: Date.now() });
    if (this._wake) this._wake();
  }

  setLink(up) {
    this.linkUp = up;
    if (!up) this._closeSocket();
    if (up && this._wake) this._wake();
  }

  get size() {
    return this.items.size;
  }

  _expire() {
    const now = Date.now();
    for (const [id, item] of this.items) {
      if (now - item.enqueuedAt > this.ttlMs) {
        this.items.delete(id);
        this.stats.expired++;
        this.log(`VERWORFEN ${msgKey(item.msg)} (Weg ${item.msg.path.join('>')}) -> ${this.name} (Timeout ${Math.round(this.ttlMs / 1000)}s ueberschritten)`);
      }
    }
  }

  _sleep(ms, wakeable) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      if (wakeable) this._wake = done;
    }).finally(() => {
      this._wake = null;
    });
  }

  async _loop() {
    while (!this.stopped) {
      this._expire();
      const first = this.items.entries().next();
      if (first.done || !this.linkUp) {
        await this._sleep(500, true);
        continue;
      }
      const [id, item] = first.value;
      try {
        await this._ensureConnected();
        await this._sendAndAwaitAck(msgKey(item.msg), item.msg);
        this.items.delete(id);
        this.stats.sent++;
        if (this.failing) {
          this.failing = false;
          this.log(`Verbindung zu ${this.name} wieder da - sende Puffer (${this.items.size} verbleibend)`);
        }
      } catch (err) {
        this._closeSocket();
        if (!this.failing && !this.stopped) {
          this.failing = true;
          this.log(`Verbindung zu ${this.name} gestoert (${err.message}) - puffere Nachrichten`);
        }
        await this._sleep(this.retryMs, false);
      }
    }
  }

  _ensureConnected() {
    if (this.sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.peer.host, port: this.peer.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('Verbindungsaufbau Timeout'));
      }, this.ackTimeoutMs);
      const onError = (e) => {
        clearTimeout(timer);
        reject(new Error(e.code || e.message));
      };
      s.once('error', onError);
      s.once('connect', () => {
        clearTimeout(timer);
        s.removeListener('error', onError);
        s.setNoDelay(true);
        s.on('error', () => {});
        s.on('close', () => {
          if (this.sock === s) {
            this.sock = null;
            this.connected = false;
            if (this.pending) this.pending.reject(new Error('Verbindung geschlossen'));
          }
        });
        attachLineReader(s, (obj) => this._onReply(obj));
        this.sock = s;
        this.connected = true;
        resolve();
      });
    });
  }

  _sendAndAwaitAck(key, msg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('kein ACK'));
      }, this.ackTimeoutMs);
      this.pending = {
        key,
        resolve: () => {
          clearTimeout(timer);
          this.pending = null;
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          this.pending = null;
          reject(e);
        },
      };
      this.sock.write(encode({ type: 'data', from: this.nodeId, msg }));
    });
  }

  _onReply(obj) {
    if (!this.pending || obj.key !== this.pending.key) return;
    if (obj.type === 'ack') this.pending.resolve();
    else if (obj.type === 'nack') this.pending.reject(new Error(`abgelehnt: ${obj.reason}`));
  }

  _closeSocket() {
    if (this.sock) {
      const s = this.sock;
      this.sock = null;
      this.connected = false;
      s.destroy();
    }
    if (this.pending) this.pending.reject(new Error('Verbindung geschlossen'));
  }
}

module.exports = { Outbox };
