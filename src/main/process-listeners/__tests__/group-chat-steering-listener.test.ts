/**
 * Tests for the group chat steering listener: a steer no turn took goes back in
 * the main-owned queue, live when the turn said so and held when it exited
 * without saying.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../group-chat/group-chat-router', () => ({
	groupChatSteeringVerdict: vi.fn(),
	unsettledGroupChatSteersOnExit: vi.fn(),
}));
vi.mock('../../group-chat/group-chat-queue', () => ({
	returnSteeredMessage: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../utils/sentry', () => ({
	captureException: vi.fn().mockResolvedValue(undefined),
}));

import { setupGroupChatSteeringListener } from '../group-chat-steering-listener';
import {
	groupChatSteeringVerdict,
	unsettledGroupChatSteersOnExit,
} from '../../group-chat/group-chat-router';
import { returnSteeredMessage } from '../../group-chat/group-chat-queue';
import { captureException } from '../../utils/sentry';
import type { ProcessManager } from '../../process-manager';

const PROCESS_ID = 'group-chat-gc-1-moderator-123';
const verdict = { type: 'steering', id: 's1', verdict: 'dropped' } as const;
const steer = { groupChatId: 'gc-1', text: 'too late', readOnly: false };

describe('Group chat steering listener', () => {
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(returnSteeredMessage).mockResolvedValue(undefined);
		vi.mocked(groupChatSteeringVerdict).mockReturnValue(null);
		vi.mocked(unsettledGroupChatSteersOnExit).mockReturnValue([]);
		eventHandlers = new Map();
		const processManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
		setupGroupChatSteeringListener(processManager);
	});

	it('ignores processes that are not group chat turns', () => {
		eventHandlers.get('steering-verdict')?.('sess-1-ai-tab-1', verdict);
		eventHandlers.get('exit')?.('sess-1-ai-tab-1', 0);

		expect(groupChatSteeringVerdict).not.toHaveBeenCalled();
		expect(unsettledGroupChatSteersOnExit).not.toHaveBeenCalled();
	});

	it('puts a steer back live when the turn says it never took it', () => {
		vi.mocked(groupChatSteeringVerdict).mockReturnValue(steer);

		eventHandlers.get('steering-verdict')?.(PROCESS_ID, verdict);

		expect(groupChatSteeringVerdict).toHaveBeenCalledWith(PROCESS_ID, verdict);
		expect(returnSteeredMessage).toHaveBeenCalledWith('gc-1', steer, false);
	});

	it('returns nothing when the verdict settles the steer as taken', () => {
		eventHandlers.get('steering-verdict')?.(PROCESS_ID, { ...verdict, verdict: 'absorbed' });

		expect(returnSteeredMessage).not.toHaveBeenCalled();
	});

	it('holds every steer a turn exited without settling', () => {
		const other = { groupChatId: 'gc-1', text: 'second', readOnly: true };
		vi.mocked(unsettledGroupChatSteersOnExit).mockReturnValue([steer, other]);

		eventHandlers.get('exit')?.(PROCESS_ID, 1);

		expect(unsettledGroupChatSteersOnExit).toHaveBeenCalledWith(PROCESS_ID);
		expect(returnSteeredMessage).toHaveBeenCalledWith('gc-1', steer, true);
		expect(returnSteeredMessage).toHaveBeenCalledWith('gc-1', other, true);
	});

	it('reports a steer it could not put back', async () => {
		const error = new Error('disk full');
		vi.mocked(returnSteeredMessage).mockRejectedValue(error);
		vi.mocked(groupChatSteeringVerdict).mockReturnValue(steer);

		eventHandlers.get('steering-verdict')?.(PROCESS_ID, verdict);

		await vi.waitFor(() => {
			expect(captureException).toHaveBeenCalledWith(
				error,
				expect.objectContaining({ operation: 'groupChat:returnSteer', groupChatId: 'gc-1' })
			);
		});
	});
});
