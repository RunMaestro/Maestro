/**
 * @file TabBar.tabWindow.test.tsx
 * @description The Tab Windows slot of the four chip menus (TW-11): "Move to
 * Tab Window" in an app window, "Dock to Main Window" in a tab window, with the
 * live `moveTabToTabWindow` chord beside it. The item hands the chip's own ref
 * to `onTabWindowMove`, appears only when that callback is set (the callers
 * omit it in web-desktop, TW-13), and never appears for a hidden consult tab
 * (TW-14).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const runtime = vi.hoisted(() => ({ tabWindow: false }));
vi.mock('../../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/utils/runtimeContext')>()),
	isTabWindow: () => runtime.tabWindow,
}));

import { TabBar } from '../../../../renderer/components/TabBar';
import {
	DOCK_TO_MAIN_WINDOW_LABEL,
	MOVE_TO_TAB_WINDOW_LABEL,
} from '../../../../renderer/components/TabBar/TabWindowMenuItem';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { DEFAULT_SHORTCUTS } from '../../../../renderer/constants/shortcuts';
import type { TabWindowTabRef } from '../../../../shared/tabWindowTypes';
import type { AITab, TerminalTab, UnifiedTab } from '../../../../renderer/types';
import { createMockAITab, createMockFileTab } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const chat = createMockAITab({ id: 'a1', name: 'Chat', agentSessionId: 'sess-1' });
const consult = createMockAITab({
	id: 'consult',
	name: 'Consult',
	agentSessionId: 'sess-2',
	hidden: true,
});
const file = createMockFileTab({ id: 'f1', name: 'notes', extension: '.md' });
const terminal: TerminalTab = {
	id: 't1',
	name: 'Shell',
	shellType: 'zsh',
	pid: 1,
	cwd: '/tmp',
	createdAt: 1,
	state: 'idle',
};
const browser = {
	id: 'b1',
	url: 'https://example.com',
	title: 'Example',
	createdAt: 1,
	canGoBack: false,
	canGoForward: false,
	isLoading: false,
};

function unified(aiTabs: AITab[]): UnifiedTab[] {
	return [
		...aiTabs.map((t) => ({ type: 'ai' as const, id: t.id, data: t })),
		{ type: 'file', id: 'f1', data: file },
		{ type: 'terminal', id: 't1', data: terminal },
		{ type: 'browser', id: 'b1', data: browser },
	] as UnifiedTab[];
}

function renderBar(
	onTabWindowMove?: (ref: TabWindowTabRef) => void,
	aiTabs: AITab[] = [chat]
): void {
	render(
		<TabBar
			tabs={aiTabs}
			activeTabId="a1"
			theme={mockTheme}
			onTabSelect={vi.fn()}
			onTabClose={vi.fn()}
			onNewTab={vi.fn()}
			unifiedTabs={unified(aiTabs)}
			onFileTabSelect={vi.fn()}
			onTerminalTabSelect={vi.fn()}
			onBrowserTabSelect={vi.fn()}
			onTabWindowMove={onTabWindowMove}
		/>
	);
}

function hover(label: string): void {
	const chip = screen.getByText(label).closest('[data-tab-id]')!;
	act(() => {
		fireEvent.mouseEnter(chip);
		vi.advanceTimersByTime(450);
	});
}

const CHIPS: [string, TabWindowTabRef][] = [
	['Chat', { type: 'ai', id: 'a1' }],
	['notes', { type: 'file', id: 'f1' }],
	['Shell', { type: 'terminal', id: 't1' }],
	['Example', { type: 'browser', id: 'b1' }],
];

beforeEach(() => {
	vi.useFakeTimers();
	runtime.tabWindow = false;
	useSettingsStore.setState({ shortcuts: DEFAULT_SHORTCUTS });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('TabBar Tab Windows chip menu item', () => {
	it.each(CHIPS)('the %s chip hands its own ref to onTabWindowMove', (label, ref) => {
		const onTabWindowMove = vi.fn();
		renderBar(onTabWindowMove);
		hover(label);
		const item = screen.getByTestId('tab-window-menu-item');
		expect(item).toHaveTextContent(MOVE_TO_TAB_WINDOW_LABEL);
		fireEvent.click(item);
		expect(onTabWindowMove).toHaveBeenCalledWith(ref);
	});

	it.each(CHIPS)('the %s chip has no item without onTabWindowMove (web-desktop)', (label) => {
		renderBar(undefined);
		hover(label);
		expect(screen.queryByTestId('tab-window-menu-item')).not.toBeInTheDocument();
	});

	it('reads "Dock to Main Window" inside a tab window', () => {
		runtime.tabWindow = true;
		const onTabWindowMove = vi.fn();
		renderBar(onTabWindowMove);
		hover('notes');
		const item = screen.getByTestId('tab-window-menu-item');
		expect(item).toHaveTextContent(DOCK_TO_MAIN_WINDOW_LABEL);
		fireEvent.click(item);
		expect(onTabWindowMove).toHaveBeenCalledWith({ type: 'file', id: 'f1' });
	});

	it('shows the live chord beside the item', () => {
		renderBar(vi.fn());
		hover('Chat');
		expect(
			screen.getByTestId('tab-window-menu-item').querySelector('[data-shortcut-hint]')
		).not.toBeNull();
	});

	it('follows a rebinding: an unbound chord draws no hint', () => {
		useSettingsStore.setState({
			shortcuts: {
				...DEFAULT_SHORTCUTS,
				moveTabToTabWindow: { ...DEFAULT_SHORTCUTS.moveTabToTabWindow, keys: [] },
			},
		});
		renderBar(vi.fn());
		hover('Chat');
		expect(
			screen.getByTestId('tab-window-menu-item').querySelector('[data-shortcut-hint]')
		).toBeNull();
	});

	it('never offers a hidden consult tab (TW-14)', () => {
		renderBar(vi.fn(), [chat, consult]);
		hover('Consult');
		expect(screen.queryByTestId('tab-window-menu-item')).not.toBeInTheDocument();
	});
});
