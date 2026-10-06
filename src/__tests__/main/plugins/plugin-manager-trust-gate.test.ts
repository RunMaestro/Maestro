/**
 * FC1 Option-B trusted-to-run gate (`isRunnable` requires `trusted`).
 *
 * Contract under test:
 * - Code executes ONLY when the plugin's signature verifies as `trusted`
 *   (valid ed25519 signature from a key in the trusted set).
 * - `unsigned`, `untrusted` (valid signature, unknown key), and `invalid`
 *   (tampered) plugins NEVER start a sandbox - even when enabled.
 * - The gate is about CODE, not data: unsigned/untrusted plugins remain
 *   installable + enableable and their DECLARATIVE contributions (themes,
 *   prompts, commands metadata) still aggregate.
 *
 * Real temp dir + real fs; MAESTRO_USER_DATA redirects plugin storage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import { PluginManager, type PluginSandboxLifecycle } from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';
import { makeSigningKeys, signPluginDir } from './plugin-signing-helper';

const trustedSigner = makeSigningKeys();
const strangerSigner = makeSigningKeys();

function writeCodePlugin(
	id: string,
	opts: {
		theme?: boolean;
		settings?: boolean;
		requires?: import('../../../shared/plugins/services').RequiredService[];
	} = {}
): string {
	const dir = path.join(pluginsDir(), id);
	fs.mkdirSync(dir, { recursive: true });
	const manifest = {
		id,
		name: id,
		version: '1.0.0',
		tier: 1,
		entry: 'main.js',
		maestro: { minHostApi: '1.0.0' },
		...(opts.requires ? { requires: opts.requires } : {}),
		...(opts.settings
			? {
					permissions: [{ capability: 'ui:panel' }],
					contributes: {
						panels: [
							{ id: 'config', title: 'Configuration', entry: 'panel.html', placement: 'settings' },
						],
					},
				}
			: {}),
		...(opts.theme
			? {
					contributes: {
						themes: [
							{
								id: 'gate-theme',
								name: 'Gate Theme',
								mode: 'dark',
								colors: { accent: '#123456' },
							},
						],
					},
				}
			: {}),
	};
	fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
	fs.writeFileSync(path.join(dir, 'panel.html'), '<html>settings</html>');
	fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { activate() {} };');
	return dir;
}

function makeSandbox(): PluginSandboxLifecycle {
	const running = new Set<string>();
	return {
		start: vi.fn((id: string) => {
			running.add(id);
		}),
		stop: vi.fn((id: string) => {
			running.delete(id);
		}),
		stopAll: vi.fn(() => running.clear()),
		isRunning: vi.fn((id: string) => running.has(id)),
		runningIds: vi.fn(() => [...running]),
		invokeCommand: vi.fn(() => false),
		invokeTool: vi.fn(async () => undefined),
	};
}

function makeManager(sandbox: PluginSandboxLifecycle): PluginManager {
	return new PluginManager({
		isEnabled: () => true,
		sandbox,
		trustedKeys: () => [trustedSigner.publicKeyB64],
	});
}

let workDir: string;
let prevUserData: string | undefined;

beforeEach(() => {
	prevUserData = process.env.MAESTRO_USER_DATA;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-trust-gate-'));
	process.env.MAESTRO_USER_DATA = path.join(workDir, 'userData');
});

afterEach(() => {
	if (prevUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevUserData;
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('FC1 trusted-to-run gate', () => {
	it('starts a sandbox for an enabled plugin signed by a trusted key', () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('trusted.plugin');
		signPluginDir(dir, trustedSigner);
		manager.refresh();
		manager.setEnabled('trusted.plugin', true);
		expect(sandbox.start).toHaveBeenCalledTimes(1);
		expect(sandbox.isRunning('trusted.plugin')).toBe(true);
	});

	it('never starts an UNSIGNED plugin, even when enabled', () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		writeCodePlugin('unsigned.plugin');
		manager.refresh();
		manager.setEnabled('unsigned.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(
			manager.getRegistry().records.find((r) => r.id === 'unsigned.plugin')?.signature?.status ??
				'unsigned'
		).toBe('unsigned');
	});

	it('never starts an UNTRUSTED plugin (valid signature, unknown key)', () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('untrusted.plugin');
		signPluginDir(dir, strangerSigner);
		manager.refresh();
		manager.setEnabled('untrusted.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(
			manager.getRegistry().records.find((r) => r.id === 'untrusted.plugin')?.signature?.status
		).toBe('untrusted');
	});

	it('never starts an INVALID plugin (tampered after signing)', () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('tampered.plugin');
		signPluginDir(dir, trustedSigner);
		fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { evil: true };');
		manager.refresh();
		manager.setEnabled('tampered.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		expect(
			manager.getRegistry().records.find((r) => r.id === 'tampered.plugin')?.signature?.status
		).toBe('invalid');
	});

	it('a trusted plugin whose signer key is REMOVED from the trusted set stops running on refresh', () => {
		const sandbox = makeSandbox();
		let trusted: string[] = [trustedSigner.publicKeyB64];
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => trusted,
		});
		const dir = writeCodePlugin('rotating.plugin');
		signPluginDir(dir, trustedSigner);
		manager.refresh();
		manager.setEnabled('rotating.plugin', true);
		expect(sandbox.isRunning('rotating.plugin')).toBe(true);

		trusted = []; // key rotation / revocation
		manager.refresh();
		expect(sandbox.stop).toHaveBeenCalledWith('rotating.plugin');
		expect(sandbox.isRunning('rotating.plugin')).toBe(false);
	});

	it('declarative contributions still aggregate for an enabled UNTRUSTED plugin (code-only gate)', () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('declarative.plugin', { theme: true });
		signPluginDir(dir, strangerSigner);
		manager.refresh();
		manager.setEnabled('declarative.plugin', true);
		expect(sandbox.start).not.toHaveBeenCalled();
		const themes = manager.getContributions().themes;
		expect(themes.some((t) => t.id === 'declarative.plugin/gate-theme')).toBe(true);
	});

	it('tampered (invalid) plugins contribute NOTHING - declarative surface included', () => {
		const sandbox = makeSandbox();
		const manager = makeManager(sandbox);
		const dir = writeCodePlugin('tampered.data', { theme: true });
		signPluginDir(dir, trustedSigner);
		fs.writeFileSync(path.join(dir, 'main.js'), 'module.exports = { evil: true };');
		manager.refresh();
		manager.setEnabled('tampered.data', true);
		const themes = manager.getContributions().themes;
		expect(themes.some((t) => t.pluginId === 'tampered.data')).toBe(false);
	});
});

describe('settings panel activation boundary', () => {
	it('requires trust, enable and live ui:panel consent and removes HTML on disable/uninstall', () => {
		let grants = [{ capability: 'ui:panel' as const }];
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox: makeSandbox(),
			trustedKeys: () => [trustedSigner.publicKeyB64],
			getGrants: () => grants,
		});
		const trusted = writeCodePlugin('settings.trusted', { settings: true });
		signPluginDir(trusted, trustedSigner);
		writeCodePlugin('settings.unsigned', { settings: true });
		manager.refresh();
		manager.setEnabled('settings.trusted', true);
		manager.setEnabled('settings.unsigned', true);
		expect(manager.getContributions().panels.map((p) => p.id)).toEqual(['settings.trusted/config']);
		expect(manager.getPanelHtml('settings.trusted/config')).toContain('settings');
		grants = [];
		expect(manager.getContributions().panels).toEqual([]);
		expect(manager.getPanelHtml('settings.trusted/config')).toBeNull();
		grants = [{ capability: 'ui:panel' }];
		manager.setEnabled('settings.trusted', false);
		expect(manager.getContributions().panels).toEqual([]);
		manager.setEnabled('settings.trusted', true);
		manager.uninstall('settings.trusted');
		expect(manager.getPanelHtml('settings.trusted/config')).toBeNull();
	});
});

describe('explicit service startup dependencies', () => {
	it('starts/stops mandatory consumers with availability while optional denial leaves text plugins running', () => {
		let available = false;
		const sandbox = makeSandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			sandbox,
			trustedKeys: () => [trustedSigner.publicKeyB64],
			serviceAvailable: () => available,
		});
		const requirement = {
			id: 'voice',
			provider: 'example.media',
			service: 'transcription',
			contract: 'maestro.audio.transcribe' as const,
			version: '^1.0.0',
		};
		signPluginDir(
			writeCodePlugin('mandatory.consumer', { requires: [requirement] }),
			trustedSigner
		);
		signPluginDir(
			writeCodePlugin('optional.consumer', { requires: [{ ...requirement, optional: true }] }),
			trustedSigner
		);
		manager.refresh();
		manager.setEnabled('mandatory.consumer', true);
		manager.setEnabled('optional.consumer', true);
		expect(sandbox.isRunning('mandatory.consumer')).toBe(false);
		expect(sandbox.isRunning('optional.consumer')).toBe(true);
		available = true;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('mandatory.consumer')).toBe(true);
		available = false;
		manager.reconcileServiceDependencies();
		expect(sandbox.isRunning('mandatory.consumer')).toBe(false);
		expect(sandbox.isRunning('optional.consumer')).toBe(true);
	});
});
