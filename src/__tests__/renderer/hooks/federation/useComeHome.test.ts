/**
 * Tests for useComeHome: the window starts the come-home job once, after the agents load, only in
 * the lifecycle owner, and hands the report on.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	COME_HOME_START_DELAY_MS,
	useComeHome,
} from '../../../../renderer/hooks/federation/useComeHome';

const maestro = window.maestro as unknown as Record<string, unknown>;
const report = { startedAt: 1, finishedAt: 2, agents: [] };

describe('useComeHome', () => {
	let saved: unknown;
	let comeHome: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		saved = maestro.federation;
		comeHome = vi.fn(async () => report);
		maestro.federation = { comeHome };
	});

	afterEach(() => {
		maestro.federation = saved;
		vi.useRealTimers();
	});

	it('waits for the agents to load, then starts the job once and hands on the report', async () => {
		const onReport = vi.fn();
		const { rerender } = renderHook((props) => useComeHome(props), {
			initialProps: { enabled: true, sessionsLoaded: false, onReport },
		});
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).not.toHaveBeenCalled();

		rerender({ enabled: true, sessionsLoaded: true, onReport });
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
		expect(comeHome).toHaveBeenCalledTimes(1);
		expect(onReport).toHaveBeenCalledWith(report);

		rerender({ enabled: true, sessionsLoaded: true, onReport: vi.fn() });
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).toHaveBeenCalledTimes(1);
	});

	it('does nothing outside the lifecycle owner', async () => {
		renderHook(() => useComeHome({ enabled: false, sessionsLoaded: true }));
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).not.toHaveBeenCalled();
	});

	it('does nothing where there is no federation API (the browser build)', async () => {
		maestro.federation = undefined;
		renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true }));
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).not.toHaveBeenCalled();
	});
});
