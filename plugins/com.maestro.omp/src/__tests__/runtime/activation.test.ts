import { afterEach, describe, expect, it } from 'vitest';
import { activate, deactivate, startFromExplicitPanelAction } from '../../runtime';

afterEach(async () => deactivate());

describe('OMP plugin activation', () => {
	it('publishes setup without root prompt, then starts only after explicit panel action and stops in teardown', async () => {
		let rootRequests = 0;
		let starts = 0;
		const stopped: string[] = [];
		const statuses: Array<{ state: string; label: string }> = [];
		await activate({
			interactiveRuntime: {
				requestWorkspaceRoot: async () => {
					rootRequests++;
					return { opaque: true };
				},
				startOmpRuntime: async () => {
					starts++;
					return {
						runtimeId: 'runtime-1',
						generation: 1n,
						writeCanonicalJson: async () => undefined,
						onEvent: () => () => undefined,
						stop: async (reason) => stopped.push(reason),
					};
				},
			},
			interactivePanel: {
				onRequest: () => () => undefined,
				resolve: async () => undefined,
				reject: async () => undefined,
				emit: async () => undefined,
			},
			workspace: {
				publishExternalSessions: async () => undefined,
				setStatus: async (status) => {
					statuses.push(status);
				},
				setBadge: async () => undefined,
			},
		});
		expect(rootRequests).toBe(0);
		expect(starts).toBe(0);
		await expect(startFromExplicitPanelAction()).resolves.toBe(true);
		expect(rootRequests).toBe(1);
		expect(starts).toBe(1);
		await deactivate();
		expect(stopped).toEqual(['workspace-deactivated']);
		expect(statuses).toEqual([
			{ state: 'offline', label: 'OMP setup required' },
			{ state: 'ready', label: 'OMP ready' },
			{ state: 'offline', label: 'OMP offline' },
		]);
	});

	it('leaves setup state unchanged when explicit root consent is cancelled', async () => {
		let starts = 0;
		await activate({
			interactiveRuntime: {
				requestWorkspaceRoot: async () => null,
				startOmpRuntime: async () => {
					starts++;
					throw new Error('unreachable');
				},
			},
			interactivePanel: {
				onRequest: () => () => undefined,
				resolve: async () => undefined,
				reject: async () => undefined,
				emit: async () => undefined,
			},
			workspace: {
				publishExternalSessions: async () => undefined,
				setStatus: async () => undefined,
				setBadge: async () => undefined,
			},
		});
		await expect(startFromExplicitPanelAction()).resolves.toBe(false);
		expect(starts).toBe(0);
	});

	it('surfaces host rejection of a stale or revoked opaque root capability without accepting a path fallback', async () => {
		await activate({
			interactiveRuntime: {
				requestWorkspaceRoot: async () => ({ opaqueHostCapability: true }),
				startOmpRuntime: async () => {
					throw new Error('workspace root capability is revoked');
				},
			},
			interactivePanel: {
				onRequest: () => () => undefined,
				resolve: async () => undefined,
				reject: async () => undefined,
				emit: async () => undefined,
			},
			workspace: {
				publishExternalSessions: async () => undefined,
				setStatus: async () => undefined,
				setBadge: async () => undefined,
			},
		});

		await expect(startFromExplicitPanelAction()).rejects.toThrow(/revoked/);
	});
});
