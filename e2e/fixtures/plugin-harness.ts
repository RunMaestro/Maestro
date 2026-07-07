/**
 * E2E harness for the Maestro plugin system.
 *
 * Boots a fully ISOLATED Maestro instance via demo mode (MAESTRO_DEMO_DIR ->
 * app.setPath('userData', ...)), seeds a versioned full-surface self-test
 * plugin (optionally ed25519-signed + trusted), drives the host-owned consent
 * window, and captures the Electron main-process stdout/stderr where the
 * sandbox's forwarded console.log lands (the host logger always mirrors to
 * console).
 *
 * Why stdout and not the log file: getLogsDir() is hardcoded to
 * %APPDATA%/Maestro/logs (NOT demo-redirected), so the on-disk log is neither
 * isolated nor reliable here. Each run also stamps a unique runId into the
 * plugin's log tag so a stale line can never false-pass.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeSigningKeys, signPluginDir, type SigningKeys } from './plugin-signing';

export const PLUGIN_ID = 'maestro.e2e.selftest';

/** A real session pre-seeded into maestro-sessions.json so session-addressed
 * probes (sessions:write, tabs:manage, transcripts:*) reach the BROKER check
 * (honest DENY) instead of erroring on an unknown session in ungranted runs. */
export const SEEDED_SESSION_ID = 'maestro-e2e-session';

/** Host binary the harness blesses for the `process:spawn` PASS row (via
 * MAESTRO_E2E_SPAWN_BINARY + DEMO_MODE). hostname exists everywhere, exits
 * immediately, and is not in the registry's FORBIDDEN_BASENAMES. */
export const SPAWN_BINARY =
	process.platform === 'win32' ? 'C:/Windows/System32/HOSTNAME.EXE' : '/bin/hostname';

/** The high-risk act verbs: separate consent channel, default UNCHECKED. */
export const ACT_CAPS = ['agents:dispatch', 'process:spawn'] as const;

/** The brokered capabilities the fixture probes, in self-test order. */
export const PROBED_CAPS = [
	'fs:write',
	'fs:read',
	'fs:watch',
	'net:fetch',
	'agents:read',
	'agents:dispatch',
	'notifications:toast',
	'settings:write',
	'settings:read',
	'sessions:read',
	'sessions:create',
	'sessions:write',
	'tabs:manage',
	'transcripts:write',
	'transcripts:read',
	'history:read',
	'storage:write',
	'storage:read',
	'storage:sql',
	'ui:command',
	'events:subscribe',
	'shell:openExternal',
	'process:spawn',
	'decisions:write',
	'power:preventSleep',
	'background:service',
] as const;

/** Manifest-requested caps that have no brokered self-test probe (declarative
 * gates). Combined with PROBED_CAPS this is the full consent-offer surface. */
export const UI_ONLY_CAPS = ['ui:contribute', 'ui:panel', 'ui:render-unsafe'] as const;

/** Every capability the fixture manifest requests (the full consent offer). */
export const REQUESTED_CAPS = [...PROBED_CAPS, ...UI_ONLY_CAPS] as const;

const FIXTURE_PLUGIN_DIR = path.join(__dirname, 'plugins', 'maestro-e2e-selftest');
const FIXTURE_FILES = ['plugin.json', 'entry.js', 'panel.html'];
const TEMPLATED_FILES: Record<string, true> = { 'plugin.json': true, 'entry.js': true };
const MAIN_ENTRY = path.join(__dirname, '../../dist/main/index.js');

