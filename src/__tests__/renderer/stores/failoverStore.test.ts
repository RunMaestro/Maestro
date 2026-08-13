/**
 * Tests for failoverStore - Provider Failover runtime, plus the seam where the
 * retry engine hands an outage off to a backup endpoint instead of waiting out
 * the primary's reset window.
 *
 * The main-process overlay write is mocked at `window.maestro.process`; the
 * assertions check that the renderer pushes the right env/model and that the
 * push happens BEFORE the resend spawns (the ordering the whole design rests on).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	switchToNextEndpoint,
	returnToPrimary,
	maybeReturnToPrimary,
	getActiveEndpoint,
	useFailoverStore,
} from '../../../renderer/stores/failoverStore';
import {
	scheduleRetryForError,
	noteDispatch,
	getRetryEntry,
	useRetryStore,
	FAILOVER_HANDOVER_DELAY_MS,
} from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { tokenExhaustionResetAt } from '../../../shared/retryClassification';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AgentError } from '../../../renderer/types';
import type { FailoverConfig } from '../../../shared/providerFailover';

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

const deps: ProcessQueuedItemDeps = {
	conductorProfile: '',
	customAICommands: [],
	speckitCommands: [],
	openspecCommands: [],
} as unknown as ProcessQueuedItemDeps;

let setFailoverOverlay: ReturnType<typeof vi.fn>;
let processQueuedItem: ReturnType<typeof vi.fn>;

const ZAI = {
	id: 'zai',
	label: 'Z.AI',
	env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-token' },
	model: 'glm-4.6',
};
const LOCAL = {
	id: 'local',
	label: 'Local vLLM',
	env: { ANTHROPIC_BASE_URL: 'http://localhost:8000' },
};

function failover(over: Partial<FailoverConfig> = {}): FailoverConfig {
	return { endpoints: [ZAI, LOCAL], enabled: true, ...over };
}

function setupSession(id: string, tabId: string, failoverConfig?: FailoverConfig) {
	const session = createMockSession({
		id,
		aiTabs: [createMockAITab({ id: tabId })],
		activeTabId: tabId,
		customEnvVars: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', KEEP_ME: 'yes' },
		failoverConfig,
	});
	useSessionStore.setState({ sessions: [session] } as any);
}

function quotaError(): AgentError {
	return {
		type: 'rate_limited',
		message: 'Usage limit reached, resets at 1am',
		recoverable: true,
		timestamp: NOW,
		agentId: 'claude-code',
	} as AgentError;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	useFailoverStore.setState({ states: {} });
	useRetryStore.setState({ retries: {}, outages: {} });
	useSessionStore.setState({ sessions: [] } as any);
	setFailoverOverlay = vi.fn().mockResolvedValue(undefined);
	processQueuedItem = vi.fn().mockResolvedValue(undefined);
	useAgentStore.setState({ processQueuedItem } as any);
	(globalThis as any).window = (globalThis as any).window ?? {};
	(window as any).maestro = { process: { setFailoverOverlay } };
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('switchToNextEndpoint', () => {
	it('pins the agent to the first endpoint and pushes its env + model to main', async () => {
		setupSession('s1', 't1', failover());

		const endpoint = await switchToNextEndpoint('s1');

		expect(endpoint?.id).toBe('zai');
		expect(setFailoverOverlay).toHaveBeenCalledWith('s1', ZAI.env, 'glm-4.6');
		expect(getActiveEndpoint('s1')?.label).toBe('Z.AI');
	});

	it('advances to the next endpoint on a second failure and records both as burned', async () => {
		setupSession('s1', 't1', failover());

		await switchToNextEndpoint('s1');
		const second = await switchToNextEndpoint('s1');

		expect(second?.id).toBe('local');
		// No model on this endpoint - main must be told to clear the override, not
		// silently keep the previous endpoint's model.
		expect(setFailoverOverlay).toHaveBeenLastCalledWith('s1', LOCAL.env, undefined);
		expect(useFailoverStore.getState().states.s1.exhausted).toEqual(['zai', 'local']);
	});

	it('returns null once every endpoint is exhausted and leaves the pin alone', async () => {
		setupSession('s1', 't1', failover());
		await switchToNextEndpoint('s1');
		await switchToNextEndpoint('s1');
		setFailoverOverlay.mockClear();

		expect(await switchToNextEndpoint('s1')).toBeNull();
		expect(setFailoverOverlay).not.toHaveBeenCalled();
		expect(getActiveEndpoint('s1')?.id).toBe('local');
	});

	it('does nothing when failover is configured but not armed', async () => {
		setupSession('s1', 't1', failover({ enabled: false }));

		expect(await switchToNextEndpoint('s1')).toBeNull();
		expect(setFailoverOverlay).not.toHaveBeenCalled();
	});

	it('leaves the store untouched when the overlay write to main fails', async () => {
		setupSession('s1', 't1', failover());
		setFailoverOverlay.mockRejectedValueOnce(new Error('ipc down'));

		await expect(switchToNextEndpoint('s1')).rejects.toThrow('ipc down');
		// The pin must reflect what main actually holds, never a phantom endpoint.
		expect(useFailoverStore.getState().states.s1).toBeUndefined();
	});
});

describe('returning to the primary', () => {
	it('clears the overlay and resets the burned list so a later outage starts over', async () => {
		setupSession('s1', 't1', failover());
		await switchToNextEndpoint('s1');

		await returnToPrimary('s1');

		expect(setFailoverOverlay).toHaveBeenLastCalledWith('s1', null, undefined);
		expect(useFailoverStore.getState().states.s1).toBeUndefined();
		expect((await switchToNextEndpoint('s1'))?.id).toBe('zai');
	});

	it('maybeReturnToPrimary is a no-op before the dwell time elapses', async () => {
		setupSession('s1', 't1', failover({ returnToPrimaryMinutes: 30 }));
		await switchToNextEndpoint('s1');
		setFailoverOverlay.mockClear();

		expect(await maybeReturnToPrimary('s1', NOW + 29 * 60 * 1000)).toBe(false);
		expect(setFailoverOverlay).not.toHaveBeenCalled();
		expect(getActiveEndpoint('s1')?.id).toBe('zai');
	});

	it('maybeReturnToPrimary moves the agent back once the dwell time elapses', async () => {
		setupSession('s1', 't1', failover({ returnToPrimaryMinutes: 30 }));
		await switchToNextEndpoint('s1');

		expect(await maybeReturnToPrimary('s1', NOW + 30 * 60 * 1000)).toBe(true);
		expect(setFailoverOverlay).toHaveBeenLastCalledWith('s1', null, undefined);
	});

	it('maybeReturnToPrimary is a no-op for an agent already on its primary', async () => {
		setupSession('s1', 't1', failover());
		expect(await maybeReturnToPrimary('s1', NOW + 10 ** 9)).toBe(false);
		expect(setFailoverOverlay).not.toHaveBeenCalled();
	});
});

describe('retry engine integration', () => {
	function seedSnapshot(id: string, tabId: string) {
		noteDispatch(id, { id: 'item-1', timestamp: 1, tabId, type: 'message', text: 'hi' }, deps);
	}

	it('hands a quota outage to a backup after the short handover instead of waiting for reset', () => {
		setupSession('s1', 't1', failover());
		seedSnapshot('s1', 't1');

		expect(scheduleRetryForError('s1', 't1', quotaError())).toBe(true);

		const entry = getRetryEntry('s1', 't1');
		expect(entry?.failingOver).toBe(true);
		expect(entry?.nextRetryAt).toBe(NOW + FAILOVER_HANDOVER_DELAY_MS);
		// Without failover this same error would park the agent for the full quota
		// wait, which is the behavior the feature exists to avoid.
		expect(tokenExhaustionResetAt(quotaError(), NOW)).toBeGreaterThan(entry!.nextRetryAt);
	});

	it('swaps the endpoint into main BEFORE the resend spawns', async () => {
		setupSession('s1', 't1', failover());
		seedSnapshot('s1', 't1');
		scheduleRetryForError('s1', 't1', quotaError());

		await vi.advanceTimersByTimeAsync(FAILOVER_HANDOVER_DELAY_MS);

		expect(setFailoverOverlay).toHaveBeenCalledWith('s1', ZAI.env, 'glm-4.6');
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(setFailoverOverlay.mock.invocationCallOrder[0]).toBeLessThan(
			processQueuedItem.mock.invocationCallOrder[0]
		);
	});

	it('still resends on the current endpoint when the overlay write fails', async () => {
		setupSession('s1', 't1', failover());
		seedSnapshot('s1', 't1');
		setFailoverOverlay.mockRejectedValue(new Error('ipc down'));
		scheduleRetryForError('s1', 't1', quotaError());

		await vi.advanceTimersByTimeAsync(FAILOVER_HANDOVER_DELAY_MS);

		// A failed swap must degrade to a plain retry, never swallow the turn.
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	it('falls back to the normal quota wait once endpoints are exhausted', async () => {
		setupSession('s1', 't1', failover());
		seedSnapshot('s1', 't1');
		await switchToNextEndpoint('s1');
		await switchToNextEndpoint('s1');

		scheduleRetryForError('s1', 't1', quotaError());

		const entry = getRetryEntry('s1', 't1');
		expect(entry?.failingOver).toBe(false);
		expect(entry?.nextRetryAt).toBe(tokenExhaustionResetAt(quotaError(), NOW));
	});

	it('leaves agents without a failover config on the plain retry path', () => {
		setupSession('s1', 't1', undefined);
		seedSnapshot('s1', 't1');

		expect(scheduleRetryForError('s1', 't1', quotaError())).toBe(true);
		expect(getRetryEntry('s1', 't1')?.failingOver).toBe(false);
		expect(setFailoverOverlay).not.toHaveBeenCalled();
	});
});
