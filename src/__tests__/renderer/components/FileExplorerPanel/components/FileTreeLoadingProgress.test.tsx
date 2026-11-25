import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeLoadingProgress } from '../../../../../renderer/components/FileExplorerPanel/components/FileTreeLoadingProgress';

vi.mock('../../../../../renderer/components/ui/Spinner', () => ({
	Spinner: ({ size }: { size: number }) => <div data-testid="spinner" data-size={size} />,
}));

const theme = {
	colors: { textMain: '#fff', textDim: '#888', accent: '#7C3AED' },
} as any;

describe('FileTreeLoadingProgress', () => {
	it('shows the same loading text in every mode', () => {
		render(<FileTreeLoadingProgress theme={theme} />);
		expect(screen.getByText('Loading files...')).toBeTruthy();
		expect(screen.queryByText(/remote/i)).toBeNull();
	});

	it('displays progress counters when progress data is provided', () => {
		const progress = { directoriesScanned: 12, filesFound: 45, currentDirectory: '/src/foo' };
		render(<FileTreeLoadingProgress theme={theme} progress={progress} />);
		expect(screen.getByText('45')).toBeTruthy();
		expect(screen.getByText('12')).toBeTruthy();
	});

	it('shows the current folder being scanned', () => {
		const progress = { directoriesScanned: 1, filesFound: 5, currentDirectory: '/src/components' };
		render(<FileTreeLoadingProgress theme={theme} progress={progress} />);
		expect(screen.getByText(/scanning: components\//)).toBeTruthy();
	});

	it('renders a cancel button when onCancel is provided', () => {
		const onCancel = vi.fn();
		render(<FileTreeLoadingProgress theme={theme} onCancel={onCancel} />);
		expect(screen.getByText('Stop loading')).toBeTruthy();
	});

	it('calls onCancel when the cancel button is clicked', () => {
		const onCancel = vi.fn();
		render(<FileTreeLoadingProgress theme={theme} onCancel={onCancel} />);
		fireEvent.click(screen.getByText('Stop loading'));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('does not render a cancel button when onCancel is absent', () => {
		render(<FileTreeLoadingProgress theme={theme} />);
		expect(screen.queryByText('Stop loading')).toBeNull();
	});
});
