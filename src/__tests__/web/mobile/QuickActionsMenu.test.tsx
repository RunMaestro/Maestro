/**
 * Tests for QuickActionsMenu component
 *
 * QuickActionsMenu is a popup menu shown on long-press of send button
 * providing quick actions like mode switching.
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
	QuickActionsMenu,
	QuickActionsMenuProps,
	QuickAction,
} from '../../../web/mobile/QuickActionsMenu';

describe('QuickActionsMenu', () => {
	const defaultProps: QuickActionsMenuProps = {
		isOpen: true,
		onClose: vi.fn(),
		onSelectAction: vi.fn(),
		inputMode: 'ai',
		anchorPosition: { x: 200, y: 500 },
		hasActiveSession: true,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		// Mock window dimensions
		Object.defineProperty(window, 'innerWidth', { value: 400, writable: true });
		Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
	});

	afterEach(() => {
		cleanup();
	});

	describe('Render conditions', () => {
		it('returns null when isOpen is false', () => {
			const { container } = render(<QuickActionsMenu {...defaultProps} isOpen={false} />);
			expect(container.firstChild).toBeNull();
		});

		it('returns null when anchorPosition is null', () => {
			const { container } = render(<QuickActionsMenu {...defaultProps} anchorPosition={null} />);
			expect(container.firstChild).toBeNull();
		});

		it('renders when isOpen is true and anchorPosition is provided', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByRole('menu')).toBeInTheDocument();
		});

		it('renders backdrop overlay', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			// Backdrop has aria-hidden="true"
			const backdrop = document.querySelector('[aria-hidden="true"]');
			expect(backdrop).toBeInTheDocument();
			expect(backdrop).toHaveStyle({ position: 'fixed' });
		});
	});

	describe('Menu positioning', () => {
		it('centers menu horizontally on anchor position', () => {
			render(<QuickActionsMenu {...defaultProps} anchorPosition={{ x: 200, y: 500 }} />);
			const menu = screen.getByRole('menu');
			// menuWidth is 200, so centered would be 200 - 100 = 100
			// But clamped by Math.max(16, Math.min(100, 400-200-16)) = Math.max(16, 100) = 100
			expect(menu).toHaveStyle({ width: '200px' });
		});

		it('clamps menu to left edge with minimum 16px margin', () => {
			render(<QuickActionsMenu {...defaultProps} anchorPosition={{ x: 50, y: 500 }} />);
			const menu = screen.getByRole('menu');
			// x=50, centered would be 50 - 100 = -50, clamped to 16
			expect(menu.style.left).toBe('16px');
		});

		it('clamps menu to right edge with minimum 16px margin', () => {
			render(<QuickActionsMenu {...defaultProps} anchorPosition={{ x: 380, y: 500 }} />);
			const menu = screen.getByRole('menu');
			// x=380, centered would be 380 - 100 = 280
			// maxRight = 400 - 200 - 16 = 184
			// Math.min(280, 184) = 184
			expect(menu.style.left).toBe('184px');
		});

		it('positions menu above anchor point', () => {
			render(<QuickActionsMenu {...defaultProps} anchorPosition={{ x: 200, y: 500 }} />);
			const menu = screen.getByRole('menu');
			// bottom: calc(100vh - 500px + 12px)
			expect(menu.style.bottom).toContain('500px');
		});
	});

	describe('Menu styling', () => {
		it('applies correct z-index', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const menu = screen.getByRole('menu');
			expect(menu).toHaveStyle({ zIndex: '200' });
		});

		it('has animation class', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const menu = screen.getByRole('menu');
			expect(menu.style.animation).toContain('quickActionsPopIn');
		});

		it('has proper border radius', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const menu = screen.getByRole('menu');
			expect(menu).toHaveStyle({ borderRadius: '12px' });
		});
	});

	describe('Menu items - AI mode', () => {
		it('renders "Switch to Terminal" when in AI mode', () => {
			render(<QuickActionsMenu {...defaultProps} inputMode="ai" />);
			expect(screen.getByText('Switch to Terminal')).toBeInTheDocument();
		});

		it('renders terminal icon when in AI mode', () => {
			render(<QuickActionsMenu {...defaultProps} inputMode="ai" />);
			const menuItem = screen.getByRole('menuitem');
			// Terminal icon has polyline with points="4 17 10 11 4 5"
			const svg = menuItem.querySelector('svg');
			expect(svg).toBeInTheDocument();
			const polyline = svg?.querySelector('polyline');
			expect(polyline).toBeInTheDocument();
			expect(polyline?.getAttribute('points')).toBe('4 17 10 11 4 5');
		});
	});

	describe('Menu items - Terminal mode', () => {
		it('renders "Switch to AI" when in terminal mode', () => {
			render(<QuickActionsMenu {...defaultProps} inputMode="terminal" />);
			expect(screen.getByText('Switch to AI')).toBeInTheDocument();
		});

		it('renders AI sparkle icon when in terminal mode', () => {
			render(<QuickActionsMenu {...defaultProps} inputMode="terminal" />);
			const menuItem = screen.getByRole('menuitem');
			// AI icon has circle with cx="12" cy="12" r="4"
			const svg = menuItem.querySelector('svg');
			expect(svg).toBeInTheDocument();
			const circle = svg?.querySelector('circle');
			expect(circle).toBeInTheDocument();
			expect(circle?.getAttribute('cx')).toBe('12');
		});
	});

	describe('Disabled state', () => {
		it('disables menu item when hasActiveSession is false', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={false} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).toBeDisabled();
			expect(menuItem).toHaveAttribute('aria-disabled', 'true');
		});

		it('applies reduced opacity when disabled', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={false} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).toHaveStyle({ opacity: '0.5' });
		});

		it('does not trigger onSelectAction when clicking disabled item', () => {
			const onSelectAction = vi.fn();
			render(
				<QuickActionsMenu
					{...defaultProps}
					hasActiveSession={false}
					onSelectAction={onSelectAction}
				/>
			);
			fireEvent.click(screen.getByRole('menuitem'));
			expect(onSelectAction).not.toHaveBeenCalled();
		});

		it('enables menu item when hasActiveSession is true', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={true} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).not.toBeDisabled();
		});
	});

	describe('Action selection', () => {
		it('calls onSelectAction with switch_mode when item is clicked', () => {
			const onSelectAction = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onSelectAction={onSelectAction} />);
			fireEvent.click(screen.getByRole('menuitem'));
			expect(onSelectAction).toHaveBeenCalledWith('switch_mode');
		});

		it('calls onClose after action is selected', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			fireEvent.click(screen.getByRole('menuitem'));
			expect(onClose).toHaveBeenCalled();
		});

		it('calls onSelectAction before onClose', () => {
			const callOrder: string[] = [];
			const onSelectAction = vi.fn(() => callOrder.push('select'));
			const onClose = vi.fn(() => callOrder.push('close'));
			render(
				<QuickActionsMenu {...defaultProps} onSelectAction={onSelectAction} onClose={onClose} />
			);
			fireEvent.click(screen.getByRole('menuitem'));
			expect(callOrder).toEqual(['select', 'close']);
		});
	});

	describe('Outside click handling', () => {
		it('closes menu when backdrop is clicked', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
			fireEvent.click(backdrop);
			expect(onClose).toHaveBeenCalled();
		});

		it('closes menu on mousedown outside', () => {
			const onClose = vi.fn();
			render(
				<div>
					<QuickActionsMenu {...defaultProps} onClose={onClose} />
					<div data-testid="outside">Outside</div>
				</div>
			);
			fireEvent.mouseDown(screen.getByTestId('outside'));
			expect(onClose).toHaveBeenCalled();
		});

		it('closes menu on touchstart outside', () => {
			const onClose = vi.fn();
			render(
				<div>
					<QuickActionsMenu {...defaultProps} onClose={onClose} />
					<div data-testid="outside">Outside</div>
				</div>
			);
			fireEvent.touchStart(screen.getByTestId('outside'));
			expect(onClose).toHaveBeenCalled();
		});

		it('does not close menu when clicking inside menu', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			const menu = screen.getByRole('menu');
			fireEvent.mouseDown(menu);
			// onClose should not be called for inside click
			// (it will only be called from handleItemClick)
			expect(onClose).not.toHaveBeenCalled();
		});

		it('removes event listeners when menu closes', () => {
			const onClose = vi.fn();
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { rerender } = render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);

			rerender(<QuickActionsMenu {...defaultProps} isOpen={false} onClose={onClose} />);

			expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
			expect(removeEventListenerSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));

			removeEventListenerSpy.mockRestore();
		});
	});

	describe('Escape key handling', () => {
		it('closes menu when Escape key is pressed', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).toHaveBeenCalled();
		});

		it('does not close menu on other keys', () => {
			const onClose = vi.fn();
			render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);
			fireEvent.keyDown(document, { key: 'Enter' });
			fireEvent.keyDown(document, { key: 'Tab' });
			fireEvent.keyDown(document, { key: 'ArrowDown' });
			expect(onClose).not.toHaveBeenCalled();
		});

		it('removes keydown listener when menu closes', () => {
			const onClose = vi.fn();
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { rerender } = render(<QuickActionsMenu {...defaultProps} onClose={onClose} />);

			rerender(<QuickActionsMenu {...defaultProps} isOpen={false} onClose={onClose} />);

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

			removeEventListenerSpy.mockRestore();
		});
	});

	describe('Touch feedback', () => {
		it('applies highlight color on touch start (enabled)', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={true} />);
			const menuItem = screen.getByRole('menuitem');

			fireEvent.touchStart(menuItem);
			// Should apply accent color with alpha (browser converts to rgba)
			// #89b4fa20 becomes rgba(137, 180, 250, 0.125)
			expect(menuItem.style.backgroundColor).toContain('rgba(137, 180, 250');
		});

		it('resets background on touch end', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={true} />);
			const menuItem = screen.getByRole('menuitem');

			fireEvent.touchStart(menuItem);
			fireEvent.touchEnd(menuItem);
			expect(menuItem.style.backgroundColor).toBe('transparent');
		});

		it('does not apply highlight on touch start when disabled', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={false} />);
			const menuItem = screen.getByRole('menuitem');
			const initialBg = menuItem.style.backgroundColor;

			fireEvent.touchStart(menuItem);
			// Should not change when disabled
			expect(menuItem.style.backgroundColor).toBe(initialBg);
		});
	});

	describe('Mouse hover feedback', () => {
		it('applies highlight color on mouse enter (enabled)', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={true} />);
			const menuItem = screen.getByRole('menuitem');

			fireEvent.mouseEnter(menuItem);
			// Browser converts #89b4fa20 to rgba(137, 180, 250, 0.125)
			expect(menuItem.style.backgroundColor).toContain('rgba(137, 180, 250');
		});

		it('resets background on mouse leave', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={true} />);
			const menuItem = screen.getByRole('menuitem');

			fireEvent.mouseEnter(menuItem);
			fireEvent.mouseLeave(menuItem);
			expect(menuItem.style.backgroundColor).toBe('transparent');
		});

		it('does not apply highlight on mouse enter when disabled', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={false} />);
			const menuItem = screen.getByRole('menuitem');
			const initialBg = menuItem.style.backgroundColor;

			fireEvent.mouseEnter(menuItem);
			expect(menuItem.style.backgroundColor).toBe(initialBg);
		});
	});

	describe('Menu item styling', () => {
		it('has minimum touch target height', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).toHaveStyle({ minHeight: '44px' });
		});

		it('has correct font styling', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).toHaveStyle({
				fontSize: '15px',
				fontWeight: '500',
			});
		});

		it('has cursor pointer when enabled', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={true} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).toHaveStyle({ cursor: 'pointer' });
		});

		it('has cursor default when disabled', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={false} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).toHaveStyle({ cursor: 'default' });
		});
	});

	describe('CSS keyframes injection', () => {
		it('injects quickActionsPopIn keyframes', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const styleElement = document.querySelector('style');
			expect(styleElement).toBeInTheDocument();
			expect(styleElement?.textContent).toContain('quickActionsPopIn');
		});

		it('injects quickActionsFadeIn keyframes', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const styleElement = document.querySelector('style');
			expect(styleElement?.textContent).toContain('quickActionsFadeIn');
		});

		it('keyframes include transform: scale animation', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const styleElement = document.querySelector('style');
			expect(styleElement?.textContent).toContain('scale(0.9)');
			expect(styleElement?.textContent).toContain('scale(1)');
		});
	});

	describe('Accessibility', () => {
		it('has role="menu" on container', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByRole('menu')).toBeInTheDocument();
		});

		it('has aria-label on menu container', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const menu = screen.getByRole('menu');
			expect(menu).toHaveAttribute('aria-label', 'Quick actions');
		});

		it('has role="menuitem" on action buttons', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			expect(screen.getByRole('menuitem')).toBeInTheDocument();
		});

		it('has aria-disabled on disabled items', () => {
			render(<QuickActionsMenu {...defaultProps} hasActiveSession={false} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).toHaveAttribute('aria-disabled', 'true');
		});

		it('backdrop has aria-hidden', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[aria-hidden="true"]');
			expect(backdrop).toBeInTheDocument();
		});
	});

	describe('Backdrop styling', () => {
		it('backdrop covers full viewport', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
			expect(backdrop).toHaveStyle({
				position: 'fixed',
				top: '0px',
				left: '0px',
				right: '0px',
				bottom: '0px',
			});
		});

		it('backdrop has lower z-index than menu', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
			const menu = screen.getByRole('menu');
			expect(backdrop).toHaveStyle({ zIndex: '199' });
			expect(menu).toHaveStyle({ zIndex: '200' });
		});

		it('backdrop has semi-transparent background', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
			expect(backdrop.style.backgroundColor).toContain('rgba(0, 0, 0');
		});

		it('backdrop has fade animation', () => {
			render(<QuickActionsMenu {...defaultProps} />);
			const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
			expect(backdrop.style.animation).toContain('quickActionsFadeIn');
		});
	});

	describe('Type exports', () => {
		it('QuickAction type is properly defined', () => {
			const action: QuickAction = 'switch_mode';
			expect(action).toBe('switch_mode');
		});
	});

	describe('Edge cases', () => {
		it('handles anchor position at screen edge (0, 0)', () => {
			render(<QuickActionsMenu {...defaultProps} anchorPosition={{ x: 0, y: 0 }} />);
			const menu = screen.getByRole('menu');
			// Should clamp to left edge minimum
			expect(menu.style.left).toBe('16px');
		});

		it('handles anchor position at bottom-right corner', () => {
			render(<QuickActionsMenu {...defaultProps} anchorPosition={{ x: 400, y: 800 }} />);
			const menu = screen.getByRole('menu');
			// Should clamp to right edge
			expect(parseInt(menu.style.left)).toBeLessThanOrEqual(184);
		});

		it('handles rapid open/close transitions', () => {
			const { rerender } = render(<QuickActionsMenu {...defaultProps} />);

			for (let i = 0; i < 10; i++) {
				rerender(<QuickActionsMenu {...defaultProps} isOpen={false} />);
				rerender(<QuickActionsMenu {...defaultProps} isOpen={true} />);
			}

			expect(screen.getByRole('menu')).toBeInTheDocument();
		});

		it('handles mode switching while open', () => {
			const { rerender } = render(<QuickActionsMenu {...defaultProps} inputMode="ai" />);
			expect(screen.getByText('Switch to Terminal')).toBeInTheDocument();

			rerender(<QuickActionsMenu {...defaultProps} inputMode="terminal" />);
			expect(screen.getByText('Switch to AI')).toBeInTheDocument();
		});

		it('handles hasActiveSession toggle while open', () => {
			const { rerender } = render(<QuickActionsMenu {...defaultProps} hasActiveSession={true} />);
			const menuItem = screen.getByRole('menuitem');
			expect(menuItem).not.toBeDisabled();

			rerender(<QuickActionsMenu {...defaultProps} hasActiveSession={false} />);
			expect(screen.getByRole('menuitem')).toBeDisabled();
		});
	});

	describe('Default export', () => {
		it('default export matches named export', async () => {
			const namedModule = await import('../../../web/mobile/QuickActionsMenu');
			expect(namedModule.default).toBe(namedModule.QuickActionsMenu);
		});
	});
});
