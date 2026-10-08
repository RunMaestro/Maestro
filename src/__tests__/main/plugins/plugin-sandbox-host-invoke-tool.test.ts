/**
 * @file plugin-sandbox-host-invoke-tool.test.ts
 * @description The brokered request/response tool-invoke on the sandbox host:
 *   - invokeTool posts an `invokeTool` control message with a correlation id and
 *     resolves with the result once the child posts a matching `toolResult`,
 *   - an `ok:false` toolResult rejects with the child's error,
 *   - invoking a tool on a plugin that is not running rejects,
 *   - an outstanding invocation rejects when the child exits before replying,
 *   - the round-trip rejects when it exceeds the bounded timeout (fake timers).
 * electron's utilityProcess and the file logger are mocked so nothing is forked
 * and no log file is written; the child is the hoisted forkMock stub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { forkMock, listeners, proc } = vi.hoisted(() => {
	const listeners = new Map<string, (...a: unknown[]) => void>();
	const proc = {
		postMessage: vi.fn(),
		on: (event: string, cb: (...a: unknown[]) => void) => {
			listeners.set(event, cb);
		},
		kill: vi.fn(),
	};
	const forkMock = vi.fn(() => proc);
	return { forkMock, listeners, proc };
});

vi.mock('electron', () => ({
	utilityProcess: { fork: forkMock },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';
import { createSandboxRealm } from '../../../main/plugins/plugin-sandbox-entry';
import { PluginServiceHost } from '../../../main/plugins/plugin-service-host';
import type { PluginMediaTools } from '../../../main/plugins/plugin-media-tools';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';

const allowAll = { authorize: () => ({ allowed: true }) } as unknown as PermissionBroker;

function emit(event: string, ...args: unknown[]): void {
	const cb = listeners.get(event);
	if (!cb) throw new Error(`no listener captured for "${event}"`);
	cb(...args);
}

/** Find the most recent invokeTool control message posted to the child. */
function lastInvokeTool(): { id: number; commandId: string; args?: unknown } {
	const calls = proc.postMessage.mock.calls;
	for (let i = calls.length - 1; i >= 0; i--) {
		const m = calls[i][0] as { kind?: string };
		if (m && m.kind === 'invokeTool') {
			return m as unknown as { id: number; commandId: string; args?: unknown };
		}
	}
	throw new Error('no invokeTool control message was posted');
}

