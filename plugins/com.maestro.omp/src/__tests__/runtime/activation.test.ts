import { afterEach, describe, expect, it } from 'vitest';
import { activate, deactivate, startFromExplicitPanelAction } from '../../runtime';

afterEach(async () => deactivate());

describe('OMP plugin activation', () => {
	it('publishes setup without root prompt, then starts only after explicit panel action and stops in teardown', async () => {
		let rootRequests = 0;
		let starts = 0;
		const stopped: string[] = [];
		const statuses: string[] = [];
		await activate({
			interactiveRuntime: {
				requestWorkspaceRoot: async () => {
					rootRequests++;
					return { opaque: true };
				},
				startOmpRuntime: async () => {
					starts++;
					return {
						writeCanonicalJson: () => undefined,
						onEvent: () => () => undefined,
						stop: async (reason) => stopped.push(reason),
					};
				},
			},
			workspace: {
				publishExternalSessions: () => undefined,
				setStatus: (status) => statuses.push(status),
				setBadge: () => undefined,
			},
		});
		expect(rootRequests).toBe(0);
		expect(starts).toBe(0);
		await expect(startFromExplicitPanelAction()).resolves.toBe(true);
		expect(rootRequests).toBe(1);
		expect(starts).toBe(1);
		await deactivate();
		expect(stopped).toEqual(['deactivate']);
		expect(statuses).toEqual(['offline', 'ready', 'offline']);
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
			workspace: {},
		});
		await expect(startFromExplicitPanelAction()).resolves.toBe(false);
		expect(starts).toBe(0);
	});
});
