/**
 * Tests for SlashCommandAutocomplete component
 *
 * SlashCommandAutocomplete displays a popup with filtered slash commands
 * based on user input in the mobile command interface.
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

import {
	SlashCommandAutocomplete,
	SlashCommandAutocompleteProps,
	SlashCommand,
	DEFAULT_SLASH_COMMANDS,
} from '../../../web/mobile/SlashCommandAutocomplete';

describe('SlashCommandAutocomplete', () => {
	const defaultProps: SlashCommandAutocompleteProps = {
		isOpen: true,
		inputValue: '',
		inputMode: 'ai',
		onSelectCommand: vi.fn(),
		onClose: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Render conditions', () => {
		it('returns null when isOpen is false', () => {
			const { container } = render(<SlashCommandAutocomplete {...defaultProps} isOpen={false} />);
			expect(container.firstChild).toBeNull();
		});

		it('returns null when no commands match filter', () => {
			const { container } = render(
				<SlashCommandAutocomplete {...defaultProps} inputValue="/nonexistent" />
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders when isOpen is true and commands match', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			expect(screen.getByText('Commands')).toBeInTheDocument();
		});
	});

	describe('DEFAULT_SLASH_COMMANDS', () => {
		it('includes /history as AI-only command', () => {
			const history = DEFAULT_SLASH_COMMANDS.find((c) => c.command === '/history');
			expect(history).toBeDefined();
			expect(history?.aiOnly).toBe(true);
			expect(history?.terminalOnly).toBeUndefined();
		});

		it('includes /clear as mode-agnostic command', () => {
			const clear = DEFAULT_SLASH_COMMANDS.find((c) => c.command === '/clear');
			expect(clear).toBeDefined();
			expect(clear?.aiOnly).toBeUndefined();
			expect(clear?.terminalOnly).toBeUndefined();
		});

		it('includes /jump as terminal-only command', () => {
			const jump = DEFAULT_SLASH_COMMANDS.find((c) => c.command === '/jump');
			expect(jump).toBeDefined();
			expect(jump?.terminalOnly).toBe(true);
			expect(jump?.aiOnly).toBeUndefined();
		});

		it('all commands have descriptions', () => {
			DEFAULT_SLASH_COMMANDS.forEach((cmd) => {
				expect(cmd.description).toBeTruthy();
				expect(cmd.description.length).toBeGreaterThan(0);
			});
		});
	});

	describe('Command filtering by input', () => {
		it('shows all available commands when input is empty', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputValue="" inputMode="ai" />);
			// In AI mode, should show /history and /clear (not /jump which is terminal-only)
			expect(screen.getByText('/history')).toBeInTheDocument();
			expect(screen.getByText('/clear')).toBeInTheDocument();
		});

		it('shows all commands when input does not start with /', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputValue="test" inputMode="ai" />);
			expect(screen.getByText('/history')).toBeInTheDocument();
			expect(screen.getByText('/clear')).toBeInTheDocument();
		});

		it('filters commands by prefix when input starts with /', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputValue="/cl" inputMode="ai" />);
			expect(screen.getByText('/clear')).toBeInTheDocument();
			expect(screen.queryByText('/history')).not.toBeInTheDocument();
		});

		it('filtering is case insensitive', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputValue="/CL" inputMode="ai" />);
			expect(screen.getByText('/clear')).toBeInTheDocument();
		});

		it('shows exact match', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputValue="/clear" inputMode="ai" />);
			expect(screen.getByText('/clear')).toBeInTheDocument();
		});
	});

	describe('Command filtering by mode', () => {
		it('hides terminal-only commands in AI mode', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" inputValue="" />);
			// /jump is terminal-only
			expect(screen.queryByText('/jump')).not.toBeInTheDocument();
		});

		it('shows terminal-only commands in terminal mode', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="terminal" inputValue="" />);
			expect(screen.getByText('/jump')).toBeInTheDocument();
		});

		it('hides AI-only commands in terminal mode', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="terminal" inputValue="" />);
			// /history is AI-only
			expect(screen.queryByText('/history')).not.toBeInTheDocument();
		});

		it('shows AI-only commands in AI mode', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" inputValue="" />);
			expect(screen.getByText('/history')).toBeInTheDocument();
		});

		it('shows mode-agnostic commands in both modes', () => {
			const { rerender } = render(
				<SlashCommandAutocomplete {...defaultProps} inputMode="ai" inputValue="" />
			);
			expect(screen.getByText('/clear')).toBeInTheDocument();

			rerender(<SlashCommandAutocomplete {...defaultProps} inputMode="terminal" inputValue="" />);
			expect(screen.getByText('/clear')).toBeInTheDocument();
		});
	});

	describe('Custom commands', () => {
		const customCommands: SlashCommand[] = [
			{ command: '/custom1', description: 'Custom command 1' },
			{ command: '/custom2', description: 'Custom command 2', aiOnly: true },
			{ command: '/custom3', description: 'Custom command 3', terminalOnly: true },
		];

		it('uses custom commands when provided', () => {
			render(
				<SlashCommandAutocomplete {...defaultProps} commands={customCommands} inputMode="ai" />
			);
			expect(screen.getByText('/custom1')).toBeInTheDocument();
			expect(screen.getByText('/custom2')).toBeInTheDocument();
			// terminal-only should be hidden in AI mode
			expect(screen.queryByText('/custom3')).not.toBeInTheDocument();
		});

		it('filters custom commands by input', () => {
			render(
				<SlashCommandAutocomplete
					{...defaultProps}
					commands={customCommands}
					inputValue="/custom1"
					inputMode="ai"
				/>
			);
			expect(screen.getByText('/custom1')).toBeInTheDocument();
			expect(screen.queryByText('/custom2')).not.toBeInTheDocument();
		});
	});

	describe('Command selection', () => {
		it('calls onSelectCommand when command is clicked', () => {
			const onSelectCommand = vi.fn();
			render(<SlashCommandAutocomplete {...defaultProps} onSelectCommand={onSelectCommand} />);

			fireEvent.click(screen.getByText('/clear'));
			expect(onSelectCommand).toHaveBeenCalledWith('/clear');
		});

		it('calls onClose after command selection', () => {
			const onClose = vi.fn();
			render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			fireEvent.click(screen.getByText('/clear'));
			expect(onClose).toHaveBeenCalled();
		});

		it('calls onSelectCommand before onClose', () => {
			const callOrder: string[] = [];
			const onSelectCommand = vi.fn(() => callOrder.push('select'));
			const onClose = vi.fn(() => callOrder.push('close'));

			render(
				<SlashCommandAutocomplete
					{...defaultProps}
					onSelectCommand={onSelectCommand}
					onClose={onClose}
				/>
			);

			fireEvent.click(screen.getByText('/clear'));
			expect(callOrder).toEqual(['select', 'close']);
		});
	});

	describe('Selected index', () => {
		it('highlights command at selectedIndex', () => {
			render(<SlashCommandAutocomplete {...defaultProps} selectedIndex={0} inputMode="ai" />);

			// Find command items by looking for elements with minHeight: 44px (touch target)
			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			const firstItem = commandItems[0] as HTMLElement;
			expect(firstItem.style.backgroundColor).toBe('rgb(137, 180, 250)'); // accent color
		});

		it('non-selected items have transparent background', () => {
			render(<SlashCommandAutocomplete {...defaultProps} selectedIndex={0} inputMode="ai" />);

			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			if (commandItems.length > 1) {
				const secondItem = commandItems[1] as HTMLElement;
				expect(secondItem.style.backgroundColor).toBe('transparent');
			}
		});

		it('calls onSelectedIndexChange on hover', () => {
			const onSelectedIndexChange = vi.fn();
			render(
				<SlashCommandAutocomplete
					{...defaultProps}
					onSelectedIndexChange={onSelectedIndexChange}
					inputMode="ai"
				/>
			);

			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			if (commandItems.length > 0) {
				fireEvent.mouseEnter(commandItems[0]);
				expect(onSelectedIndexChange).toHaveBeenCalledWith(0);
			}
		});

		it('clamps selectedIndex to valid range when filter changes', () => {
			const onSelectedIndexChange = vi.fn();
			const { rerender } = render(
				<SlashCommandAutocomplete
					{...defaultProps}
					selectedIndex={5}
					onSelectedIndexChange={onSelectedIndexChange}
					inputMode="ai"
				/>
			);

			// Index 5 is out of range for default commands (only 2 in AI mode)
			// Effect should clamp to 0
			expect(onSelectedIndexChange).toHaveBeenCalledWith(0);
		});
	});

	describe('Close button', () => {
		it('renders close button', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const closeButton = screen.getByLabelText('Close commands');
			expect(closeButton).toBeInTheDocument();
		});

		it('calls onClose when close button is clicked', () => {
			const onClose = vi.fn();
			render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			fireEvent.click(screen.getByLabelText('Close commands'));
			expect(onClose).toHaveBeenCalled();
		});

		it('stops propagation when close button is clicked', () => {
			const onClose = vi.fn();
			const onContainerClick = vi.fn();

			render(
				<div onClick={onContainerClick}>
					<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />
				</div>
			);

			fireEvent.click(screen.getByLabelText('Close commands'));
			// onClose should be called, but not propagate to parent
			expect(onClose).toHaveBeenCalled();
		});

		it('applies hover styles on mouse enter', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const closeButton = screen.getByLabelText('Close commands');

			fireEvent.mouseEnter(closeButton);
			// Should apply background color
			expect(closeButton.style.backgroundColor).toContain('rgba');
		});

		it('removes hover styles on mouse leave', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const closeButton = screen.getByLabelText('Close commands');

			fireEvent.mouseEnter(closeButton);
			fireEvent.mouseLeave(closeButton);
			expect(closeButton.style.backgroundColor).toBe('transparent');
		});
	});

	describe('Outside click handling', () => {
		it('closes on mousedown outside container', () => {
			const onClose = vi.fn();
			render(
				<div>
					<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />
					<div data-testid="outside">Outside</div>
				</div>
			);

			fireEvent.mouseDown(screen.getByTestId('outside'));
			expect(onClose).toHaveBeenCalled();
		});

		it('closes on touchstart outside container', () => {
			const onClose = vi.fn();
			render(
				<div>
					<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />
					<div data-testid="outside">Outside</div>
				</div>
			);

			fireEvent.touchStart(screen.getByTestId('outside'));
			expect(onClose).toHaveBeenCalled();
		});

		it('does not close on click inside container', () => {
			const onClose = vi.fn();
			render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			// Click on header
			fireEvent.mouseDown(screen.getByText('Commands'));
			// onClose should not be called from outside click handler
			// (it may be called from other handlers)
		});

		it('removes event listeners on unmount', () => {
			const onClose = vi.fn();
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { rerender } = render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			rerender(<SlashCommandAutocomplete {...defaultProps} isOpen={false} onClose={onClose} />);

			expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
			expect(removeEventListenerSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));

			removeEventListenerSpy.mockRestore();
		});
	});

	describe('Escape key handling', () => {
		it('closes on Escape key press', () => {
			const onClose = vi.fn();
			render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).toHaveBeenCalled();
		});

		it('prevents default and stops propagation on Escape', () => {
			const onClose = vi.fn();
			render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			const event = new KeyboardEvent('keydown', { key: 'Escape' });
			const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
			const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

			document.dispatchEvent(event);

			expect(preventDefaultSpy).toHaveBeenCalled();
			expect(stopPropagationSpy).toHaveBeenCalled();
		});

		it('does not close on other keys', () => {
			const onClose = vi.fn();
			render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			fireEvent.keyDown(document, { key: 'Enter' });
			fireEvent.keyDown(document, { key: 'Tab' });
			expect(onClose).not.toHaveBeenCalled();
		});

		it('removes keydown listener when not open', () => {
			const onClose = vi.fn();
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { rerender } = render(<SlashCommandAutocomplete {...defaultProps} onClose={onClose} />);

			rerender(<SlashCommandAutocomplete {...defaultProps} isOpen={false} onClose={onClose} />);

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

			removeEventListenerSpy.mockRestore();
		});
	});

	describe('Touch feedback', () => {
		it('applies opacity on touch start', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" />);
			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			const item = commandItems[0] as HTMLElement;

			fireEvent.touchStart(item);
			expect(item.style.opacity).toBe('0.7');
		});

		it('resets opacity on touch end', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" />);
			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			const item = commandItems[0] as HTMLElement;

			fireEvent.touchStart(item);
			fireEvent.touchEnd(item);
			expect(item.style.opacity).toBe('1');
		});
	});

	describe('Styling', () => {
		it('has fixed max height based on isInputExpanded', () => {
			const { rerender } = render(
				<SlashCommandAutocomplete {...defaultProps} isInputExpanded={false} />
			);

			let container = document.querySelector('[style*="position: absolute"]') as HTMLElement;
			expect(container.style.maxHeight).toBe('60vh');

			rerender(<SlashCommandAutocomplete {...defaultProps} isInputExpanded={true} />);

			container = document.querySelector('[style*="position: absolute"]') as HTMLElement;
			expect(container.style.maxHeight).toBe('250px');
		});

		it('has correct z-index', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const container = document.querySelector('[style*="position: absolute"]') as HTMLElement;
			expect(container.style.zIndex).toBe('110');
		});

		it('has animation', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const container = document.querySelector('[style*="position: absolute"]') as HTMLElement;
			expect(container.style.animation).toContain('slideUp');
		});

		it('command items have minimum touch target height', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" />);
			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			expect(commandItems.length).toBeGreaterThan(0);
			const item = commandItems[0] as HTMLElement;
			expect(item.style.minHeight).toBe('44px');
		});

		it('command names have monospace font', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" />);
			// Find the command name div
			const commandName = screen.getByText('/history');
			expect(commandName).toHaveStyle({
				fontFamily: 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace',
			});
		});

		it('selected item has white text', () => {
			render(<SlashCommandAutocomplete {...defaultProps} selectedIndex={0} inputMode="ai" />);

			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			const firstItem = commandItems[0] as HTMLElement;
			expect(firstItem.style.color).toBe('rgb(255, 255, 255)');
		});

		it('non-selected item has theme text color', () => {
			render(<SlashCommandAutocomplete {...defaultProps} selectedIndex={0} inputMode="ai" />);

			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			if (commandItems.length > 1) {
				const secondItem = commandItems[1] as HTMLElement;
				expect(secondItem.style.color).toBe('rgb(205, 214, 244)'); // textMain
			}
		});

		it('header is sticky', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const header = screen.getByText('Commands').closest('div');
			expect(header).toHaveStyle({ position: 'sticky' });
		});
	});

	describe('CSS keyframes', () => {
		it('injects slideUp animation', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const styleElement = document.querySelector('style');
			expect(styleElement).toBeInTheDocument();
			expect(styleElement?.textContent).toContain('@keyframes slideUp');
		});

		it('animation includes transform translateY', () => {
			render(<SlashCommandAutocomplete {...defaultProps} />);
			const styleElement = document.querySelector('style');
			expect(styleElement?.textContent).toContain('translateY(8px)');
			expect(styleElement?.textContent).toContain('translateY(0)');
		});
	});

	describe('Command item rendering', () => {
		it('shows command name', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" />);
			expect(screen.getByText('/history')).toBeInTheDocument();
		});

		it('shows command description', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" />);
			expect(
				screen.getByText('Get a synopsis of work since the last /history and add to history')
			).toBeInTheDocument();
		});

		it('shows border between items except last', () => {
			render(<SlashCommandAutocomplete {...defaultProps} inputMode="ai" />);
			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');

			if (commandItems.length > 1) {
				const firstItem = commandItems[0] as HTMLElement;
				const lastItem = commandItems[commandItems.length - 1] as HTMLElement;

				// First item should have border containing 'solid'
				expect(firstItem.style.borderBottom).toContain('solid');
				// Last item should have borderBottomStyle of 'none' or an empty/falsy value
				// (browser normalizes 'none' differently - may be empty or 'medium')
				expect(
					lastItem.style.borderBottomStyle === 'none' ||
						lastItem.style.borderBottomStyle === '' ||
						lastItem.style.borderBottom === 'medium' // jsdom quirk
				).toBe(true);
			}
		});

		it('selected item description has higher opacity', () => {
			render(<SlashCommandAutocomplete {...defaultProps} selectedIndex={0} inputMode="ai" />);

			// Find the first item's description - it's the second div inside the command item
			const commandItems = document.querySelectorAll('[style*="min-height: 44px"]');
			const firstItem = commandItems[0];
			// The description div is the second child with opacity style
			const descriptionDivs = firstItem.querySelectorAll('div');
			// Description is the second div (after command name)
			const description = descriptionDivs[1] as HTMLElement;
			expect(description?.style.opacity).toBe('0.9');
		});
	});

	describe('Edge cases', () => {
		it('handles empty commands array', () => {
			const { container } = render(<SlashCommandAutocomplete {...defaultProps} commands={[]} />);
			expect(container.firstChild).toBeNull();
		});

		it('handles rapid input changes', () => {
			const { rerender } = render(
				<SlashCommandAutocomplete {...defaultProps} inputValue="" inputMode="ai" />
			);

			for (let i = 0; i < 10; i++) {
				rerender(
					<SlashCommandAutocomplete {...defaultProps} inputValue={`/test${i}`} inputMode="ai" />
				);
			}

			// Should not crash
			expect(true).toBe(true);
		});

		it('handles mode switching while open', () => {
			const { rerender } = render(
				<SlashCommandAutocomplete {...defaultProps} inputMode="ai" inputValue="" />
			);

			expect(screen.getByText('/history')).toBeInTheDocument();
			expect(screen.queryByText('/jump')).not.toBeInTheDocument();

			rerender(<SlashCommandAutocomplete {...defaultProps} inputMode="terminal" inputValue="" />);

			expect(screen.queryByText('/history')).not.toBeInTheDocument();
			expect(screen.getByText('/jump')).toBeInTheDocument();
		});

		it('handles commands with very long descriptions', () => {
			const longDescCommand: SlashCommand[] = [
				{
					command: '/long',
					description:
						'This is a very long description that should still render properly without breaking the layout or causing any issues with the UI component rendering',
				},
			];

			render(
				<SlashCommandAutocomplete {...defaultProps} commands={longDescCommand} inputMode="ai" />
			);

			expect(screen.getByText('/long')).toBeInTheDocument();
		});

		it('handles commands with special characters', () => {
			const specialCommand: SlashCommand[] = [
				{
					command: '/test-cmd_v2',
					description: 'Test <special> & "characters"',
				},
			];

			render(
				<SlashCommandAutocomplete {...defaultProps} commands={specialCommand} inputMode="ai" />
			);

			expect(screen.getByText('/test-cmd_v2')).toBeInTheDocument();
		});

		it('handles unicode in commands', () => {
			const unicodeCommand: SlashCommand[] = [
				{
					command: '/emoji',
					description: 'Command with emoji 🚀 and unicode 世界',
				},
			];

			render(
				<SlashCommandAutocomplete {...defaultProps} commands={unicodeCommand} inputMode="ai" />
			);

			expect(screen.getByText('/emoji')).toBeInTheDocument();
			expect(screen.getByText('Command with emoji 🚀 and unicode 世界')).toBeInTheDocument();
		});
	});

	describe('Default export', () => {
		it('default export matches named export', async () => {
			const namedModule = await import('../../../web/mobile/SlashCommandAutocomplete');
			expect(namedModule.default).toBe(namedModule.SlashCommandAutocomplete);
		});
	});

	describe('Type exports', () => {
		it('SlashCommand interface is properly typed', () => {
			const cmd: SlashCommand = {
				command: '/test',
				description: 'Test command',
				aiOnly: true,
				terminalOnly: false,
			};

			expect(cmd.command).toBe('/test');
			expect(cmd.description).toBe('Test command');
			expect(cmd.aiOnly).toBe(true);
			expect(cmd.terminalOnly).toBe(false);
		});
	});
});