export interface SeededEnv {
	demoDir: string;
	scopeDir: string;
	runId: string;
	env: NodeJS.ProcessEnv;
	/** Signing keys used for a signed install; re-sign fixture edits with the
	 * SAME key (a new key = identity change = force-disable at next refresh). */
	signingKeys: SigningKeys;
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
 * created OUTSIDE the demo (userData) tree because the broker structurally
 * denies fs access into userData even with a grant.
 */
export function createSeededEnv(): SeededEnv {
	const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-demo-'));
	const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-scope-'));
	const runId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const signingKeys = makeSigningKeys();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MAESTRO_DEMO_DIR: demoDir,
		ELECTRON_DISABLE_GPU: '1',
		NODE_ENV: 'test',
		MAESTRO_E2E_TEST: 'true',
		MAESTRO_E2E_SPAWN_BINARY: SPAWN_BINARY,
	};
	return { demoDir, scopeDir, runId, env, signingKeys };
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

/** Close the running app and boot a FRESH Maestro process against the SAME
 * seeded demo dir — the e2e equivalent of quitting and reopening the app.
 * Nothing is re-seeded: whatever persisted (ledger, enable-state, plugin
 * files, keyring anchor) is exactly what the new process sees. */
export async function relaunch(launched: LaunchedApp, seeded: SeededEnv): Promise<LaunchedApp> {
	await launched.app.close();
	return launch(seeded.env);
}

/** First (throwaway) launch lets the app materialize default config files in
 *  the demo dir so we can flip flags against a valid settings document. */
async function materializeDefaults(env: NodeJS.ProcessEnv): Promise<void> {
	const app = await electron.launch({ args: [MAIN_ENTRY], env, timeout: 60_000 });
	await app.firstWindow();
	await app.close();
}

function readSettings(demoDir: string): Record<string, unknown> {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(demoDir, 'maestro-settings.json'), 'utf8')
		) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function writeSettings(demoDir: string, settings: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(demoDir, 'maestro-settings.json'),
		JSON.stringify(settings, null, '\t'),
		'utf8'
	);
}

function enablePluginsFlag(demoDir: string): void {
	const settings = readSettings(demoDir);
	const encore = (settings.encoreFeatures as Record<string, unknown> | undefined) ?? {};
	encore.plugins = true;
	settings.encoreFeatures = encore;
	// First-run Windows Support Notice is a focus-stealing modal that blocks
	// keyboard-driven UI tests (Settings shortcut); suppress it for every run.
	settings.suppressWindowsWarning = true;
	writeSettings(demoDir, settings);
}

export function seedPluginEnabledState(demoDir: string, enabled: boolean): void {
	fs.writeFileSync(
		path.join(demoDir, 'pianola-plugins.json'),
		JSON.stringify({ schemaVersion: 1, plugins: { [PLUGIN_ID]: { enabled } } }, null, '\t'),
		'utf8'
	);
}

/** Seed one real session (id SEEDED_SESSION_ID, projectPath = the fs scope)
 * into maestro-sessions.json so session-addressed probes resolve a session. */
function seedSession(seeded: SeededEnv): void {
	const now = Date.now();
	const tabId = 'e2e-seeded-tab';
	const session = {
		id: SEEDED_SESSION_ID,
		name: 'E2E Seeded Session',
		// A non-resolvable agent id: the renderer's remote-command path can never
		// spawn a REAL agent binary off a dispatched prompt on the dev box. The
		// dispatch PASS row returns synchronously before renderer resolution.
		toolType: 'e2e-null-agent',
		state: 'idle',
		cwd: fwd(seeded.scopeDir),
		fullPath: fwd(seeded.scopeDir),
		projectRoot: fwd(seeded.scopeDir),
		createdAt: now,
		updatedAt: now,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [
			{
				id: tabId,
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: now,
				state: 'idle',
			},
		],
		activeTabId: tabId,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: [{ type: 'ai', id: tabId }],
		unifiedClosedTabHistory: [],
	};
	fs.writeFileSync(
		path.join(seeded.demoDir, 'maestro-sessions.json'),
		JSON.stringify({ sessions: [session], activeSessionId: SEEDED_SESSION_ID }, null, '\t'),
		'utf8'
	);
}

function pluginDestDir(demoDir: string): string {
	return path.join(demoDir, 'plugins', PLUGIN_ID);
}

function installFixturePlugin(seeded: SeededEnv): void {
	const destDir = pluginDestDir(seeded.demoDir);
	fs.mkdirSync(destDir, { recursive: true });
	fs.mkdirSync(seeded.scopeDir, { recursive: true });
	const scope = fwd(seeded.scopeDir);
	for (const name of FIXTURE_FILES) {
		let src = fs.readFileSync(path.join(FIXTURE_PLUGIN_DIR, name), 'utf8');
		if (TEMPLATED_FILES[name]) {
			src = src
				.split('__FS_SCOPE__')
				.join(scope)
				.split('__RUN_ID__')
				.join(seeded.runId)
				.split('__SEEDED_SESSION__')
				.join(SEEDED_SESSION_ID);
		}
		fs.writeFileSync(path.join(destDir, name), src, 'utf8');
	}
}