describe('PluginSandboxHost.invokeTool request/response', () => {
	let dir: string;
	let host: PluginSandboxHost;

	beforeEach(() => {
		vi.clearAllMocks();
		proc.postMessage.mockReset();
		listeners.clear();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tool-'));
		fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
		host = new PluginSandboxHost({ broker: allowAll, handlers: {} });
		host.start('p', dir, 'entry.js');
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('stop waits for actual sandbox exit and resource cleanup, including repeated callers', async () => {
		const cleanup = Promise.withResolvers<void>();
		const stopping = new PluginSandboxHost({
			broker: allowAll,
			handlers: {},
			onStop: () => cleanup.promise,
		});
		stopping.start('p', dir, 'entry.js');
		let drained = false;
		const drain = stopping.stop('p');
		void drain.then(() => {
			drained = true;
		});
		expect(stopping.stop('p')).toBe(drain);
		expect(stopping.isAcceptingServiceCalls('p')).toBe(false);
		emit('exit', 0);
		await Promise.resolve();
		expect(drained).toBe(false);
		expect(() => stopping.start('p', dir, 'entry.js')).toThrow('PluginDrainPending');
		cleanup.resolve();
		await drain;
		expect(drained).toBe(true);
		stopping.start('p', dir, 'entry.js');
		expect(stopping.isAcceptingServiceCalls('p')).toBe(true);
	});
	it('stop cannot resolve on cleanup alone before the uncooperative sandbox exits', async () => {
		vi.useFakeTimers();
		try {
			let drained = false;
			const drain = host.stop('p');
			void drain.then(() => {
				drained = true;
			});
			await vi.advanceTimersByTimeAsync(2000);
			expect(proc.kill).toHaveBeenCalledTimes(1);
			expect(drained).toBe(false);
			emit('exit', 0);
			await drain;
			expect(drained).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
	it('rejects new media/service admissions during stop while keeping release requests usable', async () => {
		const open = vi.fn();
		const cancel = vi.fn(async () => null);
		const stopping = new PluginSandboxHost({
			broker: allowAll,
			handlers: { 'media.open': open, 'services.register': open, 'services.cancel': cancel },
		});
		stopping.start('p', dir, 'entry.js');
		const drain = stopping.stop('p');
		emit('message', { id: 10, method: 'media.open', params: {} });
		emit('message', {
			id: 11,
			method: 'services.register',
			params: { serviceId: 'transcription' },
		});
		emit('message', { id: 12, method: 'services.cancel', params: { callId: 'owned' } });
		await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
		expect(open).not.toHaveBeenCalled();
		expect(proc.postMessage).toHaveBeenCalledWith({
			id: 10,
			ok: false,
			error: 'MediaCancelled',
			errorCode: 'MediaCancelled',
		});
		expect(proc.postMessage).toHaveBeenCalledWith({
			id: 11,
			ok: false,
			error: 'ServiceUnavailable',
			errorCode: 'ServiceUnavailable',
		});
		emit('exit', 0);
		await drain;
	});

	it.each([0, 1])(
		'blocks unexpected exit %s restart until the resource drain completes',
		async (code) => {
			const cleanup = Promise.withResolvers<void>();
			const crashing = new PluginSandboxHost({
				broker: allowAll,
				handlers: {},
				onCrash: () => cleanup.promise,
			});
			crashing.start('p', dir, 'entry.js');
			emit('exit', code);
			expect(() => crashing.start('p', dir, 'entry.js')).toThrow('PluginDrainPending');
			const drain = crashing.stop('p');
			cleanup.resolve();
			await drain;
			crashing.start('p', dir, 'entry.js');
			expect(crashing.isAcceptingServiceCalls('p')).toBe(true);
		}
	);

	it('retains a failed cleanup barrier after exit and denies restart', async () => {
		const stopping = new PluginSandboxHost({
			broker: allowAll,
			handlers: {},
			onStop: async () => {
				throw new Error('MediaProcessFailed');
			},
		});
		stopping.start('p', dir, 'entry.js');
		const drain = stopping.stop('p');
		emit('exit', 0);
		await expect(drain).rejects.toThrow('MediaProcessFailed');
		await expect(stopping.stop('p')).rejects.toThrow('MediaProcessFailed');
		expect(() => stopping.start('p', dir, 'entry.js')).toThrow('PluginDrainPending');
	});

	it.each(['ServiceEmpty', 'unknown', 'late-start'])(
		'preserves only allowlisted errors across provider realm, host invocation and consumer SDK (%s)',
		async (code) => {
			const cleanupGate = Promise.withResolvers<void>();
			const startReply = Promise.withResolvers<{ callId: string }>();
			let lateReservation: { callId: string } | undefined;
			const providerLogs = vi.fn();
			const provider = createSandboxRealm({
				send: (json) => {
					const req = JSON.parse(json);
					queueMicrotask(() =>
						provider.deliverResponse(JSON.stringify({ id: req.id, ok: true, result: null }))
					);
				},
				log: providerLogs,
				timerStart: vi.fn(),
				timerClear: vi.fn(),
			});
			provider.init('p');
			provider.runScript(
				code === 'late-start'
					? `module.exports={activate:function(sdk){return sdk.services.register('transcription',function(){return {text:'Guten Tag',language:'de',model:'base',durationSeconds:1,multilingual:true,translated:false};});}};`
					: `module.exports={activate: function(sdk){return sdk.services.register('transcription',function(){var err=new Error('PRIVATE_PATH_MARKER');err.code=${JSON.stringify(code)};throw err;});}};`,
				'provider-error'
			);
			await provider.activate();
			proc.postMessage.mockImplementation((message) => {
				if (message.kind !== 'invokeTool') return;
				void provider
					.invokeTool(JSON.stringify({ commandId: message.commandId, args: message.args }))
					.then((json) =>
						emit('message', { kind: 'toolResult', id: message.id, ...JSON.parse(json) })
					);
			});
			const controller = new AbortController();
			let cleaned = false;
			const manifests: Record<string, PluginManifest> = {
				p: {
					id: 'p',
					name: 'Provider',
					version: '1.0.0',
					tier: 1,
					maestro: { minHostApi: '1.24.0' },
					provides: [
						{ id: 'transcription', contract: 'maestro.audio.transcribe', version: '1.0.0' },
					],
				},
				c: {
					id: 'c',
					name: 'Consumer',
					version: '1.0.0',
					tier: 1,
					maestro: { minHostApi: '1.24.0' },
					requires: [
						{
							id: 'voice',
							provider: 'p',
							service: 'transcription',
							contract: 'maestro.audio.transcribe',
							version: '1.0.0',
							optional: true,
						},
					],
				},
			};
			const registry = new PluginServiceHost({
				manifest: (id) => manifests[id],
				running: () => true,
				allowed: () => true,
				invoke: (id, command, args, signal, timeoutMs) =>
					host.invokeTool(id, command, args, { signal, timeoutMs }),
				media: {
					delegate: () => ({
						audioId: 'provider-alias',
						expiresAt: Date.now() + 10000,
						signal: controller.signal,
						call: vi.fn(),
						close: async () => {
							controller.abort();
							if (code === 'late-start') await cleanupGate.promise;
							cleaned = true;
						},
					}),
				} as unknown as PluginMediaTools,
			});
			registry.register('p', 'transcription');
			const consumerListeners = new Map<string, (...args: unknown[]) => void>();
			const consumerProc = {
				postMessage: vi.fn((message) => {
					if (typeof message.ok === 'boolean') consumer.deliverResponse(JSON.stringify(message));
				}),
				on: (event: string, cb: (...args: unknown[]) => void) => consumerListeners.set(event, cb),
				kill: vi.fn(),
			};
			forkMock.mockReturnValueOnce(consumerProc);
			const consumerHost = new PluginSandboxHost({
				broker: allowAll,
				handlers: {
					'services.start': (id, raw) => {
						const p = raw as { requirementId: string; request: unknown };
						const reservation = registry.start(id, p.requirementId, p.request);
						if (code === 'late-start') {
							lateReservation = reservation;
							return startReply.promise;
						}
						return reservation;
					},
					'services.result': (id, raw) => registry.result(id, (raw as { callId: string }).callId),
					'services.cancel': (id, raw) => registry.cancel(id, (raw as { callId: string }).callId),
				},
			});
			const consumerLogs = vi.fn();
			const consumer = createSandboxRealm({
				send: (json) => consumerListeners.get('message')!(JSON.parse(json)),
				log: consumerLogs,
				timerStart: vi.fn(),
				timerClear: vi.fn(),
			});
			consumer.init('c');
			consumerHost.start('c', dir, 'entry.js');
			consumer.runScript(
				code === 'late-start'
					? `module.exports={activate:async function(sdk){var locallyCancelled=true;var call=await sdk.services.start('voice',{jobId:'owner-job',audioId:'owner-audio',model:'base',language:'de'});if(locallyCancelled){await sdk.services.cancel(call.callId);console.log('cancel-drained');return;}throw new Error('unexpected dispatch');}};`
					: `module.exports={activate:async function(sdk){var call=await sdk.services.start('voice',{jobId:'owner-job',audioId:'owner-audio',model:'base',language:'de'});try{await sdk.services.result(call.callId);}catch(err){console.log(err.code+':'+err.message);}}};`,
				'consumer-error'
			);
			const activation = consumer.activate();
			if (code === 'late-start') {
				await vi.waitFor(() => expect(lateReservation).toBeDefined());
				startReply.resolve(lateReservation!);
				await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
				expect(consumerLogs).not.toHaveBeenCalled();
				expect(cleaned).toBe(false);
				cleanupGate.resolve();
				await activation;
				expect(consumerLogs).toHaveBeenCalledWith('info', 'cancel-drained');
				expect(cleaned).toBe(true);
				return;
			}
			await activation;
			const expected = code === 'ServiceEmpty' ? code : 'ServiceFailed';
			expect(consumerLogs).toHaveBeenCalledWith('info', expected + ':' + expected);
			expect(providerLogs).toHaveBeenCalledWith('error', expected);
			expect(JSON.stringify(providerLogs.mock.calls)).not.toContain('PRIVATE_PATH_MARKER');
			expect(JSON.stringify(consumerProc.postMessage.mock.calls)).not.toContain(
				'PRIVATE_PATH_MARKER'
			);
			expect(cleaned).toBe(true);
		}
	);
	it('bars new service work synchronously when stop begins', async () => {
		vi.useFakeTimers();
		try {
			expect(host.isAcceptingServiceCalls('p')).toBe(true);
			host.stop('p');
			expect(host.isAcceptingServiceCalls('p')).toBe(false);
			await expect(host.invokeTool('p', 'service:transcription', {})).rejects.toThrow(
				'ServiceUnavailable'
			);
			await vi.advanceTimersByTimeAsync(2001);
		} finally {
			vi.useRealTimers();
		}
	});

	it('aborts only the service round-trip and ignores late replies while preserving ordinary tool behavior', async () => {
		const controller = new AbortController();
		const response = host.invokeTool(
			'p',
			'service:transcription',
			{},
			{ signal: controller.signal, timeoutMs: 120000 }
		);
		const assertion = expect(response).rejects.toThrow('ServiceCancelled');
		const sent = lastInvokeTool();
		controller.abort(new Error('ServiceCancelled'));
		await assertion;
		emit('message', { kind: 'toolResult', id: sent.id, ok: true, result: 'late' });
		const ordinary = host.invokeTool('p', 'lookup', {});
		emit('message', { kind: 'toolResult', id: lastInvokeTool().id, ok: true, result: 42 });
		await expect(ordinary).resolves.toBe(42);
	});
	it('reports a bounded service deadline with a stable failure code and handles pre-cancellation', async () => {
		vi.useFakeTimers();
		try {
			const controller = new AbortController();
			const response = host.invokeTool(
				'p',
				'service:transcription',
				{},
				{ signal: controller.signal, timeoutMs: 20 }
			);
			const assertion = expect(response).rejects.toThrow('ServiceTimeout');
			await vi.advanceTimersByTimeAsync(21);
			await assertion;
			controller.abort(new Error('ServiceCancelled'));
			await expect(
				host.invokeTool('p', 'service:transcription', {}, { signal: controller.signal })
			).rejects.toThrow('ServiceCancelled');
		} finally {
			vi.useRealTimers();
		}
	});

	it('resolves with the result once the child posts a matching toolResult', async () => {
		const p = host.invokeTool('p', 'lookup', { q: 'x' });
		const sent = lastInvokeTool();
		expect(sent.commandId).toBe('lookup');
		expect(sent.args).toEqual({ q: 'x' });
		expect(typeof sent.id).toBe('number');

		emit('message', { kind: 'toolResult', id: sent.id, ok: true, result: { answer: 42 } });
		await expect(p).resolves.toEqual({ answer: 42 });
	});

	it('rejects with the child error on an ok:false toolResult', async () => {
		const p = host.invokeTool('p', 'lookup', {});
		const sent = lastInvokeTool();
		emit('message', { kind: 'toolResult', id: sent.id, ok: false, error: 'boom' });
		await expect(p).rejects.toThrow('boom');
	});

	it('ignores a toolResult with an unknown correlation id', async () => {
		const p = host.invokeTool('p', 'lookup', {});
		const sent = lastInvokeTool();
		// A stray reply for a different id must not settle our pending call.
		emit('message', { kind: 'toolResult', id: sent.id + 999, ok: true, result: 'stray' });
		emit('message', { kind: 'toolResult', id: sent.id, ok: true, result: 'real' });
		await expect(p).resolves.toBe('real');
	});

	it('rejects when the plugin is not running', async () => {
		await expect(host.invokeTool('missing', 'lookup', {})).rejects.toThrow(/not running/);
	});

	it('rejects outstanding invocations when the child exits first', async () => {
		const p = host.invokeTool('p', 'lookup', {});
		emit('exit', 1);
		await expect(p).rejects.toThrow(/exited before/);
		expect(host.isRunning('p')).toBe(false);
	});

	it('rejects when the round-trip exceeds the timeout', async () => {
		vi.useFakeTimers();
		try {
			const p = host.invokeTool('p', 'slow', {});
			const assertion = expect(p).rejects.toThrow(/timed out/);
			await vi.advanceTimersByTimeAsync(30_001);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});
