"""Run the pinned upstream backend on loopback. No model is installed or invoked here."""
from pathlib import Path
import os
import subprocess
import sys

SOURCE = Path(os.environ['THINKFLOW_SOURCE_ROOT']).resolve()
COMMIT = '1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3'
actual = subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip()
if actual != COMMIT:
    raise SystemExit('ThinkFlow source revision differs; service not started')
PORT = int(os.environ.get('THINKFLOW_PORT', '8437'))
if not 1024 <= PORT <= 65535:
    raise SystemExit('THINKFLOW_PORT must be an unprivileged port')
os.chdir(SOURCE)
sys.path.insert(0, str(SOURCE))
os.environ.setdefault('ANONYMIZED_TELEMETRY', 'False')
os.environ.setdefault('EMBEDDING_API_URL', 'http://127.0.0.1:26210')

from fastapi_app.main import app
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles

app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost'])

@app.middleware('http')
async def local_browser_origins(request, call_next):
    origin = request.headers.get('origin')
    allowed = {f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost') for port in (4317, PORT)}
    if origin and origin not in allowed:
        return JSONResponse({'detail': 'Local workspace origin required'}, status_code=403)
    return await call_next(request)

@app.get('/personal-agent-health')
async def integration_health():
    return {'service': 'personal-agent-thinkflow', 'upstream_commit': COMMIT}

dist = SOURCE / 'frontend' / 'dist'
if dist.is_dir():
    app.mount('/', StaticFiles(directory=str(dist), html=True), name='thinkflow-ui')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=PORT, log_level='warning')
