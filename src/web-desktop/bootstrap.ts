/**
 * Web-desktop bootstrap entry.
 *
 * 1. Polyfills the few Node/Electron globals the renderer probes at import time
 *    (process.env, process.versions.electron, process.platform).
 * 2. Reads server-injected config from window.__MAESTRO_CONFIG__.
 * 3. Imports the real preload index, which calls contextBridge.exposeInMainWorld
 *    — our electron-shim contextBridge writes that to window.maestro.
 * 4. Dynamically imports the real renderer main entry.
 * 5. Registers the PWA service worker (reusing src/web/utils/serviceWorker.ts).
 */

import { registerServiceWorker } from '../web/utils/serviceWorker';

declare global {
	interface Window {
		process?: {
			env: Record<string, string | undefined>;
			versions: Record<string, string>;
			platform: string;
		};
	}
}

if (!window.process) {
	window.process = {
		env: { NODE_ENV: 'production' },
		versions: { electron: '0.0.0-web', chrome: '0.0.0', node: '0.0.0' },
		platform: navigator.userAgent.includes('Mac')
			? 'darwin'
			: navigator.userAgent.includes('Win')
				? 'win32'
				: 'linux',
	};
}

// Also expose `global` as `window` for legacy code that checks it.
if (!(globalThis as Record<string, unknown>).global) {
	(globalThis as Record<string, unknown>).global = globalThis;
}

// Mark this as the browser (web-desktop) build so CSS can target phone-only
// rules via html[data-runtime='web-desktop']. The native Electron desktop app
// loads the same renderer stylesheet but never sets this attribute, so those
// rules stay inert there. Set before the renderer boots so the very first paint
// already matches.
document.documentElement.dataset.runtime = 'web-desktop';

async function boot(): Promise<void> {
	// Run preload first so window.maestro is populated.
	await import('../main/preload/index');
	// Then mount the renderer.
	await import('../renderer/main');
}

void boot()
	.then(() => {
		// Register the PWA service worker once the app is mounted. The server
		// injects window.__MAESTRO_CONFIG__ inline before any module runs, so the
		// security token is already available; registerServiceWorker() reads it to
		// register /<token>/sw.js at scope /<token>/. It swallows its own failures
		// (unsupported browser, registration error), so this never affects boot.
		void registerServiceWorker();
	})
	.catch((err) => {
		const detail = (err && (err.stack || err.message)) || String(err);
		// Prefer the shared error surface from index.html (HTML-escaped, styled, and
		// includes the same-network hint). Fall back to a minimal inline render if
		// the inline script somehow didn't run.
		const showBootError = (
			window as unknown as {
				__maestroShowBootError?: (title: string, detail: string) => void;
			}
		).__maestroShowBootError;
		if (showBootError) {
			showBootError('Maestro web-desktop failed to load', detail);
		} else {
			const root = document.getElementById('root');
			if (root) {
				root.textContent = `Maestro web-desktop failed to load: ${detail}`;
			}
		}
		console.error('[bootstrap] boot failed', err);
	});
