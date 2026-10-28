import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoiceSetupRecovery } from '../../../../renderer/components/ACappella/VoiceSetupRecovery';
import {
	PARAKEET_TDT_V2_ID,
	WHISPER_BASE_EN_ID,
	getLocalModel,
} from '../../../../shared/local-models/model-catalog';
import { mockTheme } from '../../../helpers/mockTheme';

const speech = getLocalModel(PARAKEET_TDT_V2_ID)!;
const extra = getLocalModel(WHISPER_BASE_EN_ID)!;
const models = () => window.maestro.localModels;
let modelInstalled = false;
let runtimeInstalled = false;
const onReady = vi.fn().mockResolvedValue(undefined);

describe('VoiceSetupRecovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		modelInstalled = false;
		runtimeInstalled = false;
		vi.mocked(models().list).mockImplementation(async () =>
			[speech, extra].map((entry) => ({
				entry,
				installPaths: [],
				status: {
					id: entry.id,
					status: modelInstalled && entry.id === speech.id ? 'installed' : 'not-installed',
					bytesOnDisk: 0,
					manifest: null,
					detail: '',
				},
			}))
		);
		vi.mocked(models().footprint).mockResolvedValue({ bytes: 0, models: [] });
		vi.mocked(models().runtimes.list).mockImplementation(async () => [
			{
				id: 'onnx',
				label: 'ONNX Runtime',
				models: [speech.id, extra.id],
				installed: runtimeInstalled,
				stale: false,
				downloadable: true,
				bytes: 1_000,
			},
		]);
		vi.mocked(models().runtimes.install).mockImplementation(async () => {
			runtimeInstalled = true;
			return true;
		});
		vi.mocked(models().download).mockImplementation(async (modelId) => {
			modelInstalled = true;
			return { modelId, status: 'complete', runtime: { runtimeId: 'onnx', status: 'ready' } };
		});
		vi.mocked(window.maestro.voice.models.readiness).mockImplementation(async () => ({
			canStartSession: runtimeInstalled && modelInstalled,
			canRunHandsFree: false,
			slots: [],
			blocking:
				runtimeInstalled && modelInstalled
					? []
					: [
							{
								slot: 'stt',
								providerId: 'parakeet-local',
								satisfied: false,
								reason: runtimeInstalled ? 'model-not-installed' : 'runtime-unavailable',
								requiredModelId: speech.id,
								detail: 'Speech setup is missing.',
								suggestedAction: 'Set up voice.',
							},
						],
		}));
	});

	it('offers setup without starting any transfers on mount', async () => {
		render(<VoiceSetupRecovery theme={mockTheme} fallback="Original refusal" onReady={onReady} />);

		expect(await screen.findByRole('button', { name: /Set up voice/ })).toBeEnabled();
		expect(screen.queryByText('Original refusal')).not.toBeInTheDocument();
		expect(models().download).not.toHaveBeenCalled();
		expect(models().runtimes.install).not.toHaveBeenCalled();
	});

	it('installs the required engine and selected model, then retries voice', async () => {
		render(<VoiceSetupRecovery theme={mockTheme} fallback="Original refusal" onReady={onReady} />);
		fireEvent.click(await screen.findByRole('button', { name: /Set up voice/ }));

		await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
		expect(models().runtimes.install).toHaveBeenCalledExactlyOnceWith('onnx');
		expect(models().download).toHaveBeenCalledExactlyOnceWith(speech.id);
		expect(vi.mocked(models().runtimes.install).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(models().download).mock.invocationCallOrder[0]
		);
	});

	it('shows byte progress here and skips weights already installed', async () => {
		modelInstalled = true;
		let finish!: (installed: boolean) => void;
		vi.mocked(models().runtimes.install).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		render(<VoiceSetupRecovery theme={mockTheme} fallback="Original refusal" onReady={onReady} />);
		fireEvent.click(await screen.findByRole('button', { name: /Set up voice/ }));
		const progress = vi.mocked(models().runtimes.onProgress).mock.calls.at(-1)![0];

		act(() => progress({ runtimeId: 'onnx', phase: 'downloading', bytes: 500, totalBytes: 1_000 }));
		await waitFor(() =>
			expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
		);
		expect(screen.getByRole('button', { name: 'Setting up voice...' })).toBeDisabled();
		await act(async () => {
			runtimeInstalled = true;
			finish(true);
		});
		await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
		expect(models().download).not.toHaveBeenCalled();
	});

	it('keeps an install failure visible and allows a retry without starting voice', async () => {
		vi.mocked(models().runtimes.install).mockRejectedValueOnce(new Error('Download failed.'));
		render(<VoiceSetupRecovery theme={mockTheme} fallback="Original refusal" onReady={onReady} />);
		fireEvent.click(await screen.findByRole('button', { name: /Set up voice/ }));

		expect(await screen.findByRole('alert')).toHaveTextContent('Download failed.');
		expect(screen.getByRole('button', { name: /Set up voice/ })).toBeEnabled();
		expect(models().download).not.toHaveBeenCalled();
		expect(onReady).not.toHaveBeenCalled();
	});

	it('keeps the original refusal for an installed runtime that cannot load', async () => {
		runtimeInstalled = true;
		vi.mocked(window.maestro.voice.models.readiness).mockResolvedValue({
			canStartSession: false,
			canRunHandsFree: false,
			slots: [],
			blocking: [
				{
					slot: 'stt',
					providerId: 'parakeet-local',
					satisfied: false,
					reason: 'runtime-unavailable',
					requiredModelId: speech.id,
				},
			],
		});
		render(<VoiceSetupRecovery theme={mockTheme} fallback="Original refusal" onReady={onReady} />);
		await waitFor(() => expect(models().runtimes.list).toHaveBeenCalled());

		expect(screen.getByText('Original refusal')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Set up voice/ })).not.toBeInTheDocument();
	});

	it('does not restart voice or begin another transfer after the HUD closes', async () => {
		let finish!: (installed: boolean) => void;
		vi.mocked(models().runtimes.install).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const { unmount } = render(
			<VoiceSetupRecovery theme={mockTheme} fallback="Original refusal" onReady={onReady} />
		);
		fireEvent.click(await screen.findByRole('button', { name: /Set up voice/ }));
		unmount();
		await act(async () => finish(true));

		expect(onReady).not.toHaveBeenCalled();
		expect(models().download).not.toHaveBeenCalled();
	});
});
