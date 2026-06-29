/**
 * E2E harness for the Maestro plugin system.
 *
 * Boots a fully ISOLATED Maestro instance via demo mode (MAESTRO_DEMO_DIR ->
 * app.setPath('userData', ...)), seeds a versioned self-test plugin, and
 * captures the Electron main-process stdout/stderr where the sandbox's
 * forwarded console.log lands (the host logger always mirrors to console).
 *
 * Why stdout and not the log file: getLogsDir() is hardcoded to
 * %APPDATA%/Maestro/logs (NOT demo-redirected), so the on-disk log is neither
 * isolated nor reliable here. Each run also stamps a unique runId into the
 * plugin's log tag so a stale line can never false-pass.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const PLUGIN_ID = 'maestro.e2e.selftest';

/** The brokered capabilities the fixture plugin probes (in self-test order). */
export const PROBED_CAPS = [
	'fs:write',
	'fs:read',
	'net:fetch',
	'settings:write',
	'settings:read',
	'storage:write',
	'storage:read',
	'notifications:toast',
	'events:subscribe',
	'ui:command',
] as const;

const FIXTURE_PLUGIN_DIR = path.join(__dirname, 'plugins', 'maestro-e2e-selftest');
const MAIN_ENTRY = path.join(__dirname, '../../dist/main/index.js');

export interface SeededEnv {
	demoDir: string;
	scopeDir: string;
	runId: string;
	env: NodeJS.ProcessEnv;
}

export interface LaunchedApp {
	app: ElectronApplication;
	window: Page;
	/** Accumulated main-process stdout + stderr. */
	output: () => string;
}

function fwd(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Create isolated demo + scope dirs and the launch env. The fs scope dir is
 * deliberately created OUTSIDE the demo (userData) tree because the broker
 * structurally denies fs access into userData even with a grant.
 */
export function createSeededEnv(): SeededEnv {
	const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-demo-'));
	const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-scope-'));
	const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MAESTRO_DEMO_DIR: demoDir,
		ELECTRON_DISABLE_GPU: '1',
		NODE_ENV: 'test',
		MAESTRO_E2E_TEST: 'true',
	};
	return { demoDir, scopeDir, runId, env };
}

function attachOutput(app: ElectronApplication): () => string {
	let buf = '';
	const proc = app.process();
	proc.stdout?.on('data', (d: Buffer) => {
		buf += d.toString();
	});
	proc.stderr?.on('data', (d: Buffer) => {
		buf += d.toString();
	});
	return () => buf;
}

export async function launch(env: NodeJS.ProcessEnv): Promise<LaunchedApp> {
	const app = await electron.launch({ args: [MAIN_ENTRY], env, timeout: 60_000 });
	const output = attachOutput(app);
	const window = await app.firstWindow();
	await window.waitForLoadState('domcontentloaded');
	return { app, window, output };
}

/** First (throwaway) launch lets the app materialize default config files in
 *  the demo dir so we can flip flags against a valid settings document. */
async function materializeDefaults(env: NodeJS.ProcessEnv): Promise<void> {
	const app = await electron.launch({ args: [MAIN_ENTRY], env, timeout: 60_000 });
	await app.firstWindow();
	await app.close();
}

function enablePluginsFlag(demoDir: string): void {
	const file = path.join(demoDir, 'maestro-settings.json');
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		settings = {};
	}
	const encore = (settings.encoreFeatures as Record<string, unknown> | undefined) ?? {};
	encore.plugins = true;
	settings.encoreFeatures = encore;
	fs.writeFileSync(file, JSON.stringify(settings, null, '\t'), 'utf8');
}

function seedPluginEnabledState(demoDir: string, enabled: boolean): void {
	fs.writeFileSync(
		path.join(demoDir, 'pianola-plugins.json'),
		JSON.stringify({ schemaVersion: 1, plugins: { [PLUGIN_ID]: { enabled } } }, null, '\t'),
		'utf8'
	);
}

function installFixturePlugin(seeded: SeededEnv): void {
	const destDir = path.join(seeded.demoDir, 'plugins', PLUGIN_ID);
	fs.mkdirSync(destDir, { recursive: true });
	fs.mkdirSync(seeded.scopeDir, { recursive: true });
	const scope = fwd(seeded.scopeDir);
	for (const name of ['plugin.json', 'entry.js']) {
		const src = fs.readFileSync(path.join(FIXTURE_PLUGIN_DIR, name), 'utf8');
		const out = src.split('__FS_SCOPE__').join(scope).split('__RUN_ID__').join(seeded.runId);
		fs.writeFileSync(path.join(destDir, name), out, 'utf8');
	}
}

/**
 * Probe to materialize defaults, enable the plugins Encore flag, seed the
 * plugin's enabled state, and install the fixture plugin into the demo dir.
 */
export async function seedAll(seeded: SeededEnv, opts: { enabled: boolean }): Promise<void> {
	await materializeDefaults(seeded.env);
	enablePluginsFlag(seeded.demoDir);
	seedPluginEnabledState(seeded.demoDir, opts.enabled);
	installFixturePlugin(seeded);
}

export function cleanup(seeded: SeededEnv): void {
	for (const d of [seeded.demoDir, seeded.scopeDir]) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

/** Parse the LAST self-test SUMMARY line for this run from captured output. */
export function parseSelfTestSummary(output: string, runId: string): Record<string, string> | null {
	const marker = `[e2e-selftest:${runId}] SUMMARY `;
	const lines = output.split(/\r?\n/).filter((l) => l.includes(marker));
	if (lines.length === 0) return null;
	const last = lines[lines.length - 1];
	const json = last.slice(last.indexOf('{'));
	try {
		return JSON.parse(json) as Record<string, string>;
	} catch {
		return null;
	}
}
