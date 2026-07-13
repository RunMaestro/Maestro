import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir() },
}));

import {
	PluginManager,
	type PluginSandboxLifecycle,
	type PluginWorkspaceLifecycle,
} from '../../../main/plugins/plugin-manager';
import { pluginsDir } from '../../../main/plugins/plugin-store-main';
import type { PluginRecord } from '../../../shared/plugins/plugin-registry';

let workDir: string;
let previousUserData: string | undefined;

function writePlugin(dir: string, id: string, version = '1.0.0'): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, 'plugin.json'),
		JSON.stringify({
			id,
			name: id,
			version,
			tier: 0,
			maestro: { minHostApi: '1.0.0' },
		})
	);
}

function makeSandbox(): PluginSandboxLifecycle {
	return {
		start: vi.fn(),
		stop: vi.fn(),
		stopAll: vi.fn(),
		isRunning: vi.fn(() => false),
		runningIds: vi.fn(() => []),
		invokeCommand: vi.fn(() => false),
		invokeTool: vi.fn(async () => undefined),
	};
}

beforeEach(() => {
	previousUserData = process.env.MAESTRO_USER_DATA;
	workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-workspace-lifecycle-'));
	process.env.MAESTRO_USER_DATA = path.join(workDir, 'userData');
});

afterEach(() => {
	if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = previousUserData;
	fs.rmSync(workDir, { recursive: true, force: true });
});

describe('PluginManager workspace lifecycle reconciliation', () => {
	it('reconciles initial refresh exactly once before notifying the renderer projection', () => {
		writePlugin(path.join(pluginsDir(), 'com.maestro.omp'), 'com.maestro.omp');
		const order: string[] = [];
		const workspaceRuntime: PluginWorkspaceLifecycle = {
			reconcile: vi.fn((records: readonly PluginRecord[]) => {
				order.push(`reconcile:${records.map((record) => record.id).join(',')}`);
			}),
			teardown: vi.fn(),
			teardownAll: vi.fn(),
		};
		const onChange = vi.fn(() => order.push('change'));
		const manager = new PluginManager({ isEnabled: () => true, workspaceRuntime, onChange });

		manager.refresh();

		expect(workspaceRuntime.reconcile).toHaveBeenCalledTimes(1);
		expect(workspaceRuntime.reconcile).toHaveBeenLastCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: 'com.maestro.omp' })])
		);
		expect(order).toEqual(['reconcile:com.maestro.omp', 'change']);
	});

	it('reconciles one replacement state for install and update', async () => {
		const workspaceRuntime: PluginWorkspaceLifecycle = {
			reconcile: vi.fn(),
			teardown: vi.fn(),
			teardownAll: vi.fn(),
		};
		const manager = new PluginManager({ isEnabled: () => true, workspaceRuntime });
		const sourceV1 = path.join(workDir, 'source-v1');
		const sourceV2 = path.join(workDir, 'source-v2');
		writePlugin(sourceV1, 'sample', '1.0.0');
		writePlugin(sourceV2, 'sample', '1.0.1');

		expect(manager.install(sourceV1).success).toBe(true);
		expect(workspaceRuntime.reconcile).toHaveBeenCalledTimes(1);
		expect(vi.mocked(workspaceRuntime.reconcile).mock.calls[0]?.[0][0]?.manifest?.version).toBe(
			'1.0.0'
		);

		vi.mocked(workspaceRuntime.reconcile).mockClear();
		await manager.update(sourceV2);

		expect(workspaceRuntime.reconcile).toHaveBeenCalledTimes(1);
		expect(vi.mocked(workspaceRuntime.reconcile).mock.calls[0]?.[0][0]?.manifest?.version).toBe(
			'1.0.1'
		);
	});

	it('reconciles the disabled and uninstalled states before projecting each one', () => {
		writePlugin(path.join(pluginsDir(), 'sample'), 'sample');
		const order: string[] = [];
		const workspaceRuntime: PluginWorkspaceLifecycle = {
			reconcile: vi.fn((records: readonly PluginRecord[]) =>
				order.push(
					`reconcile:${records.map((record) => `${record.id}:${record.enabled}`).join(',')}`
				)
			),
			teardown: vi.fn(() => order.push('teardown')),
			teardownAll: vi.fn(),
		};
		const onChange = vi.fn(() => order.push('change'));
		const manager = new PluginManager({ isEnabled: () => true, workspaceRuntime, onChange });
		manager.refresh();
		vi.mocked(workspaceRuntime.reconcile).mockClear();
		order.length = 0;

		manager.setEnabled('sample', false);
		expect(workspaceRuntime.reconcile).toHaveBeenCalledTimes(1);
		expect(order).toEqual(['reconcile:sample:false', 'change']);

		vi.mocked(workspaceRuntime.reconcile).mockClear();
		order.length = 0;
		expect(manager.uninstall('sample')).toEqual({ success: true });
		expect(workspaceRuntime.reconcile).toHaveBeenCalledTimes(1);
		expect(order).toEqual(['teardown', 'reconcile:', 'change']);
	});

	it('fails closed when reconciliation throws: it clears runtime registrations before the empty projection', () => {
		writePlugin(path.join(pluginsDir(), 'sample'), 'sample');
		const order: string[] = [];
		const workspaceRuntime: PluginWorkspaceLifecycle = {
			reconcile: vi.fn(() => {
				order.push('reconcile');
				throw new Error('registration rejected');
			}),
			teardown: vi.fn(),
			teardownAll: vi.fn(() => order.push('teardownAll')),
		};
		const sandbox = makeSandbox();
		const onChange = vi.fn(() => order.push('change'));
		const manager = new PluginManager({
			isEnabled: () => true,
			workspaceRuntime,
			sandbox,
			onChange,
		});

		const registry = manager.refresh();

		expect(registry.records).toEqual([]);
		expect(manager.getRegistry().records).toEqual([]);
		expect(workspaceRuntime.reconcile).toHaveBeenCalledTimes(1);
		expect(workspaceRuntime.teardownAll).toHaveBeenCalledTimes(1);
		expect(sandbox.stopAll).toHaveBeenCalledTimes(1);
		expect(order).toEqual(['reconcile', 'teardownAll', 'change']);
	});
});
