import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	__resetCodexAutoResetForTests,
	maybeAutoResetCodexUsage,
} from '../../../renderer/services/codexAutoReset';
import { useCodexResetCreditsStore } from '../../../renderer/stores/codexResetCreditsStore';
import type { AgentError, Session } from '../../../renderer/types';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

vi.mock('../../../renderer/utils/homeDir', () => ({
	getHomeDir: () => '/home/tester',
	getHomeDirAsync: () => Promise.resolve('/home/tester'),
}));

const CODEX_HOME_KEY = '/home/tester/.codex';

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: 'agent-1',
		name: 'Codex Agent',
		toolType: 'codex',
		codexAutoResetOnExhaustion: true,
		...overrides,
	} as Session;
}

function limitError(overrides: Partial<AgentError> = {}): AgentError {
	return {
		type: 'rate_limited',
		message: "You've hit your usage limit",
		recoverable: true,
		agentId: 'codex',
		sessionId: 'agent-1',
		timestamp: 1_700_000_000_000,
		...overrides,
	} as AgentError;
}

/** Seed the store as though a detail read had just landed. */
function seedCredits(counts: { available: number; applicable?: number }) {
	useCodexResetCreditsStore.setState({
		entries: {
			[CODEX_HOME_KEY]: {
				credits:
					counts.available > 0
						? [{ id: 'credit-1', supportedByPlan: true, status: 'available' as const }]
						: [],
				counts,
			},
		},
	});
}

describe('maybeAutoResetCodexUsage', () => {
	let loadMock: ReturnType<typeof vi.fn>;
	let redeemMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		__resetCodexAutoResetForTests();
		useCodexResetCreditsStore.getState().__resetForTests();
		loadMock = vi.fn().mockResolvedValue(undefined);
		redeemMock = vi.fn().mockResolvedValue({ ok: true, windowsReset: 2, attempted: true });
		useCodexResetCreditsStore.setState({ load: loadMock, redeem: redeemMock });
		(globalThis as { window?: unknown }).window = {
			maestro: { agents: { getCustomEnvVars: vi.fn().mockResolvedValue(null) } },
		};
	});

	it('spends a credit when the account confirms the reset would take effect', async () => {
		loadMock.mockImplementation(async () => seedCredits({ available: 2, applicable: 2 }));

		await expect(maybeAutoResetCodexUsage(session(), limitError())).resolves.toBe(true);
		expect(redeemMock).toHaveBeenCalledWith(CODEX_HOME_KEY);
	});

	it('does nothing for a provider with no reset credits', async () => {
		await expect(
			maybeAutoResetCodexUsage(session({ toolType: 'claude-code' }), limitError())
		).resolves.toBe(false);
		expect(loadMock).not.toHaveBeenCalled();
	});

	// The default is off, and an agent that never asked must never reach the spend.
	it('does nothing when the agent has not opted in', async () => {
		await expect(
			maybeAutoResetCodexUsage(session({ codexAutoResetOnExhaustion: undefined }), limitError())
		).resolves.toBe(false);
		expect(loadMock).not.toHaveBeenCalled();
	});

	it('does nothing for a failure that is not a quota limit', async () => {
		const crash = limitError({ type: 'unknown', message: 'segfault' });

		await expect(maybeAutoResetCodexUsage(session(), crash)).resolves.toBe(false);
		expect(loadMock).not.toHaveBeenCalled();
	});

	// The credits read here belong to THIS machine's account, not the remote's,
	// so a spend would land on the wrong account entirely.
	it('refuses an SSH-backed agent', async () => {
		const ssh = session({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
		} as Partial<Session>);

		await expect(maybeAutoResetCodexUsage(ssh, limitError())).resolves.toBe(false);
		expect(loadMock).not.toHaveBeenCalled();
	});

	// Owning credits is not enough: spending one while nothing is consumed burns
	// it for nothing.
	it('refuses when no credit would take effect', async () => {
		loadMock.mockImplementation(async () => seedCredits({ available: 2, applicable: 0 }));

		await expect(maybeAutoResetCodexUsage(session(), limitError())).resolves.toBe(false);
		expect(redeemMock).not.toHaveBeenCalled();
	});

	// A stale or partial sample is not consent.
	it('refuses when it cannot tell whether a reset would help', async () => {
		loadMock.mockImplementation(async () => seedCredits({ available: 2 }));

		await expect(maybeAutoResetCodexUsage(session(), limitError())).resolves.toBe(false);
		expect(redeemMock).not.toHaveBeenCalled();
	});

	it('refuses when the account holds nothing', async () => {
		loadMock.mockImplementation(async () => seedCredits({ available: 0, applicable: 0 }));

		await expect(maybeAutoResetCodexUsage(session(), limitError())).resolves.toBe(false);
		expect(redeemMock).not.toHaveBeenCalled();
	});

	// One wall must not be able to walk the whole balance one error at a time.
	it('spends at most once per outage', async () => {
		loadMock.mockImplementation(async () => seedCredits({ available: 2, applicable: 2 }));
		const outage = limitError();

		await maybeAutoResetCodexUsage(session(), outage);
		await maybeAutoResetCodexUsage(session(), outage);

		expect(redeemMock).toHaveBeenCalledTimes(1);
	});

	it('treats a later outage as a new one', async () => {
		loadMock.mockImplementation(async () => seedCredits({ available: 2, applicable: 2 }));

		await maybeAutoResetCodexUsage(session(), limitError({ timestamp: 1 }));
		await maybeAutoResetCodexUsage(session(), limitError({ timestamp: 2 }));

		expect(redeemMock).toHaveBeenCalledTimes(2);
	});

	// An agent pointed at a non-default CODEX_HOME must reset ITS account, never
	// the default one.
	it('resolves the account from the agent’s own CODEX_HOME', async () => {
		const scoped = '/home/tester/.codex-work';
		loadMock.mockImplementation(async () => {
			useCodexResetCreditsStore.setState({
				entries: {
					[scoped]: {
						credits: [{ id: 'c1', supportedByPlan: true, status: 'available' as const }],
						counts: { available: 1, applicable: 1 },
					},
				},
			});
		});

		await maybeAutoResetCodexUsage(
			session({ customEnvVars: { CODEX_HOME: scoped } } as Partial<Session>),
			limitError()
		);

		expect(redeemMock).toHaveBeenCalledWith(scoped);
	});

	// Env vars REPLACE rather than layer, but an agent with no overrides still
	// runs against the provider-level set - skipping it resets a stranger's quota.
	it('falls back to the provider-level CODEX_HOME', async () => {
		const providerHome = '/home/tester/.codex-team';
		(
			globalThis as unknown as {
				window: { maestro: { agents: { getCustomEnvVars: ReturnType<typeof vi.fn> } } };
			}
		).window.maestro.agents.getCustomEnvVars = vi
			.fn()
			.mockResolvedValue({ CODEX_HOME: providerHome });
		loadMock.mockImplementation(async () => {
			useCodexResetCreditsStore.setState({
				entries: {
					[providerHome]: {
						credits: [{ id: 'c1', supportedByPlan: true, status: 'available' as const }],
						counts: { available: 1, applicable: 1 },
					},
				},
			});
		});

		await maybeAutoResetCodexUsage(session(), limitError());

		expect(redeemMock).toHaveBeenCalledWith(providerHome);
	});
});
