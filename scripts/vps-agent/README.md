# Agente de logs del VPS → tab "vps"

Manda los logs del VPS (Windows) al back de monitoreo-qeb, **en vivo**. El VPS
solo hace **salida HTTPS**: no se abre ningún puerto. El back reenvía las líneas
por SSE a quien tenga abierta la tab `vps` en el monitor.

```
[ VPS Windows ]                         [ back monitoreo-qeb ]        [ navegador ]
 pm2 logs sync-aps                       POST /api/vps/logs/ingest     GET /api/vps/logs/live (SSE)
   │ (ship-logs.ps1)                       │  (secreto compartido)        ▲
   └──────── HTTPS POST (lotes) ──────────►│  hub en memoria ────────────┘
```

## 1) Configurar el back

En el env del back (DigitalOcean App → Settings → Environment):

```
VPS_LOG_SECRET=<un secreto largo y aleatorio>   # p.ej: openssl rand -hex 32
```

Sin esta variable, `/api/vps/*` responde `configured:false` y la tab muestra el aviso.

## 2) Correr el agente en el VPS

Copia `ship-logs.ps1` al VPS. En PowerShell:

```powershell
$env:VPS_LOG_ENDPOINT = "https://TU-BACK.ondigitalocean.app/api/vps/logs/ingest"
$env:VPS_LOG_SECRET   = "el-MISMO-secreto-que-pusiste-en-el-back"

# Tu caso — seguir el proceso pm2 "sync-aps":
.\ship-logs.ps1 -Pm2 sync-aps
```

Equivale a `pm2 logs sync-aps --raw` con las líneas empujándose al monitor.
Abre la tab **vps** en el monitor y las verás llegar en vivo.

### Otras formas
```powershell
# Comando arbitrario
.\ship-logs.ps1 -Command "pm2 logs sync-aps --raw"

# Por pipeline (cualquier cosa que escupa líneas)
pm2 logs sync-aps --raw | .\ship-logs.ps1

# Un archivo de log que crece
.\ship-logs.ps1 -File "C:\logs\sync-aps.log"
```

## 3) Dejarlo corriendo 24/7 (opcional)

Una ventana de PowerShell abierta funciona, pero se muere al cerrar sesión. Para
que sobreviva, lo más simple en Windows es el **Programador de tareas**:

- Programa: `powershell.exe`
- Argumentos:
  `-ExecutionPolicy Bypass -NoProfile -File "C:\ruta\ship-logs.ps1" -Pm2 sync-aps`
- Configurar: "Ejecutar aunque el usuario no haya iniciado sesión" + "Reiniciar
  si la tarea falla".
- Pon `VPS_LOG_ENDPOINT` y `VPS_LOG_SECRET` como variables de entorno **de
  sistema** (o pásalas con `-Endpoint`/`-Secret`).

> Como `sync-aps` ya vive en pm2, otra opción es correr el agente **también**
> bajo pm2: `pm2 start ship-logs.ps1 --name vps-shipper --interpreter powershell -- -Pm2 sync-aps`

## Notas

- **Modo solo-en-vivo**: no se persiste nada. Si el back reinicia se pierde el
  buffer y el agente sigue empujando sin problema.
- Las líneas se mandan en **lotes** (hasta 50 líneas o cada 1s) para no saturar.
- El nivel (INFO/WARN/ERROR/DEBUG) lo detecta el back por palabra clave en la
  línea; no necesitas etiquetar nada.
