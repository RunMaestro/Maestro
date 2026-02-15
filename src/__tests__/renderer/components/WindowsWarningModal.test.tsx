/**
 * Tests for WindowsWarningModal component
 *
 * Tests the core behavior of the Windows warning dialog:
 * - Rendering with correct content
 * - Button click handlers
 * - Suppress checkbox functionality
 * - Debug function exposure
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	WindowsWarningModal,
	exposeWindowsWarningModalDebug,
} from '../../../renderer/components/WindowsWarningModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
	Bug: () => <svg data-testid="bug-icon" />,
	Wrench: () => <svg data-testid="wrench-icon" />,
	ExternalLink: () => <svg data-testid="external-link-icon" />,
	Command: () => <svg data-testid="command-icon" />,
	Check: () => <svg data-testid="check-icon" />,
	MessageCircle: () => <svg data-testid="message-circle-icon" />,
}));

// Create a test theme
const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
		accentForeground: '#ffffff',
	},
};

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('WindowsWarningModal', () => {
	const defaultProps = {
		theme: testTheme,
		isOpen: true,
		onClose: vi.fn(),
		onSuppressFuture: vi.fn(),
		onOpenDebugPackage: vi.fn(),
		useBetaChannel: false,
		onSetUseBetaChannel: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		// Mock shell.openExternal for this test suite
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders when isOpen is true', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			expect(screen.getByText('Windows Support Notice')).toBeInTheDocument();
		});

		it('does not render when isOpen is false', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} isOpen={false} />);

			expect(screen.queryByText('Windows Support Notice')).not.toBeInTheDocument();
		});

		it('displays recommendations section', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			expect(screen.getByText('Recommendations')).toBeInTheDocument();
			expect(screen.getByText('Enable Beta Updates')).toBeInTheDocument();
			expect(screen.getByText('Report Issues')).toBeInTheDocument();
			expect(screen.getByText('Join Discord')).toBeInTheDocument();
			expect(screen.getByText('Create Debug Package')).toBeInTheDocument();
		});

		it('displays suppress checkbox', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			expect(screen.getByText("Don't show this message again")).toBeInTheDocument();
		});

		it('displays Got it! button', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			expect(screen.getByRole('button', { name: 'Got it!' })).toBeInTheDocument();
		});
	});

	describe('button handlers', () => {
		it('calls onClose when Got it! button is clicked', () => {
			const onClose = vi.fn();
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} onClose={onClose} />);

			fireEvent.click(screen.getByRole('button', { name: 'Got it!' }));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when X button is clicked', () => {
			const onClose = vi.fn();
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} onClose={onClose} />);

			// Find the X icon and click its parent button
			const closeButton = screen.getByTestId('x-icon').closest('button');
			fireEvent.click(closeButton!);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when backdrop is clicked', () => {
			const onClose = vi.fn();
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} onClose={onClose} />);

			// Click the backdrop (the dialog overlay itself)
			const dialog = screen.getByRole('dialog');
			fireEvent.click(dialog);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onSetUseBetaChannel with true when Enable Beta Updates is clicked', () => {
			const onSetUseBetaChannel = vi.fn();
			renderWithLayerStack(
				<WindowsWarningModal
					{...defaultProps}
					useBetaChannel={false}
					onSetUseBetaChannel={onSetUseBetaChannel}
				/>
			);

			fireEvent.click(screen.getByText('Enable Beta Updates'));
			expect(onSetUseBetaChannel).toHaveBeenCalledWith(true);
		});

		it('calls onSetUseBetaChannel with false when Beta Updates toggle is clicked while enabled', () => {
			const onSetUseBetaChannel = vi.fn();
			renderWithLayerStack(
				<WindowsWarningModal
					{...defaultProps}
					useBetaChannel={true}
					onSetUseBetaChannel={onSetUseBetaChannel}
				/>
			);

			fireEvent.click(screen.getByText('Enable Beta Updates'));
			expect(onSetUseBetaChannel).toHaveBeenCalledWith(false);
		});

		it('opens GitHub issues when Report Issues is clicked', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			fireEvent.click(screen.getByText('Report Issues'));
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://github.com/RunMaestro/Maestro/issues'
			);
		});

		it('opens Discord when Join Discord is clicked', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			fireEvent.click(screen.getByText('Join Discord'));
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://discord.gg/FCAh4EWzfD'
			);
		});

		it('calls onOpenDebugPackage when Create Debug Package is clicked', () => {
			const onOpenDebugPackage = vi.fn();
			renderWithLayerStack(
				<WindowsWarningModal {...defaultProps} onOpenDebugPackage={onOpenDebugPackage} />
			);

			fireEvent.click(screen.getByText('Create Debug Package'));
			expect(onOpenDebugPackage).toHaveBeenCalledTimes(1);
		});
	});

	describe('suppress checkbox', () => {
		it('checkbox is unchecked by default', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			const checkbox = screen.getByRole('checkbox');
			expect(checkbox).not.toBeChecked();
		});

		it('checkbox can be toggled', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			const checkbox = screen.getByRole('checkbox');
			fireEvent.click(checkbox);
			expect(checkbox).toBeChecked();
		});

		it('calls onSuppressFuture with false when closed without checking', () => {
			const onSuppressFuture = vi.fn();
			renderWithLayerStack(
				<WindowsWarningModal {...defaultProps} onSuppressFuture={onSuppressFuture} />
			);

			fireEvent.click(screen.getByRole('button', { name: 'Got it!' }));
			expect(onSuppressFuture).toHaveBeenCalledWith(false);
		});

		it('calls onSuppressFuture with true when closed with checkbox checked', () => {
			const onSuppressFuture = vi.fn();
			renderWithLayerStack(
				<WindowsWarningModal {...defaultProps} onSuppressFuture={onSuppressFuture} />
			);

			// Check the checkbox first
			fireEvent.click(screen.getByRole('checkbox'));
			// Then close
			fireEvent.click(screen.getByRole('button', { name: 'Got it!' }));
			expect(onSuppressFuture).toHaveBeenCalledWith(true);
		});
	});

	describe('focus management', () => {
		it('focuses Got it! button on mount', async () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Got it!' }));
			});
		});
	});

	describe('accessibility', () => {
		it('has correct ARIA attributes on dialog', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Windows Support Notice');
		});

		it('has tabIndex on dialog for focus', () => {
			renderWithLayerStack(<WindowsWarningModal {...defaultProps} />);

			expect(screen.getByRole('dialog')).toHaveAttribute('tabIndex', '-1');
		});
	});

	describe('exposeWindowsWarningModalDebug', () => {
		it('exposes __showWindowsWarningModal function to window', () => {
			const setShowModal = vi.fn();
			exposeWindowsWarningModalDebug(setShowModal);

			expect((window as any).__showWindowsWarningModal).toBeDefined();
		});

		it('calls setShowModal with true when __showWindowsWarningModal is invoked', () => {
			const setShowModal = vi.fn();
			exposeWindowsWarningModalDebug(setShowModal);

			(window as any).__showWindowsWarningModal();
			expect(setShowModal).toHaveBeenCalledWith(true);
		});
	});
});
