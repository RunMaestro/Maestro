/**
 * @file VoiceSetupModal.test.tsx
 *
 * The first-run walkthrough, and the one property everything else rests on:
 * **it asks, it does not act.** Mounting it opens no socket and starts no
 * transfer, so the whole bill of materials - every model, the engine that reads
 * them, and the total - is on screen before the user consents to any of it.
 *
 * The other half is the failure it was written to end. Voice used to enable
 * into a state where the HUD listened, the level meter moved, and nothing was
 * ever transcribed, because the models had never been downloaded and the
 * pipeline resolved to a mock. So these tests pin the two things that make the
 * new state honest: a bundle missing its ENGINE is not "ready" no matter how
 * many weights are on disk, and one Download press fetches both, engine first.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import {
	FIRST_RUN_MODEL_SET,
	VoiceSetupModal,
} from '../../../../../renderer/components/Settings/ACappella/VoiceSetupModal';
import { getModelSetEntries } from '../../../../../shared/acappella/model-catalog';
import { formatSize } from '../../../../../shared/formatters';
import { mockTheme } from '../../../../helpers/mockTheme';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';

const voiceModels = () => window.maestro.voice.models;
const voiceRuntimes = () => window.maestro.voice.runtimes;

/** The bundle a first run offers, which is what the modal lists. */
const BUNDLE = getModelSetEntries(FIRST_RUN_MODEL_SET);

function listings(status: 'installed' | 'not-installed') {
	return BUNDLE.map((entry) => ({
		entry,
		status: {
			id: entry.id,
			status,
			manifest: null,
			detail: status === 'installed' ? 'Installed' : 'Not installed',
			bytesOnDisk: status === 'installed' ? entry.bytes : 0,
		},
		installPaths: entry.files.map((file) => `/tmp/models/acappella/${entry.id}/${file.path}`),
	}));
}

/**
 * ONNX Runtime, which is what every slot in the first-run bundle actually needs
 * now that speech-to-text moved off whisper.cpp.
 */
function onnxRuntime(overrides: Record<string, unknown> = {}) {
	return {
		id: 'onnx',
		label: 'ONNX Runtime (Speech-to-Text, Text-to-Speech, and wake word)',
		slots: ['stt', 'tts', 'wake-word'],
		installed: false,
		stale: false,
		downloadable: true,
		bytes: 101_000_000,
		...overrides,
	};
}

