#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { parseArgs } = require('util');
const { SensorNode } = require('../src/sensor');
const { Leitstelle } = require('../src/leitstelle');
const { DEFAULT_PORT, parseHostPort } = require('../src/protocol');

const USAGE = `RatNET - Sensornetz fuer Kanalratten

Aufruf:
  ratnet sensor     --id <ID> --next <IP[:PORT]> [--next ...] [Optionen]
  ratnet leitstelle [Optionen]

Gemeinsame Optionen:
  --port <n>        TCP-Port fuer eingehende Nachrichten (Standard ${DEFAULT_PORT})
  --bind <ip>       Lokale Adresse zum Lauschen (Standard 0.0.0.0)
  --allow <ip>      Nur Verbindungen von dieser IP annehmen (mehrfach / kommagetrennt)
  --quiet           Keine Log-Ausgabe

Sensor:
  --id <ID>         Eindeutige ID der Ratte (z.B. A)
  --next <IP:PORT>  Nachbar, an den weitergeleitet wird (mehrfach / kommagetrennt)
  --interval <s>    Messintervall in Sekunden (Standard 2)
  --ttl <s>         Max. Pufferzeit bei Verbindungsausfall (Standard 60)
  --retry <s>       Wartezeit zwischen Verbindungsversuchen (Standard 2)
  --dedup           Duplikate schon im Relay verwerfen (Standard: nur Leitstelle)
  --state-dir <d>   Ordner fuer die gespeicherte laufende Nummer (Standard .ratnet-state)

Leitstelle:
  --web-port <n>    Port des Web-Dashboards (Standard 8080, 0 = zufaellig)

Laufzeit-Befehle (Eingabe + Enter):
  status            Zustand anzeigen
  down <n|all>      Verbindung n zu einem Nachbarn sperren (Ausfall simulieren)
  up <n|all>        Verbindung wieder freigeben
  quit              Beenden

Beispiele (Demo 1: A -> B -> C -> Leitstelle):
  Laptop 4: ratnet leitstelle
  Laptop 3: ratnet sensor --id C --next <IP Laptop 4>
  Laptop 2: ratnet sensor --id B --next <IP Laptop 3>
  Laptop 1: ratnet sensor --id A --next <IP Laptop 2>
Demo 2 zusaetzlich A -> C:
  Laptop 1: ratnet sensor --id A --next <IP Laptop 2> --next <IP Laptop 3>
`;

function fail(text) {
  console.error(`Fehler: ${text}\n`);
  console.error(USAGE);
  process.exit(2);
}

function list(values) {
  return (values || []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

function num(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} muss eine Zahl >= 0 sein`);
  return n;
}

function main(argv) {
  const role = argv[0];
  if (!role || role === '-h' || role === '--help' || role === 'help') {
    console.log(USAGE);
    return;
  }
  let opts;
  try {
    opts = parseArgs({
      args: argv.slice(1),
      options: {
        id: { type: 'string' },
        next: { type: 'string', multiple: true },
        port: { type: 'string' },
        bind: { type: 'string' },
        allow: { type: 'string', multiple: true },
        interval: { type: 'string' },
        ttl: { type: 'string' },
        retry: { type: 'string' },
        dedup: { type: 'boolean' },
        'state-dir': { type: 'string' },
        'web-port': { type: 'string' },
        quiet: { type: 'boolean' },
      },
    }).values;
  } catch (e) {
    fail(e.message);
  }

  const common = {
    port: num(opts.port, 'port', DEFAULT_PORT),
    host: opts.bind || '0.0.0.0',
    allow: list(opts.allow),
    quiet: !!opts.quiet,
  };

  let node;
  if (role === 'sensor') {
    if (!opts.id) fail('--id fehlt');
    const nextHops = list(opts.next).map((s) => parseHostPort(s));
    if (nextHops.length === 0) fail('mindestens ein --next angeben');
    node = new SensorNode({
      ...common,
      id: opts.id,
      nextHops,
      intervalMs: num(opts.interval, 'interval', 2) * 1000,
      ttlMs: num(opts.ttl, 'ttl', 60) * 1000,
      retryMs: num(opts.retry, 'retry', 2) * 1000,
      dedup: !!opts.dedup,
      stateDir: opts['state-dir'] || '.ratnet-state',
    });
  } else if (role === 'leitstelle') {
    node = new Leitstelle({ ...common, webPort: num(opts['web-port'], 'web-port', 8080) });
  } else {
    fail(`unbekannte Rolle "${role}" (sensor oder leitstelle)`);
  }

  node.start().catch((e) => {
    console.error(`Start fehlgeschlagen: ${e.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    node.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => handleCommand(node, line.trim()));
    rl.on('close', shutdown);
  }
}

function handleCommand(node, line) {
  const [cmd, arg] = line.split(/\s+/);
  if (!cmd) return;
  if (cmd === 'status') {
    console.log(node.status());
  } else if ((cmd === 'down' || cmd === 'up') && node.outboxes) {
    const targets = !arg || arg === 'all' ? node.outboxes : [node.outboxes[Number(arg) - 1]];
    if (targets.some((t) => !t)) {
      console.log(`Unbekannte Verbindung "${arg}" - siehe "status"`);
      return;
    }
    targets.forEach((o) => {
      o.setLink(cmd === 'up');
      console.log(`Verbindung -> ${o.name}: ${cmd === 'up' ? 'freigegeben' : 'GESPERRT (Nachrichten werden gepuffert)'}`);
    });
  } else if (cmd === 'quit' || cmd === 'exit') {
    node.stop();
    process.exit(0);
  } else {
    console.log('Befehle: status, down <n|all>, up <n|all>, quit');
  }
}

main(process.argv.slice(2));
