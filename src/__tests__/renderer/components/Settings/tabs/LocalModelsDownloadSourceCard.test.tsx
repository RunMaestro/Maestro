/**
 * Tests for LocalModelsDownloadSourceCard - where model files are downloaded from.
 *
 * Verifies the field starts on the saved base, that Save is offered only for a
 * valid change and stores the canonical spelling, that a bad value is named and
 * cannot be saved, and that the reset button puts Hugging Face back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import { LocalModelsDownloadSourceCard } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsDownloadSourceCard';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#3b2a5c',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

const input = () =>
	screen
		.getByTestId('local-models-download-source-input')
		.querySelector('input') as HTMLInputElement;
const save = () => screen.getByTestId('local-models-download-source-save') as HTMLButtonElement;
const reset = () => screen.getByTestId('local-models-download-source-reset') as HTMLButtonElement;

describe('LocalModelsDownloadSourceCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({ localModelsDownloadBase: 'https://huggingface.co' });
	});

	it('starts on the saved base, with nothing to save or reset', () => {
		render(<LocalModelsDownloadSourceCard theme={theme} />);

		expect(input().value).toBe('https://huggingface.co');
		expect(save().disabled).toBe(true);
		expect(reset().disabled).toBe(true);
		expect(screen.getByText('Downloading from Hugging Face.')).toBeTruthy();
	});

	it('saves a mirror in its canonical spelling and says where it downloads from', () => {
		render(<LocalModelsDownloadSourceCard theme={theme} />);

		fireEvent.change(input(), { target: { value: ' https://hf-mirror.com/ ' } });
		expect(save().disabled).toBe(false);
		fireEvent.click(save());

		expect(useSettingsStore.getState().localModelsDownloadBase).toBe('https://hf-mirror.com');
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'localModelsDownloadBase',
			'https://hf-mirror.com'
		);
		expect(input().value).toBe('https://hf-mirror.com');
		expect(screen.getByText('Downloading from hf-mirror.com.')).toBeTruthy();
	});

	it('names a value it cannot use and refuses to save it', () => {
		render(<LocalModelsDownloadSourceCard theme={theme} />);

		fireEvent.change(input(), { target: { value: 'ftp://mirror.example' } });

		expect(screen.getByText(/Only http and https URLs are supported/)).toBeTruthy();
		expect(save().disabled).toBe(true);
		fireEvent.click(save());
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('puts Hugging Face back from a mirror', () => {
		useSettingsStore.setState({ localModelsDownloadBase: 'https://hf-mirror.com' });
		render(<LocalModelsDownloadSourceCard theme={theme} />);
		expect(reset().disabled).toBe(false);

		fireEvent.click(reset());

		expect(useSettingsStore.getState().localModelsDownloadBase).toBe('https://huggingface.co');
		expect(input().value).toBe('https://huggingface.co');
	});

	it('follows a change made from outside, such as the CLI', () => {
		render(<LocalModelsDownloadSourceCard theme={theme} />);

		useSettingsStore.setState({ localModelsDownloadBase: 'https://cli.example' });

		return screen.findByDisplayValue('https://cli.example');
	});
});
