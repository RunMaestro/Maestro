/**
 * @file models-runtimes.test.ts
 * @description Tests for `maestro-cli models runtimes list|install`: both go
 * through the bridge to the service functions the Engines card in Settings ->
 * Local Models calls, list names each engine's state in the card's words, and
 * install refuses an unknown runtime id before opening the bridge.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	modelsRuntimesInstall,
	modelsRuntimesList,
	runtimeStateLabel,
} from '../../../cli/commands/models-runtimes';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import { QWEN3_1_7B_ID, getLocalModel } from '../../../shared/local-models/model-catalog';
import type { LocalRuntimeListing } from '../../../main/local-models/service';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string; timeout?: number } =
		{};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					captured.payload = payload;
					captured.responseType = rt;
					captured.timeout = timeout;
					return Promise.resolve(reply);
				}),
		} as never)
	);
	return captured;
}

function runtime(overrides: Partial<LocalRuntimeListing> = {}): LocalRuntimeListing {
	return {
		id: 'llama',
		label: 'llama.cpp',
		models: [QWEN3_1_7B_ID],
		installed: false,
		stale: false,
		downloadable: true,
		bytes: 40_000_000,
		...overrides,
	};
}

describe('models runtimes list|install commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('names each state the way the Engines card does', () => {
		expect(runtimeStateLabel(runtime())).toBe('not installed');
		expect(runtimeStateLabel(runtime({ installed: true }))).toBe('installed');
		expect(runtimeStateLabel(runtime({ installed: true, stale: true }))).toBe('needs update');
		expect(runtimeStateLabel(runtime({ downloadable: false, bytes: 0 }))).toBe('unavailable');
	});

	it('lists every engine with its state, size, and the models it runs', async () => {
		const captured = mockSend({
			success: true,
			runtimes: [
				runtime(),
				runtime({ id: 'onnx', label: 'ONNX Runtime', installed: true, models: [] }),
			],
		});

		await modelsRuntimesList({});

		expect(captured.payload).toEqual({ type: 'local_models_runtimes_list' });
		expect(captured.responseType).toBe('local_models_runtimes_list_result');
		const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
		expect(printed).toMatch(/llama\s+llama\.cpp\s+\[not installed, /);
		expect(printed).toContain(getLocalModel(QWEN3_1_7B_ID)!.displayName);
		expect(printed).toMatch(/onnx\s+ONNX Runtime\s+\[installed, /);
	});

	it('prints JSON with the state word for scripts', async () => {
		mockSend({ success: true, runtimes: [runtime({ installed: true, stale: true })] });

		await modelsRuntimesList({ json: true });

		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			success: true,
			runtimes: [{ id: 'llama', state: 'needs update' }],
		});
	});

	it('says when a platform has no build', async () => {
		mockSend({ success: true, runtimes: [runtime({ downloadable: false, bytes: 0 })] });

		await modelsRuntimesList({});

		const printed = logSpy.mock.calls.map(([line]) => String(line)).join('\n');
		expect(printed).toMatch(/\[unavailable\]/);
		expect(printed).toMatch(/No build is published for this platform/);
	});

	it('installs through the bridge with a long wait and reports success', async () => {
		const captured = mockSend({ success: true, runtime: runtime({ installed: true }) });

		await modelsRuntimesInstall('llama', {});

		expect(captured.payload).toEqual({ type: 'local_models_runtime_install', runtimeId: 'llama' });
		expect(captured.responseType).toBe('local_models_runtime_install_result');
		expect(captured.timeout).toBeGreaterThan(5 * 60 * 1000);
		expect(logSpy.mock.calls.at(-1)?.[0]).toMatch(/Installed llama/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('refuses an unknown runtime id without opening the bridge', async () => {
		await expect(modelsRuntimesInstall('cuda', {})).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		expect(errorSpy.mock.calls[0][0]).toMatch(/Unknown runtime "cuda"/);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('reports an install the app refused', async () => {
		mockSend({ success: false, error: 'hash mismatch' });

		await expect(modelsRuntimesInstall('llama', { json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			success: false,
			error: 'hash mismatch',
		});
	});
});
