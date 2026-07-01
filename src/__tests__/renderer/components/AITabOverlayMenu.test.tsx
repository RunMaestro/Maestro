/**
 * Tests for the AI tab overlay (right-click context) menu.
 *
 * The menu is pure-presentational - every action is a handler prop, and each
 * optional action is shown only when its availability prop is defined. These
 * tests focus on the "Move to New Window" item added for multi-window support:
 * it renders only when a window context wired the handler, and clicking it fires
 * the click callback. The broader menu behaviour is covered through TabBar.test.tsx.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
	AITabOverlayMenu,
	type AITabOverlayMenuProps,
} from '../../../renderer/components/TabBar/AITabOverlayMenu';
import type { AITab } from '../../../renderer/types';
import { mockTheme } from '../../helpers/mockTheme';

function createTab(partial: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'sess-1',
		name: 'My Tab',
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 0,
		state: 'idle',
		...partial,
	};
}

/** Fill every required handler with a spy; callers override the few they assert on. */
function buildProps(overrides: Partial<AITabOverlayMenuProps> = {}): AITabOverlayMenuProps {
	return {
		tab: createTab(),
		tabId: 'tab-1',
		sessionId: 'agent-A',
		theme: mockTheme,
		showCopied: false,
		onCopySessionId: vi.fn(),
		onCopyDeepLink: vi.fn(),
		onStarClick: vi.fn(),
		onRenameClick: vi.fn(),
		onMarkUnreadClick: vi.fn(),
		onExportHtmlClick: vi.fn(),
		onCopyContextClick: vi.fn(),
		onCopyContextWithReasoningClick: vi.fn(),
		onSummarizeAndContinueClick: vi.fn(),
		onMergeWithClick: vi.fn(),
		onSendToAgentClick: vi.fn(),
		onPublishGistClick: vi.fn(),
		onMoveToFirstClick: vi.fn(),
		onMoveToLastClick: vi.fn(),
		onMoveToNewWindowClick: vi.fn(),
		onCloseTabClick: vi.fn(),
		onCloseOtherTabsClick: vi.fn(),
		onCloseTabsLeftClick: vi.fn(),
		onCloseTabsRightClick: vi.fn(),
		...overrides,
	};
}

describe('AITabOverlayMenu - Move to New Window', () => {
	it('renders the item when onMoveToNewWindow is provided', () => {
		render(<AITabOverlayMenu {...buildProps({ onMoveToNewWindow: vi.fn() })} />);
		expect(screen.getByText('Move to New Window')).toBeInTheDocument();
	});

	it('hides the item when onMoveToNewWindow is undefined (no window context)', () => {
		render(<AITabOverlayMenu {...buildProps({ onMoveToNewWindow: undefined })} />);
		expect(screen.queryByText('Move to New Window')).not.toBeInTheDocument();
	});

	it('fires onMoveToNewWindowClick when the item is clicked', () => {
		const onMoveToNewWindowClick = vi.fn();
		render(
			<AITabOverlayMenu {...buildProps({ onMoveToNewWindow: vi.fn(), onMoveToNewWindowClick })} />
		);
		fireEvent.click(screen.getByText('Move to New Window'));
		expect(onMoveToNewWindowClick).toHaveBeenCalledTimes(1);
	});
});
