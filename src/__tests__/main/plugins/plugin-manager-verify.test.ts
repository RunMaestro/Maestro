/**
 * @file plugin-manager-verify.test.ts
 * @description Refresh-time authorization gate. When a `verifyRecord` seam is
 * injected, an enabled, runnable code-tier plugin whose consented authorization
 * no longer matches the bytes on disk (or was removed) is force-DISABLED by
 * refresh, even though its enable toggle says on. The seam only force-disables,
 * is scoped to runnable code-tier records (tier-0/data-only is never gated), and
 * is absent by default (the enable toggle + consent govern).
 *
 * Real temp dir + real fs; the plugin data dir is redirected via MAESTRO_USER_DATA
 * (honored by plugin-store-main ahead of Electron's app.getPath); electron is
 * mocked so importing the module never touches the (absent) runtime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import {
	PluginManager,
	type PluginManagerDeps,
	type PluginSandboxLifecycle,
} from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';
import type { PluginRecord } from '../../../shared/plugins/plugin-registry';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { packPluginArchive } from '../../../shared/plugins/plugin-archive';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';
import { bundleOmpPlugin } from '../../../main/omp-distribution/bundle-plugin';

// FC1 Option-B gate: code only RUNS with a trusted signature. Tests asserting a
// sandbox START sign their fixture with this key and register it as trusted.
const signingKeys = makeSigningKeys();

/** Materialize a plugin folder directly under the plugins data dir. */
function writePlugin(id: string, tier: 0 | 1, contributes?: Record<string, unknown>): void {
	const dir = path.join(pluginsDir(), id);
	fs.mkdirSync(dir, { recursive: true });
	const manifest: Record<string, unknown> = {
		id,
		name: id,
		version: '1.0.0',
		tier,
		maestro: { minHostApi: '1.0.0' },
		...(tier >= 1 ? { entry: 'main.js' } : {}),
		...(contributes ? { contributes } : {}),
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	if (tier >= 1) fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { activate() {} };');
}

function writePanelPlugin(id: string): void {
	const dir = path.join(pluginsDir(), id);
	fs.mkdirSync(dir, { recursive: true });
	const manifest = {
		id,
		name: id,
		version: '1.0.0',
		tier: 1,
		maestro: { minHostApi: '1.0.0' },
		entry: 'main.js',
		permissions: [{ capability: 'ui:panel', reason: 'Render a sandboxed panel.' }],
		contributes: {
			panels: [{ id: 'board', title: 'Board', entry: 'panel.html', placement: 'left' }],
		},
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { activate() {} };');
	fs.writeFileSync(path.join(dir, 'panel.html'), '<p>panel-safe</p>');
	signPluginDir(dir, signingKeys);
}

function writeInteractivePanelPlugin(id: string, html = '<p>interactive-safe</p>'): void {
	const dir = path.join(pluginsDir(), id);
	fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
	const manifest = {
		id,
		name: id,
		version: '1.0.0',
		tier: 1,
		maestro: { minHostApi: '1.0.0' },
		entry: 'main.js',
		permissions: [
			{ capability: 'ui:panel' },
			{ capability: 'ui:workspace' },
			{ capability: 'ui:interactivePanel' },
		],
		contributes: {
			panels: [
				{
					id: 'omp-panel',
					title: 'Legacy collision',
					entry: 'legacy-panel.html',
					placement: 'left',
				},
			],
			workspaces: [
				{
					localId: 'omp-workspace',
					title: 'OMP Workspace',
					icon: 'sparkles',
					interactivePanelLocalId: 'omp-panel',
				},
			],
			interactivePanels: [
				{
					localId: 'omp-panel',
					bridge: {
						requestSchemas: {
							ping: {
								canonicalJsonSchema: { type: 'object', additionalProperties: false },
							},
						},
						eventSchemas: {},
						resultSchemas: {
							ping: {
								canonicalJsonSchema: { type: 'object', additionalProperties: false },
							},
						},
						errorSchemas: {
							ping: {
								canonicalJsonSchema: { type: 'object', additionalProperties: false },
							},
						},
					},
					title: 'OMP Panel',
					entry: 'dist/panel.html',
					workspaceLocalId: 'omp-workspace',
				},
			],
		},
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { activate() {} };');
	fs.writeFileSync(path.join(dir, 'legacy-panel.html'), '<p>legacy-safe</p>');
	fs.writeFileSync(path.join(dir, 'dist', 'panel.html'), html);
	signPluginDir(dir, signingKeys);
}

async function installSignedBundledOmpPanelFixture(): Promise<{
	readonly pluginId: string;
	readonly panelLocalId: string;
	readonly panelHtml: string;
}> {
	const bundle = await bundleOmpPlugin(path.join(process.cwd(), 'plugins', 'com.maestro.omp'));
	const files = new Map(bundle.files.map((file) => [file.path, file.content]));
	const manifest = JSON.parse(Buffer.from(files.get('plugin.json') ?? '').toString('utf8')) as {
		readonly id: string;
		readonly contributes: {
			readonly interactivePanels: readonly { readonly localId: string; readonly entry: string }[];
		};
	};
	const panel = manifest.contributes.interactivePanels[0];
	if (!panel) throw new Error('bundled OMP fixture omitted its interactive panel');
	const directory = path.join(pluginsDir(), manifest.id);
	for (const file of bundle.files) {
		const destination = path.join(directory, file.path);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, file.content);
	}
	signPluginDir(directory, signingKeys);
	return {
		pluginId: manifest.id,
		panelLocalId: panel.localId,
		panelHtml: Buffer.from(files.get(panel.entry) ?? '').toString('utf8'),
	};
}

function tarOctal(value: number, length: number): string {
	const octal = value.toString(8);
	return `${octal.padStart(length - 1, '0')}\0`;
}

function writeTarHeader(name: string, size: number, typeFlag = '0', linkName = ''): Buffer {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
	header.write(tarOctal(0o644, 8), 100, 8, 'ascii');
	header.write(tarOctal(0, 8), 108, 8, 'ascii');
	header.write(tarOctal(0, 8), 116, 8, 'ascii');
	header.write(tarOctal(size, 12), 124, 12, 'ascii');
	header.write(tarOctal(0, 12), 136, 12, 'ascii');
	header.fill(' ', 148, 156);
	header.write(typeFlag, 156, 1, 'ascii');
	if (linkName) header.write(linkName, 157, Math.min(Buffer.byteLength(linkName), 100), 'utf8');
	header.write('ustar\0', 257, 6, 'ascii');
	header.write('00', 263, 2, 'ascii');
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(tarOctal(checksum, 8), 148, 8, 'ascii');
	return header;
}

function writeTgzArchive(
	outPath: string,
	entries: Array<{ name: string; content?: string; typeFlag?: string; linkName?: string }>
): void {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		const bytes = Buffer.from(entry.content ?? '', 'utf8');
		const size = entry.typeFlag === '1' || entry.typeFlag === '2' ? 0 : bytes.length;
		chunks.push(writeTarHeader(entry.name, size, entry.typeFlag ?? '0', entry.linkName ?? ''));
		if (size > 0) {
			chunks.push(bytes);
			const padding = (512 - (bytes.length % 512)) % 512;
			if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
		}
	}
	chunks.push(Buffer.alloc(1024, 0));
	fs.writeFileSync(outPath, zlib.gzipSync(Buffer.concat(chunks)));
}

function manager(deps: Partial<PluginManagerDeps> = {}): PluginManager {
	return new PluginManager({
		isEnabled: () => true,
		trustedKeys: () => [signingKeys.publicKeyB64],
		...deps,
	});
}

function recordOf(m: PluginManager, id: string): PluginRecord | undefined {
	return m.getRegistry().records.find((r) => r.id === id);
}

/** Corrupt a plugin's signature so verifyPluginSignature resolves to 'invalid'. */
function tamperSignature(id: string): void {
	fs.writeFileSync(path.join(pluginsDir(), id, 'signature.json'), 'not json');
}

/** Discover + enable a tier-1 plugin so it is runnable for the gate to apply. */
function enableTier1(m: PluginManager, id: string): void {
	m.refresh(); // discover (tier-1 lands disabled by default)
	m.setEnabled(id, true); // user consent toggle -> persisted
}

let workDir: string;
let prevUserData: string | undefined;

beforeEach(() => {
	prevUserData = process.env.MAESTRO_USER_DATA;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-verify-'));
	process.env.MAESTRO_USER_DATA = path.join(workDir, 'userData');
});

afterEach(() => {
	if (prevUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevUserData;
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('PluginManager refresh-time verifyRecord gate', () => {
	it('force-disables an enabled code-tier plugin the gate rejects', () => {
		const verifyRecord = vi.fn(() => ({ disable: true }));
		const m = manager({ verifyRecord });
		writePlugin('demo', 1);
		enableTier1(m, 'demo');

		m.refresh(); // now enabled + runnable -> gate consulted
		expect(verifyRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'demo' }));
		expect(recordOf(m, 'demo')?.enabled).toBe(false);
		expect(m.getActiveRecords().some((r) => r.id === 'demo')).toBe(false);
	});

	it('leaves an enabled plugin running when the gate accepts it', () => {
		const m = manager({ verifyRecord: () => ({ disable: false }) });
		writePlugin('demo', 1);
		enableTier1(m, 'demo');

		m.refresh();
		expect(recordOf(m, 'demo')?.enabled).toBe(true);
		expect(m.getActiveRecords().some((r) => r.id === 'demo')).toBe(true);
	});

	it('does not gate when no verifyRecord seam is injected (current behavior)', () => {
		const m = manager();
		writePlugin('demo', 1);
		enableTier1(m, 'demo');

		m.refresh();
		expect(recordOf(m, 'demo')?.enabled).toBe(true);
	});

	it('never gates a tier-0 data-only plugin (not runnable code)', () => {
		const verifyRecord = vi.fn(() => ({ disable: true }));
		const m = manager({ verifyRecord });
		writePlugin('data', 0); // tier-0 auto-enables on discovery

		m.refresh();
		expect(verifyRecord).not.toHaveBeenCalled();
		expect(recordOf(m, 'data')?.enabled).toBe(true);
	});

	it('does not consult the gate for a disabled plugin', () => {
		const verifyRecord = vi.fn(() => ({ disable: true }));
		const m = manager({ verifyRecord });
		writePlugin('demo', 1);
		m.refresh(); // tier-1 stays disabled by default; never enabled

		expect(verifyRecord).not.toHaveBeenCalled();
		expect(recordOf(m, 'demo')?.enabled).toBe(false);
	});

	it('excludes an invalid-signature code plugin from active records + contributions, with no gate', () => {
		const m = manager(); // no verifyRecord injected at all
		const theme = { id: 'midnight', name: 'Midnight', mode: 'dark', colors: { bg: '#000' } };
		writePlugin('demo', 1, { themes: [theme] });
		enableTier1(m, 'demo');
		m.refresh();
		// Positive control: a valid, enabled plugin DOES contribute its theme, so a
		// later absence proves the exclusion, not a dropped (invalid) fixture.
		expect(m.getActiveRecords().some((r) => r.id === 'demo')).toBe(true);
		expect(m.getContributions().themes.some((t) => t.pluginId === 'demo')).toBe(true);

		tamperSignature('demo'); // signature now resolves to 'invalid'
		m.refresh();
		expect(recordOf(m, 'demo')?.signature?.status).toBe('invalid');
		// Tampered code is inert via the central active filter, regardless of toggle.
		expect(m.getActiveRecords().some((r) => r.id === 'demo')).toBe(false);
		expect(m.getContributions().themes.some((t) => t.pluginId === 'demo')).toBe(false);
	});

	it('keeps an invalid-signature plugin inert even when toggled back on (no setEnabled bypass)', () => {
		const m = manager();
		const theme = { id: 'midnight', name: 'Midnight', mode: 'dark', colors: { bg: '#000' } };
		writePlugin('demo', 1, { themes: [theme] });
		enableTier1(m, 'demo');
		tamperSignature('demo');
		m.refresh();

		m.setEnabled('demo', true); // try to re-activate the tampered plugin directly
		expect(m.getActiveRecords().some((r) => r.id === 'demo')).toBe(false);
		expect(m.getContributions().themes.some((t) => t.pluginId === 'demo')).toBe(false);
	});

	it('only reads panel HTML for enabled, untampered plugins with a ui:panel grant', () => {
		const grants = new Map<string, PermissionGrant[]>();
		const m = manager({ getGrants: (id) => grants.get(id) ?? [] });
		writePanelPlugin('paneler');

		m.refresh();
		expect(recordOf(m, 'paneler')?.enabled).toBe(false);
		expect(m.getPanelHtml('paneler/board')).toBeNull();

		m.setEnabled('paneler', true);
		expect(recordOf(m, 'paneler')?.enabled).toBe(true);
		expect(m.getPanelHtml('paneler/board')).toBeNull();

		grants.set('paneler', [{ capability: 'ui:panel', grantedAt: 1 }]);
		m.refresh();
		expect(m.getPanelHtml('paneler/board')).toBe('<p>panel-safe</p>');

		tamperSignature('paneler');
		m.refresh();
		expect(recordOf(m, 'paneler')?.signature?.status).toBe('invalid');
		expect(m.getPanelHtml('paneler/board')).toBeNull();
	});

	it('reads a signed interactive panel only from its owner-bound verified snapshot', () => {
		const grants = new Map<string, PermissionGrant[]>();
		const pluginId = 'com.maestro.omp';
		const panelPath = path.join(pluginsDir(), pluginId, 'dist', 'panel.html');
		const m = manager({ getGrants: (id) => grants.get(id) ?? [] });
		writeInteractivePanelPlugin(pluginId);

		m.refresh();
		m.setEnabled(pluginId, true);
		grants.set(pluginId, [
			{ capability: 'ui:panel', grantedAt: 1 },
			{ capability: 'ui:workspace', grantedAt: 1 },
			{ capability: 'ui:interactivePanel', grantedAt: 1 },
		]);
		m.refresh();

		// A legacy panel with the same canonical contribution id exists, but it
		// must not be eligible to serve the interactive document.
		expect(m.getInteractivePanelHtml(pluginId, 'omp-panel')).toBe('<p>interactive-safe</p>');

		// Changing installed bytes cannot replace the immutable verified artifact.
		fs.writeFileSync(panelPath, '<p>attacker bytes</p>');
		expect(m.getInteractivePanelHtml(pluginId, 'omp-panel')).toBe('<p>interactive-safe</p>');

		// Revocation/disable must immediately deny the current snapshot.
		grants.set(pluginId, []);
		expect(m.getInteractivePanelHtml(pluginId, 'omp-panel')).toBeNull();
		grants.set(pluginId, [
			{ capability: 'ui:workspace', grantedAt: 1 },
			{ capability: 'ui:interactivePanel', grantedAt: 1 },
		]);
		m.setEnabled(pluginId, false);
		expect(m.getInteractivePanelHtml(pluginId, 'omp-panel')).toBeNull();
		m.setEnabled(pluginId, true);

		// Only a newly signed, refreshed artifact may replace the served bytes.
		fs.writeFileSync(panelPath, '<p>replacement-safe</p>');
		signPluginDir(path.join(pluginsDir(), pluginId), signingKeys);
		m.refresh();
		expect(m.getInteractivePanelHtml(pluginId, 'omp-panel')).toBe('<p>replacement-safe</p>');
		expect(m.getInteractivePanelHtml('other.owner', 'omp-panel')).toBeNull();
		expect(m.getInteractivePanelHtml(pluginId, '../omp-panel')).toBeNull();
	});

	it('installs and starts a CLI-packed plugin archive with nested runtime assets', async () => {
		const source = path.join(workDir, 'packed-plugin');
		fs.mkdirSync(path.join(source, 'assets', 'nested'), { recursive: true });
		const manifest = {
			id: 'packed.archive',
			name: 'Packed Archive',
			version: '1.0.0',
			tier: 1,
			maestro: { minHostApi: '1.7.0' },
			entry: 'main.js',
			permissions: [{ capability: 'notifications:toast' }],
		};
		fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify(manifest));
		fs.writeFileSync(
			path.join(source, 'main.js'),
			'module.exports = { activate() { return "ok"; } };\n'
		);
		fs.writeFileSync(path.join(source, 'assets', 'nested', 'runtime.txt'), 'runtime-asset');
		fs.mkdirSync(path.join(source, 'node_modules', 'unsigned-dep'), { recursive: true });
		fs.writeFileSync(path.join(source, 'node_modules', 'unsigned-dep', 'index.js'), 'leak');
		// Sign BEFORE packing: the shared exclusion policy keeps node_modules out
		// of both the signed set and the archive, so the install verifies trusted.
		signPluginDir(source, signingKeys);

		const running = new Set<string>();
		const starts: Array<{ id: string; pluginDir: string; entry: string }> = [];
		const sandbox: PluginSandboxLifecycle = {
			start: (id, pluginDir, entry) => {
				running.add(id);
				starts.push({ id, pluginDir, entry });
			},
			stop: (id) => {
				running.delete(id);
			},
			stopAll: () => {
				running.clear();
			},
			isRunning: (id) => running.has(id),
			runningIds: () => [...running],
			invokeCommand: () => false,
			invokeTool: () => Promise.reject(new Error('not wired')),
		};
		const m = manager({ sandbox, trustedKeys: () => [signingKeys.publicKeyB64] });

		const archivePath = path.join(workDir, 'packed-archive.tgz');
		await packPluginArchive(source, archivePath);
		const installed = m.install(archivePath);
		expect(installed.success).toBe(true);
		expect(recordOf(m, 'packed.archive')?.enabled).toBe(false);
		const installedRoot = path.join(pluginsDir(), 'packed.archive');
		expect(
			fs.readFileSync(path.join(installedRoot, 'assets', 'nested', 'runtime.txt'), 'utf8')
		).toBe('runtime-asset');
		expect(fs.existsSync(path.join(installedRoot, 'node_modules'))).toBe(false);
		m.setEnabled('packed.archive', true);
		expect(starts).toEqual([
			{
				id: 'packed.archive',
				pluginDir: expect.any(String),
				entry: expect.objectContaining({
					ownerPluginId: 'packed.archive',
					generation: 1,
				}),
			},
		]);
	});

	it('rejects unsafe packed plugin archives and cleans extraction staging', () => {
		const cases: Array<{
			name: string;
			entries: Array<{ name: string; content?: string; typeFlag?: string; linkName?: string }>;
			error: RegExp;
		}> = [
			{
				name: 'traversal',
				entries: [{ name: '../evil.txt', content: 'x' }],
				error: /unsafe archive path/,
			},
			{
				name: 'absolute',
				entries: [{ name: '/abs/plugin.json', content: '{}' }],
				error: /unsafe archive path/,
			},
			{
				name: 'windows-absolute',
				entries: [{ name: 'C:/abs/plugin.json', content: '{}' }],
				error: /unsafe archive path/,
			},
			{
				name: 'symlink',
				entries: [{ name: 'link', typeFlag: '2', linkName: 'plugin.json' }],
				error: /link entries are not allowed/,
			},
			{
				name: 'hardlink',
				entries: [{ name: 'link', typeFlag: '1', linkName: 'plugin.json' }],
				error: /link entries are not allowed/,
			},
		];
		const m = manager();

		for (const c of cases) {
			const archivePath = path.join(workDir, `${c.name}.tgz`);
			writeTgzArchive(archivePath, c.entries);
			const result = m.install(archivePath);
			expect(result.success, c.name).toBe(false);
			expect(result.error, c.name).toMatch(c.error);
			const stagingLeftovers = fs.existsSync(pluginsDir())
				? fs.readdirSync(pluginsDir()).filter((entry) => entry.startsWith('__extract-'))
				: [];
			expect(stagingLeftovers, c.name).toEqual([]);
		}
	});
});
