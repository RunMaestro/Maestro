/**
 * Tests for RecentCommandChips component
 *
 * RecentCommandChips displays quick-tap chips showing recently sent commands.
 * Users can tap to quickly reuse them in mobile touch interface.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Mock useThemeColors
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgSidebar: '#1e1e2e',
		border: '#45475a',
		textMain: '#cdd6f4',
		textDim: '#a6adc8',
		accent: '#89b4fa',
	}),
}));

// Mock haptic constants
vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [20, 50, 20],
		interrupt: [50, 100, 50],
		success: [10, 100, 10],
		error: [50, 50, 50],
	},
}));

import {
	RecentCommandChips,
	RecentCommandChipsProps,
} from '../../../web/mobile/RecentCommandChips';
import type { CommandHistoryEntry } from '../../../web/hooks/useCommandHistory';
import { triggerHaptic, HAPTIC_PATTERNS } from '../../../web/mobile/constants';

// Helper to create command entries
function createCommand(overrides: Partial<CommandHistoryEntry> = {}): CommandHistoryEntry {
	return {
		id: `cmd-${Math.random().toString(36).slice(2)}`,
		command: 'test command',
		timestamp: Date.now(),
		mode: 'ai' as const,
		...overrides,
	};
}

describe('RecentCommandChips', () => {
	const defaultProps: RecentCommandChipsProps = {
		commands: [
			createCommand({ id: '1', command: 'hello world', mode: 'ai' }),
			createCommand({ id: '2', command: 'ls -la', mode: 'terminal' }),
			createCommand({ id: '3', command: 'npm install', mode: 'terminal' }),
		],
		onSelectCommand: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Render conditions', () => {
		it('returns null when commands array is empty', () => {
			const { container } = render(<RecentCommandChips commands={[]} onSelectCommand={vi.fn()} />);
			expect(container.firstChild).toBeNull();
		});

		it('renders when commands are provided', () => {
			render(<RecentCommandChips {...defaultProps} />);
			expect(screen.getByText('Recent')).toBeInTheDocument();
		});

		it('renders chips for each command', () => {
			render(<RecentCommandChips {...defaultProps} />);
			expect(screen.getByText('hello world')).toBeInTheDocument();
			expect(screen.getByText('ls -la')).toBeInTheDocument();
			expect(screen.getByText('npm install')).toBeInTheDocument();
		});
	});

	describe('Command limiting', () => {
		it('limits to default 5 chips', () => {
			const manyCommands = Array.from({ length: 10 }, (_, i) =>
				createCommand({ id: String(i), command: `command ${i}` })
			);

			render(<RecentCommandChips commands={manyCommands} onSelectCommand={vi.fn()} />);

			// Should only show first 5
			expect(screen.getByText('command 0')).toBeInTheDocument();
			expect(screen.getByText('command 4')).toBeInTheDocument();
			expect(screen.queryByText('command 5')).not.toBeInTheDocument();
		});

		it('respects custom maxChips prop', () => {
			const manyCommands = Array.from({ length: 10 }, (_, i) =>
				createCommand({ id: String(i), command: `command ${i}` })
			);

			render(<RecentCommandChips commands={manyCommands} onSelectCommand={vi.fn()} maxChips={3} />);

			// Should only show first 3
			expect(screen.getByText('command 0')).toBeInTheDocument();
			expect(screen.getByText('command 2')).toBeInTheDocument();
			expect(screen.queryByText('command 3')).not.toBeInTheDocument();
		});

		it('handles fewer commands than maxChips', () => {
			const fewCommands = [
				createCommand({ id: '1', command: 'cmd1' }),
				createCommand({ id: '2', command: 'cmd2' }),
			];

			render(<RecentCommandChips commands={fewCommands} onSelectCommand={vi.fn()} maxChips={10} />);

			expect(screen.getByText('cmd1')).toBeInTheDocument();
			expect(screen.getByText('cmd2')).toBeInTheDocument();
		});
	});

	describe('Command truncation', () => {
		it('truncates commands longer than 30 characters', () => {
			const longCommand = createCommand({
				id: '1',
				command: 'this is a very long command that exceeds thirty characters',
			});

			render(<RecentCommandChips commands={[longCommand]} onSelectCommand={vi.fn()} />);

			// Should be truncated to 29 chars + ellipsis
			const truncated = 'this is a very long command t…';
			expect(screen.getByText(truncated)).toBeInTheDocument();
		});

		it('shows full text for short commands', () => {
			const shortCommand = createCommand({
				id: '1',
				command: 'short',
			});

			render(<RecentCommandChips commands={[shortCommand]} onSelectCommand={vi.fn()} />);

			expect(screen.getByText('short')).toBeInTheDocument();
		});

		it('replaces newlines with spaces', () => {
			const multilineCommand = createCommand({
				id: '1',
				command: 'first line\nsecond line',
			});

			render(<RecentCommandChips commands={[multilineCommand]} onSelectCommand={vi.fn()} />);

			expect(screen.getByText('first line second line')).toBeInTheDocument();
		});

		it('handles commands exactly at boundary (30 chars)', () => {
			// Exactly 30 characters
			const exactCommand = createCommand({
				id: '1',
				command: '123456789012345678901234567890',
			});

			render(<RecentCommandChips commands={[exactCommand]} onSelectCommand={vi.fn()} />);

			// Should show full text (not truncated)
			expect(screen.getByText('123456789012345678901234567890')).toBeInTheDocument();
		});

		it('handles commands just over boundary (31 chars)', () => {
			// 31 characters
			const overCommand = createCommand({
				id: '1',
				command: '1234567890123456789012345678901',
			});

			render(<RecentCommandChips commands={[overCommand]} onSelectCommand={vi.fn()} />);

			// Should be truncated: 29 chars + ellipsis
			expect(screen.getByText('12345678901234567890123456789…')).toBeInTheDocument();
		});
	});

	describe('Click handling', () => {
		it('calls onSelectCommand with full command text when chip is clicked', () => {
			const onSelectCommand = vi.fn();
			render(<RecentCommandChips {...defaultProps} onSelectCommand={onSelectCommand} />);

			fireEvent.click(screen.getByText('hello world'));
			expect(onSelectCommand).toHaveBeenCalledWith('hello world');
		});

		it('triggers haptic feedback on click', () => {
			render(<RecentCommandChips {...defaultProps} />);

			fireEvent.click(screen.getByText('hello world'));
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('does not call onSelectCommand when disabled', () => {
			const onSelectCommand = vi.fn();
			render(
				<RecentCommandChips {...defaultProps} onSelectCommand={onSelectCommand} disabled={true} />
			);

			fireEvent.click(screen.getByText('hello world'));
			expect(onSelectCommand).not.toHaveBeenCalled();
		});

		it('does not trigger haptic when disabled', () => {
			render(<RecentCommandChips {...defaultProps} disabled={true} />);

			fireEvent.click(screen.getByText('hello world'));
			expect(triggerHaptic).not.toHaveBeenCalled();
		});

		it('passes original command even when displayed truncated', () => {
			const longCmd = 'this is a very long command that exceeds the limit';
			const command = createCommand({ id: '1', command: longCmd });
			const onSelectCommand = vi.fn();

			render(<RecentCommandChips commands={[command]} onSelectCommand={onSelectCommand} />);

			// Find the truncated display
			const button = screen.getByRole('button');
			fireEvent.click(button);
			expect(onSelectCommand).toHaveBeenCalledWith(longCmd);
		});
	});

	describe('Touch feedback', () => {
		it('applies scale transform on touch start when enabled', () => {
			render(<RecentCommandChips {...defaultProps} disabled={false} />);
			const button = screen.getAllByRole('button')[0];

			fireEvent.touchStart(button);
			expect(button.style.transform).toBe('scale(0.95)');
		});

		it('applies background highlight on touch start', () => {
			render(<RecentCommandChips {...defaultProps} disabled={false} />);
			const button = screen.getAllByRole('button')[0];

			fireEvent.touchStart(button);
			// Browser converts #89b4fa15 to rgba format
			expect(button.style.backgroundColor).toContain('rgba(137, 180, 250');
		});

		it('resets transform on touch end', () => {
			render(<RecentCommandChips {...defaultProps} disabled={false} />);
			const button = screen.getAllByRole('button')[0];

			fireEvent.touchStart(button);
			fireEvent.touchEnd(button);
			expect(button.style.transform).toBe('scale(1)');
		});

		it('resets background on touch end', () => {
			render(<RecentCommandChips {...defaultProps} disabled={false} />);
			const button = screen.getAllByRole('button')[0];

			fireEvent.touchStart(button);
			fireEvent.touchEnd(button);
			expect(button.style.backgroundColor).toBe('rgb(30, 30, 46)'); // bgSidebar
		});

		it('resets on touch cancel', () => {
			render(<RecentCommandChips {...defaultProps} disabled={false} />);
			const button = screen.getAllByRole('button')[0];

			fireEvent.touchStart(button);
			fireEvent.touchCancel(button);
			expect(button.style.transform).toBe('scale(1)');
			expect(button.style.backgroundColor).toBe('rgb(30, 30, 46)');
		});

		it('does not apply touch effects when disabled', () => {
			render(<RecentCommandChips {...defaultProps} disabled={true} />);
			const button = screen.getAllByRole('button')[0];
			const initialTransform = button.style.transform;

			fireEvent.touchStart(button);
			// Should not change transform when disabled
			expect(button.style.transform).toBe(initialTransform);
		});
	});

	describe('Disabled state', () => {
		it('disables all buttons when disabled prop is true', () => {
			render(<RecentCommandChips {...defaultProps} disabled={true} />);
			const buttons = screen.getAllByRole('button');

			buttons.forEach((button) => {
				expect(button).toBeDisabled();
			});
		});

		it('applies reduced opacity when disabled', () => {
			render(<RecentCommandChips {...defaultProps} disabled={true} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ opacity: '0.5' });
		});

		it('applies cursor default when disabled', () => {
			render(<RecentCommandChips {...defaultProps} disabled={true} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ cursor: 'default' });
		});

		it('applies cursor pointer when enabled', () => {
			render(<RecentCommandChips {...defaultProps} disabled={false} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ cursor: 'pointer' });
		});

		it('reduces label opacity when disabled', () => {
			render(<RecentCommandChips {...defaultProps} disabled={true} />);
			const label = screen.getByText('Recent');
			expect(label).toHaveStyle({ opacity: '0.5' });
		});
	});

	describe('Mode icons', () => {
		it('renders AI icon (sun/sparkle) for AI mode commands', () => {
			const aiCommand = createCommand({ id: '1', command: 'test', mode: 'ai' });
			render(<RecentCommandChips commands={[aiCommand]} onSelectCommand={vi.fn()} />);

			const button = screen.getByRole('button');
			const svg = button.querySelector('svg');
			expect(svg).toBeInTheDocument();
			// AI icon has path with specific rays pattern
			const path = svg?.querySelector('path');
			expect(path).toBeInTheDocument();
			expect(path?.getAttribute('d')).toContain('M12 3v2');
		});

		it('renders terminal icon (chevron) for terminal mode commands', () => {
			const terminalCommand = createCommand({
				id: '1',
				command: 'test',
				mode: 'terminal',
			});
			render(<RecentCommandChips commands={[terminalCommand]} onSelectCommand={vi.fn()} />);

			const button = screen.getByRole('button');
			const svg = button.querySelector('svg');
			expect(svg).toBeInTheDocument();
			// Terminal icon has polyline
			const polyline = svg?.querySelector('polyline');
			expect(polyline).toBeInTheDocument();
			expect(polyline?.getAttribute('points')).toBe('4 17 10 11 4 5');
		});

		it('reduces icon opacity when disabled', () => {
			const command = createCommand({ id: '1', command: 'test', mode: 'ai' });
			render(<RecentCommandChips commands={[command]} onSelectCommand={vi.fn()} disabled={true} />);

			const button = screen.getByRole('button');
			const svg = button.querySelector('svg');
			expect(svg).toHaveStyle({ opacity: '0.5' });
		});
	});

	describe('Styling', () => {
		it('has horizontally scrollable container', () => {
			render(<RecentCommandChips {...defaultProps} />);
			// Find the scrollable div (has overflowX: auto)
			const container = document.querySelector('[class*="hide-scrollbar"]');
			expect(container).toBeInTheDocument();
			expect(container).toHaveStyle({
				display: 'flex',
				overflowX: 'auto',
			});
		});

		it('chips have monospace font family', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ fontFamily: 'ui-monospace, monospace' });
		});

		it('chips have correct font size', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ fontSize: '13px' });
		});

		it('chips have rounded corners', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ borderRadius: '20px' });
		});

		it('chips have minimum height for touch targets', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ minHeight: '36px' });
		});

		it('chips have flexShrink: 0 to prevent shrinking', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const button = screen.getAllByRole('button')[0];
			expect(button).toHaveStyle({ flexShrink: '0' });
		});

		it('label has uppercase text transform', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const label = screen.getByText('Recent');
			expect(label).toHaveStyle({ textTransform: 'uppercase' });
		});

		it('label has proper font size', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const label = screen.getByText('Recent');
			expect(label).toHaveStyle({ fontSize: '11px' });
		});
	});

	describe('Accessibility', () => {
		it('has aria-label on chips with full command text', () => {
			const command = createCommand({ id: '1', command: 'hello world' });
			render(<RecentCommandChips commands={[command]} onSelectCommand={vi.fn()} />);

			const button = screen.getByRole('button');
			expect(button).toHaveAttribute('aria-label', 'Reuse command: hello world');
		});

		it('includes full command in aria-label even when truncated', () => {
			const longCmd = 'this is a very long command that exceeds the limit';
			const command = createCommand({ id: '1', command: longCmd });
			render(<RecentCommandChips commands={[command]} onSelectCommand={vi.fn()} />);

			const button = screen.getByRole('button');
			expect(button).toHaveAttribute('aria-label', `Reuse command: ${longCmd}`);
		});
	});

	describe('CSS hiding scrollbar', () => {
		it('injects CSS to hide scrollbar', () => {
			render(<RecentCommandChips {...defaultProps} />);
			const styleElement = document.querySelector('style');
			expect(styleElement).toBeInTheDocument();
			expect(styleElement?.textContent).toContain('.hide-scrollbar::-webkit-scrollbar');
		});
	});

	describe('Edge cases', () => {
		it('handles empty string commands gracefully', () => {
			const emptyCommand = createCommand({ id: '1', command: '   ' });
			render(<RecentCommandChips commands={[emptyCommand]} onSelectCommand={vi.fn()} />);

			// Should render (trimming handled in truncateCommand)
			expect(screen.getByRole('button')).toBeInTheDocument();
		});

		it('handles special characters in commands', () => {
			// Use a short command with special chars to avoid truncation
			const specialCommand = createCommand({
				id: '1',
				command: '<script>alert(1)</script>',
			});
			render(<RecentCommandChips commands={[specialCommand]} onSelectCommand={vi.fn()} />);

			// Should render safely - check aria-label which contains full command
			const button = screen.getByRole('button');
			expect(button).toHaveAttribute('aria-label', 'Reuse command: <script>alert(1)</script>');
		});

		it('handles unicode characters in commands', () => {
			const unicodeCommand = createCommand({
				id: '1',
				command: 'echo "🚀 Hello 世界"',
			});
			render(<RecentCommandChips commands={[unicodeCommand]} onSelectCommand={vi.fn()} />);

			expect(screen.getByText('echo "🚀 Hello 世界"')).toBeInTheDocument();
		});

		it('handles single command', () => {
			const singleCommand = createCommand({ id: '1', command: 'solo' });
			render(<RecentCommandChips commands={[singleCommand]} onSelectCommand={vi.fn()} />);

			expect(screen.getByText('solo')).toBeInTheDocument();
			expect(screen.getAllByRole('button')).toHaveLength(1);
		});

		it('handles rapid clicks without breaking', () => {
			const onSelectCommand = vi.fn();
			render(<RecentCommandChips {...defaultProps} onSelectCommand={onSelectCommand} />);

			const button = screen.getAllByRole('button')[0];
			for (let i = 0; i < 10; i++) {
				fireEvent.click(button);
			}

			expect(onSelectCommand).toHaveBeenCalledTimes(10);
		});

		it('handles commands with only whitespace after trim', () => {
			const wsCommand = createCommand({ id: '1', command: '\n\t  \n' });
			render(<RecentCommandChips commands={[wsCommand]} onSelectCommand={vi.fn()} />);

			expect(screen.getByRole('button')).toBeInTheDocument();
		});

		it('handles command with multiple consecutive newlines', () => {
			const multiNewline = createCommand({
				id: '1',
				command: 'line1\n\n\nline2',
			});
			render(<RecentCommandChips commands={[multiNewline]} onSelectCommand={vi.fn()} />);

			// Newlines replaced with spaces
			expect(screen.getByText('line1 line2')).toBeInTheDocument();
		});
	});

	describe('Default export', () => {
		it('default export matches named export', async () => {
			const namedModule = await import('../../../web/mobile/RecentCommandChips');
			expect(namedModule.default).toBe(namedModule.RecentCommandChips);
		});
	});
});
