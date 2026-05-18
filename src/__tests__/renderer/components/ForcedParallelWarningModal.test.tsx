import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ForcedParallelWarningModal } from '../../../renderer/components/ForcedParallelWarningModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

vi.mock('lucide-react', () => ({
	X: () => <svg data-testid="x-icon" />,
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
}));

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
		accentDim: '#007acc80',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

const renderWithLayerStack = (ui: React.ReactElement) =>
	render(<LayerStackProvider>{ui}</LayerStackProvider>);

describe('ForcedParallelWarningModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders when isOpen is true', () => {
		renderWithLayerStack(
			<ForcedParallelWarningModal
				isOpen={true}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
				theme={testTheme}
			/>,
		);

		expect(screen.getByRole('heading', { name: 'Forced Parallel Execution' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /I understand, enable it/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
	});

	it('renders nothing when isOpen is false', () => {
		renderWithLayerStack(
			<ForcedParallelWarningModal
				isOpen={false}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
				theme={testTheme}
			/>,
		);

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('calls onConfirm when confirm button is clicked', () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		renderWithLayerStack(
			<ForcedParallelWarningModal
				isOpen={true}
				onConfirm={onConfirm}
				onCancel={onCancel}
				theme={testTheme}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: /I understand, enable it/ }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('calls onCancel when Cancel button is clicked', () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		renderWithLayerStack(
			<ForcedParallelWarningModal
				isOpen={true}
				onConfirm={onConfirm}
				onCancel={onCancel}
				theme={testTheme}
			/>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('calls onCancel when X close button is clicked', () => {
		const onCancel = vi.fn();
		renderWithLayerStack(
			<ForcedParallelWarningModal
				isOpen={true}
				onConfirm={vi.fn()}
				onCancel={onCancel}
				theme={testTheme}
			/>,
		);

		const closeButton = screen.getByTestId('x-icon').closest('button');
		fireEvent.click(closeButton!);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('calls onCancel when Escape key is pressed', () => {
		const onCancel = vi.fn();
		renderWithLayerStack(
			<ForcedParallelWarningModal
				isOpen={true}
				onConfirm={vi.fn()}
				onCancel={onCancel}
				theme={testTheme}
			/>,
		);

		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onCancel).toHaveBeenCalled();
	});

	it('renders warning copy describing parallel-write risk', () => {
		renderWithLayerStack(
			<ForcedParallelWarningModal
				isOpen={true}
				onConfirm={vi.fn()}
				onCancel={vi.fn()}
				theme={testTheme}
			/>,
		);

		expect(screen.getByText(/sends messages immediately/i)).toBeInTheDocument();
		expect(screen.getByText(/overwrite the other/i)).toBeInTheDocument();
	});
});
