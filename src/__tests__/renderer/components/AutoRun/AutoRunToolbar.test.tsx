/**
 * @file AutoRunToolbar.test.tsx
 * @description Tests for the AutoRunToolbar component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import {
	AutoRunToolbar,
	AutoRunToolbarProps,
} from '../../../../renderer/components/AutoRun/AutoRunToolbar';

import { createMockTheme } from '../../../helpers/mockTheme';

// jsdom converts shorthand hex colors to rgb() in computed styles.
// This helper converts a shorthand or full hex color to its rgb() equivalent for assertions.
const hexToRgb = (hex: string): string => {
	let expanded = hex.replace(/^#/, '');
	if (expanded.length === 3) {
		expanded = expanded
			.split('')
			.map((c) => c + c)
			.join('');
	}
	const r = parseInt(expanded.slice(0, 2), 16);
	const g = parseInt(expanded.slice(2, 4), 16);
	const b = parseInt(expanded.slice(4, 6), 16);
	return `rgb(${r}, ${g}, ${b})`;
};

const createDefaultProps = (overrides: Partial<AutoRunToolbarProps> = {}): AutoRunToolbarProps => ({
	theme: createMockTheme(),
	isAutoRunActive: false,
	isStopping: false,
	isAgentBusy: false,
	isDirty: false,
	sessionId: 'test-session-1',
	onOpenHelp: vi.fn(),
	onSave: vi.fn().mockResolvedValue(undefined),
	fileInputRef: { current: null } as React.RefObject<HTMLInputElement>,
	onFileSelect: vi.fn(),
	...overrides,
});

describe('AutoRunToolbar', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('Run button', () => {
		it('shows Run button when not active', () => {
			render(<AutoRunToolbar {...createDefaultProps({ isAutoRunActive: false })} />);
			expect(screen.getByText('Run')).toBeDefined();
		});

		it('does not show Run button when auto run is active', () => {
			render(<AutoRunToolbar {...createDefaultProps({ isAutoRunActive: true })} />);
			expect(screen.queryByText('Run')).toBeNull();
		});

		it('is disabled when isAgentBusy', () => {
			render(<AutoRunToolbar {...createDefaultProps({ isAgentBusy: true })} />);
			const runBtn = screen.getByTitle('Cannot run while agent is thinking');
			expect(runBtn.hasAttribute('disabled')).toBe(true);
		});

		it('is enabled when agent is not busy', () => {
			render(<AutoRunToolbar {...createDefaultProps({ isAgentBusy: false })} />);
			const runBtn = screen.getByTitle('Run auto-run on tasks');
			expect(runBtn.hasAttribute('disabled')).toBe(false);
		});

		it('saves before running if dirty and opens runner only after save resolves', async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const onOpenBatchRunner = vi.fn();
			render(
				<AutoRunToolbar {...createDefaultProps({ isDirty: true, onSave, onOpenBatchRunner })} />
			);
			fireEvent.click(screen.getByText('Run'));
			expect(onSave).toHaveBeenCalledTimes(1);
			// onOpenBatchRunner called after save resolves
			await waitFor(() => {
				expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
			});
			// Verify save was called before batch runner
			expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(
				onOpenBatchRunner.mock.invocationCallOrder[0]
			);
		});

		it('does not open runner if save fails', async () => {
			const onSave = vi.fn().mockRejectedValue(new Error('Save failed'));
			const onOpenBatchRunner = vi.fn();
			render(
				<AutoRunToolbar {...createDefaultProps({ isDirty: true, onSave, onOpenBatchRunner })} />
			);
			fireEvent.click(screen.getByText('Run'));
			await waitFor(() => {
				expect(onSave).toHaveBeenCalledTimes(1);
			});
			expect(onOpenBatchRunner).not.toHaveBeenCalled();
		});

		it('does not save before running if not dirty', async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const onOpenBatchRunner = vi.fn();
			render(
				<AutoRunToolbar {...createDefaultProps({ isDirty: false, onSave, onOpenBatchRunner })} />
			);
			fireEvent.click(screen.getByText('Run'));
			await waitFor(() => {
				expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
			});
			expect(onSave).not.toHaveBeenCalled();
		});

		it('calls onOpenBatchRunner when clicked', () => {
			const onOpenBatchRunner = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onOpenBatchRunner })} />);
			fireEvent.click(screen.getByText('Run'));
			expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
		});
	});

	describe('Stop button', () => {
		it('shows Stop button when auto run is active', () => {
			render(<AutoRunToolbar {...createDefaultProps({ isAutoRunActive: true })} />);
			expect(screen.getByText('Stop')).toBeDefined();
		});

		it('shows "Stopping" text when isStopping', () => {
			render(
				<AutoRunToolbar {...createDefaultProps({ isAutoRunActive: true, isStopping: true })} />
			);
			expect(screen.getByText('Stopping')).toBeDefined();
		});

		it('is disabled when isStopping', () => {
			render(
				<AutoRunToolbar {...createDefaultProps({ isAutoRunActive: true, isStopping: true })} />
			);
			const stopBtn = screen.getByTitle('Stopping after current task...');
			expect(stopBtn.hasAttribute('disabled')).toBe(true);
		});

		it('calls onStopBatchRun with sessionId when clicked and not stopping', () => {
			const onStopBatchRun = vi.fn();
			render(
				<AutoRunToolbar
					{...createDefaultProps({
						isAutoRunActive: true,
						isStopping: false,
						onStopBatchRun,
						sessionId: 'session-abc',
					})}
				/>
			);
			fireEvent.click(screen.getByTitle('Stop auto-run'));
			expect(onStopBatchRun).toHaveBeenCalledWith('session-abc');
		});

		it('does not call onStopBatchRun when isStopping', () => {
			const onStopBatchRun = vi.fn();
			render(
				<AutoRunToolbar
					{...createDefaultProps({
						isAutoRunActive: true,
						isStopping: true,
						onStopBatchRun,
					})}
				/>
			);
			fireEvent.click(screen.getByTitle('Stopping after current task...'));
			expect(onStopBatchRun).not.toHaveBeenCalled();
		});

		it('shows stop styling with error color when not stopping', () => {
			const theme = createMockTheme();
			render(
				<AutoRunToolbar
					{...createDefaultProps({ isAutoRunActive: true, isStopping: false, theme })}
				/>
			);
			const stopBtn = screen.getByTitle('Stop auto-run');
			expect(stopBtn.style.backgroundColor).toBe(hexToRgb(theme.colors.error));
			expect(stopBtn.style.border).toContain(hexToRgb(theme.colors.error));
		});

		it('shows warning styling when stopping', () => {
			const theme = createMockTheme();
			render(
				<AutoRunToolbar
					{...createDefaultProps({ isAutoRunActive: true, isStopping: true, theme })}
				/>
			);
			const stopBtn = screen.getByTitle('Stopping after current task...');
			expect(stopBtn.style.backgroundColor).toBe(hexToRgb(theme.colors.warning));
			expect(stopBtn.style.border).toContain(hexToRgb(theme.colors.warning));
		});
	});

	describe('PlayBooks button', () => {
		it('is shown when onOpenMarketplace is provided', () => {
			const onOpenMarketplace = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onOpenMarketplace })} />);
			expect(screen.getByText('PlayBooks')).toBeDefined();
		});

		it('is hidden when onOpenMarketplace is not provided', () => {
			render(<AutoRunToolbar {...createDefaultProps()} />);
			expect(screen.queryByText('PlayBooks')).toBeNull();
		});

		it('calls onOpenMarketplace when clicked', () => {
			const onOpenMarketplace = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onOpenMarketplace })} />);
			fireEvent.click(screen.getByText('PlayBooks'));
			expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
		});
	});

	describe('Wizard button', () => {
		it('is shown with text when onLaunchWizard is provided', () => {
			const onLaunchWizard = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onLaunchWizard })} />);
			expect(screen.getByText('Wizard')).toBeDefined();
			const wizardBtn = screen.getByTitle('Launch In-Tab Wizard');
			expect(wizardBtn).toBeDefined();
		});

		it('is hidden when onLaunchWizard is not provided', () => {
			render(<AutoRunToolbar {...createDefaultProps()} />);
			expect(screen.queryByTitle('Launch In-Tab Wizard')).toBeNull();
		});

		it('calls onLaunchWizard when clicked', () => {
			const onLaunchWizard = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onLaunchWizard })} />);
			fireEvent.click(screen.getByTitle('Launch In-Tab Wizard'));
			expect(onLaunchWizard).toHaveBeenCalledTimes(1);
		});
	});

	describe('Help button', () => {
		it('renders help button with text label', () => {
			render(<AutoRunToolbar {...createDefaultProps()} />);
			expect(screen.getByTitle('Learn about Auto Runner')).toBeDefined();
			expect(screen.getByText('Help')).toBeDefined();
		});

		it('calls onOpenHelp when clicked', () => {
			const onOpenHelp = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onOpenHelp })} />);
			fireEvent.click(screen.getByTitle('Learn about Auto Runner'));
			expect(onOpenHelp).toHaveBeenCalledTimes(1);
		});
	});
});
