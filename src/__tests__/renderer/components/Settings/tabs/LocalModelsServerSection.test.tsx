/**
 * Tests for the Model server card in Models > Sources: it shows the state, the
 * engine build with its accelerator, the address, the bind mode and the loaded
 * models from the report, each control calls its action, the key is read only
 * when Copy is pressed, Rotate asks first, and the section reads the report on
 * mount without starting anything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { Theme } from '../../../../../renderer/types';
import {
	LocalModelsServerCard,
	LocalModelsServerSection,
	MODEL_SERVER_KEY_PLACEHOLDER,
	initialBuildChoice,
	modelServerCanStart,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/LocalModelsServerSection';
import type { ModelServerHookState } from '../../../../../renderer/hooks/localModels';
import type { ModelServerReport } from '../../../../../shared/local-models/model-server';

vi.mock('../../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));

import { safeClipboardWrite } from '../../../../../renderer/utils/clipboard';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#a78bfa33',
		accentForeground: '#ffffff',
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

const BUILDS: ModelServerReport['engine']['builds'] = [
	{ choice: 'default', label: 'Vulkan', kind: 'vulkan', downloadBytes: 30_000_000 },
	{ choice: 'cpu', label: 'CPU', kind: 'cpu', downloadBytes: 17_000_000 },
	{ choice: 'cuda', label: 'CUDA 12.4', kind: 'cuda', downloadBytes: 650_000_000 },
];

function report(overrides: Partial<ModelServerReport> = {}): ModelServerReport {
	return {
		status: {
			state: 'running',
			port: 47811,
			bind: 'local',
			host: '127.0.0.1',
			baseUrl: 'http://127.0.0.1:47811',
			maxModels: 1,
			pid: 4242,
			startedAt: Date.now() - 60_000,
			restarts: 0,
			lastError: null,
			models: ['qwen3-1.7b-instruct-q4km'],
			loadedModels: ['qwen3-1.7b-instruct-q4km'],
			keyStorage: 'os',
			logPath: '/data/logs/model-server.log',
		},
		engine: {
			installed: true,
			stale: false,
			release: 'b11559',
			choice: 'default',
			label: 'Vulkan',
			kind: 'vulkan',
			accelerator: {
				checkedAt: 1,
				status: 'gpu',
				label: 'Vulkan (NVIDIA GeForce RTX 4090)',
				devices: [],
				problem: null,
				detail: null,
				offerCpuBuild: true,
			},
			bytes: 80_000_000,
			builds: BUILDS,
		},
		loaded: [
			{ id: 'qwen3-1.7b-instruct-q4km', displayName: 'Qwen3 1.7B', approxBytes: 1_100_000_000 },
		],
		installing: null,
		...overrides,
	};
}

function fakeServer(overrides: Partial<ModelServerHookState> = {}): ModelServerHookState {
	return {
		report: report(),
		progress: null,
		busy: null,
		error: null,
		refresh: vi.fn().mockResolvedValue(undefined),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		setBind: vi.fn().mockResolvedValue(undefined),
		setMaxModels: vi.fn().mockResolvedValue(undefined),
		rotateKey: vi.fn().mockResolvedValue(undefined),
		readKey: vi.fn().mockResolvedValue('sk-maestro-secret'),
		installEngine: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('pure helpers', () => {
	it('offers Start only when the server is stopped or failed', () => {
		expect(modelServerCanStart('stopped')).toBe(true);
		expect(modelServerCanStart('failed')).toBe(true);
		for (const state of ['starting', 'running', 'restarting', 'stopping'] as const) {
			expect(modelServerCanStart(state)).toBe(false);
		}
	});

	it('selects the installed build, else default', () => {
		expect(initialBuildChoice(null)).toBe('default');
		expect(initialBuildChoice(report())).toBe('default');
		expect(initialBuildChoice(report({ engine: { ...report().engine, choice: 'cpu' } }))).toBe(
			'cpu'
		);
	});
});

describe('LocalModelsServerCard', () => {
	it('shows the state, engine, accelerator, address, and loaded model', () => {
		render(<LocalModelsServerCard theme={theme} server={fakeServer()} />);

		expect(screen.getByTestId('model-server-state')).toHaveTextContent('Running');
		expect(screen.getByTestId('model-server-engine')).toHaveTextContent(
			/Vulkan build of llama-server b11559/
		);
		expect(screen.getByTestId('model-server-engine')).toHaveTextContent(
			/Vulkan \(NVIDIA GeForce RTX 4090\)/
		);
		expect(screen.getByTestId('model-server-engine')).toHaveTextContent(
			'separate install from the in-app llama.cpp engine'
		);
		expect(screen.getByTestId('model-server-address')).toHaveTextContent('http://127.0.0.1:47811');
		expect(screen.getByTestId('model-server-loaded')).toHaveTextContent(/Qwen3 1\.7B/);
		expect(screen.getByTestId('model-server-loaded')).toHaveTextContent(/of weights in memory/);
		// The key is never in the DOM, only a placeholder.
		expect(screen.getByTestId('model-server-key')).toHaveTextContent(MODEL_SERVER_KEY_PLACEHOLDER);
		expect(screen.getByTestId('model-server-key')).not.toHaveTextContent('sk-maestro-secret');
	});

	it('shows Stop while running and Start while stopped', () => {
		const server = fakeServer();
		const { rerender } = render(<LocalModelsServerCard theme={theme} server={server} />);
		fireEvent.click(screen.getByTestId('model-server-stop'));
		expect(server.stop).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('model-server-start')).toBeNull();

		const stopped = fakeServer({
			report: report({
				status: { ...report().status, state: 'stopped', pid: null, startedAt: null },
				loaded: [],
			}),
		});
		rerender(<LocalModelsServerCard theme={theme} server={stopped} />);
		fireEvent.click(screen.getByTestId('model-server-start'));
		expect(stopped.start).toHaveBeenCalledTimes(1);
		// Nothing is loaded while it is stopped, so the row is not drawn.
		expect(screen.queryByTestId('model-server-loaded')).toBeNull();
	});

	it('disables Start until the engine is installed, and offers the install', () => {
		const server = fakeServer({
			report: report({
				status: { ...report().status, state: 'stopped', baseUrl: null, port: null },
				engine: {
					...report().engine,
					installed: false,
					release: null,
					choice: null,
					label: null,
					kind: null,
					accelerator: null,
					bytes: 0,
				},
				loaded: [],
			}),
		});
		render(<LocalModelsServerCard theme={theme} server={server} />);

		expect(screen.getByTestId('model-server-start')).toBeDisabled();
		expect(screen.getByTestId('model-server-engine')).toHaveTextContent(/not installed/);
		expect(screen.getByTestId('model-server-engine')).toHaveTextContent(
			'Both use the same downloaded model files'
		);
		expect(screen.getByTestId('model-server-install')).toHaveAccessibleName(
			'Install hosting engine'
		);
		expect(screen.getByTestId('model-server-address')).toHaveTextContent(/chosen the first time/);

		fireEvent.change(screen.getByTestId('model-server-build'), { target: { value: 'cuda' } });
		expect(screen.getByText(/needs a matching driver/)).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('model-server-install'));
		expect(server.installEngine).toHaveBeenCalledWith('cuda');
	});

	it('shows install progress instead of the picker while installing', () => {
		render(
			<LocalModelsServerCard
				theme={theme}
				server={fakeServer({
					progress: { choice: 'cpu', phase: 'downloading', bytes: 5, totalBytes: 10 },
				})}
			/>
		);
		expect(screen.getByTestId('model-server-install-progress')).toHaveTextContent(
			/Downloading the cpu build/
		);
		expect(screen.queryByTestId('model-server-build')).toBeNull();
	});

	it('warns about an accelerator problem and offers the CPU build, without swapping', () => {
		const base = report();
		const server = fakeServer({
			report: report({
				engine: {
					...base.engine,
					accelerator: {
						...base.engine.accelerator!,
						status: 'cpu',
						label: 'CPU',
						problem: 'no-gpu-device',
					},
				},
			}),
		});
		render(<LocalModelsServerCard theme={theme} server={server} />);

		expect(screen.getByTestId('model-server-accelerator-problem')).toHaveTextContent(
			/found no GPU/
		);
		expect(server.installEngine).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId('model-server-install-cpu'));
		expect(server.installEngine).toHaveBeenCalledWith('cpu');
	});

	it('names a missing Vulkan loader (Windows or Linux with no driver) and offers the CPU build', () => {
		const base = report();
		const server = fakeServer({
			report: report({
				engine: {
					...base.engine,
					accelerator: {
						...base.engine.accelerator!,
						status: 'failed',
						label: 'Unavailable',
						problem: 'vulkan-loader-missing',
						detail: 'libvulkan.so.1: cannot open shared object file',
					},
				},
			}),
		});
		render(<LocalModelsServerCard theme={theme} server={server} />);

		const problem = screen.getByTestId('model-server-accelerator-problem');
		expect(problem).toHaveTextContent(/could not start because the Vulkan loader is missing/);
		expect(problem).toHaveTextContent(/Install or update your graphics driver/);
		// Offered, never applied: the installed build stays until the user presses it.
		expect(server.installEngine).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId('model-server-install-cpu'));
		expect(server.installEngine).toHaveBeenCalledWith('cpu');
	});

	it('reports a CUDA build with no driver as running on the CPU, and offers the CPU build', () => {
		const base = report();
		const server = fakeServer({
			report: report({
				engine: {
					...base.engine,
					choice: 'cuda',
					label: 'CUDA 12.4',
					kind: 'cuda',
					accelerator: {
						...base.engine.accelerator!,
						status: 'cpu',
						label: 'CPU',
						problem: 'no-gpu-device',
					},
				},
			}),
		});
		render(<LocalModelsServerCard theme={theme} server={server} />);

		expect(screen.getByTestId('model-server-engine')).toHaveTextContent(
			/CUDA 12\.4 build of llama-server b11559.*Runs on: CPU/
		);
		expect(screen.getByTestId('model-server-accelerator-problem')).toHaveTextContent(
			/found no GPU, so the model server will run on the CPU/
		);
		expect(screen.getByTestId('model-server-install-cpu')).toBeInTheDocument();
	});

	it('says how the key is kept: sealed, obscured where the system has no key store, or not made yet', () => {
		const withKeyStorage = (keyStorage: ModelServerReport['status']['keyStorage']) =>
			fakeServer({ report: report({ status: { ...report().status, keyStorage } }) });

		const { rerender } = render(
			<LocalModelsServerCard theme={theme} server={withKeyStorage('os')} />
		);
		expect(screen.getByTestId('model-server-key')).toHaveTextContent(
			/Stored sealed by the system key store/
		);
		expect(screen.getByTestId('model-server-key')).not.toHaveTextContent(/obscured/);

		// Linux with no keyring: the card must not let "stored" read as "encrypted".
		rerender(<LocalModelsServerCard theme={theme} server={withKeyStorage('obscured')} />);
		expect(screen.getByTestId('model-server-key')).toHaveTextContent(
			/This system has no key store, so the key is stored obscured, not encrypted/
		);
		expect(screen.getByTestId('model-server-key')).not.toHaveTextContent(/Stored sealed/);

		rerender(<LocalModelsServerCard theme={theme} server={withKeyStorage(null)} />);
		expect(screen.getByTestId('model-server-key')).toHaveTextContent(
			/Made the first time you copy it or start the server/
		);
	});

	it('changes the bind mode and warns while on the network', () => {
		const server = fakeServer();
		const { rerender } = render(<LocalModelsServerCard theme={theme} server={server} />);
		expect(screen.getByTestId('model-server-bind')).not.toHaveTextContent(
			/Other machines on your network/
		);

		fireEvent.click(screen.getByRole('button', { name: 'Network' }));
		expect(server.setBind).toHaveBeenCalledWith('network');

		const onNetwork = fakeServer({
			report: report({ status: { ...report().status, bind: 'network', host: '0.0.0.0' } }),
		});
		rerender(<LocalModelsServerCard theme={theme} server={onNetwork} />);
		expect(screen.getByTestId('model-server-bind')).toHaveTextContent(
			/Other machines on your network/
		);
	});

	it('sets the number of models loaded at once', () => {
		const server = fakeServer();
		render(<LocalModelsServerCard theme={theme} server={server} />);
		fireEvent.change(screen.getByTestId('model-server-max-models'), { target: { value: '3' } });
		expect(server.setMaxModels).toHaveBeenCalledWith(3);
	});

	it('reads the key only when Copy is pressed, and copies it', async () => {
		const server = fakeServer();
		render(<LocalModelsServerCard theme={theme} server={server} />);
		expect(server.readKey).not.toHaveBeenCalled();

		fireEvent.click(screen.getByTestId('model-server-copy-key'));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('sk-maestro-secret'));
	});

	it('asks before rotating the key', () => {
		const server = fakeServer();
		render(<LocalModelsServerCard theme={theme} server={server} />);

		fireEvent.click(screen.getByTestId('model-server-rotate'));
		expect(server.rotateKey).not.toHaveBeenCalled();
		expect(screen.getByText(/makes the current key stop working/)).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('model-server-rotate-confirm'));
		expect(server.rotateKey).toHaveBeenCalledTimes(1);
	});

	it('opens the log', () => {
		render(<LocalModelsServerCard theme={theme} server={fakeServer()} />);
		fireEvent.click(screen.getByTestId('model-server-open-log'));
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/data/logs/model-server.log');
	});

	it('shows the last error and an action error', () => {
		render(
			<LocalModelsServerCard
				theme={theme}
				server={fakeServer({
					error: 'Another program is using 127.0.0.1:47811.',
					report: report({
						status: { ...report().status, state: 'failed', lastError: 'It crashed 3 times.' },
					}),
				})}
			/>
		);
		expect(screen.getByTestId('model-server-state')).toHaveTextContent('Failed');
		expect(screen.getByText('It crashed 3 times.')).toBeInTheDocument();
		expect(screen.getByText('Another program is using 127.0.0.1:47811.')).toBeInTheDocument();
	});
});

describe('LocalModelsServerSection', () => {
	it('reads the report on mount and starts nothing', async () => {
		render(<LocalModelsServerSection theme={theme} />);
		await waitFor(() => expect(screen.getByTestId('model-server-state')).toBeInTheDocument());

		const api = window.maestro.localModels.server;
		expect(api.report).toHaveBeenCalled();
		expect(api.start).not.toHaveBeenCalled();
		expect(api.installEngine).not.toHaveBeenCalled();
		expect(api.key).not.toHaveBeenCalled();
		expect(document.querySelector('[data-setting-id="local-models-model-server"]')).not.toBeNull();
	});
});
