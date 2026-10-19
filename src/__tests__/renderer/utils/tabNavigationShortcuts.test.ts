/**
 * The tab-switching shortcut table shared by the main window's keyboard
 * handler and a tab window (Tab Windows, TW-6).
 */
import { describe, it, expect, vi } from 'vitest';
import {
	matchTabNavigationShortcut,
	UNIFIED_TAB_NAVIGATORS,
	type UnifiedTabNavigators,
} from '../../../renderer/utils/tabNavigationShortcuts';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';

const EVENT = new KeyboardEvent('keydown');

/** A binding lookup where exactly `bound` matches. */
const only = (bound: string) => (_e: KeyboardEvent, actionId: string) => actionId === bound;

function fakeNavigators(): UnifiedTabNavigators {
	return {
		navigateToNextUnifiedTab: vi.fn(() => null),
		navigateToPrevUnifiedTab: vi.fn(() => null),
		navigateToUnifiedTabByIndex: vi.fn(() => null),
		navigateToLastUnifiedTab: vi.fn(() => null),
	};
}

const SESSION = createMockSession({
	aiTabs: [createMockAITab({ id: 'a1' }), createMockAITab({ id: 'a2' })],
	unifiedTabOrder: [
		{ type: 'ai', id: 'a1' },
		{ type: 'ai', id: 'a2' },
	],
	activeTabId: 'a1',
});

describe('matchTabNavigationShortcut', () => {
	it('answers null for a keystroke that switches no tab', () => {
		expect(matchTabNavigationShortcut(EVENT, only('cycleNext'), true)).toBeNull();
		expect(matchTabNavigationShortcut(EVENT, only('closeTab'), true)).toBeNull();
	});

	it('maps next and previous tab to the unified walkers', () => {
		const navigators = fakeNavigators();
		const next = matchTabNavigationShortcut(EVENT, only('nextTab'), true);
		const prev = matchTabNavigationShortcut(EVENT, only('prevTab'), true);
		expect(next?.shortcutId).toBe('nextTab');
		expect(prev?.shortcutId).toBe('prevTab');
		next?.navigate(SESSION, true, navigators);
		prev?.navigate(SESSION, false, navigators);
		expect(navigators.navigateToNextUnifiedTab).toHaveBeenCalledWith(SESSION, true);
		expect(navigators.navigateToPrevUnifiedTab).toHaveBeenCalledWith(SESSION, false);
	});

	it('maps Cmd+N to the zero-based index', () => {
		const navigators = fakeNavigators();
		const match = matchTabNavigationShortcut(EVENT, only('goToTab3'), true);
		expect(match?.shortcutId).toBe('goToTab3');
		match?.navigate(SESSION, false, navigators);
		expect(navigators.navigateToUnifiedTabByIndex).toHaveBeenCalledWith(SESSION, 2, false);
	});

	it('with useCmd0AsLastTab on, Cmd+9 is tab 9 and Cmd+0 the last tab', () => {
		const navigators = fakeNavigators();
		matchTabNavigationShortcut(EVENT, only('goToTab9'), true)?.navigate(SESSION, false, navigators);
		expect(navigators.navigateToUnifiedTabByIndex).toHaveBeenCalledWith(SESSION, 8, false);
		const last = matchTabNavigationShortcut(EVENT, only('goToLastTab'), true);
		expect(last?.shortcutId).toBe('goToLastTab');
		last?.navigate(SESSION, false, navigators);
		expect(navigators.navigateToLastUnifiedTab).toHaveBeenCalledWith(SESSION, false);
	});

	it('with useCmd0AsLastTab off, Cmd+9 is the last tab and Cmd+0 is unused', () => {
		const navigators = fakeNavigators();
		const nine = matchTabNavigationShortcut(EVENT, only('goToTab9'), false);
		expect(nine?.shortcutId).toBe('goToLastTab');
		nine?.navigate(SESSION, false, navigators);
		expect(navigators.navigateToLastUnifiedTab).toHaveBeenCalled();
		expect(navigators.navigateToUnifiedTabByIndex).not.toHaveBeenCalled();
		expect(matchTabNavigationShortcut(EVENT, only('goToLastTab'), false)).toBeNull();
	});

	it('runs the tabHelpers navigators when none are supplied', () => {
		const result = matchTabNavigationShortcut(EVENT, only('nextTab'), true)?.navigate(
			SESSION,
			false
		);
		expect(result).toMatchObject({ type: 'ai', id: 'a2' });
		expect(UNIFIED_TAB_NAVIGATORS.navigateToNextUnifiedTab(SESSION)).toMatchObject({ id: 'a2' });
	});

	it('loads without touching tabHelpers, so a mock of a few of its functions still loads it', async () => {
		vi.resetModules();
		vi.doMock('../../../renderer/utils/tabHelpers', () => ({}));
		try {
			const module = await import('../../../renderer/utils/tabNavigationShortcuts');
			expect(module.UNIFIED_TAB_NAVIGATORS).toBeDefined();
		} finally {
			vi.doUnmock('../../../renderer/utils/tabHelpers');
			vi.resetModules();
		}
	});
});
