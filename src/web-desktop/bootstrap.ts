/**
 * Web-desktop bootstrap entry.
 *
 * 1. Polyfills the few Node/Electron globals the renderer probes at import time
 *    (process.env, process.versions.electron, process.platform).
 * 2. Reads server-injected config from window.__MAESTRO_CONFIG__.
 * 3. Imports the real preload index, which calls contextBridge.exposeInMainWorld
 *    — our electron-shim contextBridge writes that to window.maestro.
 * 4. Dynamically imports the real renderer main entry.
 */

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

async function boot(): Promise<void> {
	// Run preload first so window.maestro is populated.
	await import('../main/preload/index');
	// Then mount the renderer.
	await import('../renderer/main');
}

void boot().catch((err) => {
	const root = document.getElementById('root');
	if (root) {
		root.innerHTML = `<div style="padding:24px;font-family:monospace;color:#f88;background:#111;min-height:100vh"><h2>Web-Desktop bootstrap failed</h2><pre>${
			(err && (err.stack || err.message)) || String(err)
		}</pre></div>`;
	}
	console.error('[bootstrap] boot failed', err);
});
