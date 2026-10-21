"""Run the pinned, unmodified ThinkFlow backend and built UI on loopback only."""
from pathlib import Path
import os
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.runtime' / 'thinkflow' / 'source'
os.chdir(SOURCE)
sys.path.insert(0, str(SOURCE))
os.environ.setdefault('ANONYMIZED_TELEMETRY', 'False')
os.environ.setdefault('LLM_API_URL', 'http://127.0.0.1:8317/v1')
os.environ.setdefault('DEFAULT_LLM_API_URL', 'http://127.0.0.1:8317/v1')
os.environ.setdefault('LLM_MODEL', 'gpt-6-luna')
os.environ.setdefault('KB_CHAT_MODEL', 'gpt-6-luna')
os.environ.setdefault('EMBEDDING_API_URL', 'http://127.0.0.1:26210')
try:
    proxy = Path.home() / 'Desktop' / 'EasyCLIProxyAPI-v0.3.9-Windows-amd64' / 'EasyCLIProxyAPI-v0.3.9-Windows-amd64' / 'config.toml'
    config = tomllib.loads(proxy.read_text(encoding='utf-8-sig'))
    key = config.get('api-keys', [])[0]
    os.environ.setdefault('LLM_API_KEY', key.get('key', '') if isinstance(key, dict) else key)
except (OSError, ValueError, IndexError, TypeError):
    pass

from fastapi_app.main import app
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles

app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost'])

@app.middleware('http')
async def local_browser_origins(request, call_next):
    origin = request.headers.get('origin')
    allowed = {f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost') for port in (4317, 8437)}
    if origin and origin not in allowed:
        return JSONResponse({'detail': 'Local workspace origin required'}, status_code=403)
    return await call_next(request)

@app.get('/personal-agent-health')
async def integration_health():
    return {'service': 'personal-agent-thinkflow', 'upstream_commit': '1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3'}

dist = SOURCE / 'frontend' / 'dist'
if dist.exists():
    app.mount('/', StaticFiles(directory=str(dist), html=True), name='thinkflow-ui')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8437, log_level='warning')
