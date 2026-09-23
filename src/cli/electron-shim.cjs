/**
 * What `require('electron')` resolves to inside the `maestro-cli` bundle
 * (aliased in `scripts/build-cli.mjs`).
 *
 * The CLI runs under plain Node, where there is no Electron API: on a headless
 * server the `electron` package is not installed at all, and where it is, it
 * exports a binary path string rather than `app`. Several main-process modules
 * the CLI reaches still import it - most importantly `electron-store`, which
 * reads `app` / `ipcMain` at construction and is pulled in by the standalone
 * Cue engine (cue-engine -> cue-executor -> cue-spawn-builder ->
 * resolveClaudeSpawnMode -> claudeUsageStore). Without this shim,
 * `maestro-cli cue engine start` dies on `Cannot find module 'electron'`.
 *
 * Only the surface those stores need is provided, and `app.getPath('userData')`
 * answers with the SAME directory the desktop app uses, so a store written here
 * is the file the desktop reads. Everything else stays `undefined`, so a module
 * that genuinely needs a window or a real IPC channel still fails loudly
 * instead of pretending to work. CommonJS on purpose: esbuild does not check
 * named imports against a CJS module, so `import { BrowserWindow } from
 * 'electron'` elsewhere keeps compiling and simply reads `undefined`.
 */
/* global require, module, __MAESTRO_CLI_VERSION__ */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS by design, see above */
const os = require('os');
const path = require('path');
const { resolveMaestroUserDataDir } = require('../shared/maestroUserDataDir');

const app = {
	isPackaged: false,
	getName: () => 'Maestro',
	getVersion: () =>
		typeof __MAESTRO_CLI_VERSION__ === 'string' ? __MAESTRO_CLI_VERSION__ : '0.0.0',
	getPath: (name) => {
		if (name === 'userData' || name === 'appData') return resolveMaestroUserDataDir();
		if (name === 'home') return os.homedir();
		if (name === 'temp') return os.tmpdir();
		return path.join(resolveMaestroUserDataDir(), name);
	},
};

// electron-store only treats itself as running in the main process when both
// `app` and `ipcMain` exist; its one `ipcMain` call registers a renderer
// listener that has no renderer to serve here, so a no-op is correct.
const ipcMain = { on: () => ipcMain, handle: () => undefined, removeHandler: () => undefined };

module.exports = { app, ipcMain };
