$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = "C:\Users\sky17\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

Set-Location -LiteralPath $projectRoot
& $node server.js
