import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileSearchModal } from '../../../renderer/components/FileSearchModal';
import type { Theme } from '../../../renderer/types';
import type { FileNode } from '../../../renderer/types/fileTree';

const registerLayer = vi.fn();
const unregisterLayer = vi.fn();
const updateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer,
		unregisterLayer,
		updateLayerHandler,
	}),
}));

const mockTheme: Theme = {
	id: 'custom',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		border: '#303030',
		textMain: '#f8f8f8',
		textDim: '#a0a0a0',
		accent: '#4f8cff',
		accentDim: '#4f8cff33',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#3fb950',
		warning: '#d29922',
		error: '#f85149',
	},
};

const fileTree: FileNode[] = [{ name: 'README.md', type: 'file' }];

const renderModal = (onClose = vi.fn()) =>
	render(
		<FileSearchModal
			theme={mockTheme}
			fileTree={fileTree}
			expandedFolders={undefined}
			onFileSelect={vi.fn()}
			onClose={onClose}
		/>
	);

afterEach(() => {
	vi.clearAllMocks();
});

describe('FileSearchModal layer registration', () => {
	it('registers an initial Escape handler that closes the modal', () => {
		const onClose = vi.fn();
		registerLayer.mockReturnValue(undefined);

		renderModal(onClose);

		const layerConfig = registerLayer.mock.calls[0]?.[0];
		expect(layerConfig).toMatchObject({
			type: 'modal',
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Fuzzy File Search',
		});

		layerConfig.onEscape();

		expect(onClose).toHaveBeenCalledOnce();
		expect(updateLayerHandler).not.toHaveBeenCalled();
		expect(unregisterLayer).not.toHaveBeenCalled();
	});

	it('updates and unregisters the layer when an id is available', () => {
		registerLayer.mockReturnValue('file-search-layer');

		const { unmount } = renderModal();

		expect(updateLayerHandler).toHaveBeenCalledWith('file-search-layer', expect.any(Function));

		unmount();

		expect(unregisterLayer).toHaveBeenCalledWith('file-search-layer');
	});
});
