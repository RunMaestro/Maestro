/**
 * Tests for src/renderer/services/aiTabClose.ts
 *
 * One close sequence for a click on a tab chip and for Tab Cleanup
 * Suggestions. The steps that fail without anyone noticing are pinned here:
 * the transcript snapshot is taken before the tab leaves the session, the
 * close is undoable, a wizard tab is not put in the history, and the agent
 * named is the agent acted on, whichever one is on screen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runtime = vi.hoisted(() => ({ webDesktop: false }));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => runtime.webDesktop,
}));

const snapshotClosedTabTranscript = vi.fn();
vi.mock('../../../renderer/utils/starredSessions', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/starredSessions')>()),
	snapshotClosedTabTranscript: (...args: unknown[]) => snapshotClosedTabTranscript(...args),
}));

const requestDesktopTabClose = vi.fn();
vi.mock('../../../renderer/services/desktopTabClose', () => ({
	requestDesktopTabClose: (...args: unknown[]) => requestDesktopTabClose(...args),
}));

import { closeAiTabInSession } from '../../../renderer/services/aiTabClose';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { getLiveDraft, setLiveDraft } from '../../../renderer/utils/liveDraftStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AITab, Session } from '../../../renderer/types';

function agentWith(id: string, tabs: AITab[]): Session {
	return createMockSession({
		id,
		aiTabs: tabs,
		unifiedTabOrder: tabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		activeTabId: tabs[0]?.id,
	});
}

function session(id: string): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === id)!;
}

beforeEach(() => {
	vi.clearAllMocks();
	runtime.webDesktop = false;
	useSessionStore.setState({
		sessions: [
			agentWith('a1', [createMockAITab({ id: 't1' }), createMockAITab({ id: 't2' })]),
			agentWith('a2', [createMockAITab({ id: 't3' }), createMockAITab({ id: 't4' })]),
		],
		activeSessionId: 'a1',
	});
});

describe('closeAiTabInSession', () => {
	it('closes a tab on an agent that is not on screen and keeps it reopenable', () => {
		expect(closeAiTabInSession('a2', 't4')).toBe(true);

		expect(session('a2').aiTabs.map((tab) => tab.id)).toEqual(['t3']);
		expect(session('a2').unifiedClosedTabHistory?.[0]).toMatchObject({
			type: 'ai',
			tab: { id: 't4' },
			unifiedIndex: 1,
		});
		expect(session('a1').aiTabs.map((tab) => tab.id)).toEqual(['t1', 't2']);
	});

	it('snapshots the transcript from the tab as it was before the close', () => {
		closeAiTabInSession('a1', 't2');

		expect(snapshotClosedTabTranscript).toHaveBeenCalledTimes(1);
		const [sessionArg, tabArg] = snapshotClosedTabTranscript.mock.calls[0];
		expect(sessionArg.id).toBe('a1');
		expect(sessionArg.aiTabs.map((tab: AITab) => tab.id)).toEqual(['t1', 't2']);
		expect(tabArg.id).toBe('t2');
	});

	it('drops the draft still being typed in the closed tab', () => {
		setLiveDraft('t2', 'never sent');
		closeAiTabInSession('a1', 't2');
		expect(getLiveDraft('t2')).toBeUndefined();
	});

	it('reports a missing agent or tab and changes nothing', () => {
		expect(closeAiTabInSession('nope', 't1')).toBe(false);
		expect(closeAiTabInSession('a1', 't3')).toBe(false);

		expect(session('a1').aiTabs).toHaveLength(2);
		expect(session('a2').aiTabs).toHaveLength(2);
		expect(snapshotClosedTabTranscript).not.toHaveBeenCalled();
	});

	it('closes a wizard tab without history and ends its wizard', () => {
		useSessionStore.setState({
			sessions: [
				agentWith('a1', [
					createMockAITab({ id: 't1' }),
					createMockAITab({ id: 'w1', wizardState: { isActive: true } as AITab['wizardState'] }),
				]),
			],
			activeSessionId: 'a1',
		});
		const endWizard = vi.fn().mockResolvedValue(undefined);

		expect(closeAiTabInSession('a1', 'w1', endWizard)).toBe(true);

		expect(session('a1').aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		expect(session('a1').unifiedClosedTabHistory ?? []).toEqual([]);
		expect(endWizard).toHaveBeenCalledWith('w1');
	});

	it('asks the desktop to close it in the browser build, and writes nothing locally', () => {
		runtime.webDesktop = true;
		const endWizard = vi.fn();

		expect(closeAiTabInSession('a2', 't4', endWizard)).toBe(true);

		expect(requestDesktopTabClose).toHaveBeenCalledWith('a2', 't4', endWizard);
		expect(session('a2').aiTabs.map((tab) => tab.id)).toEqual(['t3', 't4']);
		expect(snapshotClosedTabTranscript).not.toHaveBeenCalled();
	});
});
