// Source: src/__tests__/main/plugins/plugin-scan.test.ts
// Source: src/__tests__/main/plugins/plugin-background-supervisor.test.ts
// Source: src/__tests__/main/plugins/plugin-event-bus.test.ts
// Source: src/__tests__/main/plugins/plugin-host-view-registry.test.ts
// Source: src/__tests__/main/plugins/plugin-scheduler-host.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { afterAll } from 'vitest';
import { beforeAll } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
import { PluginFileScanner } from '../../../main/plugins/plugin-scan';
import { pluginIdentity } from '../../../main/plugins/plugin-identity';
import { buildSigningPayload } from '../../../shared/plugins/signing';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { PluginBackgroundSupervisor } from '../../../main/plugins/plugin-background-supervisor';
import type { PluginBackgroundSupervisorDeps } from '../../../main/plugins/plugin-background-supervisor';
import { PluginEventBusImpl } from '../../../main/plugins/plugin-event-bus';
import type { PluginEvent } from '../../../shared/plugins/events';
import type { PluginEventTopic } from '../../../shared/plugins/events';
import { collectContributions } from '../../../shared/plugins/contributions';
import type { HostViewContribution } from '../../../shared/plugins/contributions';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';
import { applyMovementPayload } from '../../../renderer/stores/movementStore';
import { useMovementStore } from '../../../renderer/stores/movementStore';
import { PluginHostViewRegistry } from '../../../main/plugins/plugin-host-view-registry';
import type { HostViewMutation } from '../../../main/plugins/plugin-host-view-registry';
import { forwardPluginHostViewToRenderer } from '../../../main/plugins/plugin-host-view-forwarder';
import { PluginSchedulerHost } from '../../../main/plugins/plugin-scheduler-host';
import relayRelease from '../../shared/plugins/fixtures/relay-release-question.json';
import { schedulerNowFromDate } from '../../../shared/plugins/plugin-scheduler';
import { evaluateScheduledDispatch } from '../../../shared/plugins/plugin-dispatch-gate';
import type { CueTriggerContribution } from '../../../shared/plugins/contributions';
describeSourceSuite('plugin-scan', () => {
	let dir: string, script: string, pluginDir: string, key: string;
	beforeAll(async () => {
		const scratch = path.resolve('.maestro/scratch');
		fs.mkdirSync(scratch, { recursive: true });
		dir = fs.mkdtempSync(path.join(scratch, 'fresh-plugin-worker-'));
		script = path.join(dir, 'worker.cjs');
		await build({
			entryPoints: [path.resolve('src/main/plugins/plugin-scan-worker.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			outfile: script,
		});
		pluginDir = path.join(dir, 'plugin');
		fs.mkdirSync(pluginDir);
		const files: Record<string, string> = {},
			bytes = Buffer.alloc(4096, 65);
		const payload = path.join(dir, 'payload');
		fs.writeFileSync(payload, bytes);
		const hash = createHash('sha256').update(bytes).digest('hex');
		await Promise.all(
			Array.from({ length: 32 }, async (_, offset) => {
				for (let i = offset; i < 5000; i += 32) {
					const name = 'file-' + i;
					await fs.promises.copyFile(payload, path.join(pluginDir, name));
					files[name] = hash;
				}
			})
		);
		const pair = generateKeyPairSync('ed25519');
		key = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
		fs.writeFileSync(
			path.join(pluginDir, 'signature.json'),
			JSON.stringify({
				algorithm: 'ed25519',
				publicKey: key,
				signature: sign(null, Buffer.from(buildSigningPayload(files)), pair.privateKey).toString(
					'base64'
				),
				files,
			})
		);
	});
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
	describe('fresh off-main plugin verification', () => {
		it('allows the event loop to run during a real signed5000-file/20480000-byte scan and rejects next-call tampering', async () => {
			const scanner = new PluginFileScanner(script);
			const baselineStart = performance.now();
			const baselineTimer = new Promise<number>((resolve) =>
				setTimeout(() => resolve(performance.now() - baselineStart), 0)
			);
			const baseline = pluginIdentity(pluginDir, [key]);
			const baselineElapsedMs = performance.now() - baselineStart;
			const baselineTimerDelayMs = await baselineTimer;
			expect(baseline?.signatureStatus).toBe('trusted');
			let ticks = 0,
				maxDelay = 0,
				last = performance.now();
			const timer = setInterval(() => {
				const now = performance.now();
				maxDelay = Math.max(maxDelay, now - last);
				last = now;
				ticks++;
			}, 1);
			const start = performance.now();
			try {
				const pending = scanner.scan(pluginDir, [key]);
				expect(
					await Promise.race([
						pending.then(() => 'scan'),
						new Promise((resolve) => setTimeout(() => resolve('timer'), 0)),
					])
				).toBe('timer');
				const first = await pending;
				expect(first.identity).toEqual(baseline);
				expect(ticks).toBeGreaterThan(1);
				const metrics = {
					fixtureFiles: 5000,
					fixtureBytes: 20480000,
					baselineElapsedMs,
					baselineTimerDelayMs,
					elapsedMs: performance.now() - start,
					eventLoopTicks: ticks,
					maxTimerGapMs: maxDelay,
				};
				if (process.env.MAESTRO_PLUGIN_SCAN_BENCHMARK)
					fs.writeFileSync(
						process.env.MAESTRO_PLUGIN_SCAN_BENCHMARK,
						JSON.stringify(metrics, null, 2)
					);

				fs.writeFileSync(path.join(pluginDir, 'file-1'), 'tampered');
				expect((await scanner.scan(pluginDir, [key])).identity?.signatureStatus).toBe('invalid');
			} finally {
				clearInterval(timer);
			}
		});
		it('fails closed when worker construction/loading fails, with no inline fallback', async () => {
			const scanner = new PluginFileScanner(path.join(dir, 'missing-worker.cjs'));
			await expect(scanner.scan(pluginDir, [key])).rejects.toThrow(/unavailable/);
		});
	});
});
describeSourceSuite('plugin-background-supervisor', () => {
	// Mirror the (unexported) source constants so timing assertions stay in sync.
	const MAX_RESTARTS = 5;
	const BACKOFF_BASE_MS = 1000;
	const BACKOFF_CAP_MS = 30_000;
	const STABLE_RUN_MS = 60_000;

	let restartPlugin: ReturnType<typeof vi.fn>;
	let enabled: Set<string>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		restartPlugin = vi.fn();
		enabled = new Set(['p']);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makeSupervisor(over: Partial<PluginBackgroundSupervisorDeps> = {}) {
		return new PluginBackgroundSupervisor({
			restartPlugin,
			isPluginEnabled: (id) => enabled.has(id),
			...over,
		});
	}

	describe('register / unregister', () => {
		it('registers with a caller id, generates one when absent, and reports running', () => {
			const sup = makeSupervisor();
			expect(sup.register('p', { id: 'svc' })).toEqual({ serviceId: 'svc' });
			const generated = sup.register('p', {});
			expect(generated.serviceId).toMatch(/^bg_/);

			const health = sup.health('p');
			expect(health.state).toBe('running');
			expect(health.restarts).toBe(0);
			expect(health.services.map((s) => s.id)).toContain('svc');
			expect(health.services).toHaveLength(2);
		});

		it('caps services per plugin but allows idempotent re-registration at the cap', () => {
			const sup = makeSupervisor();
			for (let i = 0; i < 16; i++) sup.register('p', { id: `svc${i}` });
			expect(() => sup.register('p', { id: 'one-too-many' })).toThrow(/limit reached/);
			// Same id again is a re-registration, not growth.
			expect(sup.register('p', { id: 'svc0' })).toEqual({ serviceId: 'svc0' });
			expect(sup.health('p').services).toHaveLength(16);
		});

		it('unregister removes one service; unknown ids report false; last one leaves supervision', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'a' });
			sup.register('p', { id: 'b' });
			expect(sup.unregister('p', 'nope')).toBe(false);
			expect(sup.unregister('p', 'a')).toBe(true);
			expect(sup.unregister('p', 'a')).toBe(false);
			expect(sup.unregister('p', 'b')).toBe(true);

			// Fully unregistered: a later crash restarts nothing.
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
			expect(restartPlugin).not.toHaveBeenCalled();
			expect(sup.healthAll()).toEqual([]);
		});

		it('bounds a hostile service name and ignores non-string ids', () => {
			const sup = makeSupervisor();
			const { serviceId } = sup.register('p', { id: 42 as unknown, name: 'x'.repeat(500) });
			expect(serviceId).toMatch(/^bg_/);
			expect(sup.health('p').services[0].name).toHaveLength(200);
		});
	});

	describe('crash -> bounded-backoff restart', () => {
		it('restarts the owning plugin after the first backoff; re-registration restores running', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });

			sup.onPluginCrash('p', 1);
			const afterCrash = sup.health('p');
			expect(afterCrash.state).toBe('restarting');
			expect(afterCrash.restarts).toBe(1);
			// Registrations died with the child.
			expect(afterCrash.services).toEqual([]);
			expect(afterCrash.lastError).toMatch(/code 1/);

			// Not yet: backoff base is 1s.
			vi.advanceTimersByTime(BACKOFF_BASE_MS - 1);
			expect(restartPlugin).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(restartPlugin).toHaveBeenCalledTimes(1);
			expect(restartPlugin).toHaveBeenCalledWith('p');

			// The restarted child's activate path re-registers -> running again.
			sup.register('p', { id: 'svc' });
			const recovered = sup.health('p');
			expect(recovered.state).toBe('running');
			expect(recovered.services.map((s) => s.id)).toEqual(['svc']);
			expect(recovered.lastError).toBeUndefined();
		});

		it.each(['stop', 'replace'] as const)(
			'late crash drain cannot restart supervision after %s',
			async (mode) => {
				const sup = makeSupervisor();
				const gate = Promise.withResolvers<void>();
				sup.register('p', { id: 'svc' });
				sup.onPluginCrash('p', 1, gate.promise);
				if (mode === 'stop') sup.onPluginStopped('p');
				else {
					sup.teardown('p');
					sup.register('p', { id: 'new-svc' });
				}
				gate.resolve();
				await vi.advanceTimersByTimeAsync(BACKOFF_CAP_MS * 2);
				expect(restartPlugin).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
				expect(sup.health('p').state).toBe(mode === 'stop' ? 'stopped' : 'running');
			}
		);

		it('doubles the backoff per consecutive failure and caps the delay', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });

			// Failure 1 -> 1s, failure 2 -> 2s, failure 3 -> 4s.
			for (const delay of [1000, 2000, 4000]) {
				sup.onPluginCrash('p', 1);
				vi.advanceTimersByTime(delay - 1);
				const before = restartPlugin.mock.calls.length;
				vi.advanceTimersByTime(1);
				expect(restartPlugin.mock.calls.length).toBe(before + 1);
			}
			// Failures 4 and 5 -> 8s, 16s; a 6th would exceed MAX_RESTARTS.
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(8000);
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(16_000);
			expect(restartPlugin).toHaveBeenCalledTimes(MAX_RESTARTS);
		});

		it('a crash while restarting (child died before re-registering) burns another attempt', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(BACKOFF_BASE_MS);
			expect(restartPlugin).toHaveBeenCalledTimes(1);

			// Restarted child crashes again WITHOUT registering.
			sup.onPluginCrash('p', 9);
			expect(sup.health('p').restarts).toBe(2);
			vi.advanceTimersByTime(2000);
			expect(restartPlugin).toHaveBeenCalledTimes(2);
		});

		it('marks failed-permanent after MAX_RESTARTS consecutive failures and stops retrying', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });

			for (let i = 0; i < MAX_RESTARTS; i++) {
				sup.onPluginCrash('p', 1);
				vi.advanceTimersByTime(BACKOFF_CAP_MS);
			}
			expect(restartPlugin).toHaveBeenCalledTimes(MAX_RESTARTS);

			sup.onPluginCrash('p', 1);
			expect(sup.health('p').state).toBe('failed-permanent');
			vi.advanceTimersByTime(BACKOFF_CAP_MS * 4);
			expect(restartPlugin).toHaveBeenCalledTimes(MAX_RESTARTS);

			// failed-permanent is terminal for crashes: further crash events are ignored.
			sup.onPluginCrash('p', 1);
			expect(sup.health('p').state).toBe('failed-permanent');
		});

		it('a stable run resets the failure streak', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(BACKOFF_BASE_MS);
			sup.register('p', { id: 'svc' });
			expect(sup.health('p').restarts).toBe(1);

			// Runs stably past the threshold, then dies: streak resets, then +1.
			vi.advanceTimersByTime(STABLE_RUN_MS);
			sup.onPluginCrash('p', 1);
			expect(sup.health('p').restarts).toBe(1);
		});

		it('never restarts a plugin disabled mid-backoff', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginCrash('p', 1);
			enabled.delete('p');
			vi.advanceTimersByTime(BACKOFF_CAP_MS);
			expect(restartPlugin).not.toHaveBeenCalled();
			expect(sup.health('p').state).toBe('stopped');
		});

		it('a crash with no registered services restarts nothing', () => {
			const sup = makeSupervisor();
			sup.onPluginCrash('ghost', 1);
			vi.advanceTimersByTime(BACKOFF_CAP_MS);
			expect(restartPlugin).not.toHaveBeenCalled();
			expect(sup.healthAll()).toEqual([]);
		});

		it('catches an asynchronously rejected restart and retries, but never after teardown', async () => {
			restartPlugin.mockRejectedValueOnce(new Error('async refresh failed'));
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginCrash('p', 1);
			await vi.advanceTimersByTimeAsync(BACKOFF_BASE_MS);
			expect(sup.health('p').lastError).toBe('async refresh failed');
			await vi.advanceTimersByTimeAsync(2000);
			expect(restartPlugin).toHaveBeenCalledTimes(2);
			sup.stopAll();
		});
		it('a throwing restart hook schedules the next attempt instead of losing the plugin', () => {
			restartPlugin.mockImplementationOnce(() => {
				throw new Error('refresh failed');
			});
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(BACKOFF_BASE_MS);
			expect(sup.health('p').state).toBe('restarting');
			expect(sup.health('p').lastError).toMatch(/refresh failed/);
			vi.advanceTimersByTime(2000);
			expect(restartPlugin).toHaveBeenCalledTimes(2);
		});
	});

	describe('intentional stop / teardown', () => {
		it('onPluginStopped (disable/reload) clears services and the exit is never a crash', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginStopped('p');

			const health = sup.health('p');
			expect(health.state).toBe('stopped');
			expect(health.services).toEqual([]);
			expect(health.restarts).toBe(0);

			// The stopped child's exit event (possibly non-zero on hard-kill) arrives
			// after the stop: it must NOT schedule a restart.
			sup.onPluginCrash('p', 1);
			vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
			expect(restartPlugin).not.toHaveBeenCalled();
			expect(sup.health('p').state).toBe('stopped');
		});

		it('onPluginStopped cancels a pending backoff restart', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginCrash('p', 1);
			expect(sup.health('p').state).toBe('restarting');

			sup.onPluginStopped('p');
			vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
			expect(restartPlugin).not.toHaveBeenCalled();
			expect(sup.health('p').state).toBe('stopped');
		});

		it('teardown (uninstall) forgets the plugin entirely, mid-backoff included', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc' });
			sup.onPluginCrash('p', 1);
			sup.teardown('p');

			vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
			expect(restartPlugin).not.toHaveBeenCalled();
			expect(sup.healthAll()).toEqual([]);
			// Fresh default for an unknown plugin.
			expect(sup.health('p')).toEqual({
				pluginId: 'p',
				state: 'stopped',
				restarts: 0,
				services: [],
			});
		});

		it('stopAll (app quit) cancels every pending restart across plugins', () => {
			const sup = makeSupervisor();
			enabled.add('q');
			sup.register('p', { id: 'a' });
			sup.register('q', { id: 'b' });
			sup.onPluginCrash('p', 1);
			sup.onPluginCrash('q', 1);

			sup.stopAll();
			vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
			expect(restartPlugin).not.toHaveBeenCalled();
			expect(sup.healthAll()).toEqual([]);
		});
	});

	describe('health reporting', () => {
		it('returns fresh serializable objects, never internal references', () => {
			const sup = makeSupervisor();
			sup.register('p', { id: 'svc', name: 'poller' });
			const a = sup.health('p');
			a.services[0].name = 'mutated';
			expect(sup.health('p').services[0].name).toBe('poller');
		});

		it('healthAll includes restarting and failed plugins', () => {
			const sup = makeSupervisor();
			enabled.add('q');
			sup.register('p', { id: 'a' });
			sup.register('q', { id: 'b' });
			sup.onPluginCrash('p', 1);

			const all = sup.healthAll();
			expect(all).toHaveLength(2);
			const states = new Map(all.map((h) => [h.pluginId, h.state]));
			expect(states.get('p')).toBe('restarting');
			expect(states.get('q')).toBe('running');
		});
	});
});
describeSourceSuite('plugin-event-bus', () => {
	function ev(topic: PluginEventTopic, payload: unknown = {}): PluginEvent {
		return { topic, at: '2026-01-01T00:00:00Z', payload } as PluginEvent;
	}

	describe('PluginEventBusImpl', () => {
		it('subscribe keeps only catalog topics and reports the registered set', () => {
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
			const res = bus.subscribe('p', [
				'session.created',
				'not.a.topic',
				'cue.fired',
			] as unknown as PluginEventTopic[]);
			expect(res.topics.sort()).toEqual(['cue.fired', 'session.created']);
		});

		it('emit fans out only to subscribers of that topic', () => {
			const push = vi.fn(() => true);
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
			bus.subscribe('a', ['session.created']);
			bus.subscribe('b', ['cue.fired']);
			const e = ev('session.created', { sessionId: 's1' });
			bus.emit(e);
			expect(push).toHaveBeenCalledTimes(1);
			expect(push).toHaveBeenCalledWith('a', e);
		});

		it('RE-AUTHORIZES every delivery and prunes a revoked subscriber', () => {
			let permitted = true;
			const push = vi.fn(() => true);
			const bus = new PluginEventBusImpl({ isPermitted: () => permitted, push });
			bus.subscribe('a', ['agent.awaiting']);
			bus.emit(ev('agent.awaiting', { agentId: 'x' }));
			expect(push).toHaveBeenCalledTimes(1);

			permitted = false; // grant revoked between deliveries
			bus.emit(ev('agent.awaiting', { agentId: 'x' }));
			expect(push).toHaveBeenCalledTimes(1);
			expect(bus.topicsFor('a')).toEqual([]);

			permitted = true; // re-granting does NOT resurrect the pruned subscription
			bus.emit(ev('agent.awaiting', { agentId: 'x' }));
			expect(push).toHaveBeenCalledTimes(1);
		});

		it('prunes a subscriber whose sink reports it is gone', () => {
			const push = vi.fn(() => false); // plugin not running
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
			bus.subscribe('a', ['session.removed']);
			bus.emit(ev('session.removed', { sessionId: 's' }));
			expect(push).toHaveBeenCalledTimes(1);
			expect(bus.topicsFor('a')).toEqual([]);
		});

		it('unsubscribe removes specific topics or all; clear drops everything', () => {
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
			bus.subscribe('a', ['session.created', 'session.updated']);
			bus.unsubscribe('a', ['session.created']);
			expect(bus.topicsFor('a')).toEqual(['session.updated']);
			bus.unsubscribe('a');
			expect(bus.topicsFor('a')).toEqual([]);
			bus.subscribe('a', ['cue.fired']);
			bus.clear('a');
			expect(bus.topicsFor('a')).toEqual([]);
		});

		it('ignores an emit for an unknown topic', () => {
			const push = vi.fn(() => true);
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
			bus.subscribe('a', ['session.created']);
			bus.emit({ topic: 'bogus', at: 'now', payload: {} } as unknown as PluginEvent);
			expect(push).not.toHaveBeenCalled();
		});

		it('strips non-primitive payload fields, delivering metadata only', () => {
			let received: PluginEvent | undefined;
			const push = vi.fn((_id: string, e: PluginEvent) => {
				received = e;
				return true;
			});
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
			bus.subscribe('a', ['session.created']);
			bus.emit(
				ev('session.created', {
					sessionId: 's1',
					title: 'hello',
					count: 2,
					ok: true,
					empty: null,
					nested: { secret: 'transcript text' },
					list: ['a', 'b'],
					fn: () => 'x',
				})
			);
			expect(push).toHaveBeenCalledTimes(1);
			expect(received?.payload).toEqual({
				sessionId: 's1',
				title: 'hello',
				count: 2,
				ok: true,
				empty: null,
			});
		});

		it('delivers tool.executed metadata and strips a smuggled state object', () => {
			let received: PluginEvent | undefined;
			const push = vi.fn((_id: string, e: PluginEvent) => {
				received = e;
				return true;
			});
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
			bus.subscribe('a', ['tool.executed']);
			bus.emit(
				ev('tool.executed', {
					sessionId: 's1',
					toolName: 'Read',
					toolCallId: 'call-1',
					phase: 'completed',
					timestamp: 1700000000000,
					// A buggy emit site smuggling the tool's state blob: must not survive.
					state: { input: { path: '/etc/passwd' }, output: 'file contents' },
				})
			);
			expect(push).toHaveBeenCalledTimes(1);
			expect(received?.payload).toEqual({
				sessionId: 's1',
				toolName: 'Read',
				toolCallId: 'call-1',
				phase: 'completed',
				timestamp: 1700000000000,
			});
			expect(received?.payload).not.toHaveProperty('state');
		});

		it('drops the entire payload when it exceeds the serialized size cap', () => {
			let received: PluginEvent | undefined;
			const push = vi.fn((_id: string, e: PluginEvent) => {
				received = e;
				return true;
			});
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
			bus.subscribe('a', ['cue.fired']);
			bus.emit(ev('cue.fired', { cueType: 'x'.repeat(20000) }));
			expect(push).toHaveBeenCalledTimes(1);
			expect(received?.payload).toEqual({});
		});

		describe('per-topic capability gating (FC4)', () => {
			it('withholds history.entryAdded from a subscriber without history:read', () => {
				const push = vi.fn(() => true);
				const onDelivery = vi.fn();
				const bus = new PluginEventBusImpl({
					isPermitted: () => true,
					hasCapability: () => false, // holds events:subscribe but NOT history:read
					push,
					onDelivery,
				});
				bus.subscribe('a', ['history.entryAdded']);
				bus.emit(ev('history.entryAdded', { entryId: 'e1', kind: 'AUTO' }));
				expect(push).not.toHaveBeenCalled();
				expect(onDelivery).toHaveBeenCalledWith('a', 'history.entryAdded', false);
				// Withheld, NOT pruned: a later grant resumes delivery.
				expect(bus.topicsFor('a')).toEqual(['history.entryAdded']);
			});

			it('delivers history.entryAdded to a subscriber holding history:read', () => {
				const push = vi.fn(() => true);
				const bus = new PluginEventBusImpl({
					isPermitted: () => true,
					hasCapability: (_pluginId, capability) => capability === 'history:read',
					push,
				});
				bus.subscribe('a', ['history.entryAdded']);
				bus.emit(ev('history.entryAdded', { entryId: 'e1', kind: 'AUTO' }));
				expect(push).toHaveBeenCalledTimes(1);
			});

			it('gates agent.completed on agents:read', () => {
				const push = vi.fn(() => true);
				const capable = vi.fn(
					(_pluginId: string, capability: string) => capability === 'agents:read'
				);
				const bus = new PluginEventBusImpl({
					isPermitted: () => true,
					hasCapability: capable,
					push,
				});
				bus.subscribe('a', ['agent.completed']);
				bus.emit(ev('agent.completed', { sessionId: 's1', status: 'completed' }));
				expect(capable).toHaveBeenCalledWith('a', 'agents:read');
				expect(push).toHaveBeenCalledTimes(1);
			});

			it('FAILS CLOSED: gated topics reach nobody when no hasCapability dep is wired', () => {
				const push = vi.fn(() => true);
				const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
				bus.subscribe('a', ['history.entryAdded', 'agent.completed']);
				bus.emit(ev('history.entryAdded', { entryId: 'e1' }));
				bus.emit(ev('agent.completed', { sessionId: 's1', status: 'completed' }));
				expect(push).not.toHaveBeenCalled();
			});

			it('re-checks the capability on EVERY delivery (instant revoke, instant re-grant)', () => {
				let granted = true;
				const push = vi.fn(() => true);
				const bus = new PluginEventBusImpl({
					isPermitted: () => true,
					hasCapability: () => granted,
					push,
				});
				bus.subscribe('a', ['history.entryAdded']);
				bus.emit(ev('history.entryAdded', { entryId: 'e1' }));
				expect(push).toHaveBeenCalledTimes(1);

				granted = false; // capability revoked between deliveries
				bus.emit(ev('history.entryAdded', { entryId: 'e2' }));
				expect(push).toHaveBeenCalledTimes(1);

				granted = true; // re-grant: subscription survived, delivery resumes
				bus.emit(ev('history.entryAdded', { entryId: 'e3' }));
				expect(push).toHaveBeenCalledTimes(2);
			});

			it('leaves ungated topics untouched by the capability checker', () => {
				const push = vi.fn(() => true);
				const capable = vi.fn(() => false);
				const bus = new PluginEventBusImpl({
					isPermitted: () => true,
					hasCapability: capable,
					push,
				});
				bus.subscribe('a', ['agent.exited', 'session.created']);
				bus.emit(ev('agent.exited', { sessionId: 's1', exitCode: 0 }));
				bus.emit(ev('session.created', { sessionId: 's1' }));
				expect(push).toHaveBeenCalledTimes(2);
				expect(capable).not.toHaveBeenCalled();
			});
		});
	});
});
describeSourceSuite('plugin-host-view-registry', () => {
	function tierZeroManifest(): PluginManifest {
		return {
			id: 'com.example.static-view',
			name: 'Static View',
			version: '1.0.0',
			tier: 0,
			maestro: { minHostApi: '1.0.0' },
			contributes: {
				hostViews: [
					{
						id: 'status',
						surface: 'movement',
						title: 'Static status',
						blocks: [{ kind: 'heading', text: 'Ready' }],
					},
				],
			},
		};
	}

	function forwardToMovement(mutation: HostViewMutation): boolean {
		if (mutation.view.surface !== 'movement') return true;
		if (mutation.kind === 'remove') {
			applyMovementPayload({ op: 'remove', id: mutation.view.id });
			return true;
		}
		applyMovementPayload({
			op: 'add',
			id: mutation.view.id,
			title: mutation.view.title,
			body: JSON.stringify(mutation.blocks),
		});
		return true;
	}

	beforeEach(() => {
		useMovementStore.setState({
			items: [],
			viewportWidth: 0,
			viewportHeight: 0,
			hidden: false,
			flashedId: null,
		});
	});

	describe('PluginHostViewRegistry', () => {
		it('renders a tier-0 static Movement host view when enabled and removes it when disabled', () => {
			const views = collectContributions(tierZeroManifest()).hostViews;
			let enabled = true;
			const registry = new PluginHostViewRegistry({
				isEnabled: () => enabled,
				getHostViews: () => (enabled ? views : []),
				isPluginRecordPresent: () => true,
				forward: forwardToMovement,
			});

			registry.sync();
			expect(useMovementStore.getState().items).toMatchObject([
				{
					id: 'com.example.static-view/status',
					title: 'Static status',
					spec: [{ kind: 'heading', text: 'Ready' }],
				},
			]);

			enabled = false;
			registry.sync();
			expect(useMovementStore.getState().items).toEqual([]);
		});

		it('replays active static views after a renderer becomes available and refreshes changed tier-0 data', () => {
			const initial = collectContributions(tierZeroManifest()).hostViews;
			let views = initial;
			const forward = vi.fn(() => true);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => views,
				isPluginRecordPresent: () => true,
				forward,
			});

			registry.sync();
			registry.replay();
			views = [
				{
					...initial[0],
					title: 'Static status updated',
					blocks: [{ kind: 'heading', text: 'Updated' }],
				},
			];
			registry.sync();

			expect(forward).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ kind: 'upsert', view: initial[0] })
			);
			expect(forward).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ kind: 'upsert', view: initial[0] })
			);
			expect(forward).toHaveBeenNthCalledWith(
				3,
				expect.objectContaining({
					kind: 'upsert',
					view: expect.objectContaining({ title: 'Static status updated' }),
					blocks: [{ kind: 'heading', text: 'Updated' }],
				})
			);
		});

		it('retries a static view that was discovered before the renderer existed', () => {
			const views = collectContributions(tierZeroManifest()).hostViews;
			let rendererAvailable = false;
			const forward = vi.fn(() => rendererAvailable);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => views,
				isPluginRecordPresent: () => true,
				forward,
			});

			registry.sync();
			rendererAvailable = true;
			registry.replay();

			expect(forward).toHaveBeenCalledTimes(2);
			expect(forward).toHaveBeenLastCalledWith(
				expect.objectContaining({ kind: 'upsert', view: views[0] })
			);
		});

		it('forwards only declared runtime views and purges them when the sandbox stops', () => {
			const view: HostViewContribution = {
				id: 'com.example.runtime/status',
				localId: 'status',
				pluginId: 'com.example.runtime',
				surface: 'cadenza',
				title: 'Runtime status',
			};
			const forward = vi.fn(() => true);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => [view],
				isPluginRecordPresent: () => true,
				forward,
			});

			expect(
				registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }])
			).toBe(true);
			expect(registry.update('com.example.runtime', 'not-declared', [])).toBe(false);
			registry.purge('com.example.runtime');

			expect(forward).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ kind: 'upsert', view, blocks: [{ kind: 'text', text: 'Live' }] })
			);
			expect(forward).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ kind: 'remove', view, force: true })
			);
		});

		it('removes a live runtime view when a loaded plugin replaces its declaration on sync', () => {
			const view: HostViewContribution = {
				id: 'com.example.runtime/status',
				localId: 'status',
				pluginId: 'com.example.runtime',
				surface: 'cadenza',
				title: 'Runtime status',
			};
			let views: readonly HostViewContribution[] = [view];
			const forward = vi.fn(() => true);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => views,
				isPluginRecordPresent: () => true,
				forward,
			});

			registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
			views = [
				{
					...view,
					id: 'com.example.runtime/replacement',
					localId: 'replacement',
				},
			];
			registry.sync();
			registry.purge('com.example.runtime');

			expect(forward).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'remove', view }));
			expect(forward.mock.calls[1][0]).not.toHaveProperty('force');
			expect(forward).toHaveBeenCalledTimes(2);
		});

		it('removes a live runtime view when its loaded plugin has zero declarations', () => {
			const view: HostViewContribution = {
				id: 'com.example.runtime/status',
				localId: 'status',
				pluginId: 'com.example.runtime',
				surface: 'cadenza',
				title: 'Runtime status',
			};
			let views: readonly HostViewContribution[] = [view];
			const forward = vi.fn(() => true);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => views,
				isPluginRecordPresent: () => true,
				forward,
			});

			registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
			views = [];
			registry.sync();

			expect(forward).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'remove', view }));
			expect(forward.mock.calls[1][0]).not.toHaveProperty('force');
		});

		it('retains a live runtime view while its plugin record is transiently unavailable', () => {
			const view: HostViewContribution = {
				id: 'com.example.runtime/status',
				localId: 'status',
				pluginId: 'com.example.runtime',
				surface: 'cadenza',
				title: 'Runtime status',
			};
			let views: readonly HostViewContribution[] = [view];
			let pluginRecordPresent = true;
			const forward = vi.fn(() => true);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => views,
				isPluginRecordPresent: () => pluginRecordPresent,
				forward,
			});

			registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
			views = [];
			pluginRecordPresent = false;
			registry.sync();
			registry.replay();

			expect(forward).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ kind: 'upsert', view, blocks: [{ kind: 'text', text: 'Live' }] })
			);
			expect(forward).toHaveBeenCalledTimes(2);
		});

		it('purges a live runtime view when the record persists in a failed load state', () => {
			// A reload that produces an `invalid`/`incompatible` record keeps the record
			// PRESENT while dropping its declarations - that is a permanent failure, not
			// a transient window, so the stale runtime view must not keep replaying.
			const view: HostViewContribution = {
				id: 'com.example.runtime/status',
				localId: 'status',
				pluginId: 'com.example.runtime',
				surface: 'movement',
				title: 'Runtime status',
			};
			let views: readonly HostViewContribution[] = [view];
			const forward = vi.fn(() => true);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => views,
				isPluginRecordPresent: () => true,
				forward,
			});

			registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
			views = [];
			registry.sync();
			registry.replay();

			expect(forward).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'remove' }));
			expect(forward).toHaveBeenCalledTimes(2);
		});

		it('forwards a Cadenza close to both an existing HUD and the main renderer', () => {
			const view: HostViewContribution = {
				id: 'com.example.runtime/status',
				localId: 'status',
				pluginId: 'com.example.runtime',
				surface: 'cadenza',
				title: 'Runtime status',
			};
			const sendToMain = vi.fn();
			const deliverCadenzaToExistingHud = vi.fn(() => false);
			const forward = (mutation: HostViewMutation) =>
				forwardPluginHostViewToRenderer(mutation, {
					sourcePlugin: view.pluginId,
					isCadenzaEnabled: true,
					sendToMain,
					deliverCadenza: vi.fn(() => false),
					deliverCadenzaToExistingHud,
				});
			const registry = new PluginHostViewRegistry({
				isEnabled: () => true,
				getHostViews: () => [view],
				isPluginRecordPresent: () => true,
				forward,
			});

			registry.update('com.example.runtime', 'status', [{ kind: 'text', text: 'Live' }]);
			deliverCadenzaToExistingHud.mockReturnValue(true);
			registry.purge('com.example.runtime');

			expect(deliverCadenzaToExistingHud).toHaveBeenCalledWith({ op: 'close', id: view.id });
			expect(sendToMain).toHaveBeenNthCalledWith(
				1,
				'remote:cadenza',
				expect.objectContaining({ op: 'open', id: view.id })
			);
			expect(sendToMain).toHaveBeenNthCalledWith(2, 'remote:cadenza', {
				op: 'close',
				id: view.id,
			});
		});

		it('does not forward or retain runtime updates while either feature gate is off', () => {
			const forward = vi.fn(() => true);
			const registry = new PluginHostViewRegistry({
				isEnabled: () => false,
				getHostViews: () => [
					{
						id: 'com.example.disabled/status',
						localId: 'status',
						pluginId: 'com.example.disabled',
						surface: 'movement',
						title: 'Disabled',
					},
				],
				forward,
				isPluginRecordPresent: () => true,
			});

			expect(registry.update('com.example.disabled', 'status', [])).toBe(false);
			expect(forward).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('plugin-scheduler-host', () => {
	// A daily-time trigger whose times include the current AND next clock minute, so
	// it is due on the very first tick() regardless of a minute rollover mid-test.
	function dueTrigger(over: Partial<CueTriggerContribution> = {}): CueTriggerContribution {
		const d = new Date();
		const cur = schedulerNowFromDate(d).hhmm;
		const next = schedulerNowFromDate(new Date(d.getTime() + 60_000)).hhmm;
		return {
			id: 'p/t',
			localId: 't',
			pluginId: 'p',
			title: 'T',
			schedule: { kind: 'dailyTimes', times: [cur, next] },
			action: 'dispatch',
			payload: 'post a friendly summary',
			...over,
		};
	}

	// Production-equivalent gate: low/medium risk is necessary but not sufficient;
	// dispatch also requires a live agents:dispatch grant naming the target agent,
	// a trusted signature, AND the separate unattended consent (scheduler ticks are
	// no-user-present execution).
	const gate = (
		t: CueTriggerContribution,
		ctx: { hasDispatchGrant: boolean; trusted: boolean; hasUnattendedConsent: boolean } = {
			hasDispatchGrant: true,
			trusted: true,
			hasUnattendedConsent: true,
		}
	) => evaluateScheduledDispatch(t.payload, ctx);

	describe('PluginSchedulerHost dispatch gating', () => {
		it('still notifies rather than dispatching the Relay release discussion', () => {
			const notify = vi.fn();
			const dispatch = vi.fn();
			const trigger = dueTrigger({
				id: 'sh.maestro.relay/t',
				pluginId: 'sh.maestro.relay',
				payload: relayRelease.fullPrompt,
			});
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [trigger],
				notify,
				dispatch,
				evaluateDispatch: gate,
			});
			h.tick();
			expect(dispatch).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith(trigger);
		});

		it('auto-dispatches an eligible (non-high-risk) trigger when a sink is wired', () => {
			const notify = vi.fn();
			const dispatch = vi.fn();
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [dueTrigger()],
				notify,
				dispatch,
				evaluateDispatch: gate,
			});
			h.tick();
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(notify).not.toHaveBeenCalled();
		});

		it('surfaces (notifies) a high-risk trigger instead of auto-dispatching', () => {
			const notify = vi.fn();
			const dispatch = vi.fn();
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [
					dueTrigger({ payload: 'delete the production database and drop all tables' }),
				],
				notify,
				dispatch,
				evaluateDispatch: gate,
			});
			h.tick();
			expect(dispatch).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it('surfaces an otherwise eligible trigger when the plugin is untrusted', () => {
			const notify = vi.fn();
			const dispatch = vi.fn();
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [dueTrigger()],
				notify,
				dispatch,
				evaluateDispatch: (trigger) => gate(trigger, { hasDispatchGrant: true, trusted: false }),
			});
			h.tick();
			expect(dispatch).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it('surfaces an otherwise eligible trigger when the agents:dispatch grant is absent', () => {
			const notify = vi.fn();
			const dispatch = vi.fn();
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [dueTrigger()],
				notify,
				dispatch,
				evaluateDispatch: (trigger) => gate(trigger, { hasDispatchGrant: false, trusted: true }),
			});
			h.tick();
			expect(dispatch).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it('surfaces an otherwise eligible trigger without the separate UNATTENDED consent (notify-only fallback)', () => {
			const notify = vi.fn();
			const dispatch = vi.fn();
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [dueTrigger()],
				notify,
				dispatch,
				evaluateDispatch: (trigger) =>
					gate(trigger, { hasDispatchGrant: true, trusted: true, hasUnattendedConsent: false }),
			});
			h.tick();
			expect(dispatch).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it('skips loudly (does not crash the tick) when the dispatch sink throws for a missing target', () => {
			const notify = vi.fn();
			const dispatch = vi.fn(() => {
				throw new Error('target agent "agent-a" is not running');
			});
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [dueTrigger({ agentId: 'agent-a' })],
				notify,
				dispatch,
				evaluateDispatch: gate,
			});
			expect(() => h.tick()).not.toThrow();
			expect(dispatch).toHaveBeenCalledTimes(1);
		});

		it('surfaces an eligible trigger when no dispatch sink is wired (auto-exec off)', () => {
			const notify = vi.fn();
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [dueTrigger()],
				notify,
				evaluateDispatch: gate,
			});
			h.tick();
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it('runs a notify-action trigger directly', () => {
			const notify = vi.fn();
			const dispatch = vi.fn();
			const h = new PluginSchedulerHost({
				isEnabled: () => true,
				getTriggers: () => [dueTrigger({ action: 'notify', payload: 'hello' })],
				notify,
				dispatch,
				evaluateDispatch: gate,
			});
			h.tick();
			expect(notify).toHaveBeenCalledTimes(1);
			expect(dispatch).not.toHaveBeenCalled();
		});
	});
});
