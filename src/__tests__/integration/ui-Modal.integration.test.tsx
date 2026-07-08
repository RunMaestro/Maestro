import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal, ModalFooter } from '../../renderer/components/ui/Modal';
import type { Theme } from '../../renderer/types';

const hookMocks = vi.hoisted(() => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../renderer/hooks', () => ({
	useModalLayer: hookMocks.useModalLayer,
}));

const theme: Theme = {
	id: 'dracula',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		border: '#444444',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#8b5cf6',
		accentDim: '#6d28d9',
		accentText: '#f5f3ff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

describe('Modal', () => {
	beforeEach(() => {
		hookMocks.useModalLayer.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('registers with the layer stack, focuses the requested element, and closes from backdrop or close button', () => {
		const onClose = vi.fn();
		const focusRef = createRef<HTMLButtonElement>();
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 1;
		});

		render(
			<>
				<button ref={focusRef}>Focusable action</button>
				<Modal
					theme={theme}
					title="Settings"
					priority={7}
					onClose={onClose}
					footer={<button>Footer action</button>}
					headerIcon={<span>Icon</span>}
					width={480}
					maxHeight="70vh"
					closeOnBackdropClick
					zIndex={42}
					layerOptions={{ isDirty: true }}
					initialFocusRef={focusRef}
					testId="settings-modal"
				>
					<p>Modal body</p>
				</Modal>
			</>
		);

		const dialog = screen.getByTestId('settings-modal');
		expect(hookMocks.useModalLayer).toHaveBeenCalledWith(7, 'Settings', onClose, {
			isDirty: true,
		});
		expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog);
		expect(dialog).toHaveStyle({ zIndex: '42' });
		expect(screen.getByText('Icon')).toBeInTheDocument();
		expect(screen.getByText('Footer action')).toBeInTheDocument();
		expect(focusRef.current).toHaveFocus();

		fireEvent.click(screen.getByText('Modal body'));
		expect(onClose).not.toHaveBeenCalled();

		const keyDown = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
		const stopPropagation = vi.spyOn(keyDown, 'stopPropagation');
		dialog.dispatchEvent(keyDown);
		expect(stopPropagation).toHaveBeenCalled();

		fireEvent.click(dialog);
		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));

		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('focuses the dialog by default and supports custom or hidden headers', () => {
		const onClose = vi.fn();
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 1;
		});
		const { rerender } = render(
			<Modal
				theme={theme}
				title="Custom"
				priority={1}
				onClose={onClose}
				customHeader={<div>Custom header</div>}
				closeOnBackdropClick={false}
				testId="custom-modal"
			>
				<p>Custom body</p>
			</Modal>
		);

		const customDialog = screen.getByTestId('custom-modal');
		expect(customDialog).toHaveFocus();
		expect(screen.getByText('Custom header')).toBeInTheDocument();
		fireEvent.click(customDialog);
		expect(onClose).not.toHaveBeenCalled();

		rerender(
			<Modal
				theme={theme}
				title="Hidden"
				priority={1}
				onClose={onClose}
				showHeader={false}
				testId="hidden-header-modal"
			>
				<p>Hidden header body</p>
			</Modal>
		);

		expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
		expect(screen.getByText('Hidden header body')).toBeInTheDocument();
	});

	it('can render a default header without the close button', () => {
		render(
			<Modal theme={theme} title="No Close" priority={1} onClose={vi.fn()} showCloseButton={false}>
				<p>No close body</p>
			</Modal>
		);

		expect(screen.getByText('No Close')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Close modal' })).not.toBeInTheDocument();
	});
});

describe('ModalFooter', () => {
	it('fires cancel and confirm actions from clicks and Enter key presses', () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();
		render(
			<ModalFooter
				theme={theme}
				onCancel={onCancel}
				onConfirm={onConfirm}
				cancelLabel="Back"
				confirmLabel="Save"
			/>
		);

		const cancel = screen.getByRole('button', { name: 'Back' });
		const confirm = screen.getByRole('button', { name: 'Save' });

		fireEvent.keyDown(cancel, { key: 'Enter' });
		fireEvent.keyDown(cancel, { key: 'Escape' });
		fireEvent.click(cancel);
		fireEvent.keyDown(confirm, { key: 'Enter' });
		fireEvent.click(confirm);

		expect(onCancel).toHaveBeenCalledTimes(2);
		expect(onConfirm).toHaveBeenCalledTimes(2);
	});

	it('does not run confirm from Enter when the confirm button is disabled', () => {
		const onConfirm = vi.fn();
		render(
			<ModalFooter
				theme={theme}
				onCancel={vi.fn()}
				onConfirm={onConfirm}
				confirmLabel="Delete"
				confirmDisabled
				destructive
				showCancel={false}
			/>
		);

		const confirm = screen.getByRole('button', { name: 'Delete' });

		fireEvent.keyDown(confirm, { key: 'Enter' });
		fireEvent.click(confirm);

		expect(confirm).toBeDisabled();
		expect(onConfirm).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
	});
});
