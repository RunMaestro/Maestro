/**
 * @file observations.test.ts
 * @description What the engine does with the observations a surface makes of a running turn: the
 * provider session id it announced (`sessionAnnounced`), the usage it reported (`usageReported`),
 * and its streaming output (`liveOutput`).
 *
 * These are the cases the desktop's session-id, usage and data listeners used to carry; the
 * listeners now only hand the event over, and the headless runtime's runner calls the same
 * functions, so one set of tests pins both.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createGroupChatEngine } from '../router';
import { createGroupChatStore, type GroupChatStore } from '../storage';
import { createGroupChatTurnMetrics } from '../turn-metrics';
import { createSleepTracker } from '../../../sleepTracking';
import type { UsageStats } from '../../../types';
import type { GroupChat, GroupChatEventSink } from '../types';

const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 1000,
	outputTokens: 500,
	cacheReadInputTokens: 200,
	cacheCreationInputTokens: 100,
	totalCostUsd: 0.05,
	contextWindow: 100000,
	...overrides,
});

describe('group chat engine: observations of a running turn', () => {
	let dir: string;
	let store: GroupChatStore;
	let events: { [K in keyof GroupChatEventSink]: ReturnType<typeof vi.fn> };
	let engine: ReturnType<typeof createGroupChatEngine>;
	let chat: GroupChat;
	let participantProcess: string;
	let moderatorProcess: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'group-chat-observations-'));
		store = createGroupChatStore({ groupChatsDir: () => dir });
		events = {
			message: vi.fn(),
			stateChange: vi.fn(),
			participantsChanged: vi.fn(),
			moderatorUsage: vi.fn(),
			historyEntry: vi.fn(),
			participantState: vi.fn(),
			moderatorSessionIdChanged: vi.fn(),
			autoRunTriggered: vi.fn(),
			autoRunBatchComplete: vi.fn(),
			participantLiveOutput: vi.fn(),
		};
		const tracker = createSleepTracker();
		engine = createGroupChatEngine({
			store,
			events: events as unknown as GroupChatEventSink,
			agents: {
				list: () => [],
				providerConfig: () => ({}),
				providerEnvVars: () => undefined,
				conductorProfile: () => '',
				sshStore: () => null,
			},
			prompts: { get: (id) => `[${id}]` },
			power: { block: vi.fn(), unblock: vi.fn() },
			metrics: createGroupChatTurnMetrics({
				spans: { begin: tracker.beginSpan, elapsedMs: tracker.elapsedMs },
			}),
		});
		chat = await store.createGroupChat('Room', 'claude-code');
		await engine.spawnModerator(chat);
		await engine.addParticipant(chat.id, 'TestAgent', 'claude-code');
		participantProcess = `group-chat-${chat.id}-participant-TestAgent-1700000000000`;
		moderatorProcess = `group-chat-${chat.id}-moderator-1700000000000`;
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	describe('sessionAnnounced', () => {
		it("stores a participant's provider session id and tells the UI", async () => {
			await engine.sessionAnnounced(participantProcess, 'agent-session-xyz');

			const stored = await store.getParticipant(chat.id, 'TestAgent');
			expect(stored?.agentSessionId).toBe('agent-session-xyz');
			expect(events.participantsChanged).toHaveBeenCalledWith(
				chat.id,
				expect.arrayContaining([expect.objectContaining({ agentSessionId: 'agent-session-xyz' })])
			);
		});

		it("stores a moderator turn's session id apart from the routing prefix", async () => {
			await engine.sessionAnnounced(moderatorProcess, 'moderator-session-xyz');

			const stored = await store.loadGroupChat(chat.id);
			expect(stored?.moderatorAgentSessionId).toBe('moderator-session-xyz');
			expect(stored?.moderatorSessionId).toBe(`group-chat-${chat.id}-moderator`);
			expect(events.moderatorSessionIdChanged).toHaveBeenCalledWith(
				chat.id,
				'moderator-session-xyz'
			);
		});

		it('does not store a synthesis turn: its id is not the moderator conversation', async () => {
			await engine.sessionAnnounced(
				`group-chat-${chat.id}-moderator-synthesis-1700000000000`,
				'synthesis-session'
			);

			expect((await store.loadGroupChat(chat.id))?.moderatorAgentSessionId).toBeUndefined();
			expect(events.moderatorSessionIdChanged).not.toHaveBeenCalled();
		});

		it('ignores a process that is not a group chat', async () => {
			await engine.sessionAnnounced('regular-session-123', 'agent-session-abc');

			expect(events.participantsChanged).not.toHaveBeenCalled();
			expect(events.moderatorSessionIdChanged).not.toHaveBeenCalled();
		});

		it('never rejects when the chat is gone: the failure is logged and the round goes on', async () => {
			await store.deleteGroupChat(chat.id);

			await expect(engine.sessionAnnounced(participantProcess, 'agent-session-xyz')).resolves.toBe(
				undefined
			);
			await expect(
				engine.sessionAnnounced(moderatorProcess, 'moderator-session-xyz')
			).resolves.toBe(undefined);
			expect(events.participantsChanged).not.toHaveBeenCalled();
			expect(events.moderatorSessionIdChanged).not.toHaveBeenCalled();
		});
	});

	describe('usageReported', () => {
		it("updates a participant's card with cost, tokens and the share of its window", async () => {
			engine.usageReported(participantProcess, usage({ contextWindow: 100000 }));

			await vi.waitFor(async () => {
				const stored = await store.getParticipant(chat.id, 'TestAgent');
				// 1000 input + 200 cache read + 100 cache creation = 1300 of 100000
				expect(stored).toMatchObject({ contextUsage: 1, tokenCount: 1300, totalCost: 0.05 });
			});
			expect(events.participantsChanged).toHaveBeenCalledWith(chat.id, expect.any(Array));
		});

		it('falls back to the default window when the provider reports none', async () => {
			engine.usageReported(participantProcess, usage({ contextWindow: 0, inputTokens: 100000 }));

			await vi.waitFor(async () => {
				// 100300 of the 200000 fallback window
				expect((await store.getParticipant(chat.id, 'TestAgent'))?.contextUsage).toBe(50);
			});
		});

		it('keeps the previous context figures when a multi-tool turn reports an accumulated total', async () => {
			engine.usageReported(participantProcess, usage({ contextWindow: 1000 }));

			await vi.waitFor(async () => {
				const stored = await store.getParticipant(chat.id, 'TestAgent');
				// 1300 is more than a 1000 window: only the cost moves
				expect(stored?.totalCost).toBe(0.05);
				expect(stored?.contextUsage).toBeUndefined();
				expect(stored?.tokenCount).toBeUndefined();
			});
		});

		it("reports a moderator's usage as a context share, for synthesis turns too", () => {
			engine.usageReported(moderatorProcess, usage({ contextWindow: 13000 }));
			engine.usageReported(
				`group-chat-${chat.id}-moderator-synthesis-1700000000001`,
				usage({ contextWindow: 13000 })
			);

			expect(events.moderatorUsage).toHaveBeenNthCalledWith(1, chat.id, {
				contextUsage: 10,
				totalCost: 0.05,
				tokenCount: 1300,
			});
			expect(events.moderatorUsage).toHaveBeenCalledTimes(2);
		});

		it('reports -1 for a moderator total that does not fit the window, so the card keeps its numbers', () => {
			engine.usageReported(moderatorProcess, usage({ contextWindow: 1000 }));

			expect(events.moderatorUsage).toHaveBeenCalledWith(chat.id, {
				contextUsage: -1,
				totalCost: 0.05,
				tokenCount: -1,
			});
		});

		it('ignores a process that is not a group chat', () => {
			engine.usageReported('regular-session-123', usage());

			expect(events.moderatorUsage).not.toHaveBeenCalled();
			expect(events.participantsChanged).not.toHaveBeenCalled();
		});

		it('logs and carries on when the participant write fails', async () => {
			await store.deleteGroupChat(chat.id);

			engine.usageReported(participantProcess, usage());
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(events.participantsChanged).not.toHaveBeenCalled();
		});
	});

	describe('liveOutput', () => {
		it("streams a participant's chunks to its peek panel", () => {
			engine.liveOutput(participantProcess, '{"type":"assistant"}');

			expect(events.participantLiveOutput).toHaveBeenCalledWith(
				chat.id,
				'TestAgent',
				'{"type":"assistant"}'
			);
		});

		it("does not show a moderator's output, nor a process that is not a group chat's", () => {
			engine.liveOutput(moderatorProcess, 'chunk');
			engine.liveOutput('regular-session-123', 'chunk');

			expect(events.participantLiveOutput).not.toHaveBeenCalled();
		});
	});
});
