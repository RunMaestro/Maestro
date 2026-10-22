/**
 * The operations a person performs on a whole chat, over fake ports so the ORDER of what each one
 * does is what is asserted: a delete that removes the folder before the processes are stopped is a
 * participant writing into a chat that no longer exists.
 */
import { describe, expect, it, vi } from 'vitest';

import { createGroupChatOperations } from '../chat-ops';
import type { GroupChat, GroupChatLauncher } from '../types';

const chatOf = (overrides: Partial<GroupChat> = {}): GroupChat => ({
	id: 'c1',
	name: 'Room',
	createdAt: 1,
	updatedAt: 1,
	moderatorAgentId: 'claude-code',
	moderatorSessionId: '',
	participants: [
		{ name: 'Alpha', agentId: 'claude-code', sessionId: 's-a', addedAt: 1 },
		{ name: 'Beta', agentId: 'codex', sessionId: 's-b', addedAt: 1 },
	],
	logPath: '/x/chat.log',
	imagesDir: '/x/images',
	...overrides,
});

function harness(
	options: { launcher?: boolean; moderatorActive?: boolean; loaded?: GroupChat | null } = {}
) {
	const order: string[] = [];
	const stopped: string[] = [];
	const log = (name: string) => order.push(name);
	const launcher: GroupChatLauncher = {
		runner: { start: vi.fn(), stop: (id) => void stopped.push(id) },
		resolveAgent: async () => null,
	};
	const store = {
		createGroupChat: vi.fn(async () => (log('createGroupChat'), chatOf())),
		loadGroupChat: vi.fn(async () => (options.loaded === undefined ? chatOf() : options.loaded)),
		updateGroupChat: vi.fn(
			async (_id: string, updates: Partial<GroupChat>) => (log('updateGroupChat'), chatOf(updates))
		),
		deleteGroupChat: vi.fn(async () => void log('deleteGroupChat')),
	};
	const engine = {
		spawnModerator: vi.fn(async () => (log('spawnModerator'), 'prefix')),
		killModerator: vi.fn(async (_id: string, control?: { kill(id: string): boolean }) => {
			log('killModerator');
			control?.kill('moderator-turn');
		}),
		isModeratorActive: vi.fn(() => options.moderatorActive ?? true),
		clearAllParticipantSessions: vi.fn(
			async (_id: string, control?: { kill(id: string): boolean }) => {
				log('clearAllParticipantSessions');
				control?.kill('participant-turn');
			}
		),
		clearPendingParticipants: vi.fn(() => void log('clearPendingParticipants')),
		routeUserMessage: vi.fn(async () => void log('routeUserMessage')),
	};
	const events = {
		participantState: vi.fn(
			(_id: string, name: string, state: string) => void log(`participant:${name}:${state}`)
		),
		stateChange: vi.fn((_id: string, state: string) => void log(`state:${state}`)),
	};
	const ops = createGroupChatOperations({
		store,
		engine,
		launcher: () => (options.launcher === false ? undefined : launcher),
		events,
		chatState: () => 'idle',
	});
	return { ops, store, engine, events, order, stopped, launcher };
}

describe('group chat operations', () => {
	it('creates a chat with its moderator registered, and answers the chat as stored', async () => {
		const h = harness();
		const chat = await h.ops.createChat({ name: 'Room', moderatorProvider: 'claude-code' });

		expect(h.store.createGroupChat).toHaveBeenCalledWith(
			'Room',
			'claude-code',
			undefined,
			undefined
		);
		expect(h.order).toEqual(['createGroupChat', 'spawnModerator']);
		expect(chat.id).toBe('c1');
	});

	it('stops the round BEFORE it deletes the chat', async () => {
		const h = harness();
		await h.ops.deleteChat('c1');

		expect(h.order).toEqual([
			'killModerator',
			'clearAllParticipantSessions',
			'clearPendingParticipants',
			'deleteGroupChat',
		]);
		// The runner is what stops a process, by its full id.
		expect(h.stopped).toEqual(['moderator-turn', 'participant-turn']);
	});

	it('stops without a runner when the host has none: the registries are still cleared', async () => {
		const h = harness({ launcher: false });
		await h.ops.deleteChat('c1');
		expect(h.stopped).toEqual([]);
		expect(h.order).toContain('clearAllParticipantSessions');
	});

	it('stops everything and shows the room idle with every card at rest', async () => {
		const h = harness();
		await h.ops.stopAll('c1');

		expect(h.order).toEqual([
			'killModerator',
			'clearAllParticipantSessions',
			'clearPendingParticipants',
			'participant:Alpha:idle',
			'participant:Beta:idle',
			'state:idle',
		]);
	});

	it('stops a chat that no longer loads without throwing', async () => {
		const h = harness({ loaded: null });
		await expect(h.ops.stopAll('c1')).resolves.toBeUndefined();
		expect(h.order.at(-1)).toBe('state:idle');
	});

	it('archives by stopping the room first, and unarchives without touching it', async () => {
		const archive = harness();
		await archive.ops.archiveChat('c1', true);
		expect(archive.order).toEqual([
			'killModerator',
			'clearAllParticipantSessions',
			'clearPendingParticipants',
			'updateGroupChat',
		]);
		expect(archive.store.updateGroupChat).toHaveBeenCalledWith('c1', { archived: true });

		const restore = harness();
		await restore.ops.archiveChat('c1', false);
		expect(restore.order).toEqual(['updateGroupChat']);
	});

	it('renames through the store', async () => {
		const h = harness();
		await h.ops.renameChat('c1', 'Shipping');
		expect(h.store.updateGroupChat).toHaveBeenCalledWith('c1', { name: 'Shipping' });
	});

	describe('sending a message', () => {
		it('routes it to the moderator with the launcher, and the read-only flag and images', async () => {
			const h = harness();
			await h.ops.sendUserMessage('c1', 'hello', { readOnly: true, images: ['x.png'] });

			expect(h.engine.routeUserMessage).toHaveBeenCalledWith('c1', 'hello', h.launcher, true, [
				'x.png',
			]);
			expect(h.engine.spawnModerator).not.toHaveBeenCalled();
		});

		it('registers the moderator first when it is not active (a chat loaded from disk)', async () => {
			const h = harness({ moderatorActive: false });
			await h.ops.sendUserMessage('c1', 'hello');
			expect(h.order).toEqual(['spawnModerator', 'routeUserMessage']);
		});

		it('says so when the chat is gone', async () => {
			const h = harness({ moderatorActive: false, loaded: null });
			await expect(h.ops.sendUserMessage('c1', 'hello')).rejects.toThrow(
				'Group chat not found: c1'
			);
			expect(h.engine.routeUserMessage).not.toHaveBeenCalled();
		});

		it('routes with no launcher when the host has none: the engine logs the message and starts nothing', async () => {
			const h = harness({ launcher: false });
			await h.ops.sendUserMessage('c1', 'hello');
			expect(h.engine.routeUserMessage).toHaveBeenCalledWith(
				'c1',
				'hello',
				undefined,
				undefined,
				undefined
			);
		});
	});
});