/**
 * Sign the installed plugin dir with this instance's ed25519 key, mirroring
 * the host's frozen signing contract via the shared pure module (recursive
 * walk, POSIX relpaths, shared exclusions). Returns the base64 SPKI key.
 */
function signInstalledPlugin(destDir: string, keys: SigningKeys): string {
	signPluginDir(destDir, keys);
	return keys.publicKeyB64;
}

/** Re-sign the INSTALLED fixture with the SAME per-instance key after a
 * mid-test edit — the exact-file-set check makes a stale signature `invalid`,
 * and a NEW key would be an identity change (force-disable at next refresh). */
export function resignFixture(seeded: SeededEnv): void {
	signPluginDir(pluginDestDir(seeded.demoDir), seeded.signingKeys);
}

function seedTrustedKey(demoDir: string, publicKeyB64: string): void {
	const settings = readSettings(demoDir);
	const keys = Array.isArray(settings.pluginTrustedKeys)
		? (settings.pluginTrustedKeys as string[])
		: [];
	if (!keys.includes(publicKeyB64)) keys.push(publicKeyB64);
	settings.pluginTrustedKeys = keys;
	writeSettings(demoDir, settings);
}

/**
 * Probe to materialize defaults, enable the plugins Encore flag, seed the
 * plugin's enabled state + a real session, install the fixture, and (when
 * trusted) sign it and register its key in the trusted set.
 *
 * `untrusted: true` signs with a STRANGER key that is NOT seeded into
 * pluginTrustedKeys — a signed-but-untrusted plugin, which the Option-B gate
 * must treat exactly like an unsigned one (never runs code). Stronger than
 * leaving it unsigned: proves untrusted ≠ unsigned both never run.
 */
export async function seedAll(
	seeded: SeededEnv,
	opts: { enabled: boolean; trusted?: boolean; untrusted?: boolean }
): Promise<void> {
	await materializeDefaults(seeded.env);
	enablePluginsFlag(seeded.demoDir);
	seedPluginEnabledState(seeded.demoDir, opts.enabled);
	seedSession(seeded);
	installFixturePlugin(seeded);
	if (opts.trusted) {
		const pub = signInstalledPlugin(pluginDestDir(seeded.demoDir), seeded.signingKeys);
		seedTrustedKey(seeded.demoDir, pub);
	} else if (opts.untrusted) {
		signInstalledPlugin(pluginDestDir(seeded.demoDir), makeSigningKeys());
	}
}

export function cleanup(seeded: SeededEnv): void {
	// Best-effort: drop this demo instance's keyring anchor so e2e runs never
	// accumulate entries in the OS credential store.
	try {
		deleteAnchor(seeded);
	} catch {
		/* keyring unavailable */
	}
	for (const d of [seeded.demoDir, seeded.scopeDir]) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
}

// ---------------------------------------------------------------------------
// Grant-ledger persistence surface (WS-grant-ledger relaunch e2e).
//
// The app persists the sealed authorization ledger at
// <userData>/plugin-authorization.bin and anchors its freshness in the OS
// credential store under service 'com.maestro.plugin-authorization'. In demo
// mode the account is scoped per demo dir ('freshness:<sha256(demoDir)[:16]>')
// so isolated e2e instances never touch the developer's real anchor slot —
// which is also what makes DELETING the anchor (scenario: lost/corrupt
// keyring) safe to exercise here.
// ---------------------------------------------------------------------------

const ANCHOR_SERVICE = 'com.maestro.plugin-authorization';

export function ledgerPath(seeded: SeededEnv): string {
	return path.join(seeded.demoDir, 'plugin-authorization.bin');
}

/** The demo-scoped keyring account for this instance's freshness anchor.
 * MUST match the derivation in src/main/index.ts (DEMO_MODE branch). */
function anchorAccount(seeded: SeededEnv): string {
	const hash = crypto.createHash('sha256').update(seeded.demoDir, 'utf8').digest('hex');
	return `freshness:${hash.slice(0, 16)}`;
}

