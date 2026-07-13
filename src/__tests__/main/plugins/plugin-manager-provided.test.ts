import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import { PluginManager } from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';
import { OMP_PLUGIN_ID } from '../../../main/plugins/plugin-trust-root-service';

let userData = '';
let previousUserData: string | undefined;

function writePlugin(folder: string, id: string): string {
	const source = path.join(pluginsDir(), folder);
	fs.mkdirSync(source, { recursive: true });
	fs.writeFileSync(
		path.join(source, 'plugin.json'),
		JSON.stringify({
			id,
			name: id === OMP_PLUGIN_ID ? 'OMP' : 'Community plugin',
			version: '1.0.0',
			tier: id === OMP_PLUGIN_ID ? 1 : 0,
			...(id === OMP_PLUGIN_ID ? { entry: 'main.js' } : {}),
			maestro: { minHostApi: '1.0.0' },
		})
	);
	if (id === OMP_PLUGIN_ID) fs.writeFileSync(path.join(source, 'main.js'), 'module.exports = {};');
	return source;
}

beforeEach(() => {
	previousUserData = process.env.MAESTRO_USER_DATA;
	userData = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-provided-plugin-'));
	process.env.MAESTRO_USER_DATA = userData;
});

afterEach(() => {
	if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = previousUserData;
	fs.rmSync(userData, { recursive: true, force: true });
});

describe('provided OMP ownership', () => {
	it('lists a verified bundled OMP record for a fresh profile while the community runtime gate is off', () => {
		const bundledSource = writePlugin(OMP_PLUGIN_ID, OMP_PLUGIN_ID);
		const manager = new PluginManager({
			isEnabled: () => false,
			resolveInstallOwner: (record) =>
				record.id === OMP_PLUGIN_ID && record.source === bundledSource ? 'bundle' : undefined,
		});

		const registry = manager.refresh();

		expect(registry.records).toHaveLength(1);
		expect(registry.records[0]).toMatchObject({
			id: OMP_PLUGIN_ID,
			installOwner: 'bundle',
			enabled: false,
		});
		expect(manager.getActiveRecords()).toEqual([]);
	});

	it('does not grant first-party provenance to a spoofed OMP manifest id', () => {
		writePlugin('spoofed-omp', OMP_PLUGIN_ID);
		const manager = new PluginManager({
			isEnabled: () => true,
			resolveInstallOwner: () => undefined,
		});

		const record = manager.refresh().records[0];

		expect(record).toMatchObject({ id: OMP_PLUGIN_ID });
		expect(record?.installOwner).toBeUndefined();
	});

	it('keeps a community plugin discoverable only when the community runtime gate is enabled', () => {
		writePlugin('com.example.community', 'com.example.community');
		const disabled = new PluginManager({ isEnabled: () => false });
		const enabled = new PluginManager({ isEnabled: () => true });

		expect(disabled.refresh().records).toEqual([]);
		expect(enabled.refresh().records).toMatchObject([{ id: 'com.example.community' }]);
	});

	it('rejects reserved OMP external install, update, and uninstall actions before writes', async () => {
		const bundledSource = writePlugin(OMP_PLUGIN_ID, OMP_PLUGIN_ID);
		const externalSource = path.join(userData, 'external-omp');
		fs.mkdirSync(externalSource);
		fs.cpSync(bundledSource, externalSource, { recursive: true });
		const manager = new PluginManager({
			isEnabled: () => true,
			resolveInstallOwner: (record) =>
				record.id === OMP_PLUGIN_ID && record.source === bundledSource ? 'bundle' : undefined,
		});
		manager.refresh();

		expect(manager.install(externalSource)).toMatchObject({
			success: false,
			error: 'reserved host-provided plugin',
		});
		await expect(manager.update(externalSource)).rejects.toThrow('reserved host-provided plugin');
		expect(manager.uninstall(OMP_PLUGIN_ID)).toEqual({
			success: false,
			error: 'reserved host-provided plugin',
		});
		expect(fs.existsSync(bundledSource)).toBe(true);
	});
});
