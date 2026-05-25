import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QuitConfirmModal } from '../../../renderer/components/QuitConfirmModal';
import type { Theme } from '../../../renderer/types';

const layerMocks = vi.hoisted(() => ({
	registerLayer: vi.fn(),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: layerMocks.registerLayer,
		unregisterLayer: layerMocks.unregisterLayer,
		updateLayerHandler: layerMocks.updateLayerHandler,
	}),
}));

vi.mock('lucide-react', () => ({
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
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

describe('QuitConfirmModal layer registration seam', () => {
	it('uses the registered escape handler and skips unregister when no layer id is returned', () => {
		const onCancel = vi.fn();
		layerMocks.registerLayer.mockReturnValueOnce('');

		const { unmount } = render(
			<QuitConfirmModal
				theme={testTheme}
				busyAgentCount={1}
				busyAgentNames={['Agent A']}
				onConfirmQuit={vi.fn()}
				onCancel={onCancel}
			/>
		);

		const registeredLayer = layerMocks.registerLayer.mock.calls[0][0];
		registeredLayer.onEscape();
		unmount();

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(layerMocks.updateLayerHandler).not.toHaveBeenCalled();
		expect(layerMocks.unregisterLayer).not.toHaveBeenCalled();
	});
});
