import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useInputSync } from '../../../renderer/hooks/input/useInputSync';
import type { AITab, Session } from '../../../renderer/types';

function makeTab(overrides: Partial<AITab> & { id: string }): AITab {
	return {
		id: overrides.id,
		name: overrides.name ?? null,
		inputValue: overrides.inputValue ?? '',
		logs: overrides.logs ?? [],
		isProcessing: overrides.isProcessing ?? false,
		...overrides,
	} as AITab;
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
	const aiTabs = overrides.aiTabs ?? [];
	return {
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		activeTabId: overrides.activeTabId ?? aiTabs[0]?.id ?? '',
		aiTabs,
		terminalDraftInput: overrides.terminalDraftInput,
	} as Session;
}

function renderInputSync(activeSession: Session | null, initialSessions: Session[]) {
	let sessions = initialSessions;
	const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
	});
	const hook = renderHook(() => useInputSync(activeSession, { setSessions }));

	return {
		...hook,
		getSessions: () => sessions,
		setSessions,
	};
}

describe('useInputSync', () => {
	it('does not sync AI input when there is no active session', () => {
		const rendered = renderInputSync(null, [makeSession({ id: 'session-1' })]);

		act(() => {
			rendered.result.current.syncAiInputToSession('draft');
		});

		expect(rendered.setSessions).not.toHaveBeenCalled();
	});

	it('syncs AI input to the active tab for the active session only', () => {
		const activeSession = makeSession({
			id: 'session-1',
			activeTabId: 'tab-2',
			aiTabs: [
				makeTab({ id: 'tab-1', inputValue: 'old one' }),
				makeTab({ id: 'tab-2', inputValue: 'old two' }),
			],
		});
		const otherSession = makeSession({
			id: 'session-2',
			aiTabs: [makeTab({ id: 'other-tab', inputValue: 'other draft' })],
		});
		const rendered = renderInputSync(activeSession, [activeSession, otherSession]);

		act(() => {
			rendered.result.current.syncAiInputToSession('new draft');
		});

		expect(rendered.getSessions()).toEqual([
			expect.objectContaining({
				id: 'session-1',
				aiTabs: [
					expect.objectContaining({ id: 'tab-1', inputValue: 'old one' }),
					expect.objectContaining({ id: 'tab-2', inputValue: 'new draft' }),
				],
			}),
			otherSession,
		]);
	});

	it('falls back to the first AI tab when activeTabId is stale', () => {
		const activeSession = makeSession({
			id: 'session-1',
			activeTabId: 'missing-tab',
			aiTabs: [
				makeTab({ id: 'tab-1', inputValue: 'old one' }),
				makeTab({ id: 'tab-2', inputValue: 'old two' }),
			],
		});
		const rendered = renderInputSync(activeSession, [activeSession]);

		act(() => {
			rendered.result.current.syncAiInputToSession('fallback draft');
		});

		expect(rendered.getSessions()[0].aiTabs).toEqual([
			expect.objectContaining({ id: 'tab-1', inputValue: 'fallback draft' }),
			expect.objectContaining({ id: 'tab-2', inputValue: 'old two' }),
		]);
	});

	it('leaves AI input unchanged when the active session has no tabs', () => {
		const activeSession = makeSession({ id: 'session-1', aiTabs: [] });
		const rendered = renderInputSync(activeSession, [activeSession]);

		act(() => {
			rendered.result.current.syncAiInputToSession('ignored draft');
		});

		expect(rendered.getSessions()).toEqual([activeSession]);
	});

	it('syncs terminal input to an explicitly targeted session', () => {
		const activeSession = makeSession({ id: 'active-session' });
		const rendered = renderInputSync(activeSession, [
			activeSession,
			makeSession({ id: 'target-session', terminalDraftInput: 'old terminal' }),
		]);

		act(() => {
			rendered.result.current.syncTerminalInputToSession('new terminal', 'target-session');
		});

		expect(rendered.getSessions()).toEqual([
			activeSession,
			expect.objectContaining({
				id: 'target-session',
				terminalDraftInput: 'new terminal',
			}),
		]);
	});

	it('syncs terminal input to the active session when no target is provided', () => {
		const activeSession = makeSession({ id: 'active-session', terminalDraftInput: 'old' });
		const rendered = renderInputSync(activeSession, [activeSession]);

		act(() => {
			rendered.result.current.syncTerminalInputToSession('new terminal');
		});

		expect(rendered.getSessions()).toEqual([
			expect.objectContaining({
				id: 'active-session',
				terminalDraftInput: 'new terminal',
			}),
		]);
	});

	it('does not sync terminal input when no target session can be resolved', () => {
		const rendered = renderInputSync(null, [makeSession({ id: 'session-1' })]);

		act(() => {
			rendered.result.current.syncTerminalInputToSession('ignored terminal');
		});

		expect(rendered.setSessions).not.toHaveBeenCalled();
	});
});
