'use strict';
// Wire-Protokoll: TCP, eine JSON-Nachricht pro Zeile (NDJSON).
//
//   Sender -> Empfaenger:  {"type":"data","from":"A","msg":{...}}
//   Empfaenger -> Sender:  {"type":"ack","key":"A#17"}
//                          {"type":"nack","key":"A#17","reason":"..."}
//
// Eine Nachricht (msg) sieht so aus:
//   {
//     "rat_id": "A",            eindeutige ID der Ratte
//     "seq":    17,             laufende Nummer, zaehlt nur hoch
//     "ts":     1761134400,     ungefaehrer Zeitstempel (Unix-Sekunden)
//     "data":   {...},          Sensordaten (Demodaten)
//     "path":   ["A","B"]       Knoten, die die Nachricht bisher passiert hat
//   }
//
// Ein ACK bedeutet: der Empfaenger hat die Verantwortung fuer die Nachricht
// uebernommen (hop-by-hop Store-and-Forward).

const DEFAULT_PORT = 5000;

function msgKey(msg) {
  return `${msg.rat_id}#${msg.seq}`;
}

function encode(obj) {
  return JSON.stringify(obj) + '\n';
}

function validateMsg(msg) {
  return (
    msg !== null &&
    typeof msg === 'object' &&
    typeof msg.rat_id === 'string' && msg.rat_id.length > 0 &&
    Number.isInteger(msg.seq) && msg.seq >= 0 &&
    typeof msg.ts === 'number' &&
    msg.data !== null && typeof msg.data === 'object' &&
    Array.isArray(msg.path)
  );
}

// Haengt sich an einen Socket und ruft onObject fuer jede empfangene JSON-Zeile auf.
function attachLineReader(socket, onObject) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      onObject(obj);
    }
    if (buf.length > 1024 * 1024) socket.destroy(); // Schutz vor Muell
  });
}

// "192.168.0.12", "192.168.0.12:5001" oder "[::1]:5001" -> {host, port}
function parseHostPort(str, defaultPort = DEFAULT_PORT) {
  const s = String(str).trim();
  const v6 = s.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort };
  const parts = s.split(':');
  if (parts.length === 2) return { host: parts[0], port: Number(parts[1]) };
  return { host: s, port: defaultPort };
}

function normalizeIp(addr) {
  if (!addr) return addr;
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

module.exports = {
  DEFAULT_PORT,
  msgKey,
  encode,
  validateMsg,
  attachLineReader,
  parseHostPort,
  normalizeIp,
};
