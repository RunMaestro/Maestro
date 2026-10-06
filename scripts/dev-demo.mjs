import os from 'node:os';
import path from 'node:path';

// Demo mode: point the app at an isolated, throwaway data dir. Mirrors the
// DEMO_MODE fallback in src/main/constants.ts and works on every OS (the old
// hardcoded /tmp/maestro-demo did not exist on Windows). An explicit
// MAESTRO_DEMO_DIR from the caller still wins.
if (!process.env.MAESTRO_DEMO_DIR) {
	process.env.MAESTRO_DEMO_DIR = path.join(os.tmpdir(), 'maestro-demo');
}

await import('./dev.mjs');
