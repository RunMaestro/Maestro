import { afterEach, describe, expect, it } from 'vitest';
import { activate, deactivate, startFromExplicitPanelAction } from '../../runtime';

afterEach(async () => deactivate());

describe('OMP plugin activation', () => {
	it('publishes setup without requesting a root or starting a runtime before explicit user action', async () => {
		let rootRequests = 0;
		let starts = 0;
		const statuses: Array<{ state: string; label: string }> = [];
		await activate({
			interactiveRuntime: {
				requestWorkspaceRoot: async () => {
					rootRequests++;
					return { opaque: true };
				},
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
				setStatus: async (status) => {
					statuses.push(status);
				},
				setBadge: async () => undefined,
			},
		});
		expect(rootRequests).toBe(0);
		expect(starts).toBe(0);
		await deactivate();
		expect(statuses).toEqual([
			{ state: 'offline', label: 'OMP setup required' },
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

it('binds a runtime generation JSONL stream to the RPC controller and publishes the ready projection', async () => {
	const writes: Array<Record<string, unknown>> = [];
	const sessions: Array<readonly unknown[]> = [];
	const statuses: Array<{ state: string; label: string }> = [];
	const panels: Array<{ kind: string; payload: unknown }> = [];
	let emit: ((event: unknown) => void) | undefined;
	let messageSequence = 0;
	let resolveMessageSubscription!: () => void;
	const messageSubscription = new Promise<void>((resolve) => {
		resolveMessageSubscription = resolve;
	});
	const emitLine = (frame: Record<string, unknown>) =>
		emit?.({ sequence: ++messageSequence, value: frame });
	await activate({
		interactiveRuntime: {
			requestWorkspaceRoot: async () => ({ opaque: true }),
			startOmpRuntime: async () => ({
				runtimeId: 'runtime-1',
				generation: 1n,
				writeCanonicalJson: async (request) => {
					const frame = request as Record<string, unknown>;
					writes.push(frame);
					if (frame.type === 'get_state') {
						emitLine({
							type: 'response',
							id: frame.id,
							command: 'get_state',
							success: true,
							data: {
								sessionId: 'session-1',
								sessionName: 'First session',
								isStreaming: false,
								isCompacting: false,
								steeringMode: 'all',
								followUpMode: 'all',
								interruptMode: 'immediate',
								autoCompactionEnabled: false,
								messageCount: 0,
								queuedMessageCount: 0,
								todoPhases: [],
							},
						});
					}
					if (frame.type === 'get_available_commands') {
						emitLine({
							type: 'response',
							id: frame.id,
							command: 'get_available_commands',
							success: true,
							data: { commands: ['new_session'] },
						});
					}
					if (frame.type === 'get_available_models') {
						emitLine({
							type: 'response',
							id: frame.id,
							command: 'get_available_models',
							success: true,
							data: { models: [] },
						});
					}
					if (frame.type === 'set_host_tools' || frame.type === 'set_host_uri_schemes') {
						emitLine({
							type: 'response',
							id: frame.id,
							command: frame.type,
							success: true,
						});
					}
				},
				onMessage: (listener) => {
					emit = listener as (event: unknown) => void;
					resolveMessageSubscription();
					emitLine({ type: 'ready' });
					return () => {
						emit = undefined;
					};
				},
				onEvent: () => () => undefined,
				stop: async () => undefined,
			}),
		},
		interactivePanel: {
			onRequest: () => () => undefined,
			resolve: async () => undefined,
			reject: async () => undefined,
			emit: async (kind, payload) => {
				panels.push({ kind, payload });
			},
		},
		workspace: {
			publishExternalSessions: async (_revision, value) => {
				sessions.push(value);
			},
			setStatus: async (status) => {
				statuses.push(status);
			},
			setBadge: async () => undefined,
		},
	});

	const starting = startFromExplicitPanelAction();
	await messageSubscription;
	await expect(starting).resolves.toBe(true);
	expect(messageSequence).toBe(6);

	expect(writes.map((frame) => frame.type)).toEqual(
		expect.arrayContaining([
			'set_host_tools',
			'set_host_uri_schemes',
			'get_state',
			'get_available_commands',
			'get_available_models',
		])
	);
	expect(sessions.at(-1)).toEqual([
		expect.objectContaining({ externalSessionId: 'session-1', status: 'idle' }),
	]);
	expect(statuses.at(-1)).toEqual({ state: 'ready', label: 'OMP ready' });
	expect(panels.at(-1)).toEqual(
		expect.objectContaining({
			kind: 'omp.view.replace',
			payload: expect.objectContaining({ sessionId: 'session-1' }),
		})
	);
});
