import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

import {
	PluginManager,
	type PluginExecutionSnapshot,
	type PluginSandboxLifecycle,
} from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';
import { OMP_PLUGIN_ID } from '../../../main/plugins/plugin-trust-root-service';
import type { PluginRecord } from '../../../shared/plugins/plugin-registry';

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

function resolveVerifiedBundledTrust(source: string) {
	return (record: Pick<PluginRecord, 'id' | 'source'>) =>
		record.id === OMP_PLUGIN_ID && record.source === source
			? {
					installOwner: 'bundle' as const,
					signature: {
						status: 'trusted' as const,
						signerKey: 'immutable-first-party-public-key',
						detail: 'verified immutable bundled artifact (first-party-key-id)',
					},
				}
			: undefined;
}

function immutableSnapshot(): PluginExecutionSnapshot {
	return {
		identity: {
			artifactDigest: 'a'.repeat(64),
			authorizationContentHash: 'b'.repeat(64),
			authorizationSignerKey: 'immutable-first-party-public-key',
			signerKeyId: 'first-party-key-id',
		},
		text: (filePath) => (filePath === 'main.js' ? 'module.exports = {};' : null),
		release: () => undefined,
	};
}

function sandbox(): PluginSandboxLifecycle {
	const running = new Set<string>();
	return {
		start: vi.fn((pluginId: string) => running.add(pluginId)),
		stop: vi.fn((pluginId: string) => running.delete(pluginId)),
		stopAll: vi.fn(() => running.clear()),
		isRunning: vi.fn((pluginId: string) => running.has(pluginId)),
		runningIds: vi.fn(() => [...running]),
		invokeCommand: vi.fn(() => false),
		invokeTool: vi.fn(async () => undefined),
	};
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
	it('projects immutable bundled proof as trusted when materialized OMP has no directory signature', () => {
		const bundledSource = writePlugin(OMP_PLUGIN_ID, OMP_PLUGIN_ID);
		const manager = new PluginManager({
			isEnabled: () => false,
			resolveBundledPluginTrust: resolveVerifiedBundledTrust(bundledSource),
		});

		const registry = manager.refresh();

		expect(registry.records).toHaveLength(1);
		expect(registry.records[0]).toMatchObject({
			id: OMP_PLUGIN_ID,
			installOwner: 'bundle',
			enabled: false,
			signature: {
				status: 'trusted',
				signerKey: 'immutable-first-party-public-key',
				detail: 'verified immutable bundled artifact (first-party-key-id)',
			},
		});
		expect(manager.getActiveRecords()).toEqual([]);
	});

	it('does not grant first-party provenance to a spoofed OMP manifest id', () => {
		const spoofedSource = writePlugin('spoofed-omp', OMP_PLUGIN_ID);
		const manager = new PluginManager({
			isEnabled: () => true,
			resolveBundledPluginTrust: resolveVerifiedBundledTrust(
				path.join(pluginsDir(), OMP_PLUGIN_ID)
			),
		});

		const record = manager.refresh().records[0];

		expect(record).toMatchObject({
			id: OMP_PLUGIN_ID,
			source: spoofedSource,
			signature: { status: 'unsigned' },
		});
		expect(record?.installOwner).toBeUndefined();
	});

	it('keeps a community plugin discoverable only when the community runtime gate is enabled', () => {
		writePlugin('com.example.community', 'com.example.community');
		const disabled = new PluginManager({ isEnabled: () => false });
		const enabled = new PluginManager({ isEnabled: () => true });

		expect(disabled.refresh().records).toEqual([]);
		expect(enabled.refresh().records).toMatchObject([{ id: 'com.example.community' }]);
	});

	it('does not project bundle trust to a community record even if an injected resolver misbehaves', () => {
		writePlugin('com.example.community', 'com.example.community');
		const manager = new PluginManager({
			isEnabled: () => true,
			resolveBundledPluginTrust: () => ({
				installOwner: 'bundle',
				signature: {
					status: 'trusted',
					signerKey: 'forged-resolver-key',
					detail: 'forged resolver result',
				},
			}),
		});

		expect(manager.refresh().records[0]).toMatchObject({
			id: 'com.example.community',
			signature: { status: 'unsigned' },
		});
	});

	it('starts bundled OMP through the ordinary trusted tier-1 gate after consent enables it', () => {
		const bundledSource = writePlugin(OMP_PLUGIN_ID, OMP_PLUGIN_ID);
		const runtime = sandbox();
		const manager = new PluginManager({
			isEnabled: () => true,
			resolveBundledPluginTrust: resolveVerifiedBundledTrust(bundledSource),
			snapshotFor: () => immutableSnapshot(),
			sandbox: runtime,
		});

		manager.refresh();
		manager.setEnabled(OMP_PLUGIN_ID, true);

		expect(runtime.start).toHaveBeenCalledWith(
			OMP_PLUGIN_ID,
			'module.exports = {};',
			expect.objectContaining({
				authorizationSignerKey: 'immutable-first-party-public-key',
			})
		);
	});

	it('exposes a bundled authorization snapshot only while exact provenance remains verified', () => {
		const bundledSource = writePlugin(OMP_PLUGIN_ID, OMP_PLUGIN_ID);
		const snapshot = immutableSnapshot();
		let provenanceIsCurrent = true;
		const manager = new PluginManager({
			isEnabled: () => false,
			resolveBundledPluginTrust: (record) =>
				provenanceIsCurrent && record.id === OMP_PLUGIN_ID && record.source === bundledSource
					? {
							installOwner: 'bundle',
							signature: {
								status: 'trusted',
								signerKey: snapshot.identity.authorizationSignerKey,
								detail: 'verified immutable bundled artifact',
							},
						}
					: undefined,
			snapshotFor: (pluginId) => (pluginId === OMP_PLUGIN_ID ? snapshot : null),
		});

		const record = manager.refresh().records[0];
		expect(manager.getVerifiedBundledExecutionSnapshot(record!)).toBe(snapshot);

		provenanceIsCurrent = false;
		expect(manager.getVerifiedBundledExecutionSnapshot(record!)).toBeNull();
		expect(
			manager.getVerifiedBundledExecutionSnapshot({ ...record!, installOwner: 'external' })
		).toBeNull();
	});

	it('rejects reserved OMP external install, update, and uninstall actions before writes', async () => {
		const bundledSource = writePlugin(OMP_PLUGIN_ID, OMP_PLUGIN_ID);
		const externalSource = path.join(userData, 'external-omp');
		fs.mkdirSync(externalSource);
		fs.cpSync(bundledSource, externalSource, { recursive: true });
		const manager = new PluginManager({
			isEnabled: () => true,
			resolveBundledPluginTrust: resolveVerifiedBundledTrust(bundledSource),
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