describe('VoiceSetupModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(voiceModels().list).mockResolvedValue(listings('not-installed'));
		vi.mocked(voiceModels().footprint).mockResolvedValue({ bytes: 0, models: [] });
		vi.mocked(voiceModels().readiness).mockResolvedValue({
			canStartSession: false,
			canRunHandsFree: false,
			slots: [],
			blocking: [],
		});
		vi.mocked(voiceRuntimes().list).mockResolvedValue([onnxRuntime()]);
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
	});

	it('downloads nothing when it is merely opened', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		render(
			<LayerStackProvider>
				<VoiceSetupModal theme={mockTheme} enabled onClose={vi.fn()} />
			</LayerStackProvider>
		);

		await waitFor(() => expect(voiceModels().list).toHaveBeenCalled());
		await waitFor(() => expect(voiceRuntimes().list).toHaveBeenCalled());

		// Reading the catalog and the disk is the whole job. Nothing opens a
		// connection until the user presses the button.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(voiceModels().download).not.toHaveBeenCalled();
		expect(voiceRuntimes().install).not.toHaveBeenCalled();
	});

	it('lists the engine alongside the models, so the total matches the rows', async () => {
		render(
			<LayerStackProvider>
				<VoiceSetupModal theme={mockTheme} enabled onClose={vi.fn()} />
			</LayerStackProvider>
		);

		// The engine is a real download the user is about to make. A bill of
		// materials that omits it would put a number on the button larger than the
		// sum of everything shown above it.
		await waitFor(() => expect(screen.getByTestId('voice-setup-runtime-onnx')).toBeInTheDocument());

		const modelBytes = BUNDLE.reduce((total, entry) => total + entry.bytes, 0);
		const button = screen.getByTestId('voice-setup-modal-download');
		// Rendered with `formatSize`, so assert on the same formatter rather than a
		// hand-typed string: both halves are counted, not just the models.
		expect(button.textContent).toContain(formatSize(modelBytes + 101_000_000));
	});

	it('fetches the engine BEFORE the models when Download is pressed', async () => {
		const order: string[] = [];
		vi.mocked(voiceRuntimes().install).mockImplementation(async () => {
			order.push('runtime');
			return true;
		});
		vi.mocked(voiceModels().downloadMany ?? voiceModels().download).mockImplementation(async () => {
			order.push('models');
			return { modelId: '', status: 'complete' as const };
		});

		render(
			<LayerStackProvider>
				<VoiceSetupModal theme={mockTheme} enabled onClose={vi.fn()} />
			</LayerStackProvider>
		);
		await waitFor(() => expect(screen.getByTestId('voice-setup-modal-download')).toBeEnabled());

		fireEvent.click(screen.getByTestId('voice-setup-modal-download'));

		await waitFor(() => expect(voiceRuntimes().install).toHaveBeenCalledWith('onnx'));
		// The engine leads because it is the smaller half: the long wait then
		// happens with everything else already in place, rather than ending in a
		// gigabyte of weights that nothing can read.
		expect(order[0]).toBe('runtime');
	});

	it('is NOT ready when every model is installed but the engine is missing', async () => {
		vi.mocked(voiceModels().list).mockResolvedValue(listings('installed'));
		vi.mocked(voiceRuntimes().list).mockResolvedValue([onnxRuntime({ installed: false })]);

		render(
			<LayerStackProvider>
				<VoiceSetupModal theme={mockTheme} enabled onClose={vi.fn()} />
			</LayerStackProvider>
		);

		await waitFor(() => expect(screen.getByTestId('voice-setup-runtime-onnx')).toBeInTheDocument());
		// This is the exact shape of the old silent failure: everything looks
		// present, and the first spoken word would be refused. Telling the user
		// "Voice is ready" here is the lie the walkthrough exists to prevent.
		expect(screen.queryByText(/Voice is ready/i)).not.toBeInTheDocument();
		expect(screen.getByTestId('voice-setup-modal-dismiss')).toHaveTextContent('Later');
	});

	it('reports ready and offers Done once the models and the engine are both installed', async () => {
		vi.mocked(voiceModels().list).mockResolvedValue(listings('installed'));
		vi.mocked(voiceRuntimes().list).mockResolvedValue([onnxRuntime({ installed: true })]);

		render(
			<LayerStackProvider>
				<VoiceSetupModal theme={mockTheme} enabled onClose={vi.fn()} />
			</LayerStackProvider>
		);

		await waitFor(() => expect(screen.getByText(/Voice is ready/i)).toBeInTheDocument());
		expect(screen.getByTestId('voice-setup-modal-download')).toBeDisabled();
		expect(screen.getByTestId('voice-setup-modal-dismiss')).toHaveTextContent('Done');
	});

	it('treats Later as a real answer and just closes', async () => {
		const onClose = vi.fn();
		render(
			<LayerStackProvider>
				<VoiceSetupModal theme={mockTheme} enabled onClose={onClose} />
			</LayerStackProvider>
		);

		await waitFor(() => expect(voiceModels().list).toHaveBeenCalled());
		fireEvent.click(screen.getByTestId('voice-setup-modal-dismiss'));

		// Dismissing leaves voice enabled and unconfigured, which is legitimate:
		// the capability gate refuses by name and points back here.
		expect(onClose).toHaveBeenCalled();
		expect(voiceModels().download).not.toHaveBeenCalled();
		expect(voiceRuntimes().install).not.toHaveBeenCalled();
	});

	it('offers a runtime that has no build for this platform', async () => {
		vi.mocked(voiceRuntimes().list).mockResolvedValue([
			onnxRuntime({ downloadable: false, bytes: 0 }),
		]);

		render(
			<LayerStackProvider>
				<VoiceSetupModal theme={mockTheme} enabled onClose={vi.fn()} />
			</LayerStackProvider>
		);
		await waitFor(() => expect(voiceRuntimes().list).toHaveBeenCalled());

		// Offering a download that cannot exist is worse than saying nothing, so
		// the row is absent rather than present-and-broken.
		expect(screen.queryByTestId('voice-setup-runtime-onnx')).not.toBeInTheDocument();
	});
});
