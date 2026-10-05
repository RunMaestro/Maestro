/**
 * Tests for the bridge the desktop answers agent, group, and tab messages with while it hosts the
 * runtime (DM15). They run against a real runtime on a temp data dir, so a reply is checked against
 * what reached disk, and a push against the event that caused it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createRuntimeBridge,
	RUNTIME_BRIDGE_MESSAGE_TYPES,
	type RuntimeBridge,
} from '../../../main/library-runtime/bridge';
import { DEFAULT_TAB_DEFAULTS } from '../../../shared/maestro-lib/agents/rules';
import { createMaestroRuntime, type MaestroRuntime } from '../../../shared/maestro-lib/runtime';

const T0 = Date.parse('2026-10-05T12:00:00Z');
const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

describe('createRuntimeBridge', () => {
	let dir: string;
	let runtime: MaestroRuntime;
	let bridge: RuntimeBridge;

	const sessionsFile = () => path.join(dir, 'maestro-sessions.json');
	const sessionsOnDisk = () => JSON.parse(fs.readFileSync(sessionsFile(), 'utf-8')).sessions;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-bridge-test-'));
		fs.writeFileSync(
			sessionsFile(),
			confText({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: dir,
						projectRoot: dir,
						aiTabs: [{ id: 't1', agentSessionId: null, name: null, starred: false, logs: [] }],
						activeTabId: 't1',
						unifiedTabOrder: [{ type: 'ai', id: 't1' }],
					},
				],
				activeSessionId: 'a1',
			})
		);
		let id = 0;
		let now = 1_000;
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'desktop',
			deps: {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: () => true,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory: () => ({ close: () => undefined }),
			},
		});
		if (!started.ok) throw new Error(started.refusal.message);
		runtime = started.runtime;
		bridge = createRuntimeBridge(runtime);
	});

	afterEach(async () => {
		bridge.dispose();
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('which messages it answers', () => {
		it('is exactly the fifteen agent, group, and tab messages', () => {
			expect([...RUNTIME_BRIDGE_MESSAGE_TYPES].sort()).toEqual(
				[
					'close_tab',
					'create_group',
					'create_session',
					'delete_group',
					'delete_session',
					'move_session_to_group',
					'new_tab',
					'rename_group',
					'rename_session',
					'rename_tab',
					'set_auto_run_folder',
					'star_tab',
					'update_session_config',
					'update_session_cwd',
					'update_session_ssh',
				].sort()
			);
		});

		it.each(['create_session', 'new_tab', 'star_tab', 'delete_group'])('handles %s', (type) => {
			expect(bridge.handles(type)).toBe(true);
		});

		it.each([
			'select_session',
			'select_tab',
			'switch_mode',
			'send_command',
			'enqueue_command',
			'ping',
			'get_sessions',
			'reorder_tab',
			'toggle_bookmark',
			'update_group',
			'create_worktree_session',
			'cross_agent_ask',
			'start_group_chat',
		])('leaves %s to the desktop', (type) => {
			expect(bridge.handles(type)).toBe(false);
		});

		it('handles nothing that is not a string', () => {
			expect(bridge.handles(undefined)).toBe(false);
			expect(bridge.handles(42)).toBe(false);
		});
	});

	describe('replies', () => {
		it('creates an agent: the reply names it and it is on disk', async () => {
			const reply = await bridge.handle({
				type: 'create_session',
				name: 'Fresh',
				toolType: 'claude-code',
				cwd: dir,
			});

			expect(reply).toMatchObject({ type: 'create_session_result', success: true });
			const created = sessionsOnDisk().find((s: { name: string }) => s.name === 'Fresh');
			expect(created?.id).toBe((reply as { sessionId: string }).sessionId);
		});

		it('renames an agent', async () => {
			const reply = await bridge.handle({
				type: 'rename_session',
				sessionId: 'a1',
				newName: 'Beta',
			});
			expect(reply).toMatchObject({ type: 'rename_session_result', success: true });
			expect(sessionsOnDisk()[0].name).toBe('Beta');
		});

		it('runs a tab through its life: create, rename, star, close', async () => {
			const created = await bridge.handle({ type: 'new_tab', sessionId: 'a1' });
			expect(created).toMatchObject({ type: 'new_tab_result', success: true });
			const tabId = (created as { tabId: string }).tabId;

			expect(
				await bridge.handle({ type: 'rename_tab', sessionId: 'a1', tabId, newName: 'scratch' })
			).toMatchObject({ type: 'rename_tab_result', success: true });
			expect(
				await bridge.handle({ type: 'star_tab', sessionId: 'a1', tabId, starred: true })
			).toMatchObject({ type: 'star_tab_result', success: true });
			const tab = sessionsOnDisk()[0].aiTabs.find((t: { id: string }) => t.id === tabId);
			expect(tab).toMatchObject({ name: 'scratch', starred: true });

			expect(await bridge.handle({ type: 'close_tab', sessionId: 'a1', tabId })).toMatchObject({
				type: 'close_tab_result',
				success: true,
			});
			expect(sessionsOnDisk()[0].aiTabs.map((t: { id: string }) => t.id)).toEqual(['t1']);
		});

		it('creates a group and moves an agent into it', async () => {
			const group = await bridge.handle({ type: 'create_group', name: 'work' });
			expect(group).toMatchObject({ type: 'create_group_result', success: true });
			const groupId = (group as { groupId: string }).groupId;

			expect(
				await bridge.handle({ type: 'move_session_to_group', sessionId: 'a1', groupId })
			).toMatchObject({ type: 'move_session_to_group_result', success: true });
			expect(sessionsOnDisk()[0].groupId).toBe(groupId);
		});

		it("answers a failure as a value, with the runtime's words", async () => {
			const reply = await bridge.handle({
				type: 'rename_session',
				sessionId: 'nobody',
				newName: 'x',
			});
			expect(reply).toMatchObject({ type: 'rename_session_result', success: false });
			expect((reply as { error: string }).error).toMatch(/not found/i);
		});

		it('returns undefined for a message the runtime does not know, so the caller can say so', async () => {
			expect(await bridge.handle({ type: 'select_session', sessionId: 'a1' })).toBeUndefined();
		});
	});

	describe('pushes', () => {
		const target = () => ({ broadcastToAll: vi.fn() });

		it('broadcasts a lifecycle sync for an agent the runtime created', async () => {
			const server = target();
			bridge.attach(server);

			await bridge.handle({
				type: 'create_session',
				name: 'Fresh',
				toolType: 'claude-code',
				cwd: dir,
			});

			// The web-desktop sync channel a browser applies, the same frame `maestro-cli host` pushes.
			const frames = server.broadcastToAll.mock.calls.map(
				([frame]) => frame as Record<string, any>
			);
			const added = frames.find(
				(frame) => frame.type === 'bridge.event' && frame.channel === 'sessions:lifecycleSync'
			);
			expect(added?.args[0].added.map((agent: { name: string }) => agent.name)).toEqual(['Fresh']);
		});

		it('broadcasts a removal', async () => {
			const server = target();
			bridge.attach(server);

			await bridge.handle({ type: 'delete_session', sessionId: 'a1' });

			const frames = server.broadcastToAll.mock.calls.map(([frame]) => frame as { type: string });
			expect(frames).toContainEqual(
				expect.objectContaining({ type: 'session_removed', sessionId: 'a1' })
			);
		});

		it('sends nothing before a server is attached and nothing after it detaches', async () => {
			const server = target();
			await bridge.handle({ type: 'rename_session', sessionId: 'a1', newName: 'Before' });
			const detach = bridge.attach(server);
			await bridge.handle({ type: 'rename_session', sessionId: 'a1', newName: 'During' });
			const during = server.broadcastToAll.mock.calls.length;
			expect(during).toBeGreaterThan(0);

			detach();
			await bridge.handle({ type: 'rename_session', sessionId: 'a1', newName: 'After' });
			expect(server.broadcastToAll.mock.calls.length).toBe(during);
		});

		it('replaces the first server when a second attaches (the web interface restarted)', async () => {
			const first = target();
			const second = target();
			const detachFirst = bridge.attach(first);
			bridge.attach(second);

			await bridge.handle({ type: 'rename_session', sessionId: 'a1', newName: 'Beta' });
			expect(first.broadcastToAll).not.toHaveBeenCalled();
			expect(second.broadcastToAll).toHaveBeenCalled();

			// The stale detach must not unhook the live server.
			detachFirst();
			second.broadcastToAll.mockClear();
			await bridge.handle({ type: 'rename_session', sessionId: 'a1', newName: 'Gamma' });
			expect(second.broadcastToAll).toHaveBeenCalled();
		});

		it('stops listening on dispose', async () => {
			const server = target();
			bridge.attach(server);
			bridge.dispose();
			await runtime.agents.rename('a1', 'Quiet');
			expect(server.broadcastToAll).not.toHaveBeenCalled();
		});
	});
});
