import { describe as __maestroMicrobenchDescribe } from 'vitest';
import * as os from 'os';
import { afterEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import Conf from 'conf';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { createPluginSessionLifecycle } from '../../../main/plugins/plugin-session-lifecycle';
import { nativeCurrentTurns } from '../../../main/pianola/current-turn';
import { PluginGroupingRegistry } from '../../../main/plugins/plugin-grouping-registry';
import { validatePublishedGrouping } from '../../../main/plugins/plugin-grouping-registry';
import { ActionGuard } from '../../../main/plugins/action-guard';
__maestroMicrobenchDescribe('plugin-session-lifecycle', () => {
	const directories: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		nativeCurrentTurns.setEnabled(false);
		nativeCurrentTurns.setEnabled(true);
		for (const directory of directories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	});

	function fixture() {
		const root = os.tmpdir();
		mkdirSync(root, { recursive: true });
		const directory = mkdtempSync(path.join(root, 'm02-plugin-'));
		directories.push(directory);
		const store = new Conf<{ sessions: Array<Record<string, unknown>>; activeSessionId: string }>({
			cwd: directory,
			defaults: { sessions: [], activeSessionId: 'unchanged' },
		});
		const flush = vi.fn(async () => {});
		const autoWatchNewSessions = vi.fn(async () => {});
		const adapter = createPluginSessionLifecycle({
			readSessions: () => store.get('sessions'),
			writeSessions: (sessions) => store.set('sessions', sessions),
			flush,
			getActiveSessionId: () => store.get('activeSessionId'),
			setActiveSessionId: (id) => store.set('activeSessionId', id),
			getSupervisor: () => ({ autoWatchNewSessions }),
		});
		return { store, flush, autoWatchNewSessions, adapter, directory };
	}

	describe('production plugin session lifecycle', () => {
		it('rejects concurrent duplicate IDs before any persistence, activation or notification', async () => {
			const f = fixture();
			let release!: () => void;
			f.flush.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					})
			);
			const create = f.adapter.create({
				id: 'same',
				title: 'Original',
				agentId: 'codex',
				projectPath: path.join(f.directory, 'project'),
			});
			const disk = readFileSync(f.store.path, 'utf8');
			await expect(f.adapter.create({ id: 'same', title: 'Duplicate' })).rejects.toThrow(
				'Session already exists'
			);
			expect(readFileSync(f.store.path, 'utf8')).toBe(disk);
			expect(f.store.get('activeSessionId')).toBe('unchanged');
			expect(f.autoWatchNewSessions).not.toHaveBeenCalled();
			release();
			await expect(create).resolves.toMatchObject({
				id: 'same',
				title: 'Original',
				agentId: 'codex',
				projectPath: path.join(f.directory, 'project'),
				status: 'idle',
			});
			expect(f.autoWatchNewSessions).toHaveBeenCalledOnce();
			expect(f.store.get('sessions')).toHaveLength(1);
		});

		it('does not reactivate a session deleted while creation awaits its flush', async () => {
			const f = fixture();
			let release!: () => void;
			f.flush.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					})
			);
			const create = f.adapter.create({ id: 'removed' });
			expect(await f.adapter.remove('removed')).toBe(true);
			release();
			await expect(create).rejects.toThrow('Session changed during creation');
			expect(f.store.get('sessions')).toEqual([]);
			expect(f.store.get('activeSessionId')).toBe('unchanged');
			expect(f.autoWatchNewSessions).toHaveBeenCalledExactlyOnceWith([], [], ['removed']);
		});

		it('does not enroll or activate a failed durable create', async () => {
			const f = fixture();
			f.flush.mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
			await expect(f.adapter.create({ id: 'failed' })).rejects.toThrow('disk full');
			expect(f.autoWatchNewSessions).not.toHaveBeenCalled();
			expect(f.store.get('activeSessionId')).toBe('unchanged');
			const session = f.store.get('sessions')[0];
			const tab = (session.aiTabs as Array<{ id: string; createdAt: number }>)[0];
			nativeCurrentTurns.commit({
				sessionId: 'failed',
				tabId: tab.id,
				field: 'logs',
				snapshot: true,
				upserts: [],
				removedIds: [],
				orderIds: [],
				runtime: { state: 'idle' },
				observation: {
					sourceGeneration: 'renderer',
					sequence: 1,
					createdAt: tab.createdAt,
					provider: 'claude-code',
				},
			});
			expect(
				nativeCurrentTurns.read({
					agentId: 'failed',
					tabId: tab.id,
					createdAt: tab.createdAt,
					provider: 'claude-code',
					agentSessionId: null,
					open: true,
				}).status
			).toBe('incomplete');
		});
	});
});
__maestroMicrobenchDescribe('plugin-grouping-registry', () => {
	function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'by-agent-type',
			groups: [
				{ id: 'agents', label: 'Agents' },
				{ id: 'claude', label: 'Claude', parentId: 'agents' },
			],
			assignments: { 'session-1': 'claude', unknown: 'claude' },
			...overrides,
		};
	}

	describe('validatePublishedGrouping', () => {
		it('preserves a fake session id in snapshot readback without checking host sessions', () => {
			const registry = new PluginGroupingRegistry();
			registry.publish(
				validatePublishedGrouping(
					'com.acme',
					'by-agent-type',
					payload({ assignments: { 'fake-session-id': 'claude' } })
				)
			);

			expect(registry.snapshot()).toEqual([
				expect.objectContaining({
					assignments: { 'fake-session-id': 'claude' },
				}),
			]);
		});

		it('rejects nested schema extras, cycles, and hierarchies deeper than two levels', () => {
			expect(() =>
				validatePublishedGrouping(
					'com.acme',
					'by-agent-type',
					payload({ groups: [{ id: 'root', label: 'Root', unexpected: true }] })
				)
			).toThrow(/invalid group/);
			expect(() =>
				validatePublishedGrouping(
					'com.acme',
					'by-agent-type',
					payload({
						groups: [
							{ id: 'a', label: 'A', parentId: 'b' },
							{ id: 'b', label: 'B', parentId: 'a' },
						],
					})
				)
			).toThrow(/cycle/);
			expect(() =>
				validatePublishedGrouping(
					'com.acme',
					'by-agent-type',
					payload({
						groups: [
							{ id: 'root', label: 'Root' },
							{ id: 'child', label: 'Child', parentId: 'root' },
							{ id: 'grandchild', label: 'Grandchild', parentId: 'child' },
						],
					})
				)
			).toThrow(/depth/);
		});
	});

	describe('PluginGroupingRegistry', () => {
		it('purges every snapshot for a stopped or disabled plugin and never leaks mutable state', () => {
			const onChanged = vi.fn();
			const registry = new PluginGroupingRegistry(onChanged);
			registry.publish(validatePublishedGrouping('com.acme', 'by-agent-type', payload()));
			registry.publish(
				validatePublishedGrouping('com.other', 'by-agent-type', payload({ id: 'by-agent-type' }))
			);

			const snapshot = registry.snapshot();
			snapshot[0].assignments['session-2'] = 'claude';
			expect(registry.snapshot()[0].assignments).not.toHaveProperty('session-2');

			registry.removePlugin('com.acme');
			expect(registry.snapshot()).toHaveLength(1);
			expect(registry.snapshot()[0].pluginId).toBe('com.other');
			expect(onChanged).toHaveBeenCalledTimes(3);
		});

		it('clears all snapshots when the plugins feature is switched off', () => {
			const registry = new PluginGroupingRegistry();
			registry.publish(validatePublishedGrouping('com.acme', 'by-agent-type', payload()));

			registry.clearAll();

			expect(registry.snapshot()).toEqual([]);
		});
	});
});
__maestroMicrobenchDescribe('action-guard', () => {
	describe('ActionGuard', () => {
		it('allows up to the rate limit, denies within the window, recovers after it', () => {
			let t = 0;
			const guard = new ActionGuard({
				now: () => t,
				limits: { high: { windowMs: 1000, maxPerWindow: 2, maxConcurrent: 10 } },
			});
			const a = guard.begin('p', 'fs:write');
			expect(a.ok).toBe(true);
			if (a.ok) a.release();
			const b = guard.begin('p', 'fs:write');
			expect(b.ok).toBe(true);
			if (b.ok) b.release();
			expect(guard.begin('p', 'fs:write').ok).toBe(false); // 3rd within window
			t = 1001;
			expect(guard.begin('p', 'fs:write').ok).toBe(true); // window elapsed
		});

		it('enforces max concurrency and frees the slot on release', () => {
			const guard = new ActionGuard({
				limits: { high: { windowMs: 1000, maxPerWindow: 100, maxConcurrent: 1 } },
			});
			const a = guard.begin('p', 'fs:write');
			expect(a.ok).toBe(true);
			expect(guard.begin('p', 'fs:write').ok).toBe(false); // slot busy
			if (a.ok) a.release();
			expect(guard.begin('p', 'fs:write').ok).toBe(true); // slot freed
		});

		it('audits high-risk BEFORE action, but not low-risk', () => {
			const audit = vi.fn();
			const guard = new ActionGuard({ now: () => 5, audit });
			guard.begin('p', 'fs:write', '/tmp/x'); // high
			guard.begin('p', 'storage:read'); // low
			expect(audit).toHaveBeenCalledTimes(1);
			expect(audit).toHaveBeenCalledWith({
				pluginId: 'p',
				capability: 'fs:write',
				at: 5,
				target: '/tmp/x',
			});
		});

		it('keys limits independently per plugin and per capability', () => {
			const guard = new ActionGuard({
				limits: { high: { windowMs: 1000, maxPerWindow: 1, maxConcurrent: 10 } },
			});
			expect(guard.begin('p1', 'fs:write').ok).toBe(true);
			expect(guard.begin('p1', 'fs:write').ok).toBe(false); // p1+fs:write exhausted
			expect(guard.begin('p2', 'fs:write').ok).toBe(true); // different plugin
			expect(guard.begin('p1', 'process:spawn').ok).toBe(true); // different capability
		});
	});
});
