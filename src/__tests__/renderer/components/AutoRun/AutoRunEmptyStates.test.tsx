/**
 * @file AutoRunEmptyStates.test.tsx
 * @description Tests for the NoFolderState and EmptyFolderState components
 *
 * NoFolderState: Shown when no Auto Run folder is selected. Displays explanation text,
 * feature items (Markdown Documents, Checkbox Tasks, Batch Execution), and a button
 * to select a folder.
 *
 * EmptyFolderState: Shown when the selected folder has no markdown files. Displays
 * a heading, description, and Refresh/Change Folder buttons.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	NoFolderState,
	EmptyFolderState,
} from '../../../../renderer/components/AutoRun/AutoRunEmptyStates';

import { createMockTheme } from '../../../helpers/mockTheme';

// Mock Lucide icons, preserving className for assertion
vi.mock('lucide-react', () => ({
	FileText: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="file-text-icon" className={className} style={style} />
	),
	CheckSquare: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="check-square-icon" className={className} style={style} />
	),
	Play: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="play-icon" className={className} style={style} />
	),
	FolderOpen: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="folder-open-icon" className={className} style={style} />
	),
	RefreshCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="refresh-icon" className={className} style={style} />
	),
}));

describe('NoFolderState', () => {
	const theme = createMockTheme();

	it('renders explanation text about Auto Run', () => {
		render(<NoFolderState theme={theme} onOpenSetup={vi.fn()} />);
		expect(
			screen.getByText(/Auto Run lets you manage and execute Markdown documents/i)
		).toBeInTheDocument();
	});

	it('shows "Markdown Documents" feature item', () => {
		render(<NoFolderState theme={theme} onOpenSetup={vi.fn()} />);
		expect(screen.getByText('Markdown Documents')).toBeInTheDocument();
		expect(
			screen.getByText(/Each \.md file in your folder becomes a runnable document/)
		).toBeInTheDocument();
	});

	it('shows "Checkbox Tasks" feature item', () => {
		render(<NoFolderState theme={theme} onOpenSetup={vi.fn()} />);
		expect(screen.getByText('Checkbox Tasks')).toBeInTheDocument();
		expect(
			screen.getByText(/Use markdown checkboxes.*to define tasks that can be automated/)
		).toBeInTheDocument();
	});

	it('shows "Batch Execution" feature item', () => {
		render(<NoFolderState theme={theme} onOpenSetup={vi.fn()} />);
		expect(screen.getByText('Batch Execution')).toBeInTheDocument();
		expect(
			screen.getByText(/Run multiple documents in sequence with loop and reset options/)
		).toBeInTheDocument();
	});

	it('shows "Select Auto Run Folder" button', () => {
		render(<NoFolderState theme={theme} onOpenSetup={vi.fn()} />);
		expect(screen.getByRole('button', { name: /Select Auto Run Folder/i })).toBeInTheDocument();
	});

	it('clicking folder button calls onOpenSetup', () => {
		const onOpenSetup = vi.fn();
		render(<NoFolderState theme={theme} onOpenSetup={onOpenSetup} />);
		fireEvent.click(screen.getByRole('button', { name: /Select Auto Run Folder/i }));
		expect(onOpenSetup).toHaveBeenCalledTimes(1);
	});
});

describe('EmptyFolderState', () => {
	const theme = createMockTheme();

	it('renders "No Documents Found" heading', () => {
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={false}
				onRefresh={vi.fn()}
				onOpenSetup={vi.fn()}
			/>
		);
		expect(screen.getByText('No Documents Found')).toBeInTheDocument();
	});

	it('shows description text about no markdown files', () => {
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={false}
				onRefresh={vi.fn()}
				onOpenSetup={vi.fn()}
			/>
		);
		expect(screen.getByText(/doesn't contain any markdown \(\.md\) files/)).toBeInTheDocument();
	});

	it('shows Refresh button', () => {
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={false}
				onRefresh={vi.fn()}
				onOpenSetup={vi.fn()}
			/>
		);
		expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
	});

	it('shows Change Folder button', () => {
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={false}
				onRefresh={vi.fn()}
				onOpenSetup={vi.fn()}
			/>
		);
		expect(screen.getByRole('button', { name: /Change Folder/i })).toBeInTheDocument();
	});

	it('clicking Refresh calls onRefresh', () => {
		const onRefresh = vi.fn();
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={false}
				onRefresh={onRefresh}
				onOpenSetup={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it('clicking Change Folder calls onOpenSetup', () => {
		const onOpenSetup = vi.fn();
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={false}
				onRefresh={vi.fn()}
				onOpenSetup={onOpenSetup}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: /Change Folder/i }));
		expect(onOpenSetup).toHaveBeenCalledTimes(1);
	});

	it('Refresh icon has animate-spin class when isRefreshingEmpty is true', () => {
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={true}
				onRefresh={vi.fn()}
				onOpenSetup={vi.fn()}
			/>
		);
		const refreshIcon = screen.getByTestId('refresh-icon');
		expect(refreshIcon.getAttribute('class')).toContain('animate-spin');
	});

	it('Refresh icon does not animate when isRefreshingEmpty is false', () => {
		render(
			<EmptyFolderState
				theme={theme}
				isRefreshingEmpty={false}
				onRefresh={vi.fn()}
				onOpenSetup={vi.fn()}
			/>
		);
		const refreshIcon = screen.getByTestId('refresh-icon');
		expect(refreshIcon.getAttribute('class')).not.toContain('animate-spin');
	});
});
