import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useTerminalTabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import {
	createMockAITab,
	createMockTerminalTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from './testUtils';

describe('useTerminalTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
	});

	afterEach(() => {
		cleanup();
	});

	it('opens and selects terminal tabs through tabStore', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		const { result } = renderHook(() => useTerminalTabHandlers());

		act(() => {
			result.current.handleOpenTerminalTab({ shell: 'bash', cwd: '/repo', name: 'Local' });
		});

		const terminalTab = getSession().terminalTabs[0];
		expect(terminalTab).toMatchObject({ shellType: 'bash', cwd: '/repo', name: 'Local' });
		expect(getSession().activeTerminalTabId).toBe(terminalTab.id);
	});

	it('closes idle terminal tabs immediately', async () => {
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'terminal',
		});
		vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(false);
		const { result } = renderHook(() => useTerminalTabHandlers());

		await act(async () => {
			result.current.handleCloseTerminalTab('term-1');
			await Promise.resolve();
		});

		expect(window.maestro.process.isTerminalBusy).toHaveBeenCalledWith(
			'test-session-terminal-term-1'
		);
		expect(getSession().terminalTabs).toHaveLength(0);
	});

	it('opens a destructive confirmation when the terminal is busy', async () => {
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			terminalTabs: [terminalTab],
			activeTerminalTabId: terminalTab.id,
			inputMode: 'terminal',
		});
		vi.mocked(window.maestro.process.isTerminalBusy).mockResolvedValue(true);
		const { result } = renderHook(() => useTerminalTabHandlers());

		await act(async () => {
			result.current.handleCloseTerminalTab('term-1');
			await Promise.resolve();
		});

		const modal = useModalStore.getState().modals.get('confirm');
		expect(modal?.data?.destructive).toBe(true);
		expect(getSession().terminalTabs).toHaveLength(1);

		act(() => {
			modal?.data?.onConfirm();
		});

		expect(getSession().terminalTabs).toHaveLength(0);
	});
});
