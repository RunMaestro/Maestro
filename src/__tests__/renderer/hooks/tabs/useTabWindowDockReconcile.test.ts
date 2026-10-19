import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	dockStaleTabWindowRefs,
	findDockedTabsToFocus,
	focusDockedTabs,
	useTabWindowDockReconcile,
} from '../../../../renderer/hooks/tabs/useTabWindowDockReconcile';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useTabWindowStore } from '../../../../renderer/stores/tabWindowStore';
import type { Session } from '../../../../renderer/types';
import type { TabWindowInfo, TabWindowTabRef } from '../../../../shared/tabWindowTypes';
import { createMockAITab, createMockFileTab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import { installTabWindowsApi } from '../../../helpers/tabWindows';

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

function agent(id: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id,
		aiTabs: [
			createMockAITab({ id: 'a1' }),
			createMockAITab({ id: 'a2' }),
			createMockAITab({ id: 'a3' }),
		],
		filePreviewTabs: [createMockFileTab({ id: 'f1' })],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a1' },
			{ type: 'ai', id: 'a2' },
			{ type: 'file', id: 'f1' },
			{ type: 'ai', id: 'a3' },
		],
		activeTabId: 'a1',
		activeFileTabId: null,
		...overrides,
	});
}

function tabWindow(
	agentId: string,
	tabRefs: TabWindowTabRef[],
	activeTabRef: TabWindowTabRef | null = tabRefs[0] ?? null
): TabWindowInfo {
	return { windowId: `tw-${agentId}`, agentId, tabRefs, activeTabRef };
}

const setWindows = (windows: TabWindowInfo[]) => useTabWindowStore.getState().setWindows(windows);
const session = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)!;

function resetStores(sessions: Session[]) {
	useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	useSessionStore.setState({
		sessions,
		activeSessionId: sessions[0]?.id ?? '',
		sessionsLoaded: true,
		sessionsReadOk: true,
	});
}

describe('findDockedTabsToFocus', () => {
	const a2: TabWindowTabRef = { type: 'ai', id: 'a2' };
	const f1: TabWindowTabRef = { type: 'file', id: 'f1' };

	it('is empty when no ref left a tab window', () => {
		const windows = [tabWindow('s1', [a2])];
		expect(findDockedTabsToFocus(windows, windows).size).toBe(0);
		expect(findDockedTabsToFocus([], [tabWindow('s1', [a2])]).size).toBe(0);
	});

	it('names the one docked ref', () => {
		const docked = findDockedTabsToFocus([tabWindow('s1', [a2, f1])], [tabWindow('s1', [f1])]);
		expect(docked.get('s1')).toEqual(a2);
	});

	it('prefers the tab the window was showing when several dock at once', () => {
		const docked = findDockedTabsToFocus([tabWindow('s1', [a2, f1], a2)], []);
		expect(docked.get('s1')).toEqual(a2);
	});

	it('falls back to the last docked ref in strip order', () => {
		const docked = findDockedTabsToFocus(
			[tabWindow('s1', [a2, f1, { type: 'ai', id: 'a3' }], { type: 'ai', id: 'a3' })],
			[tabWindow('s1', [{ type: 'ai', id: 'a3' }])]
		);
		expect(docked.get('s1')).toEqual(f1);
	});

	it('keeps agents apart (TW-5)', () => {
		const docked = findDockedTabsToFocus(
			[tabWindow('s1', [a2]), tabWindow('s2', [f1])],
			[tabWindow('s1', [a2])]
		);
		expect(docked.has('s1')).toBe(false);
		expect(docked.get('s2')).toEqual(f1);
	});
});

describe('focusDockedTabs', () => {
	beforeEach(() => resetStores([agent('s1'), agent('s2')]));

	it('makes the docked AI tab active at its kept slot (TW-8)', () => {
		const before = session('s1');
		focusDockedTabs([tabWindow('s1', [{ type: 'ai', id: 'a2' }])], []);
		expect(session('s1').activeTabId).toBe('a2');
		expect(session('s1').inputMode).toBe('ai');
		expect(session('s1').unifiedTabOrder).toBe(before.unifiedTabOrder);
	});

	it('lands on a docked file tab', () => {
		focusDockedTabs([tabWindow('s1', [{ type: 'file', id: 'f1' }])], []);
		expect(session('s1').activeFileTabId).toBe('f1');
		expect(session('s1').activeTabId).toBe('a1');
	});

	it('leaves other agents untouched', () => {
		const other = session('s2');
		focusDockedTabs([tabWindow('s1', [{ type: 'ai', id: 'a2' }])], []);
		expect(session('s2')).toBe(other);
	});

	it('skips a tab the agent no longer has (closed from the tab window)', () => {
		const before = useSessionStore.getState().sessions;
		focusDockedTabs([tabWindow('s1', [{ type: 'ai', id: 'gone' }])], []);
		expect(useSessionStore.getState().sessions).toBe(before);
	});

	it('never writes an agent this window does not own', () => {
		focusDockedTabs([tabWindow('s1', [{ type: 'ai', id: 'a2' }])], [], (id) => id !== 's1');
		expect(session('s1').activeTabId).toBe('a1');
	});
});

