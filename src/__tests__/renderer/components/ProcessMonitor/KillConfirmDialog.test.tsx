import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRegisterLayer = vi.fn(() => 'kill-layer');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

import { KillConfirmDialog } from '../../../../renderer/components/ProcessMonitor/KillConfirmDialog';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import type { Theme } from '../../../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'test',
	mode: 'dark',
	colors: {
		bgMain: '#000',
		bgSidebar: '#111',
		bgActivity: '#222',
		textMain: '#fff',
		textDim: '#888',
		accent: '#7b2cbf',
		border: '#333',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
};

describe('KillConfirmDialog', () => {
	beforeEach(() => {
		mockRegisterLayer.mockClear();
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders title and warning copy', () => {
		render(
			<KillConfirmDialog theme={theme} isKilling={false} onConfirm={() => {}} onCancel={() => {}} />
		);
		expect(screen.getByText('Kill Process?')).toBeInTheDocument();
		expect(
			screen.getByText('This will forcefully terminate the process. Any unsaved work may be lost.')
		).toBeInTheDocument();
	});

	it('clicking Cancel triggers onCancel', () => {
		const onCancel = vi.fn();
		render(
			<KillConfirmDialog theme={theme} isKilling={false} onConfirm={() => {}} onCancel={onCancel} />
		);
		fireEvent.click(screen.getByText('Cancel'));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('clicking the backdrop triggers onCancel', () => {
		const onCancel = vi.fn();
		const { container } = render(
			<KillConfirmDialog theme={theme} isKilling={false} onConfirm={() => {}} onCancel={onCancel} />
		);
		const backdrop = container.querySelector('.fixed.inset-0') as HTMLElement;
		fireEvent.click(backdrop);
		expect(onCancel).toHaveBeenCalled();
	});

	it('clicking Kill Process triggers onConfirm', () => {
		const onConfirm = vi.fn();
		render(
			<KillConfirmDialog
				theme={theme}
				isKilling={false}
				onConfirm={onConfirm}
				onCancel={() => {}}
			/>
		);
		fireEvent.click(screen.getByText('Kill Process'));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('Enter confirms when not already killing', () => {
		const onConfirm = vi.fn();
		const { container } = render(
			<KillConfirmDialog
				theme={theme}
				isKilling={false}
				onConfirm={onConfirm}
				onCancel={() => {}}
			/>
		);
		const dialog = container.querySelector('[tabindex="-1"]') as HTMLElement;
		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('Enter does NOT fire onConfirm while killing is in flight', () => {
		const onConfirm = vi.fn();
		const { container } = render(
			<KillConfirmDialog theme={theme} isKilling={true} onConfirm={onConfirm} onCancel={() => {}} />
		);
		const dialog = container.querySelector('[tabindex="-1"]') as HTMLElement;
		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('registers a CONFIRM-priority layer so Escape wins over ProcessMonitor', () => {
		render(
			<KillConfirmDialog theme={theme} isKilling={false} onConfirm={() => {}} onCancel={() => {}} />
		);
		expect(mockRegisterLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				priority: MODAL_PRIORITIES.CONFIRM,
				ariaLabel: 'Kill Process',
			})
		);
		expect(MODAL_PRIORITIES.CONFIRM).toBeGreaterThan(MODAL_PRIORITIES.PROCESS_MONITOR);
	});

	it('the registered onEscape handler invokes onCancel', () => {
		const onCancel = vi.fn();
		render(
			<KillConfirmDialog theme={theme} isKilling={false} onConfirm={() => {}} onCancel={onCancel} />
		);
		const layer = mockRegisterLayer.mock.calls.at(-1)?.[0] as { onEscape?: () => void } | undefined;
		expect(layer?.onEscape).toBeTypeOf('function');
		layer?.onEscape?.();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('unregisters its layer on unmount', () => {
		const { unmount } = render(
			<KillConfirmDialog theme={theme} isKilling={false} onConfirm={() => {}} onCancel={() => {}} />
		);
		unmount();
		expect(mockUnregisterLayer).toHaveBeenCalledWith('kill-layer');
	});

	it('shows the "Killing..." spinner state and disables both buttons', () => {
		render(
			<KillConfirmDialog theme={theme} isKilling={true} onConfirm={() => {}} onCancel={() => {}} />
		);
		expect(screen.getByText('Killing...')).toBeInTheDocument();
		expect((screen.getByText('Cancel') as HTMLButtonElement).disabled).toBe(true);
		// The confirm button renders the "Killing..." label inside it while killing.
		const confirmButton = screen.getByText('Killing...').closest('button') as HTMLButtonElement;
		expect(confirmButton).not.toBeNull();
		expect(confirmButton.disabled).toBe(true);
	});
});
