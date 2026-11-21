// Source: src/__tests__/renderer/components/LinkContextMenu.test.tsx
// Source: src/__tests__/renderer/components/TerminalSelectionContextMenu.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { LinkContextMenu } from '../../../renderer/components/LinkContextMenu';
import { openInMaestroBrowser, openInSystemBrowser } from '../../../renderer/utils/openUrl';
import { type Theme } from '../../../renderer/types';
import { TerminalSelectionContextMenu } from '../../../renderer/components/TerminalSelectionContextMenu';
import { spyOnListeners, expectAllListenersRemoved } from '../../helpers/listenerLeakAssertions';
const { mockSafeClipboardWrite } = vi.hoisted(() => ({ mockSafeClipboardWrite: vi.fn() }));
vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: (...args: unknown[]) => mockSafeClipboardWrite(...args),
}));
vi.mock('../../../renderer/utils/openUrl', () => ({
	openInMaestroBrowser: vi.fn(),
	openInSystemBrowser: vi.fn(),
}));
describe('LinkContextMenu', () => {
	const theme = {
		colors: { bgSidebar: '#111', border: '#222', textMain: '#eee' },
	} as unknown as Theme;

	function renderMenu(url: string) {
		const onDismiss = vi.fn();
		const utils = render(
			<LinkContextMenu menu={{ x: 10, y: 10, url }} theme={theme} onDismiss={onDismiss} />
		);
		return { ...utils, onDismiss };
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('LinkContextMenu', () => {
		it('copies a routing-hinted link without its hint', () => {
			const { getByText } = renderMenu('maestro+http://localhost:5173/x');
			fireEvent.click(getByText('Copy Link'));
			expect(mockSafeClipboardWrite).toHaveBeenCalledWith('http://localhost:5173/x');
		});

		it('copies a plain link unchanged', () => {
			const { getByText } = renderMenu('https://example.com');
			fireEvent.click(getByText('Copy Link'));
			expect(mockSafeClipboardWrite).toHaveBeenCalledWith('https://example.com');
		});

		it('treats a hinted link as openable from either menu item', () => {
			const { getByText } = renderMenu('system+https://example.com');
			fireEvent.click(getByText('Open in Maestro Browser'));
			expect(openInMaestroBrowser).toHaveBeenCalledWith('system+https://example.com');
		});

		it('does not open a hint in front of a non-http scheme', () => {
			const { getByText } = renderMenu('maestro+file:///tmp/x');
			fireEvent.click(getByText('Open in System Browser'));
			expect(openInSystemBrowser).not.toHaveBeenCalled();
		});
	});
});
describe('TerminalSelectionContextMenu', () => {
	const baseTheme: Theme = {
		id: 'dark',
		name: 'Dark',
		mode: 'dark',
		colors: {
			bgMain: '#1e1e1e',
			bgSidebar: '#252526',
			textMain: '#d4d4d4',
			textDim: '#808080',
			accent: '#007acc',
			accentDim: '#004a7f',
			accentForeground: '#ffffff',
			border: '#3c3c3c',
			error: '#f44747',
			warning: '#ff8c00',
			selection: '#264f78',
		},
	} as unknown as Theme;

	const menu = { x: 100, y: 120, selection: 'hello world' };

	describe('TerminalSelectionContextMenu', () => {
		it('renders both actions when both handlers are provided', () => {
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={vi.fn()}
					onCopy={vi.fn()}
					onSendToAgent={vi.fn()}
				/>
			);
			expect(screen.getByText('Copy to Clipboard')).toBeTruthy();
			expect(screen.getByText('Send to Agent')).toBeTruthy();
		});

		it('invokes onCopy with the selection and then dismisses', () => {
			const onCopy = vi.fn();
			const onDismiss = vi.fn();
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={onDismiss}
					onCopy={onCopy}
					onSendToAgent={vi.fn()}
				/>
			);
			fireEvent.click(screen.getByText('Copy to Clipboard'));
			expect(onCopy).toHaveBeenCalledWith('hello world');
			expect(onDismiss).toHaveBeenCalledTimes(1);
		});

		it('invokes onSendToAgent with the selection and then dismisses', () => {
			const onSend = vi.fn();
			const onDismiss = vi.fn();
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={onDismiss}
					onCopy={vi.fn()}
					onSendToAgent={onSend}
				/>
			);
			fireEvent.click(screen.getByText('Send to Agent'));
			expect(onSend).toHaveBeenCalledWith('hello world');
			expect(onDismiss).toHaveBeenCalledTimes(1);
		});

		it('invokes onQuote with the selection and then dismisses', () => {
			const onQuote = vi.fn();
			const onDismiss = vi.fn();
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={onDismiss}
					onQuote={onQuote}
				/>
			);
			fireEvent.click(screen.getByText('Quote in Message'));
			expect(onQuote).toHaveBeenCalledWith('hello world');
			expect(onDismiss).toHaveBeenCalledTimes(1);
		});

		it('omits actions whose handler is undefined', () => {
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={vi.fn()}
					onCopy={vi.fn()}
					// onSendToAgent intentionally omitted
				/>
			);
			expect(screen.getByText('Copy to Clipboard')).toBeTruthy();
			expect(screen.queryByText('Send to Agent')).toBeNull();
			expect(screen.queryByText('Quote in Message')).toBeNull();
		});

		it('dismisses on Escape', () => {
			const onDismiss = vi.fn();
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={onDismiss}
					onCopy={vi.fn()}
					onSendToAgent={vi.fn()}
				/>
			);
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onDismiss).toHaveBeenCalledTimes(1);
		});

		it('dismisses on document mousedown outside the menu', () => {
			const onDismiss = vi.fn();
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={onDismiss}
					onCopy={vi.fn()}
					onSendToAgent={vi.fn()}
				/>
			);
			fireEvent.mouseDown(document.body);
			expect(onDismiss).toHaveBeenCalledTimes(1);
		});

		it('ignores non-Escape keys', () => {
			const onDismiss = vi.fn();
			render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={onDismiss}
					onCopy={vi.fn()}
					onSendToAgent={vi.fn()}
				/>
			);
			fireEvent.keyDown(document, { key: 'a' });
			fireEvent.keyDown(document, { key: 'Enter' });
			expect(onDismiss).not.toHaveBeenCalled();
		});

		it('does not call onDismiss after unmount', () => {
			const onDismiss = vi.fn();
			const { unmount } = render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={onDismiss}
					onCopy={vi.fn()}
					onSendToAgent={vi.fn()}
				/>
			);
			unmount();
			fireEvent.keyDown(document, { key: 'Escape' });
			fireEvent.mouseDown(document.body);
			expect(onDismiss).not.toHaveBeenCalled();
		});

		it('removes its document listeners on unmount (no leak)', () => {
			const spies = spyOnListeners(document);
			const { unmount } = render(
				<TerminalSelectionContextMenu
					menu={menu}
					theme={baseTheme}
					onDismiss={vi.fn()}
					onCopy={vi.fn()}
					onSendToAgent={vi.fn()}
				/>
			);
			unmount();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});
	});
});
