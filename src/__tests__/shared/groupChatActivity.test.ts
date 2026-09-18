/**
 * Tests for group chat working-time math.
 *
 * The bug this module exists to prevent is a chat that reports 481 hours of
 * "duration" for an afternoon of work, because it measured the age of the room
 * instead of the work done in it. These cases pin the properties that keep the
 * number honest: parallel turns collapse instead of summing, idle nights are
 * excluded, and a chat whose turns carried no usage reports unknown rather
 * than free.
 */

import { describe, it, expect } from 'vitest';
import {
	computeGroupChatActivity,
	GROUP_CHAT_ACTIVITY_STITCH_MS,
} from '../../shared/groupChatActivity';
import type { GroupChatHistoryEntry } from '../../shared/group-chat-types';

const T0 = 1_700_000_000_000;

function entry(overrides: Partial<GroupChatHistoryEntry> = {}): GroupChatHistoryEntry {
	return {
		id: `e${Math.round(overrides.timestamp ?? 0)}`,
		timestamp: T0,
		summary: 'did a thing',
		participantName: 'rc',
		participantColor: '#fff',
		type: 'response',
		...overrides,
	};
}

const MIN = 60_000;

describe('computeGroupChatActivity', () => {
	it('reports zeros for an empty history', () => {
		const totals = computeGroupChatActivity([]);
		expect(totals.workingTimeMs).toBe(0);
		expect(totals.totalTurns).toBe(0);
		expect(totals.turnsWithTokens).toBe(0);
	});

	it('measures a single turn by its own duration, not by its timestamp', () => {
		const totals = computeGroupChatActivity([
			entry({ timestamp: T0 + 10 * MIN, elapsedTimeMs: 3 * MIN }),
		]);
		expect(totals.workingTimeMs).toBe(3 * MIN);
		expect(totals.measuredTurns).toBe(1);
	});

	it('collapses parallel turns instead of summing them', () => {
		// Three agents each work the same 10 minutes. That is ten minutes of
		// chat time, not thirty.
		const totals = computeGroupChatActivity([
			entry({ participantName: 'a', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
			entry({ participantName: 'b', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
			entry({ participantName: 'c', timestamp: T0 + 10 * MIN, elapsedTimeMs: 10 * MIN }),
		]);
		expect(totals.workingTimeMs).toBe(10 * MIN);
	});

	it('excludes an idle gap between two work blocks', () => {
		const dayLater = T0 + 24 * 60 * MIN;
		const totals = computeGroupChatActivity([
			entry({ timestamp: T0, elapsedTimeMs: 2 * MIN }),
			entry({ timestamp: dayLater, elapsedTimeMs: 2 * MIN }),
		]);
		expect(totals.workingTimeMs).toBe(4 * MIN);
	});

	it('stitches turns that land closer together than the idle gap', () => {
		// Untimed turns are points. Without stitching a whole chat reports 0m.
		const totals = computeGroupChatActivity([
			entry({ timestamp: T0 }),
			entry({ timestamp: T0 + 1 * MIN }),
			entry({ timestamp: T0 + 2 * MIN }),
		]);
		expect(totals.workingTimeMs).toBe(2 * MIN);
		expect(totals.measuredTurns).toBe(0);
		expect(totals.totalTurns).toBe(3);
	});

	it('splits blocks when the gap exceeds the stitch window', () => {
		const gap = GROUP_CHAT_ACTIVITY_STITCH_MS + MIN;
		const totals = computeGroupChatActivity([
			entry({ timestamp: T0 }),
			entry({ timestamp: T0 + MIN }),
			entry({ timestamp: T0 + MIN + gap }),
		]);
		expect(totals.workingTimeMs).toBe(MIN);
	});

	it('sorts entries itself, since the history log reads newest first', () => {
		const newestFirst = [
			entry({ timestamp: T0 + 4 * MIN, elapsedTimeMs: MIN }),
			entry({ timestamp: T0 + 2 * MIN, elapsedTimeMs: MIN }),
		];
		expect(computeGroupChatActivity(newestFirst).workingTimeMs).toBe(3 * MIN);
	});

	it('ignores a negative or missing duration rather than shrinking the union', () => {
		const totals = computeGroupChatActivity([
			entry({ timestamp: T0 + 5 * MIN, elapsedTimeMs: -1000 }),
			entry({ timestamp: T0 + 6 * MIN }),
		]);
		expect(totals.workingTimeMs).toBe(MIN);
		expect(totals.measuredTurns).toBe(0);
	});

	it('sums tokens and cost only from turns that reported them', () => {
		const totals = computeGroupChatActivity([
			entry({ timestamp: T0, tokenCount: 1000, cost: 0.25 }),
			entry({ timestamp: T0 + MIN, tokenCount: 500 }),
			entry({ timestamp: T0 + 2 * MIN }),
		]);
		expect(totals.tokenCount).toBe(1500);
		expect(totals.turnsWithTokens).toBe(2);
		expect(totals.costUsd).toBeCloseTo(0.25);
		expect(totals.turnsWithCost).toBe(1);
		expect(totals.totalTurns).toBe(3);
	});

	it('reports no token coverage when nothing recorded usage', () => {
		const totals = computeGroupChatActivity([entry({ timestamp: T0 }), entry({ timestamp: T0 })]);
		expect(totals.turnsWithTokens).toBe(0);
		expect(totals.tokenCount).toBe(0);
	});
});
