# Startet die komplette Demo auf EINEM Rechner (localhost, verschiedene Ports),
# jeden Knoten in einem eigenen Fenster.
#
#   .\demo\local-demo.ps1 -Demo 1
#   .\demo\local-demo.ps1 -Demo 2
param([ValidateSet(1, 2)][int]$Demo = 1)

$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'bin\ratnet.js'

function Start-Node($title, $cliArgs) {
    $cmd = "`$Host.UI.RawUI.WindowTitle = '$title'; node '$cli' $cliArgs"
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmd -WorkingDirectory $root
}

Start-Node 'Leitstelle' 'leitstelle --port 5000 --web-port 8080'
Start-Sleep -Milliseconds 500
Start-Node 'Ratte C' 'sensor --id C --port 5003 --next 127.0.0.1:5000'
Start-Node 'Ratte B' 'sensor --id B --port 5002 --next 127.0.0.1:5003'
if ($Demo -eq 1) {
    Start-Node 'Ratte A' 'sensor --id A --port 5001 --next 127.0.0.1:5002'
} else {
    Start-Node 'Ratte A' 'sensor --id A --port 5001 --next 127.0.0.1:5002 --next 127.0.0.1:5003'
}
Start-Sleep -Seconds 1
Start-Process 'http://localhost:8080/'
