#!/usr/bin/env sh
# Startet die komplette Demo auf EINEM Rechner (localhost, verschiedene Ports)
# im Hintergrund; Ctrl+C beendet alles.
#
#   ./demo/local-demo.sh 1
#   ./demo/local-demo.sh 2
DEMO=${1:-1}
cd "$(dirname "$0")/.." || exit 1

node bin/ratnet.js leitstelle --port 5000 --web-port 8080 &
sleep 0.5
node bin/ratnet.js sensor --id C --port 5003 --next 127.0.0.1:5000 &
node bin/ratnet.js sensor --id B --port 5002 --next 127.0.0.1:5003 &
if [ "$DEMO" = "2" ]; then
  node bin/ratnet.js sensor --id A --port 5001 --next 127.0.0.1:5002 --next 127.0.0.1:5003 &
else
  node bin/ratnet.js sensor --id A --port 5001 --next 127.0.0.1:5002 &
fi
echo "Dashboard: http://localhost:8080/"
trap 'kill 0' INT TERM
wait
