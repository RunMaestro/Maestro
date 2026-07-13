import { afterEach, describe, expect, it, vi } from 'vitest';
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
				consumeResource: async () => {
					throw new Error('unreachable');
				},
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

	it('resolves the first refresh with an actionable setup projection without requesting a root or starting OMP', async () => {
		let listener:
			| ((request: { kind: string; requestId: string; payload: Record<string, unknown> }) => void)
			| undefined;
		let releaseBadge!: () => void;
		const badgePending = new Promise<void>((resolve) => {
			releaseBadge = resolve;
		});
		let rootRequests = 0;
		let starts = 0;
		const resolved = vi.fn(async () => undefined);
		const rejected = vi.fn(async () => undefined);
		const activation = activate({
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
				onRequest: (registered) => {
					listener = registered as typeof listener;
					return () => undefined;
				},
				resolve: resolved,
				reject: rejected,
				emit: async () => undefined,
				consumeResource: async () => {
					throw new Error('unreachable');
				},
			},
			workspace: {
				publishExternalSessions: async () => undefined,
				setStatus: async () => undefined,
				setBadge: async () => {
					expect(listener).toBeTypeOf('function');
					listener?.({
						kind: 'omp.commands.refresh',
						requestId: 'initial-get-snapshot',
						payload: {},
					});
					return badgePending;
				},
			},
		});

		await vi.waitFor(() =>
			expect(resolved).toHaveBeenCalledWith('initial-get-snapshot', 'omp.commands.refresh', {
				connection: 'offline',
				models: [],
				sessions: [],
				activeSessionId: '',
				error: 'OMP setup required. Create a new session to start OMP.',
			})
		);
		expect(rejected).not.toHaveBeenCalled();
		expect(rootRequests).toBe(0);
		expect(starts).toBe(0);
		releaseBadge();
		await activation;
	});

	it('rolls back the panel listener and active authority when setup fails', async () => {
		const unsubscribe = vi.fn();
		await expect(
			activate({
				interactiveRuntime: {
					requestWorkspaceRoot: async () => null,
					startOmpRuntime: async () => {
						throw new Error('unreachable');
					},
				},
				interactivePanel: {
					onRequest: () => unsubscribe,
					resolve: async () => undefined,
					reject: async () => undefined,
					emit: async () => undefined,
					consumeResource: async () => {
						throw new Error('unreachable');
					},
				},
				workspace: {
					publishExternalSessions: async () => undefined,
					setStatus: async () => undefined,
					setBadge: async () => {
						throw new Error('badge unavailable');
					},
				},
			})
		).rejects.toThrow('badge unavailable');
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		await expect(startFromExplicitPanelAction()).rejects.toThrow('not active');
		await expect(deactivate()).resolves.toBeUndefined();
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
				consumeResource: async () => {
					throw new Error('unreachable');
				},
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
				consumeResource: async () => {
					throw new Error('unreachable');
				},
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
	const panelResults: Array<{ requestId: string; kind: string; payload: unknown }> = [];
	let receivePanelRequest:
		| ((request: { kind: string; requestId: string; payload: Record<string, unknown> }) => void)
		| undefined;
	let resolvePanelRequest: (() => void) | undefined;
	const panelRequestHandled = new Promise<void>((resolve) => {
		resolvePanelRequest = resolve;
	});
	const consumedBytes = new Uint8Array([97, 98, 99]);
	const mismatchedBytes = new Uint8Array([97, 98, 100]);
	const rejections: unknown[][] = [];
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
							data: { commands: [{ name: 'help', description: 'Show slash commands' }] },
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
					if (frame.type === 'prompt') {
						emitLine({
							type: 'response',
							id: frame.id,
							command: 'prompt',
							success: true,
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
				hostTools: {
					catalog: async () => [
						{
							name: 'maestro.workspace.read',
							description: 'Read a host-approved workspace file.',
							parameters: { type: 'object', additionalProperties: false },
						},
					],
					call: async () => ({ text: 'ok' }),
					cancel: async () => undefined,
				},
			}),
		},
		interactivePanel: {
			onRequest: (listener) => {
				receivePanelRequest = listener as typeof receivePanelRequest;
				return () => undefined;
			},
			resolve: async (requestId, kind, payload) => {
				panelResults.push({ requestId, kind, payload });
				resolvePanelRequest?.();
			},
			reject: async (...args) => {
				rejections.push(args);
			},
			emit: async (kind, payload) => {
				panels.push({ kind, payload });
			},
			consumeResource: async (ref) => {
				if (ref === 'f40b0d1e-2f5c-4a7f-a7c3-3e1d51fa82c7') {
					return {
						ref,
						name: 'image.png',
						mediaType: 'image/png',
						size: 3,
						sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
						bytes: mismatchedBytes,
					};
				}
				expect(ref).toBe('a3a2c574-aeb6-4ba7-9634-4f8ddbe8e1e8');
				return {
					ref,
					name: 'image.png',
					mediaType: 'image/png',
					size: 3,
					sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
					bytes: consumedBytes,
				};
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
	receivePanelRequest?.({
		kind: 'omp.prompt.send',
		requestId: 'panel-request-1',
		payload: {
			sessionId: 'session-1',
			text: 'inspect image',
			attachments: [
				{
					ref: 'a3a2c574-aeb6-4ba7-9634-4f8ddbe8e1e8',
					name: 'image.png',
					mediaType: 'image/png',
					size: 3,
					sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
				},
			],
		},
	});
	await panelRequestHandled;
	expect(writes.find((frame) => frame.type === 'prompt')).toMatchObject({
		message: 'inspect image',
		images: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }],
	});
	expect(consumedBytes).toEqual(new Uint8Array([0, 0, 0]));
	receivePanelRequest?.({
		kind: 'omp.prompt.send',
		requestId: 'panel-request-mismatch',
		payload: {
			sessionId: 'session-1',
			text: 'reject tampered image',
			attachments: [
				{
					ref: 'f40b0d1e-2f5c-4a7f-a7c3-3e1d51fa82c7',
					name: 'image.png',
					mediaType: 'image/png',
					size: 3,
					sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
				},
			],
		},
	});
	await vi.waitFor(() => expect(rejections).toHaveLength(1));
	expect(mismatchedBytes).toEqual(new Uint8Array([0, 0, 0]));

	expect(writes.map((frame) => frame.type)).toEqual(
		expect.arrayContaining([
			'set_host_tools',
			'set_host_uri_schemes',
			'get_state',
			'get_available_commands',
			'get_available_models',
		])
	);
	expect(writes.find((frame) => frame.type === 'set_host_tools')).toMatchObject({
		tools: [
			{
				name: 'maestro.workspace.read',
				parameters: { additionalProperties: false },
			},
		],
	});
	expect(sessions.at(-1)).toEqual([
		expect.objectContaining({ externalSessionId: 'session-1', status: 'idle' }),
	]);
	expect(statuses.at(-1)).toEqual({ state: 'ready', label: 'OMP ready' });
	expect(panels.at(-1)).toEqual({
		kind: 'omp.view.replace',
		payload: {
			connection: 'ready',
			models: [],
			sessions: [
				expect.objectContaining({
					id: 'session-1',
					title: 'First session',
					status: 'idle',
					model: 'OMP default',
					mode: 'build',
					events: [],
					tree: [],
					subagents: [],
					usage: { inputTokens: 0, outputTokens: 0 },
					queuedMessageCount: 0,
					todoPhases: [],
				}),
			],
			activeSessionId: 'session-1',
		},
	});
	receivePanelRequest?.({
		kind: 'omp.commands.refresh',
		requestId: 'panel-refresh',
		payload: {},
	});
	await vi.waitFor(() =>
		expect(panelResults).toContainEqual({
			requestId: 'panel-refresh',
			kind: 'omp.commands.refresh',
			payload: expect.objectContaining({
				connection: 'ready',
				models: [],
				sessions: [
					expect.objectContaining({
						id: 'session-1',
						events: [],
						tree: [],
						subagents: [],
						usage: { inputTokens: 0, outputTokens: 0 },
					}),
				],
				activeSessionId: 'session-1',
			}),
		})
	);
});
