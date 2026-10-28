/**
 * Tests for AddHuggingFaceModelCard - adding a model the catalog does not list.
 *
 * Verifies that mounting sends nothing, that Look up shows the license before
 * anything is saved, that Add saves and reports, that a refusal is shown, and
 * that editing a field drops the answer it no longer describes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import { AddHuggingFaceModelCard } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/AddHuggingFaceModelCard';
import type { HardwareProfile } from '../../../../../shared/local-models/model-fit';
import {
	USER_MODEL_UNVERIFIED_LABEL,
	userLocalModelEntry,
} from '../../../../../shared/local-models/user-models';

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

const REPO = 'unsloth/Qwen3.5-2B-GGUF';
const FILE = 'Qwen3.5-2B-Q4_K_M.gguf';

const ENTRY = userLocalModelEntry({
	id: 'hf-unsloth-qwen3.5-2b-q4_k_m',
	displayName: 'Qwen3.5-2B-Q4_K_M',
	repo: REPO,
	revision: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
	license: { spdx: 'apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.5-2B/blob/main/LICENSE' },
	files: [{ path: FILE, sha256: 'a'.repeat(64), bytes: 1_280_835_840 }],
	parametersB: 1.88,
	contextLength: 262_144,
	addedAt: 0,
});

const MAC_16GB: HardwareProfile = {
	platform: 'darwin',
	arch: 'arm64',
	totalMemoryBytes: 16 * 1024 ** 3,
	unifiedMemory: true,
	gpus: [],
};

const hf = () =>
	(
		window.maestro.localModels as unknown as {
			huggingFace: Record<string, ReturnType<typeof vi.fn>>;
		}
	).huggingFace;

function type(testId: string, value: string) {
	const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement;
	fireEvent.change(input, { target: { value } });
}

function renderCard(onAdded = vi.fn(), hardware: HardwareProfile | null = MAC_16GB) {
	render(<AddHuggingFaceModelCard theme={theme} hardware={hardware} onAdded={onAdded} />);
	return onAdded;
}

describe('AddHuggingFaceModelCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hf().preview.mockResolvedValue({ ok: true, value: { entry: ENTRY, alreadyAdded: false } });
		hf().add.mockResolvedValue({ ok: true, value: { entry: ENTRY, added: true } });
	});

	it('sends nothing on mount, and cannot look up until both fields are filled', () => {
		renderCard();
		expect(hf().preview).not.toHaveBeenCalled();
		expect(screen.getByTestId('local-models-add-hf-lookup')).toBeDisabled();
		type('local-models-add-hf-repo', REPO);
		expect(screen.getByTestId('local-models-add-hf-lookup')).toBeDisabled();
		type('local-models-add-hf-file', FILE);
		expect(screen.getByTestId('local-models-add-hf-lookup')).not.toBeDisabled();
		expect(screen.queryByTestId('local-models-add-hf-add')).not.toBeInTheDocument();
	});

	it('shows the license, size, revision and fit before anything is saved', async () => {
		renderCard();
		type('local-models-add-hf-repo', REPO);
		type('local-models-add-hf-file', FILE);
		fireEvent.click(screen.getByTestId('local-models-add-hf-lookup'));

		const preview = await screen.findByTestId('local-models-add-hf-preview');
		expect(hf().preview).toHaveBeenCalledWith(REPO, FILE);
		expect(hf().add).not.toHaveBeenCalled();
		expect(screen.getByTestId('local-models-add-hf-license')).toHaveTextContent('apache-2.0');
		expect(screen.getByTestId('local-models-add-hf-license')).toHaveAttribute(
			'href',
			ENTRY.license.url
		);
		expect(preview).toHaveTextContent('1.2 GB in 1 file');
		expect(preview).toHaveTextContent(`${REPO}@f6d5376`);
		expect(preview).toHaveTextContent(USER_MODEL_UNVERIFIED_LABEL);
		expect(screen.getByTestId('local-models-add-hf-fit')).toHaveTextContent(/^Fits: Needs /);
	});

	it('adds the model, says where to download it, and asks for a re-read', async () => {
		const onAdded = renderCard();
		type('local-models-add-hf-repo', REPO);
		type('local-models-add-hf-file', FILE);
		fireEvent.click(screen.getByTestId('local-models-add-hf-lookup'));
		fireEvent.click(await screen.findByTestId('local-models-add-hf-add'));

		await waitFor(() => expect(hf().add).toHaveBeenCalledWith(REPO, FILE));
		expect(await screen.findByTestId('local-models-add-hf-notice')).toHaveTextContent(
			'Qwen3.5-2B-Q4_K_M is in the Library. Download it from its row.'
		);
		expect(onAdded).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('local-models-add-hf-preview')).not.toBeInTheDocument();
	});

	it('shows a refusal from the look up, and offers no Add', async () => {
		hf().preview.mockResolvedValue({
			ok: false,
			message: `${REPO} is gated on Hugging Face.`,
		});
		renderCard();
		type('local-models-add-hf-repo', REPO);
		type('local-models-add-hf-file', FILE);
		fireEvent.click(screen.getByTestId('local-models-add-hf-lookup'));
		expect(await screen.findByTestId('local-models-add-hf-error')).toHaveTextContent('gated');
		expect(screen.queryByTestId('local-models-add-hf-add')).not.toBeInTheDocument();
	});

	it('says so when the model is already in the Library, and offers no Add', async () => {
		hf().preview.mockResolvedValue({ ok: true, value: { entry: ENTRY, alreadyAdded: true } });
		renderCard();
		type('local-models-add-hf-repo', REPO);
		type('local-models-add-hf-file', FILE);
		fireEvent.click(screen.getByTestId('local-models-add-hf-lookup'));
		expect(await screen.findByTestId('local-models-add-hf-preview')).toHaveTextContent(
			'already in the Library'
		);
		expect(screen.queryByTestId('local-models-add-hf-add')).not.toBeInTheDocument();
	});

	it('drops the answer when a field is edited, and shows no fit before the hardware is read', async () => {
		renderCard(vi.fn(), null);
		type('local-models-add-hf-repo', REPO);
		type('local-models-add-hf-file', FILE);
		fireEvent.click(screen.getByTestId('local-models-add-hf-lookup'));
		await screen.findByTestId('local-models-add-hf-preview');
		expect(screen.queryByTestId('local-models-add-hf-fit')).not.toBeInTheDocument();

		type('local-models-add-hf-file', 'Other.gguf');
		expect(screen.queryByTestId('local-models-add-hf-preview')).not.toBeInTheDocument();
		expect(screen.queryByTestId('local-models-add-hf-add')).not.toBeInTheDocument();
	});
});
