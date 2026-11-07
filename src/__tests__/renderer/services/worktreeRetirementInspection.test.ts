import { describe, expect, it } from 'vitest';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, BatchRunState, FilePreviewTab, QueuedItem } from '../../../renderer/types';
import { retirementSessionBlocker } from '../../../renderer/services/worktreeRetirementInspection';

const composer = { aiValue: '', aiValueTabId: null, terminalValue: '' };
const tab = { id: 'tab-1', state: 'idle', inputValue: '', stagedImages: [] } as AITab;

describe('retirementSessionBlocker', () => {
	it('keeps idle saved transcripts eligible for further checks', () => {
		const session = createMockSession({
			aiTabs: [{ ...tab, logs: [{ text: 'saved history' }] } as AITab],
		});
		expect(retirementSessionBlocker(session, undefined, composer, false)).toBeUndefined();
		expect(session.aiTabs[0].logs[0].text).toBe('saved history');
	});

	it('rejects held queue items, pending steers, running tabs and paused Auto Run', () => {
		const session = createMockSession({ executionQueue: [{ paused: true } as QueuedItem] });
		expect(retirementSessionBlocker(session, undefined, composer, false)).toBe('queued work');
		session.executionQueue = [];
		session.pendingSteers = [{} as NonNullable<typeof session.pendingSteers>[number]];
		expect(retirementSessionBlocker(session, undefined, composer, false)).toBe('queued work');
		session.pendingSteers = [];
		session.aiTabs = [{ ...tab, state: 'busy' }];
		expect(retirementSessionBlocker(session, undefined, composer, false)).toBe('agent activity');
		session.aiTabs = [tab];
		expect(
			retirementSessionBlocker(
				session,
				{ isRunning: true, errorPaused: true } as BatchRunState,
				composer,
				false
			)
		).toBe('Auto Run');
	});

	it('sees a live composer draft before it is written to the tab', () => {
		const session = createMockSession({ aiTabs: [tab] });
		expect(
			retirementSessionBlocker(
				session,
				undefined,
				{ ...composer, aiValue: 'draft', aiValueTabId: tab.id },
				false
			)
		).toBe('AI draft');
		expect(retirementSessionBlocker(session, undefined, { ...composer, aiValue: ' ' }, true)).toBe(
			'AI draft'
		);
		expect(
			retirementSessionBlocker(session, undefined, { ...composer, terminalValue: 'ls' }, true)
		).toBe('terminal draft');
	});

	it('rejects open file tabs and snoozes that can wake later', () => {
		const session = createMockSession({ filePreviewTabs: [{} as FilePreviewTab] });
		expect(retirementSessionBlocker(session, undefined, composer, false)).toBe('open file tabs');
		session.filePreviewTabs = [];
		session.snoozedTabs = [{} as NonNullable<typeof session.snoozedTabs>[number]];
		expect(retirementSessionBlocker(session, undefined, composer, false)).toBe('snoozed tabs');
	});
});