describe('dockStaleTabWindowRefs', () => {
	let api: ReturnType<typeof installTabWindowsApi>;

	beforeEach(() => {
		resetStores([agent('s1'), agent('s2')]);
		api = installTabWindowsApi();
	});
	afterEach(() => api.restore());

	it('docks only the refs whose tab the session lacks, once per ref while it is pending', () => {
		setWindows([
			tabWindow('s1', [
				{ type: 'ai', id: 'a2' },
				{ type: 'terminal', id: 't-dropped' },
			]),
		]);
		const pending = new Set<string>();
		dockStaleTabWindowRefs(pending);
		expect(api.dock).toHaveBeenCalledTimes(1);
		expect(api.dock).toHaveBeenCalledWith('s1', { type: 'terminal', id: 't-dropped' });
		expect(pending.size).toBe(1);

		dockStaleTabWindowRefs(pending);
		expect(api.dock).toHaveBeenCalledTimes(1);
	});

	it('docks the ref of a popped tab the owner closed (D7)', () => {
		setWindows([tabWindow('s1', [{ type: 'ai', id: 'a2' }])]);
		const pending = new Set<string>();
		dockStaleTabWindowRefs(pending);
		expect(api.dock).not.toHaveBeenCalled();

		useSessionStore.setState({
			sessions: [agent('s1', { aiTabs: [createMockAITab({ id: 'a1' })] }), agent('s2')],
		});
		dockStaleTabWindowRefs(pending);
		expect(api.dock).toHaveBeenCalledWith('s1', { type: 'ai', id: 'a2' });
	});

	it('forgets a dock once main dropped the ref, so the tab can dock again later', () => {
		const gone = { type: 'ai', id: 'gone' } as const;
		setWindows([tabWindow('s1', [gone])]);
		const pending = new Set<string>();
		dockStaleTabWindowRefs(pending);
		expect(api.dock).toHaveBeenCalledTimes(1);

		// Main dropped it; the same id pops out again and is lost again.
		setWindows([]);
		dockStaleTabWindowRefs(pending);
		expect(pending.size).toBe(0);
		setWindows([tabWindow('s1', [gone])]);
		dockStaleTabWindowRefs(pending);
		expect(api.dock).toHaveBeenCalledTimes(2);
	});

	it('waits until the sessions were read back', () => {
		useSessionStore.setState({ sessionsLoaded: true, sessionsReadOk: false });
		setWindows([tabWindow('s1', [{ type: 'ai', id: 'gone' }])]);
		const pending = new Set<string>();
		dockStaleTabWindowRefs(pending);
		expect(api.dock).not.toHaveBeenCalled();
		expect(pending.size).toBe(0);
	});

	it('leaves an agent this window does not own (or has not loaded) for later', () => {
		setWindows([
			tabWindow('s1', [{ type: 'ai', id: 'gone' }]),
			tabWindow('missing', [{ type: 'ai', id: 'x' }]),
		]);
		const pending = new Set<string>();
		dockStaleTabWindowRefs(pending, () => false);
		expect(api.dock).not.toHaveBeenCalled();
		expect(pending.size).toBe(0);

		dockStaleTabWindowRefs(pending);
		expect(api.dock).toHaveBeenCalledTimes(1);
		expect(api.dock).toHaveBeenCalledWith('s1', { type: 'ai', id: 'gone' });
	});

	it('is a no-op without the tab windows API (web-desktop, TW-13)', () => {
		api.restore();
		setWindows([tabWindow('s1', [{ type: 'ai', id: 'gone' }])]);
		const pending = new Set<string>();
		expect(() => dockStaleTabWindowRefs(pending)).not.toThrow();
		expect(pending.size).toBe(0);
	});
});

describe('useTabWindowDockReconcile', () => {
	let api: ReturnType<typeof installTabWindowsApi>;

	beforeEach(() => {
		resetStores([agent('s1')]);
		api = installTabWindowsApi();
	});
	afterEach(() => api.restore());

	it('shows a tab when it docks back', () => {
		act(() => setWindows([tabWindow('s1', [{ type: 'ai', id: 'a3' }])]));
		renderHook(() => useTabWindowDockReconcile());
		act(() => setWindows([]));
		expect(session('s1').activeTabId).toBe('a3');
	});

	it('docks a restored ref once the sessions finish loading', () => {
		useSessionStore.setState({ sessionsLoaded: false, sessionsReadOk: false });
		setWindows([tabWindow('s1', [{ type: 'terminal', id: 't-dropped' }])]);
		renderHook(() => useTabWindowDockReconcile());
		expect(api.dock).not.toHaveBeenCalled();

		act(() => useSessionStore.setState({ sessionsLoaded: true, sessionsReadOk: true }));
		expect(api.dock).toHaveBeenCalledWith('s1', { type: 'terminal', id: 't-dropped' });
	});

	it('docks a ref of a tab window restored after the first read', () => {
		renderHook(() => useTabWindowDockReconcile());
		act(() => setWindows([tabWindow('s1', [{ type: 'ai', id: 'gone' }])]));
		expect(api.dock).toHaveBeenCalledWith('s1', { type: 'ai', id: 'gone' });
	});

	it('docks a popped tab the moment the owner closes it (D7)', () => {
		act(() => setWindows([tabWindow('s1', [{ type: 'ai', id: 'a3' }])]));
		renderHook(() => useTabWindowDockReconcile());
		expect(api.dock).not.toHaveBeenCalled();

		act(() =>
			useSessionStore.setState({
				sessions: [agent('s1', { aiTabs: [createMockAITab({ id: 'a1' })] })],
			})
		);
		expect(api.dock).toHaveBeenCalledTimes(1);
		expect(api.dock).toHaveBeenCalledWith('s1', { type: 'ai', id: 'a3' });
	});

	it('stops after unmount', () => {
		act(() => setWindows([tabWindow('s1', [{ type: 'ai', id: 'a3' }])]));
		const { unmount } = renderHook(() => useTabWindowDockReconcile());
		unmount();
		act(() => setWindows([]));
		expect(session('s1').activeTabId).toBe('a1');
	});
});
