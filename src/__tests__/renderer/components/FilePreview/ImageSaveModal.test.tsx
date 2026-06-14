/**
 * Tests for ImageSaveModal component
 *
 * ImageSaveModal is the destination picker shown after editing an image file in
 * the annotator. Phase 1 offers "Overwrite" vs "Save to a new file"; phase 2
 * collects the new file name. These tests cover phase switching, the callbacks,
 * the seeded default name, and the format-changed warning.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageSaveModal } from '../../../../renderer/components/FilePreview/ImageSaveModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../renderer/types';

vi.mock('lucide-react', () => ({
	FilePlus2: () => <svg data-testid="file-plus-icon" />,
	FileWarning: () => <svg data-testid="file-warning-icon" />,
	Save: () => <svg data-testid="save-icon" />,
	X: () => <svg data-testid="x-icon" />,
	Loader2: () => <svg data-testid="spinner-icon" />,
}));

const createTestTheme = (): Theme =>
	({
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
	}) as unknown as Theme;

const renderWithProviders = (ui: React.ReactElement) =>
	render(<LayerStackProvider>{ui}</LayerStackProvider>);

describe('ImageSaveModal', () => {
	let theme: Theme;
	let onOverwrite: ReturnType<typeof vi.fn>;
	let onSaveAs: ReturnType<typeof vi.fn>;
	let onCancel: ReturnType<typeof vi.fn>;

	const renderModal = (props: Partial<React.ComponentProps<typeof ImageSaveModal>> = {}) =>
		renderWithProviders(
			<ImageSaveModal
				theme={theme}
				fileName="icon-wand.png"
				outputExtension="png"
				canOverwrite={true}
				fallbackFileName="icon-wand.png"
				originalExtension="png"
				onOverwrite={onOverwrite}
				onSaveAs={onSaveAs}
				onCancel={onCancel}
				{...props}
			/>
		);

	beforeEach(() => {
		theme = createTestTheme();
		onOverwrite = vi.fn();
		onSaveAs = vi.fn();
		onCancel = vi.fn();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('choose phase', () => {
		it('shows both destination options and the original file name', () => {
			renderModal();
			expect(screen.getByText('Overwrite the existing file')).toBeInTheDocument();
			expect(screen.getByText('Save to a new file')).toBeInTheDocument();
			expect(screen.getByText('Replace icon-wand.png')).toBeInTheDocument();
		});

		it('calls onOverwrite when the overwrite option is clicked', () => {
			renderModal();
			fireEvent.click(screen.getByText('Overwrite the existing file'));
			expect(onOverwrite).toHaveBeenCalledTimes(1);
			expect(onSaveAs).not.toHaveBeenCalled();
		});

		it('calls onCancel when the Cancel button is clicked', () => {
			renderModal();
			fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
			expect(onCancel).toHaveBeenCalledTimes(1);
		});

		it('offers a plain overwrite when the format can be written in place', () => {
			renderModal({ canOverwrite: true });
			expect(screen.queryByTestId('file-warning-icon')).not.toBeInTheDocument();
			expect(screen.getByText('Replace icon-wand.png')).toBeInTheDocument();
		});

		it('warns and names the fallback file when the format cannot be written', () => {
			renderModal({
				fileName: 'photo.jpg',
				outputExtension: 'png',
				canOverwrite: false,
				fallbackFileName: 'photo.png',
				originalExtension: 'jpg',
			});
			expect(screen.getByTestId('file-warning-icon')).toBeInTheDocument();
			expect(
				screen.getByText("Can't write JPG, will create photo.png instead")
			).toBeInTheDocument();
		});

		it('routes the overwrite action through onOverwrite even in fallback mode', () => {
			renderModal({
				fileName: 'photo.jpg',
				canOverwrite: false,
				fallbackFileName: 'photo.png',
				originalExtension: 'jpg',
			});
			fireEvent.click(screen.getByText('Overwrite the existing file'));
			expect(onOverwrite).toHaveBeenCalledTimes(1);
		});

		it('disables the options while a save is in flight', () => {
			renderModal({ isSaving: true });
			const overwrite = screen.getByText('Overwrite the existing file').closest('button');
			expect(overwrite).toBeDisabled();
		});
	});

	describe('name phase', () => {
		it('switches to the name phase and seeds an -edited default name', () => {
			renderModal();
			fireEvent.click(screen.getByText('Save to a new file'));
			expect(screen.getByDisplayValue('icon-wand-edited.png')).toBeInTheDocument();
		});

		it('seeds the default name using the output extension, not the original', () => {
			renderModal({ fileName: 'photo.jpg', outputExtension: 'png' });
			fireEvent.click(screen.getByText('Save to a new file'));
			expect(screen.getByDisplayValue('photo-edited.png')).toBeInTheDocument();
		});

		it('calls onSaveAs with the trimmed file name', () => {
			renderModal();
			fireEvent.click(screen.getByText('Save to a new file'));
			const input = screen.getByDisplayValue('icon-wand-edited.png');
			fireEvent.change(input, { target: { value: '  my-art.png  ' } });
			fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
			expect(onSaveAs).toHaveBeenCalledWith('my-art.png');
		});

		it('returns to the choose phase when Back is clicked', () => {
			renderModal();
			fireEvent.click(screen.getByText('Save to a new file'));
			fireEvent.click(screen.getByRole('button', { name: /back/i }));
			expect(screen.getByText('Overwrite the existing file')).toBeInTheDocument();
		});

		it('disables Save when the name is empty', () => {
			renderModal();
			fireEvent.click(screen.getByText('Save to a new file'));
			const input = screen.getByDisplayValue('icon-wand-edited.png');
			fireEvent.change(input, { target: { value: '   ' } });
			expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
		});
	});
});
