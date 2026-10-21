import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Only the local client key in the user-designated proxy config is read.
// OAuth files and upstream tokens are never opened or copied.
export const proxyDirectory = join(homedir(), 'Desktop', 'EasyCLIProxyAPI-v0.3.9-Windows-amd64', 'EasyCLIProxyAPI-v0.3.9-Windows-amd64');
export const proxyConfigPath = join(proxyDirectory, 'config.toml');
export function proxyDetected() { return existsSync(proxyConfigPath); }
export function readProxyKey() {
  try {
    const config = readFileSync(proxyConfigPath, 'utf8');
    const array = config.match(/^api-keys\s*=\s*(\[[\s\S]*?\])/m)?.[1];
    if (!array) return '';
    try {
      const keys = JSON.parse(array);
      if (Array.isArray(keys) && typeof keys[0] === 'string') return keys[0];
    } catch { /* EasyCLIProxyAPI also writes TOML inline tables. */ }
    const key = array.match(/(?:^|[\s{,])key\s*=\s*("(?:\\.|[^"\\])*")/)?.[1];
    return key ? JSON.parse(key) : '';
  } catch { return ''; }
}
