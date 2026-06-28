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

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import { PluginManager, type PluginManagerDeps } from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';
import type { PluginRecord } from '../../../shared/plugins/plugin-registry';

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

function manager(deps: Partial<PluginManagerDeps> = {}): PluginManager {
	return new PluginManager({ isEnabled: () => true, ...deps });
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
});
