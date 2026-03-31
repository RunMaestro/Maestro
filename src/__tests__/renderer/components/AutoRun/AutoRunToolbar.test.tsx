/**
 * @file AutoRunToolbar.test.tsx
 * @description Tests for the AutoRunToolbar component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import {
	AutoRunToolbar,
	AutoRunToolbarProps,
} from '../../../../renderer/components/AutoRun/AutoRunToolbar';
import type { Theme } from '../../../../renderer/types';

vi.mock('../../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

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

const createMockTheme = (): Theme => ({
	id: 'test',
	name: 'Test',
	mode: 'dark' as const,
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		textMain: '#fff',
		textDim: '#888',
		accent: '#0066ff',
		accentForeground: '#fff',
		border: '#333',
		highlight: '#0066ff33',
		success: '#0a0',
		warning: '#fa0',
		error: '#f00',
	},
});

const createDefaultProps = (overrides: Partial<AutoRunToolbarProps> = {}): AutoRunToolbarProps => ({
	theme: createMockTheme(),
	mode: 'edit',
	isLocked: false,
	isAutoRunActive: false,
	isStopping: false,
	isAgentBusy: false,
	isDirty: false,
	sessionId: 'test-session-1',
	onSwitchMode: vi.fn(),
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

	describe('Expand button', () => {
		it('renders expand button when onExpand is provided', () => {
			const onExpand = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onExpand })} />);
			const expandBtn = screen.getByTitle(/Expand to full screen/);
			expect(expandBtn).toBeDefined();
		});

		it('does not render expand button when onExpand is not provided', () => {
			render(<AutoRunToolbar {...createDefaultProps()} />);
			const expandBtn = screen.queryByTitle(/Expand to full screen/);
			expect(expandBtn).toBeNull();
		});

		it('calls onExpand when clicked', () => {
			const onExpand = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onExpand })} />);
			fireEvent.click(screen.getByTitle(/Expand to full screen/));
			expect(onExpand).toHaveBeenCalledTimes(1);
		});

		it('shows shortcut hint in tooltip when shortcuts provided', () => {
			const onExpand = vi.fn();
			const shortcuts = {
				toggleAutoRunExpanded: { keys: ['Ctrl', 'Shift', 'E'], label: 'Expand' },
			};
			render(<AutoRunToolbar {...createDefaultProps({ onExpand, shortcuts })} />);
			const expandBtn = screen.getByTitle('Expand to full screen (Ctrl+Shift+E)');
			expect(expandBtn).toBeDefined();
		});

		it('does not show shortcut hint when shortcuts not provided', () => {
			const onExpand = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onExpand })} />);
			const expandBtn = screen.getByTitle('Expand to full screen');
			expect(expandBtn).toBeDefined();
		});
	});

	describe('Edit button', () => {
		it('is enabled when not locked', () => {
			render(<AutoRunToolbar {...createDefaultProps({ isLocked: false })} />);
			const editBtn = screen.getByTitle('Edit document');
			expect(editBtn).toBeDefined();
			expect(editBtn.hasAttribute('disabled')).toBe(false);
		});

		it('is disabled when locked', () => {
			render(<AutoRunToolbar {...createDefaultProps({ isLocked: true })} />);
			const editBtn = screen.getByTitle('Editing disabled while Auto Run active');
			expect(editBtn).toBeDefined();
			expect(editBtn.hasAttribute('disabled')).toBe(true);
		});

		it('calls onSwitchMode with edit when clicked and not locked', () => {
			const onSwitchMode = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onSwitchMode, isLocked: false })} />);
			fireEvent.click(screen.getByTitle('Edit document'));
			expect(onSwitchMode).toHaveBeenCalledWith('edit');
		});

		it('does not call onSwitchMode when clicked and locked', () => {
			const onSwitchMode = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onSwitchMode, isLocked: true })} />);
			fireEvent.click(screen.getByTitle('Editing disabled while Auto Run active'));
			expect(onSwitchMode).not.toHaveBeenCalled();
		});

		it('shows active styling when mode is edit and not locked', () => {
			const theme = createMockTheme();
			render(<AutoRunToolbar {...createDefaultProps({ mode: 'edit', isLocked: false, theme })} />);
			const editBtn = screen.getByTitle('Edit document');
			expect(editBtn.style.backgroundColor).toBe(hexToRgb(theme.colors.bgActivity));
			expect(editBtn.style.border).toContain(hexToRgb(theme.colors.accent));
		});
	});

	describe('Preview button', () => {
		it('calls onSwitchMode with preview when clicked', () => {
			const onSwitchMode = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onSwitchMode })} />);
			fireEvent.click(screen.getByTitle('Preview document'));
			expect(onSwitchMode).toHaveBeenCalledWith('preview');
		});

		it('shows active styling when mode is preview', () => {
			const theme = createMockTheme();
			render(
				<AutoRunToolbar {...createDefaultProps({ mode: 'preview', isLocked: false, theme })} />
			);
			const previewBtn = screen.getByTitle('Preview document');
			expect(previewBtn.style.backgroundColor).toBe(hexToRgb(theme.colors.bgActivity));
			expect(previewBtn.style.border).toContain(hexToRgb(theme.colors.accent));
		});

		it('shows active styling when isLocked is true regardless of mode', () => {
			const theme = createMockTheme();
			render(<AutoRunToolbar {...createDefaultProps({ mode: 'edit', isLocked: true, theme })} />);
			const previewBtn = screen.getByTitle('Preview document');
			expect(previewBtn.style.backgroundColor).toBe(hexToRgb(theme.colors.bgActivity));
			expect(previewBtn.style.border).toContain(hexToRgb(theme.colors.accent));
		});
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

		it('saves before running if dirty', () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const onOpenBatchRunner = vi.fn();
			render(
				<AutoRunToolbar {...createDefaultProps({ isDirty: true, onSave, onOpenBatchRunner })} />
			);
			fireEvent.click(screen.getByText('Run'));
			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
		});

		it('does not save before running if not dirty', () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const onOpenBatchRunner = vi.fn();
			render(
				<AutoRunToolbar {...createDefaultProps({ isDirty: false, onSave, onOpenBatchRunner })} />
			);
			fireEvent.click(screen.getByText('Run'));
			expect(onSave).not.toHaveBeenCalled();
			expect(onOpenBatchRunner).toHaveBeenCalledTimes(1);
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

		it('shows "Stopping..." text when isStopping', () => {
			render(
				<AutoRunToolbar {...createDefaultProps({ isAutoRunActive: true, isStopping: true })} />
			);
			expect(screen.getByText('Stopping...')).toBeDefined();
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

	describe('Exchange button', () => {
		it('is shown when onOpenMarketplace is provided', () => {
			const onOpenMarketplace = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onOpenMarketplace })} />);
			expect(screen.getByText('Exchange')).toBeDefined();
		});

		it('is hidden when onOpenMarketplace is not provided', () => {
			render(<AutoRunToolbar {...createDefaultProps()} />);
			expect(screen.queryByText('Exchange')).toBeNull();
		});

		it('calls onOpenMarketplace when clicked', () => {
			const onOpenMarketplace = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onOpenMarketplace })} />);
			fireEvent.click(screen.getByText('Exchange'));
			expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
		});
	});

	describe('Wizard button', () => {
		it('is shown when onLaunchWizard is provided', () => {
			const onLaunchWizard = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onLaunchWizard })} />);
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
		it('renders help button', () => {
			render(<AutoRunToolbar {...createDefaultProps()} />);
			expect(screen.getByTitle('Learn about Auto Runner')).toBeDefined();
		});

		it('calls onOpenHelp when clicked', () => {
			const onOpenHelp = vi.fn();
			render(<AutoRunToolbar {...createDefaultProps({ onOpenHelp })} />);
			fireEvent.click(screen.getByTitle('Learn about Auto Runner'));
			expect(onOpenHelp).toHaveBeenCalledTimes(1);
		});
	});
});
