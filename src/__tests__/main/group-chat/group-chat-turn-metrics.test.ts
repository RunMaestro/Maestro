/**
 * Tests for group chat per-turn measurement.
 *
 * Group chat turns never reach the renderer's stats pipeline, so this module is
 * the only thing that can say how long a turn ran or what it burned. These
 * cases pin the properties that keep the answer attributable: parallel
 * participants stay separate, a turn nobody started reports nothing rather
 * than a fabricated zero, and a respawn does not inherit the abandoned turn's
 * tokens.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
	beginGroupChatTurn,
	recordGroupChatTurnUsage,
	finishGroupChatTurn,
	resolveGroupChatTurnKey,
	getGroupChatTurnCount,
	resetGroupChatTurnMetricsForTests,
} from '../../../main/group-chat/group-chat-turn-metrics';
import type { UsageStats } from '../../../shared/types';

const CHAT = '550e8400-e29b-41d4-a716-446655440000';

function usage(overrides: Partial<UsageStats> = {}): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200000,
		...overrides,
	};
}

describe('group-chat-turn-metrics', () => {
	beforeEach(() => {
		resetGroupChatTurnMetricsForTests();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('resolveGroupChatTurnKey', () => {
		it('resolves a participant session', () => {
			expect(resolveGroupChatTurnKey(`group-chat-${CHAT}-participant-rc-1702934567890`)).toEqual({
				groupChatId: CHAT,
				participantName: 'rc',
			});
		});

		it('resolves a moderator session to the name the history log uses', () => {
			expect(resolveGroupChatTurnKey(`group-chat-${CHAT}-moderator-1702934567890`)).toEqual({
				groupChatId: CHAT,
				participantName: 'Moderator',
			});
		});

		it('refuses a session that is not a group chat turn', () => {
			expect(resolveGroupChatTurnKey('agent-123-ai-tab1')).toBeNull();
		});
	});

	it('reports the elapsed time of a finished turn', () => {
		beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
		vi.advanceTimersByTime(90_000);

		expect(finishGroupChatTurn(CHAT, 'rc').elapsedTimeMs).toBe(90_000);
	});

	it('sums usage events into the turn that is running', () => {
		const session = `group-chat-${CHAT}-participant-rc-1`;
		beginGroupChatTurn(session);
		recordGroupChatTurnUsage(session, usage({ inputTokens: 100, outputTokens: 20 }));
		recordGroupChatTurnUsage(
			session,
			usage({ cacheReadInputTokens: 800, cacheCreationInputTokens: 80, totalCostUsd: 0.5 })
		);

		const metrics = finishGroupChatTurn(CHAT, 'rc');
		expect(metrics.tokenCount).toBe(1000);
		expect(metrics.cost).toBeCloseTo(0.5);
	});

	it('keeps parallel participants apart', () => {
		beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
		beginGroupChatTurn(`group-chat-${CHAT}-participant-Maestro-2`);
		recordGroupChatTurnUsage(`group-chat-${CHAT}-participant-rc-1`, usage({ inputTokens: 500 }));
		recordGroupChatTurnUsage(`group-chat-${CHAT}-participant-Maestro-2`, usage({ inputTokens: 7 }));

		expect(finishGroupChatTurn(CHAT, 'rc').tokenCount).toBe(500);
		expect(finishGroupChatTurn(CHAT, 'Maestro').tokenCount).toBe(7);
	});

	it('reports nothing at all when no turn is in flight', () => {
		expect(finishGroupChatTurn(CHAT, 'rc')).toEqual({});
	});

	it('omits tokens rather than reporting a fabricated zero', () => {
		beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
		const metrics = finishGroupChatTurn(CHAT, 'rc');

		expect(metrics.elapsedTimeMs).toBeDefined();
		expect(metrics.tokenCount).toBeUndefined();
		expect(metrics.cost).toBeUndefined();
	});

	it('does not carry an abandoned turn usage into its respawn', () => {
		const first = `group-chat-${CHAT}-participant-rc-1`;
		beginGroupChatTurn(first);
		recordGroupChatTurnUsage(first, usage({ inputTokens: 900 }));

		const recovery = `group-chat-${CHAT}-participant-rc-recovery-2`;
		beginGroupChatTurn(recovery);
		recordGroupChatTurnUsage(recovery, usage({ inputTokens: 5 }));

		expect(finishGroupChatTurn(CHAT, 'rc').tokenCount).toBe(5);
	});

	it('ignores a late event from an abandoned session', () => {
		const first = `group-chat-${CHAT}-participant-rc-1`;
		beginGroupChatTurn(first);
		beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-recovery-2`);
		recordGroupChatTurnUsage(first, usage({ inputTokens: 900 }));

		expect(finishGroupChatTurn(CHAT, 'rc').tokenCount).toBeUndefined();
	});

	it('drops the turn once it has been claimed', () => {
		beginGroupChatTurn(`group-chat-${CHAT}-participant-rc-1`);
		expect(getGroupChatTurnCount()).toBe(1);

		finishGroupChatTurn(CHAT, 'rc');
		expect(getGroupChatTurnCount()).toBe(0);
	});

	it('ignores sessions that are not group chat turns', () => {
		beginGroupChatTurn('agent-123-ai-tab1');
		expect(getGroupChatTurnCount()).toBe(0);
	});
});
