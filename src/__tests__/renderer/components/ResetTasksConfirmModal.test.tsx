import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ResetTasksConfirmModal } from '../../../renderer/components/ResetTasksConfirmModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

vi.mock('lucide-react', () => ({
	RotateCcw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="rotate-icon" className={className} style={style} />
	),
	X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
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
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const renderModal = (completedTaskCount: number, overrides = {}) => {
	const props = {
		theme: testTheme,
		documentName: 'Release Plan',
		completedTaskCount,
		onConfirm: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};

	render(
		<LayerStackProvider>
			<ResetTasksConfirmModal {...props} />
		</LayerStackProvider>
	);

	return props;
};

const getMessageContaining = (text: string) =>
	screen.getByText((_, element) => element?.tagName === 'P' && element.textContent?.includes(text));

describe('ResetTasksConfirmModal', () => {
	it('renders plural completed task copy', () => {
		renderModal(2);

		expect(screen.getByRole('heading', { name: 'Reset Completed Tasks' })).toBeInTheDocument();
		expect(screen.getByText('Release Plan')).toBeInTheDocument();
		expect(getMessageContaining('2 completed tasks in Release Plan')).toBeInTheDocument();
		expect(screen.getByText(/marking them as pending again/i)).toBeInTheDocument();
	});

	it('renders singular completed task copy', () => {
		renderModal(1);

		const message = getMessageContaining('1 completed task in Release Plan');

		expect(message).toBeInTheDocument();
		expect(message).not.toHaveTextContent('completed tasks');
	});

	it('confirms before closing', () => {
		const callOrder: string[] = [];
		const onConfirm = vi.fn(() => callOrder.push('confirm'));
		const onClose = vi.fn(() => callOrder.push('close'));

		renderModal(2, { onConfirm, onClose });

		fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(callOrder).toEqual(['confirm', 'close']);
	});

	it('closes without confirming when canceled', () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();

		renderModal(2, { onConfirm, onClose });

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onConfirm).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
