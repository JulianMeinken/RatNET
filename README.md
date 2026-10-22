# RatNET 🐀

Sensornetz für Kanalratten: Jede Ratte trägt einen Sensor, der eigene Messwerte
erzeugt **und** gleichzeitig als Relay die Nachrichten anderer Ratten
weiterleitet. Nur die letzte Ratte der Kette erreicht die **Leitstelle**, die
alle Daten sammelt und in einem Web-Dashboard darstellt.

- Keine Abhängigkeiten, nur **Node.js ≥ 18.3** (`node --version`)
- Ein CLI-Tool, Rolle per Argument: `sensor` oder `leitstelle`
- Nachbarn werden per IP-Adresse angegeben (`--next`)

## Schnellstart

```bash
git clone <repo> && cd RatNET
node bin/ratnet.js --help
```

Optional global installieren (dann reicht `ratnet ...`):

```bash
npm install -g .
```

## Demo auf 4 Laptops

Alle Laptops im selben IP-Netz. Beispiel-IPs (mit `ipconfig` / `ip a` ermitteln):

| Laptop | Rolle      | IP (Beispiel)  |
|--------|------------|----------------|
| 1      | Ratte A    | 192.168.0.11   |
| 2      | Ratte B    | 192.168.0.12   |
| 3      | Ratte C    | 192.168.0.13   |
| 4      | Leitstelle | 192.168.0.14   |

Standard-Port aller Knoten ist **5000**, das Dashboard läuft auf **8080**.
Am besten in der Reihenfolge Leitstelle → C → B → A starten (Reihenfolge ist aber
egal, nicht erreichbare Nachbarn werden automatisch erneut versucht).

### Demo 1: `A → B → C → Leitstelle`

```bash
# Laptop 4
node bin/ratnet.js leitstelle
# Laptop 3
node bin/ratnet.js sensor --id C --next 192.168.0.14
# Laptop 2
node bin/ratnet.js sensor --id B --next 192.168.0.13
# Laptop 1
node bin/ratnet.js sensor --id A --next 192.168.0.12
```

Dashboard öffnen: `http://192.168.0.14:8080/`

### Demo 2: zusätzliche Verbindung `A → C`

```
A ──→ B ──→ C ──→ Leitstelle
└───────────↑
```

Gleich wie Demo 1, nur A bekommt zwei Nachbarn:

```bash
# Laptop 1
node bin/ratnet.js sensor --id A --next 192.168.0.12 --next 192.168.0.13
```

Jede Nachricht von A kommt jetzt auf **zwei Wegen** (A>C und A>B>C) in der
Leitstelle an. Sie wird nur **einmal registriert**, die zweite Kopie erscheint
im Dashboard als `DUPLIKAT` und wird ignoriert.

### Erzwungene Topologie (optional)

Mit `--allow <IP>` nimmt ein Knoten nur Verbindungen von bestimmten Rechnern
an, z.B. akzeptiert die Leitstelle dann wirklich nur Ratte C:

```bash
node bin/ratnet.js leitstelle --allow 192.168.0.13
node bin/ratnet.js sensor --id C --next 192.168.0.14 --allow 192.168.0.11,192.168.0.12
```

### Verbindungsausfall vorführen

Möglichkeiten:

1. Im Fenster einer Ratte `down 1` eintippen: Die Verbindung zum 1. Nachbarn
   wird gesperrt, Nachrichten werden gepuffert. Mit `up 1` geht alles raus.
   `status` zeigt die Puffergröße.
2. WLAN/Kabel eines Laptops trennen oder einen Knoten mit Ctrl+C beenden und
   neu starten.

Nach der Wiederherstellung zeigt das Dashboard die gepufferten Nachrichten mit
hoher **Verzögerung** (Empfangszeit − Messzeit). Liegt eine Nachricht länger als
**60 s** im Puffer (`--ttl`), wird sie verworfen. Im Dashboard tauchen dann
**fehlende Nummern** bei der betroffenen Ratte auf.

### Alles auf einem Rechner testen

```bash
.\demo\local-demo.ps1 -Demo 2     # Windows: öffnet 4 Fenster + Browser
./demo/local-demo.sh 2            # Linux/macOS
```

## Funktionsweise

### Nachricht

```json
{
  "rat_id": "A",
  "seq": 17,
  "ts": 1761134400,
  "data": { "temperature_c": 15.2, "humidity_pct": 91.3, "methane_ppm": 80,
            "heart_rate_bpm": 410, "battery_pct": 97.5, "position_m": 42.1 },
  "path": ["A", "B", "C"]
}
```

- `rat_id`: eindeutige ID der Ratte (`--id`)
- `seq`: laufende Nummer, zählt **nur hoch**. Sie wird in
  `.ratnet-state/seq-<ID>.json` gespeichert, *bevor* sie verwendet wird, und
  läuft deshalb auch nach einem Neustart weiter.
