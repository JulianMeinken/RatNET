'use strict';
// TCP-Empfangsseite, gemeinsam fuer Sensor (Relay) und Leitstelle.

const net = require('net');
const { encode, attachLineReader, validateMsg, msgKey, normalizeIp } = require('./protocol');

// onMessage(msg, from) wird fuer jede gueltige Nachricht aufgerufen. Erst wenn
// sie ohne Fehler zurueckkehrt, wird das ACK gesendet.
function createReceiver({ allow = [], onMessage, log = () => {} }) {
  const allowSet = new Set(allow.map(normalizeIp));
  const server = net.createServer((sock) => {
    const ip = normalizeIp(sock.remoteAddress);
    sock.setNoDelay(true);
    sock.on('error', () => {});
    if (allowSet.size > 0 && !allowSet.has(ip)) {
      log(`Verbindung von ${ip} abgelehnt (nicht in --allow)`);
      sock.end(encode({ type: 'nack', key: null, reason: 'not allowed' }));
      return;
    }
    attachLineReader(sock, (req) => {
      if (req.type !== 'data') return;
      const msg = req.msg;
      if (!validateMsg(msg)) {
        sock.write(encode({ type: 'nack', key: null, reason: 'invalid message' }));
        return;
      }
      const key = msgKey(msg);
      try {
        onMessage(msg, req.from || ip);
        sock.write(encode({ type: 'ack', key }));
      } catch (e) {
        sock.write(encode({ type: 'nack', key, reason: e.message }));
      }
    });
  });
  return server;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

module.exports = { createReceiver, listen };
