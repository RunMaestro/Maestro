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
import type { GroupChat, GroupChatEventSink, GroupChatParticipant } from '../types';

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
	let metrics: ReturnType<typeof createGroupChatTurnMetrics>;
	let loadGroupChat: ReturnType<typeof vi.fn<GroupChatStore['loadGroupChat']>>;
	let updateParticipant: ReturnType<typeof vi.fn<GroupChatStore['updateParticipant']>>;
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
		metrics = createGroupChatTurnMetrics({
			spans: { begin: tracker.beginSpan, elapsedMs: tracker.elapsedMs },
		});
		// The engine captures these methods during construction; keep the real store behind them.
		loadGroupChat = vi.fn(store.loadGroupChat);
		updateParticipant = vi.fn(store.updateParticipant);
		engine = createGroupChatEngine({
			store: { ...store, loadGroupChat, updateParticipant },
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
			metrics,
		});
		chat = await store.createGroupChat('Room', 'claude-code');
		await engine.spawnModerator(chat);
		await engine.addParticipant(chat.id, 'TestAgent', 'claude-code');
		participantProcess = `group-chat-${chat.id}-participant-TestAgent-1700000000000`;
		moderatorProcess = `group-chat-${chat.id}-moderator-1700000000000`;
	});

	afterEach(async () => {
		await engine.drainUsageUpdates();
		await store.drain();
		metrics.reset();
		vi.restoreAllMocks();
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

		it("reports a moderator's usage as a context share, for synthesis turns too", async () => {
			engine.usageReported(moderatorProcess, usage({ contextWindow: 13000 }));
			engine.usageReported(
				`group-chat-${chat.id}-moderator-synthesis-1700000000001`,
				usage({ contextWindow: 13000 })
			);
			await engine.drainUsageUpdates();

			expect(events.moderatorUsage).toHaveBeenNthCalledWith(1, chat.id, {
				contextUsage: 10,
				totalCost: 0.05,
				tokenCount: 1300,
			});
			expect(events.moderatorUsage).toHaveBeenCalledTimes(2);
		});

		it('reports -1 for a moderator total that does not fit the window, so the card keeps its numbers', async () => {
			engine.usageReported(moderatorProcess, usage({ contextWindow: 1000 }));
			await engine.drainUsageUpdates();

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
			await engine.drainUsageUpdates();

			expect(events.participantsChanged).not.toHaveBeenCalled();
		});
	});

	describe.each(['participant', 'moderator'] as const)('Grok %s usage', (role) => {
		let processId: string;
		let owner: string;

		beforeEach(async () => {
			const stored = (await store.loadGroupChat(chat.id))!;
			await store.updateGroupChat(chat.id, {
				moderatorAgentId: role === 'moderator' ? 'grok' : 'claude-code',
				participants: stored.participants.map((participant) => ({
					...participant,
					agentId: role === 'participant' ? 'grok' : 'claude-code',
				})),
			});
			processId = role === 'participant' ? participantProcess : moderatorProcess;
			owner = role === 'participant' ? 'TestAgent' : 'Moderator';
			events.participantsChanged.mockClear();
			loadGroupChat.mockClear();
			updateParticipant.mockClear();
		});

		it.each([undefined, 0, -1, NaN, Infinity, -Infinity])(
			'withholds context for window %s without losing usage accounting',
			async (contextWindow) => {
				metrics.begin(processId);
				engine.usageReported(processId, usage({ contextWindow, inputTokens: 100000 }));
				await engine.drainUsageUpdates();

				const observed =
					role === 'participant'
						? await store.getParticipant(chat.id, 'TestAgent')
						: events.moderatorUsage.mock.calls.at(-1)?.[1];
				expect(observed).toBeDefined();
				expect(observed?.contextUsage).toBe(role === 'participant' ? undefined : -2);
				expect(observed?.tokenCount).toBe(role === 'participant' ? undefined : -2);
				expect(observed?.totalCost).toBe(0.05);
				// Includes output and both cache categories even though the card has no denominator.
				expect(metrics.finish(chat.id, owner)).toMatchObject({ tokenCount: 100800, cost: 0.05 });
				expect(metrics.finish(chat.id, owner)).toEqual({});
			}
		);

		it.each([
			[13000, 10],
			[26000, 5],
			[1300, 100],
		])(
			'uses the supplied %i window for a %i percent measurement',
			async (contextWindow, percent) => {
				engine.usageReported(processId, usage({ contextWindow }));
				await engine.drainUsageUpdates();

				const observed =
					role === 'participant'
						? await store.getParticipant(chat.id, 'TestAgent')
						: events.moderatorUsage.mock.calls.at(-1)?.[1];
				expect(observed).toMatchObject({
					contextUsage: percent,
					tokenCount: 1300,
					totalCost: 0.05,
				});
				expect(loadGroupChat).not.toHaveBeenCalled();
			}
		);

		it.each([0, 13000])(
			'handles empty usage with window %i without dividing by zero',
			async (contextWindow) => {
				engine.usageReported(
					processId,
					usage({
						contextWindow,
						inputTokens: 0,
						outputTokens: 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0,
					})
				);
				await engine.drainUsageUpdates();

				const observed =
					role === 'participant'
						? await store.getParticipant(chat.id, 'TestAgent')
						: events.moderatorUsage.mock.calls.at(-1)?.[1];
				const expected = contextWindow > 0 ? 0 : role === 'participant' ? undefined : -2;
				expect(observed).toBeDefined();
				expect(observed?.contextUsage).toBe(expected);
				expect(observed?.tokenCount).toBe(expected);
				expect(observed?.totalCost).toBe(0);
			}
		);

		it('clears a previous measurement and uses the newly selected context when it becomes known', async () => {
			metrics.begin(processId);
			for (const [contextWindow, totalCostUsd, percent] of [
				[13000, 0.01, 10],
				[0, 0.02, undefined],
				[26000, 0.03, 5],
			] as const) {
				engine.usageReported(processId, usage({ contextWindow, totalCostUsd }));
				await engine.drainUsageUpdates();
				const observed =
					role === 'participant'
						? await store.getParticipant(chat.id, 'TestAgent')
						: events.moderatorUsage.mock.calls.at(-1)?.[1];
				const unavailable = role === 'participant' ? undefined : -2;
				expect(observed).toBeDefined();
				expect(observed?.contextUsage).toBe(percent ?? unavailable);
				expect(observed?.tokenCount).toBe(contextWindow > 0 ? 1300 : unavailable);
				expect(observed?.totalCost).toBe(totalCostUsd);
			}
			expect(metrics.finish(chat.id, owner)).toMatchObject({ tokenCount: 5400, cost: 0.06 });
		});

		it('preserves the last context measurement for accumulated usage while accounting for all tokens', async () => {
			metrics.begin(processId);
			engine.usageReported(processId, usage({ contextWindow: 13000, totalCostUsd: 0.01 }));
			engine.usageReported(
				processId,
				usage({ contextWindow: 13000, inputTokens: 20000, totalCostUsd: 0.03 })
			);
			await engine.drainUsageUpdates();

			const observed =
				role === 'participant'
					? await store.getParticipant(chat.id, 'TestAgent')
					: events.moderatorUsage.mock.calls.at(-1)?.[1];
			expect(observed).toMatchObject({
				contextUsage: role === 'participant' ? 10 : -1,
				tokenCount: role === 'participant' ? 1300 : -1,
				totalCost: 0.03,
			});
			expect(metrics.finish(chat.id, owner)).toMatchObject({ tokenCount: 22600, cost: 0.04 });
		});

		it.each([
			['claude-code', 0],
			['codex', undefined],
			['opencode', NaN],
		] as const)('retains the 200K group-chat fallback for %s', async (agentId, contextWindow) => {
			const stored = (await store.loadGroupChat(chat.id))!;
			// The other role remains Grok, so its unknown default must not contaminate this owner.
			await store.updateGroupChat(chat.id, {
				moderatorAgentId: role === 'moderator' ? agentId : 'grok',
				participants: stored.participants.map((participant) => ({
					...participant,
					agentId: role === 'participant' ? agentId : 'grok',
				})),
			});
			engine.usageReported(processId, usage({ contextWindow, inputTokens: 100000 }));
			await engine.drainUsageUpdates();

			const observed =
				role === 'participant'
					? await store.getParticipant(chat.id, 'TestAgent')
					: events.moderatorUsage.mock.calls.at(-1)?.[1];
			expect(observed).toMatchObject({ contextUsage: 50, tokenCount: 100300, totalCost: 0.05 });
		});

		it('orders a delayed unknown lookup before a recovery or synthesis turn and finishes accounting immediately', async () => {
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			loadGroupChat.mockImplementationOnce(async (id) => {
				entered.resolve();
				await gate.promise;
				return store.loadGroupChat(id);
			});
			const replacement =
				role === 'participant'
					? `group-chat-${chat.id}-participant-TestAgent-recovery-1700000000001`
					: `group-chat-${chat.id}-moderator-synthesis-1700000000001`;
			try {
				metrics.begin(processId);
				engine.usageReported(processId, usage({ contextWindow: 0, totalCostUsd: 0.01 }));
				engine.usageReported(processId, usage({ contextWindow: 0, totalCostUsd: 0.02 }));
				await entered.promise;
				expect(metrics.finish(chat.id, owner)).toMatchObject({ tokenCount: 3600, cost: 0.03 });
				expect(metrics.finish(chat.id, owner)).toEqual({});
				metrics.begin(replacement);
				engine.usageReported(replacement, usage({ contextWindow: 26000, totalCostUsd: 0.04 }));
				expect(metrics.finish(chat.id, owner)).toMatchObject({ tokenCount: 1800, cost: 0.04 });
				expect(events.participantsChanged).not.toHaveBeenCalled();
				expect(events.moderatorUsage).not.toHaveBeenCalled();
				gate.resolve();
				await engine.drainUsageUpdates();

				const observations =
					role === 'participant'
						? events.participantsChanged.mock.calls.map(([, participants]) =>
								participants.find((p: GroupChatParticipant) => p.name === 'TestAgent')
							)
						: events.moderatorUsage.mock.calls.map(([, observation]) => observation);
				const unavailable = role === 'participant' ? undefined : -2;
				expect(observations).toMatchObject([
					{ contextUsage: unavailable, tokenCount: unavailable, totalCost: 0.01 },
					{ contextUsage: unavailable, tokenCount: unavailable, totalCost: 0.02 },
					{ contextUsage: 5, tokenCount: 1300, totalCost: 0.04 },
				]);
				if (role === 'participant') {
					expect(await store.getParticipant(chat.id, 'TestAgent')).toMatchObject({
						contextUsage: 5,
						tokenCount: 1300,
						totalCost: 0.04,
					});
				}
				expect(metrics.finish(chat.id, owner)).toEqual({});
			} finally {
				gate.resolve();
				await engine.drainUsageUpdates();
			}
		});

		it('continues after a rejected provider lookup and retains both usage reports in the ledger', async () => {
			loadGroupChat.mockRejectedValueOnce(new Error(`Group chat not found: ${chat.id}`));
			metrics.begin(processId);
			engine.usageReported(processId, usage({ contextWindow: 0, totalCostUsd: 0.01 }));
			await engine.drainUsageUpdates();
			expect(events.participantsChanged).not.toHaveBeenCalled();
			expect(events.moderatorUsage).not.toHaveBeenCalled();

			engine.usageReported(processId, usage({ contextWindow: 0, totalCostUsd: 0.03 }));
			await engine.drainUsageUpdates();
			const observed =
				role === 'participant'
					? await store.getParticipant(chat.id, 'TestAgent')
					: events.moderatorUsage.mock.calls.at(-1)?.[1];
			expect(observed?.totalCost).toBe(0.03);
			expect(observed?.contextUsage).toBe(role === 'participant' ? undefined : -2);
			expect(loadGroupChat).toHaveBeenCalledTimes(2);
			expect(metrics.finish(chat.id, owner)).toMatchObject({ tokenCount: 3600, cost: 0.04 });
		});
	});

	it('recovers after a rejected Grok participant write without dropping token or cost accounting', async () => {
		const stored = (await store.loadGroupChat(chat.id))!;
		await store.updateGroupChat(chat.id, {
			participants: stored.participants.map((participant) => ({ ...participant, agentId: 'grok' })),
		});
		events.participantsChanged.mockClear();
		updateParticipant.mockRejectedValueOnce(new Error(`Group chat not found: ${chat.id}`));
		metrics.begin(participantProcess);
		engine.usageReported(participantProcess, usage({ contextWindow: 0, totalCostUsd: 0.01 }));
		await engine.drainUsageUpdates();
		expect(events.participantsChanged).not.toHaveBeenCalled();
		engine.usageReported(participantProcess, usage({ contextWindow: 13000, totalCostUsd: 0.03 }));
		await engine.drainUsageUpdates();
		expect(await store.getParticipant(chat.id, 'TestAgent')).toMatchObject({
			contextUsage: 10,
			tokenCount: 1300,
			totalCost: 0.03,
		});
		expect(events.participantsChanged).toHaveBeenCalledTimes(1);
		expect(metrics.finish(chat.id, 'TestAgent')).toMatchObject({ tokenCount: 3600, cost: 0.04 });
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
