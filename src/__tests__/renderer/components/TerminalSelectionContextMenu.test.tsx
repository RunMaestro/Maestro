/**
 * Tests for TerminalSelectionContextMenu — the right-click menu shown when the
 * user highlights text in XTerminal and chooses Copy-to-Clipboard or Send-to-Agent.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TerminalSelectionContextMenu } from '../../../renderer/components/TerminalSelectionContextMenu';
import type { Theme } from '../../../renderer/types';

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
});