interface KeyringEntryLike {
	getPassword(): string | null;
	deletePassword(): boolean;
}

function keyringEntry(seeded: SeededEnv): KeyringEntryLike {
	// Lazy require so merely importing the harness never hard-depends on the
	// native module; tests that USE the anchor helpers fail loudly instead.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mod = require('@napi-rs/keyring') as {
		Entry: new (service: string, account: string) => KeyringEntryLike;
	};
	return new mod.Entry(ANCHOR_SERVICE, anchorAccount(seeded));
}

/** Read this demo instance's freshness anchor (null when absent). */
export function readAnchor(seeded: SeededEnv): string | null {
	try {
		return keyringEntry(seeded).getPassword();
	} catch {
		return null;
	}
}

/** Delete this demo instance's freshness anchor — simulates a lost/corrupt
 * OS keyring entry while the sealed ledger file still exists on disk. */
export function deleteAnchor(seeded: SeededEnv): boolean {
	try {
		return keyringEntry(seeded).deletePassword();
	} catch {
		return false;
	}
}

/**
 * Drive the host-owned consent window: open it via requestConsent, uncheck the
 * `withhold` capabilities, and approve the rest. Resolves once the window has
 * closed (whether the mint succeeded or was rejected, e.g. on a conflict).
 *
 * Act verbs (agents:dispatch / process:spawn) render in the SEPARATE high-risk
 * section, default UNCHECKED, on the `.cap-check-high-risk` channel — a plain
 * approve leaves them ungranted. Pass `highRisk` to opt them in, and
 * `unattended` (subset of `highRisk`) to also check the nested no-user-present
 * consent, which is disabled until its parent act-verb row is checked.
 */
export async function approveConsent(
	launched: LaunchedApp,
	opts: {
		withhold?: readonly string[];
		highRisk?: readonly string[];
		unattended?: readonly string[];
	} = {}
): Promise<void> {
	const consentPromise = launched.app.waitForEvent('window', { timeout: 30_000 });
	await launched.window.evaluate((id) => window.maestro.plugins.requestConsent(id), PLUGIN_ID);
	const consent = await consentPromise;
	await consent.waitForLoadState('domcontentloaded');
	await consent.locator('button.btn-approve').waitFor({ state: 'visible', timeout: 15_000 });
	for (const cap of opts.withhold ?? []) {
		await consent.locator(`.cap-check[data-cap="${cap}"]`).uncheck();
	}
	// Check the parent act-verb row BEFORE its nested unattended checkbox: the
	// consent page keeps the child disabled while the parent is unchecked.
	for (const cap of opts.highRisk ?? []) {
		await consent.locator(`.cap-check-high-risk[data-cap="${cap}"]`).check();
	}
	for (const cap of opts.unattended ?? []) {
		await consent.locator(`.unattended-check[data-cap="${cap}"]`).check();
	}
	await consent.locator('button.btn-approve').click();
	await consent.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined);
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

/** Did the plugin log delivery of the given event topic for this run? */
export function sawDeliveredEvent(output: string, runId: string, topic: string): boolean {
	return output.includes(`[e2e-selftest:${runId}] EVENT ${topic}`);
}

/** The LAST delivered payload for a topic (parsed), or null when none arrived. */
export function deliveredEventPayload(
	output: string,
	runId: string,
	topic: string
): Record<string, unknown> | null {
	const marker = `[e2e-selftest:${runId}] EVENT ${topic} `;
	const lines = output.split(/\r?\n/).filter((l) => l.includes(marker));
	if (lines.length === 0) return null;
	const last = lines[lines.length - 1];
	try {
		return JSON.parse(last.slice(last.indexOf(marker) + marker.length)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Trigger a host `session.updated` plugin event by writing a history file: the
 * HistoryManager watches <userData>/history and fires session.updated for any
 * *.json change. Returns the synthetic session id used.
 */
export function triggerSessionUpdated(demoDir: string, runId: string): string {
	const historyDir = path.join(demoDir, 'history');
	fs.mkdirSync(historyDir, { recursive: true });
	const sessionId = `e2e-evt-${runId}`;
	fs.writeFileSync(
		path.join(historyDir, `${sessionId}.json`),
		JSON.stringify({ t: Date.now() }),
		'utf8'
	);
	return sessionId;
}