- `ts`: ungefährer Zeitstempel (Unix-Sekunden, lokale Uhr des Sensors)
- `data`: Demo-Sensordaten (Random Walk)
- `path`: Knoten, die die Nachricht durchlaufen hat (für Anzeige und Schleifenschutz)

### Übertragung: hop-by-hop Store-and-Forward

- TCP, eine JSON-Nachricht pro Zeile.
- Jeder Knoten hat pro Nachbar einen **Ausgangspuffer**. Eine Nachricht bleibt
  darin, bis der Nachbar sie mit einem `ack` bestätigt. Der Nachbar bestätigt
  erst, nachdem er sie selbst in seine Puffer übernommen bzw. (Leitstelle)
  registriert hat.
- Ist der Nachbar nicht erreichbar, wird alle 2 s (`--retry`) neu verbunden.
- Nach 60 s (`--ttl`) im Puffer wird eine Nachricht verworfen.
- Hat ein Knoten mehrere Nachbarn, geht jede Nachricht an **alle** (Flooding).
  Fällt ein Weg aus, kommt die Nachricht über den anderen an.

### Duplikaterkennung

Eine Nachricht ist eindeutig durch `(rat_id, seq)` bestimmt. Die Leitstelle
merkt sich pro Ratte alle empfangenen Nummern. Kommt eine Nummer erneut an
(anderer Weg, erneute Übertragung nach verlorenem ACK), wird sie bestätigt,
aber nicht noch einmal registriert.

Standardmäßig leiten Relays Duplikate weiter, damit die Deduplizierung in der
Leitstelle sichtbar ist. Mit `--dedup` verwirft schon das Relay bereits
gesehene Nachrichten (spart Bandbreite).

### Dashboard

`http://<Leitstelle>:8080/` zeigt:

- pro Ratte: aktuelle Messwerte, Verlauf (Temperatur/Methan), Anzahl
  registriert / Duplikate / fehlende Nummern, letzter Weg, Online-Status
- die beobachteten Wege als Graph (aktive Kanten hervorgehoben)
- Liste der empfangenen Nachrichten mit Status `NEU` / `DUPLIKAT` und Verzögerung

## CLI-Referenz

```
ratnet sensor     --id <ID> --next <IP[:PORT]> [--next ...] [Optionen]
ratnet leitstelle [Optionen]

--port <n>        TCP-Port für eingehende Nachrichten (Standard 5000)
--bind <ip>       Lokale Adresse zum Lauschen (Standard 0.0.0.0)
--allow <ip>      Nur Verbindungen von dieser IP annehmen (mehrfach / kommagetrennt)
--quiet           Keine Log-Ausgabe
--id <ID>         (Sensor) Eindeutige ID der Ratte
--next <IP:PORT>  (Sensor) Nachbar, an den weitergeleitet wird (mehrfach / kommagetrennt)
--interval <s>    (Sensor) Messintervall (Standard 2)
--ttl <s>         (Sensor) Max. Pufferzeit bei Ausfall (Standard 60)
--retry <s>       (Sensor) Wartezeit zwischen Verbindungsversuchen (Standard 2)
--dedup           (Sensor) Duplikate schon im Relay verwerfen
--state-dir <d>   (Sensor) Ordner für die laufende Nummer (Standard .ratnet-state)
--web-port <n>    (Leitstelle) Port des Dashboards (Standard 8080)
```

Laufzeit-Befehle im Terminal: `status`, `down <n|all>`, `up <n|all>`, `quit`.

## Tests

```bash
npm test
```

Die Tests bauen Demo 1 und 2 auf localhost auf und prüfen Zustellung,
Deduplizierung, Ausweichen über den zweiten Weg, Pufferung, Timeout und die
persistente laufende Nummer.

## Troubleshooting

- **Windows-Firewall**: Beim ersten Start fragt Windows, ob Node.js im Netzwerk
  kommunizieren darf → für *private Netzwerke* erlauben. Alternativ eingehend
  TCP 5000 und 8080 freigeben.
- **Netzwerkprofil** des WLANs auf „Privat" stellen, sonst blockiert Windows.
- Erreichbarkeit testen: `Test-NetConnection 192.168.0.13 -Port 5000` (Windows)
  bzw. `nc -vz 192.168.0.13 5000`.
- Uni-/Gast-WLANs blockieren oft Verbindungen zwischen Clients (Client
  Isolation). Dann einen Handy-Hotspot oder eigenen Router verwenden.

## Grenzen der Demo

- Puffer liegen im Arbeitsspeicher: Stürzt ein Relay ab, sind die Nachrichten
  in *seinem* Puffer verloren (sie wurden dem Vorgänger ja schon bestätigt).
- Keine Verschlüsselung/Authentifizierung, `--allow` filtert nur nach IP.
- Die Leitstelle hält ihren Zustand im Speicher; nach einem Neustart beginnt
  die Duplikaterkennung von vorn.
