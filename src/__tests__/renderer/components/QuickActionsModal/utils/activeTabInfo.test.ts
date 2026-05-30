import { describe, expect, it } from 'vitest';
import { createMockSession } from '../../../../helpers/mockSession';
import { getActiveTabInfo } from '../../../../../renderer/components/QuickActionsModal/utils/activeTabInfo';

describe('getActiveTabInfo', () => {
	it('reports no active tab without an active session', () => {
		expect(getActiveTabInfo(undefined)).toEqual({
			isTerminalMode: false,
			hasActiveTab: false,
			activeUnifiedIndex: -1,
			unifiedTabCount: 0,
		});
	});

	it('finds the active AI tab index', () => {
		const session = createMockSession({
			activeTabId: 'ai-2',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'ai-2' },
			],
		});

		expect(getActiveTabInfo(session, true)).toMatchObject({
			hasActiveTab: true,
			activeUnifiedIndex: 1,
			unifiedTabCount: 2,
		});
	});

	it('prioritizes browser, terminal, file, then AI active tab refs', () => {
		const session = createMockSession({
			inputMode: 'terminal',
			activeTabId: 'ai-1',
			activeFileTabId: 'file-1',
			activeBrowserTabId: 'browser-1',
			activeTerminalTabId: 'terminal-1',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'file-1' },
				{ type: 'terminal', id: 'terminal-1' },
				{ type: 'browser', id: 'browser-1' },
			],
		});

		expect(getActiveTabInfo(session)).toMatchObject({
			isTerminalMode: true,
			hasActiveTab: true,
			activeUnifiedIndex: 3,
		});
	});
});
