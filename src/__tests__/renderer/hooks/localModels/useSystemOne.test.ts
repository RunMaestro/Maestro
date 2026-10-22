/**
 * Tests for useSystemOne: mounting reads the report and asks the engine
 * nothing, a change stores the report main answers with, a change announced by
 * main (the CLI) is read again, and a key handed to `setKey` is never kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useSystemOne } from '../../../../renderer/hooks/localModels';
import type {
	SystemOneReport,
	SystemOneTestResult,
} from '../../../../shared/local-models/system-one-settings';

const api = () =>
	window.maestro.localModels.systemOne as unknown as Record<string, ReturnType<typeof vi.fn>>;

function report(engine: SystemOneReport['settings']['engine'], timeoutMs = 1500): SystemOneReport {
	return {
		settings: {
			engine,
			openJevUrl: null,
			timeoutMs,
			models: {},
			failPolicies: {},
			keepInputs: false,
		},
		engineLabel: engine,
		disclosure: '',
		baseUrl: null,
		model: null,
		modelLabel: null,
		timeoutMs: engine === 'off' ? null : timeoutMs,
		calibrated: null,
		keys: { 'jev-cloud': { source: 'none' }, openjev: { source: 'none' } },
		problem: null,
		failPolicies: [],
	};
}

const TEST_OK: SystemOneTestResult = {
	ok: true,
	engine: 'jev-cloud',
	engineLabel: 'Jev (TypeSafe cloud)',
	model: 'jev-1.13.0',
	probability: 0.97,
	latencyMs: 212,
	calibrated: true,
	usage: { inputTokens: 41, outputTokens: 1 },
	costUsd: 0,
};

describe('useSystemOne', () => {
	let announce: (() => void) | null;

	beforeEach(() => {
		vi.clearAllMocks();
		announce = null;
		api().report.mockResolvedValue(report('off'));
		api().onChanged.mockImplementation((handler: () => void) => {
			announce = handler;
			return () => {
				announce = null;
			};
		});
	});

	it('reads the report on mount and asks the engine nothing', async () => {
		const { result } = renderHook(() => useSystemOne());
		expect(result.current.report).toBeNull();
		await waitFor(() => expect(result.current.report?.settings.engine).toBe('off'));
		expect(api().test).not.toHaveBeenCalled();
		expect(api().set).not.toHaveBeenCalled();
	});

	it('stores the report a change answers with', async () => {
		api().set.mockResolvedValue(report('jev-cloud'));
		const { result } = renderHook(() => useSystemOne());
		await waitFor(() => expect(result.current.report).not.toBeNull());

		let stored = false;
		await act(async () => {
			stored = await result.current.set({ engine: 'jev-cloud' });
		});
		expect(stored).toBe(true);
		expect(api().set).toHaveBeenCalledWith({ engine: 'jev-cloud' });
		expect(result.current.report?.settings.engine).toBe('jev-cloud');
		expect(result.current.busy).toBeNull();
	});

	it('reports a refused change, and leaves the report as it was', async () => {
		api().set.mockRejectedValue(new Error('"gpt" is not an engine.'));
		const { result } = renderHook(() => useSystemOne());
		await waitFor(() => expect(result.current.report).not.toBeNull());

		let stored = true;
		await act(async () => {
			stored = await result.current.set({ engine: 'gpt' as never });
		});
		expect(stored).toBe(false);
		expect(result.current.error).toContain('is not an engine');
		expect(result.current.report?.settings.engine).toBe('off');
	});

	it('reads again when main says something changed, as after a CLI change', async () => {
		const { result } = renderHook(() => useSystemOne());
		await waitFor(() => expect(result.current.report).not.toBeNull());

		api().report.mockResolvedValue(report('openjev'));
		act(() => announce?.());
		await waitFor(() => expect(result.current.report?.settings.engine).toBe('openjev'));
	});

	it('hands a key to main and keeps none of it', async () => {
		const key = 'sk-hook-test-0123456789abcdef';
		api().setKey.mockResolvedValue(report('jev-cloud'));
		api().clearKey.mockResolvedValue(report('jev-cloud'));
		const { result } = renderHook(() => useSystemOne());
		await waitFor(() => expect(result.current.report).not.toBeNull());

		await act(async () => {
			await result.current.setKey('jev-cloud', key);
		});
		expect(api().setKey).toHaveBeenCalledWith({ engine: 'jev-cloud', key });
		expect(JSON.stringify(result.current)).not.toContain(key);

		await act(async () => {
			await result.current.clearKey('jev-cloud');
		});
		expect(api().clearKey).toHaveBeenCalledWith({ engine: 'jev-cloud' });
	});

	it('keeps the last Test until the engine changes, and across a fail policy or Keep inputs change', async () => {
		api().test.mockResolvedValue(TEST_OK);
		api().set.mockResolvedValue(report('jev-cloud'));
		const { result } = renderHook(() => useSystemOne());
		await waitFor(() => expect(result.current.report).not.toBeNull());

		await act(async () => {
			await result.current.runTest();
		});
		expect(result.current.test).toEqual(TEST_OK);

		await act(async () => {
			await result.current.set({ failPolicy: { taskId: 'cue-gate', policy: 'closed' } });
		});
		expect(result.current.test).toEqual(TEST_OK);

		// What the ledger keeps is not part of the engine the Test asked either.
		await act(async () => {
			await result.current.set({ keepInputs: true });
		});
		expect(result.current.test).toEqual(TEST_OK);

		// Nor is who may ask, or how much they may spend.
		await act(async () => {
			await result.current.set({ agents: { enabled: false, dailyBudgetUsd: 2 } });
		});
		expect(result.current.test).toEqual(TEST_OK);

		await act(async () => {
			await result.current.set({ timeoutMs: 900 });
		});
		expect(result.current.test).toBeNull();
	});

	it('reports a Test that could not be run at all', async () => {
		api().test.mockRejectedValue(new Error('bridge closed'));
		const { result } = renderHook(() => useSystemOne());
		await waitFor(() => expect(result.current.report).not.toBeNull());
		await act(async () => {
			await result.current.runTest();
		});
		expect(result.current.error).toContain('bridge closed');
		expect(result.current.test).toBeNull();
	});
});
