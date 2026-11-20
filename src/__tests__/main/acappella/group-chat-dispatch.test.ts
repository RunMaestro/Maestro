import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupChatEvents } from '../../../main/group-chat/emitters';
import { loadGroupChat } from '../../../main/group-chat/group-chat-storage';
import { submitMessage } from '../../../main/group-chat/group-chat-queue';
import { dispatchToGroupChat } from '../../../main/acappella/dispatch/group-chat-dispatch';

vi.mock('../../../main/group-chat/group-chat-storage', () => ({ loadGroupChat: vi.fn() }));
vi.mock('../../../main/group-chat/group-chat-queue', () => ({ submitMessage: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const scope = { kind: 'group-chat', groupChatId: 'room', readOnly: true } as const;
const emit = (from: string, content: string, id = 'room') =>
	groupChatEvents.emit('message', id, { timestamp: 'now', from, content });

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(loadGroupChat).mockResolvedValue({ id: 'room', name: 'Review' } as never);
	vi.mocked(submitMessage).mockResolvedValue({ paused: false, items: [] } as never);
});
afterEach(() => {
	expect(groupChatEvents.listenerCount('message')).toBe(0);
	expect(groupChatEvents.listenerCount('state')).toBe(0);
	expect(groupChatEvents.listenerCount('submission')).toBe(0);
});

describe('Group Chat voice dispatch', () => {
	it('does not speak delegation chatter when the round stops before synthesis', async () => {
		const result = dispatchToGroupChat(scope, 'Review this.');
		await vi.waitFor(() => expect(submitMessage).toHaveBeenCalled());
		groupChatEvents.emit('submission', 'room', vi.mocked(submitMessage).mock.calls[0][1].id);
		emit('user', 'Review this.');
		emit('moderator', 'Asking the team.');
		groupChatEvents.emit('state', 'room', 'agent-working');
		groupChatEvents.emit('state', 'room', 'idle');
		await expect(result).resolves.toMatchObject({
			replyText: 'The group chat round ended without a moderator reply.',
		});
	});
	it('uses the main queue, skips participants, and speaks only the last moderator reply at idle', async () => {
		const accepted = vi.fn();
		const result = dispatchToGroupChat(scope, 'Review this.', undefined, accepted);
		await vi.waitFor(() =>
			expect(submitMessage).toHaveBeenCalledWith(
				'room',
				expect.objectContaining({ text: 'Review this.', readOnlyMode: true })
			)
		);
		emit('moderator', 'Unrelated reply', 'other-room');
		groupChatEvents.emit('submission', 'room', vi.mocked(submitMessage).mock.calls[0][1].id);
		emit('user', 'Review this.');
		emit('moderator', 'Asking the team.');
		emit('Backend', 'Internal participant reply.');
		groupChatEvents.emit('state', 'room', 'agent-working');
		emit('moderator', 'Final synthesis.');
		groupChatEvents.emit('state', 'other-room', 'idle');
		groupChatEvents.emit('state', 'room', 'idle');
		await expect(result).resolves.toMatchObject({
			groupChatId: 'room',
			agentName: 'Review',
			replyText: 'Final synthesis.',
		});
		expect(accepted).toHaveBeenCalledOnce();
	});
	it('does not complete on an older round ending while its own message is still queued', async () => {
		const result = dispatchToGroupChat(scope, 'Next round.');
		await vi.waitFor(() => expect(submitMessage).toHaveBeenCalled());
		emit('user', 'Next round.'); // Identical text from another client must not claim this queued item.
		emit('moderator', 'Previous synthesis.');
		groupChatEvents.emit('state', 'room', 'idle');
		expect(groupChatEvents.listenerCount('state')).toBe(1);
		groupChatEvents.emit('submission', 'room', vi.mocked(submitMessage).mock.calls[0][1].id);
		emit('user', 'Next round.');
		emit('moderator', 'Next synthesis.');
		groupChatEvents.emit('state', 'room', 'idle');
		await expect(result).resolves.toMatchObject({ replyText: 'Next synthesis.' });
	});
	it('ends the voice wait on cancellation and leaves the submitted message alone', async () => {
		const abort = new AbortController();
		const result = dispatchToGroupChat(scope, 'Continue.', abort.signal);
		const rejection = expect(result).rejects.toThrow('Voice session ended');
		await vi.waitFor(() => expect(submitMessage).toHaveBeenCalled());
		abort.abort();
		await rejection;
		expect(submitMessage).toHaveBeenCalledOnce();
	});
	it('reports a paused queue without discarding the queued message', async () => {
		vi.mocked(submitMessage).mockResolvedValueOnce({ paused: true, items: [] } as never);
		await expect(dispatchToGroupChat(scope, 'Continue.')).rejects.toThrow('queue is paused');
	});
	it('refuses a deleted room before submitting', async () => {
		vi.mocked(loadGroupChat).mockResolvedValueOnce(null);
		await expect(dispatchToGroupChat(scope, 'Continue.')).rejects.toThrow('no longer exists');
		expect(submitMessage).not.toHaveBeenCalled();
	});
});
