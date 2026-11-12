/**
 * Tests for src/renderer/services/snoozeWakePrompt.ts
 *
 * A snooze can carry a prompt as well as a note. The note is addressed to the
 * user; the prompt is addressed to the agent, and it fires whenever the tab
 * comes BACK - on the schedule or when pulled back early.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueuePromptForTab = vi.fn();
vi.mock('../../../renderer/services/queuedPrompt', () => ({
	enqueuePromptForTab: (...args: unknown[]) => enqueuePromptForTab(...args),
}));

import {
	runSnoozeWakePrompt,
	runSnoozeWakePromptAfterGroupWake,
} from '../../../renderer/services/snoozeWakePrompt';
import { createMockAITab } from '../../helpers/mockTab';
import type { SnoozedTabEntry } from '../../../renderer/types';

function aiSnooze(overrides: Partial<SnoozedTabEntry> = {}): SnoozedTabEntry {
	return {
		type: 'ai',
		tab: createMockAITab({ id: 'b', name: 'Bravo' }),
		id: 'snooze-1',
		unifiedIndex: 1,
		snoozedAt: 0,
		wakeAt: 0,
		...overrides,
	} as SnoozedTabEntry;
}

describe('runSnoozeWakePrompt', () => {
	beforeEach(() => {
		enqueuePromptForTab.mockReset();
		enqueuePromptForTab.mockReturnValue({ id: 'item-1' });
	});

	it('queues the prompt into the tab that came back', () => {
		const fired = runSnoozeWakePrompt(
			'session-1',
			aiSnooze({ wakePrompt: 'summarize what changed' }),
			'b'
		);

		expect(fired).toBe(true);
		expect(enqueuePromptForTab).toHaveBeenCalledWith({
			sessionId: 'session-1',
			tabId: 'b',
			text: 'summarize what changed',
		});
	});

	it('does nothing for a snooze with no prompt', () => {
		expect(runSnoozeWakePrompt('session-1', aiSnooze(), 'b')).toBe(false);
		expect(enqueuePromptForTab).not.toHaveBeenCalled();
	});

	it('does nothing when the parked tab was not a conversation', () => {
		// A file tab has nowhere to send a prompt, so an entry that somehow
		// carries one must not have it rerouted to whatever tab is nearby.
		const fileEntry = aiSnooze({ wakePrompt: 'do the thing' });
		const asFile = { ...fileEntry, type: 'file', tab: { id: 'f1' } } as unknown as SnoozedTabEntry;

		expect(runSnoozeWakePrompt('session-1', asFile, 'f1')).toBe(false);
		expect(enqueuePromptForTab).not.toHaveBeenCalled();
	});

	it('reports false when the queue refuses the prompt', () => {
		enqueuePromptForTab.mockReturnValue(null);
		expect(runSnoozeWakePrompt('session-1', aiSnooze({ wakePrompt: 'go' }), 'b')).toBe(false);
	});
});

describe('runSnoozeWakePromptAfterGroupWake', () => {
	const groupEntry = {
		type: 'group',
		id: 'snooze-2',
		unifiedIndex: 0,
		snoozedAt: 0,
		wakeAt: 0,
		wakePrompt: 'pick up where we left off',
		group: { id: 'g1' },
		members: [
			{ type: 'ai', tab: createMockAITab({ id: 'ai-dead' }) },
			{ type: 'ai', tab: createMockAITab({ id: 'ai-alive' }) },
		],
	} as unknown as SnoozedTabEntry;

	beforeEach(() => {
		enqueuePromptForTab.mockReset();
		enqueuePromptForTab.mockReturnValue({ id: 'item-1' });
	});

	it('skips panes the wake could not bring back', () => {
		runSnoozeWakePromptAfterGroupWake('session-1', groupEntry, 'g1', [
			{ type: 'ai', tab: createMockAITab({ id: 'ai-dead' }) },
		]);

		expect(enqueuePromptForTab).toHaveBeenCalledWith(
			expect.objectContaining({ tabId: 'ai-alive' })
		);
	});

	it('queues nothing when every AI pane was dropped', () => {
		const fired = runSnoozeWakePromptAfterGroupWake('session-1', groupEntry, 'g1', [
			{ type: 'ai', tab: createMockAITab({ id: 'ai-dead' }) },
			{ type: 'ai', tab: createMockAITab({ id: 'ai-alive' }) },
		]);

		expect(fired).toBe(false);
		expect(enqueuePromptForTab).not.toHaveBeenCalled();
	});
});
