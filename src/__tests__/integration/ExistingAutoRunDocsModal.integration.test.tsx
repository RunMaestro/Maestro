import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExistingAutoRunDocsModal } from '../../renderer/components/Wizard/ExistingAutoRunDocsModal';
import { MODAL_PRIORITIES } from '../../renderer/constants/modalPriorities';
import type { Theme } from '../../renderer/types';

const layerMocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'existing-autodocs-layer'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: layerMocks.registerLayer,
		unregisterLayer: layerMocks.unregisterLayer,
		updateLayerHandler: layerMocks.updateLayerHandler,
	}),
}));

const theme = {
	id: 'existing-docs-test',
	name: 'Existing Docs Test',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		error: '#ef4444',
		warning: '#f59e0b',
	},
} as Theme;

function createProps(overrides: Partial<ComponentProps<typeof ExistingAutoRunDocsModal>> = {}) {
	return {
		theme,
		directoryPath: '/Users/tester/projects/maestro-app',
		documentCount: 2,
		onStartFresh: vi.fn(),
		onContinuePlanning: vi.fn(),
		onCancel: vi.fn(),
		...overrides,
	};
}

function renderModal(overrides: Partial<ComponentProps<typeof ExistingAutoRunDocsModal>> = {}) {
	const props = createProps(overrides);
	const view = render(<ExistingAutoRunDocsModal {...props} />);
	return { ...view, props };
}

describe('ExistingAutoRunDocsModal integration', () => {
	beforeEach(() => {
		layerMocks.registerLayer.mockClear();
		layerMocks.unregisterLayer.mockClear();
		layerMocks.updateLayerHandler.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders existing document context and registers the modal layer', () => {
		const { props, unmount } = renderModal({ documentCount: 1 });

		expect(
			screen.getByRole('dialog', { name: 'Existing Playbook Documents Detected' })
		).toBeInTheDocument();
		expect(screen.getByText('Existing Planning Documents Found')).toBeInTheDocument();
		expect(screen.getByText('maestro-app')).toHaveAttribute('title', props.directoryPath);
		expect(screen.getByText(/1 document/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Continue Planning' })).toHaveFocus();
		expect(layerMocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				priority: MODAL_PRIORITIES.EXISTING_AUTORUN_DOCS,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				ariaLabel: 'Existing Playbook Documents Detected',
				onEscape: expect.any(Function),
			})
		);
		expect(layerMocks.updateLayerHandler).toHaveBeenCalledWith(
			'existing-autodocs-layer',
			expect.any(Function)
		);
		const updatedEscapeHandler = layerMocks.updateLayerHandler.mock.calls[0][1];
		updatedEscapeHandler();
		expect(props.onCancel).toHaveBeenCalledTimes(1);

		unmount();

		expect(layerMocks.unregisterLayer).toHaveBeenCalledWith('existing-autodocs-layer');
	});

	it('calls the selected actions and shows deleting state for start fresh', async () => {
		const { props } = renderModal();

		expect(screen.getByText(/2 documents/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Continue Planning' }));
		expect(props.onContinuePlanning).toHaveBeenCalledTimes(1);

		const startFreshButton = screen.getByRole('button', {
			name: 'Start Fresh (Delete Existing Docs)',
		});
		fireEvent.focus(startFreshButton);
		fireEvent.click(startFreshButton);

		expect(props.onStartFresh).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(startFreshButton).toBeDisabled();
			expect(screen.getByText('Deleting...')).toBeInTheDocument();
		});
	});

	it('confirms the focused action from keyboard navigation', () => {
		const continueCase = renderModal();
		const dialog = screen.getByRole('dialog', { name: 'Existing Playbook Documents Detected' });

		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(continueCase.props.onContinuePlanning).toHaveBeenCalledTimes(1);
		expect(continueCase.props.onStartFresh).not.toHaveBeenCalled();
		continueCase.unmount();

		const tabCase = renderModal();
		const tabDialog = screen.getByRole('dialog', { name: 'Existing Playbook Documents Detected' });
		fireEvent.keyDown(tabDialog, { key: 'Tab' });
		fireEvent.keyDown(tabDialog, { key: 'Enter' });
		expect(tabCase.props.onStartFresh).toHaveBeenCalledTimes(1);
		tabCase.unmount();

		const arrowCase = renderModal({ directoryPath: '/Users/tester/projects/' });
		const arrowDialog = screen.getByRole('dialog', {
			name: 'Existing Playbook Documents Detected',
		});
		expect(screen.getByText('/Users/tester/projects/')).toBeInTheDocument();
		fireEvent.keyDown(arrowDialog, { key: 'ArrowUp' });
		fireEvent.keyDown(arrowDialog, { key: 'ArrowDown' });
		fireEvent.keyDown(arrowDialog, { key: 'Enter' });
		expect(arrowCase.props.onContinuePlanning).toHaveBeenCalledTimes(1);
		expect(arrowCase.props.onStartFresh).not.toHaveBeenCalled();
	});
});
