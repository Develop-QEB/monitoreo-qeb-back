<#
.SYNOPSIS
  Empuja los logs del VPS al back de monitoreo-qeb (tab "vps"), en vivo.

.DESCRIPTION
  Cada línea de log se manda por HTTPS (POST, en lotes) al endpoint
  /api/vps/logs/ingest del back, autenticado con un secreto compartido.
  Modo SOLO-EN-VIVO: no se guarda nada, solo se reenvía a quien tenga la tab
  abierta. No abre ningún puerto en el VPS (solo salida HTTPS).

.PARAMETER Pm2
  Nombre del proceso de pm2 a seguir. Equivale a envolver:
      pm2 logs <Pm2> --raw --lines 20
  Ej: -Pm2 sync-aps

.PARAMETER Command
  Comando arbitrario cuya salida (stdout + stderr) quieres seguir.
  Ej: -Command "pm2 logs sync-aps --raw"

.PARAMETER File
  Ruta a un archivo de log que crece; se sigue con Get-Content -Wait.
  Ej: -File "C:\logs\sync-aps.log"

.PARAMETER Endpoint
  URL completa del endpoint de ingesta. Default: $env:VPS_LOG_ENDPOINT

.PARAMETER Secret
  Secreto compartido (el MISMO que VPS_LOG_SECRET en el back).
  Default: $env:VPS_LOG_SECRET

.EXAMPLE
  # Tu caso: seguir el proceso pm2 "sync-aps"
  $env:VPS_LOG_ENDPOINT = "https://TU-BACK.ondigitalocean.app/api/vps/logs/ingest"
  $env:VPS_LOG_SECRET   = "el-mismo-secreto-del-back"
  .\ship-logs.ps1 -Pm2 sync-aps

.EXAMPLE
  # Cualquier cosa por pipeline
  pm2 logs sync-aps --raw | .\ship-logs.ps1
#>
[CmdletBinding()]
param(
  [string]$Pm2,
  [string]$Command,
  [string]$File,
  [string]$Endpoint = $env:VPS_LOG_ENDPOINT,
  [string]$Secret   = $env:VPS_LOG_SECRET,
  [string]$Source   = $env:COMPUTERNAME,
  [int]$BatchMs = 1000,
  [int]$BatchMax = 50,
  [Parameter(ValueFromPipeline = $true)]
  [string]$InputLine
)

begin {
  # Windows PowerShell 5.1 a veces negocia TLS viejo; forzamos 1.2.
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

  if (-not $Endpoint) { throw "Falta -Endpoint o `$env:VPS_LOG_ENDPOINT" }
  if (-not $Secret)   { throw "Falta -Secret o `$env:VPS_LOG_SECRET" }
  if (-not $Source)   { $Source = "vps" }

  $script:headers = @{ 'x-vps-secret' = $Secret }
  $script:buffer  = New-Object System.Collections.Generic.List[object]
  $script:sw      = [System.Diagnostics.Stopwatch]::StartNew()

  function Flush-Buffer {
    if ($script:buffer.Count -eq 0) { return }
    $payload = @{ source = $Source; lines = $script:buffer.ToArray() } |
      ConvertTo-Json -Depth 4 -Compress
    try {
      Invoke-RestMethod -Uri $Endpoint -Method Post -Headers $script:headers `
        -ContentType 'application/json' -Body $payload -TimeoutSec 15 | Out-Null
    } catch {
      Write-Warning ("ship-logs: fallo al enviar {0} lineas: {1}" -f $script:buffer.Count, $_.Exception.Message)
    }
    $script:buffer.Clear()
    $script:sw.Restart()
  }

  function Add-Line([string]$text) {
    if ([string]::IsNullOrWhiteSpace($text)) { return }
    # ts en UTC ISO-8601; el back lo normaliza igual si falta.
    $ts = [DateTime]::UtcNow.ToString("o")
    $script:buffer.Add(@{ ts = $ts; msg = $text })
    if ($script:buffer.Count -ge $BatchMax -or $script:sw.ElapsedMilliseconds -ge $BatchMs) {
      Flush-Buffer
    }
  }

  # Si vino -Pm2, construimos el comando estándar de pm2.
  if ($Pm2 -and -not $Command) { $Command = "pm2 logs $Pm2 --raw --lines 20" }

  Write-Host "[ship-logs] source=$Source -> $Endpoint" -ForegroundColor Cyan
  if ($Command) { Write-Host "[ship-logs] siguiendo comando: $Command" -ForegroundColor Cyan }
  elseif ($File) { Write-Host "[ship-logs] siguiendo archivo: $File" -ForegroundColor Cyan }
  else { Write-Host "[ship-logs] leyendo del pipeline (stdin)" -ForegroundColor Cyan }
}

process {
  # Modo pipeline: cada objeto que entra por stdin.
  if ($PSBoundParameters.ContainsKey('InputLine') -or $InputLine) {
    Add-Line ([string]$InputLine)
  }
}

end {
  try {
    if ($Command) {
      # Ejecuta y streamea la salida línea por línea (stdout + stderr).
      Invoke-Expression "$Command 2>&1" | ForEach-Object { Add-Line ([string]$_) }
    }
    elseif ($File) {
      Get-Content -Path $File -Wait -Tail 20 | ForEach-Object { Add-Line ([string]$_) }
    }
    # (modo pipeline ya se consumió en process{})
  }
  finally {
    Flush-Buffer
    Write-Host "[ship-logs] fin." -ForegroundColor Cyan
  }
}
