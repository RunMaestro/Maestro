import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCodexResetCreditsStore } from '../../../renderer/stores/codexResetCreditsStore';
import { useCodexUsageStore } from '../../../renderer/stores/codexUsageStore';
import type { CodexResetCredit } from '../../../shared/codexResetCredits';

/**
 * The store is the only path that spends a reset credit, and a credit is
 * finite, expires, and cannot be refunded. So the behaviours pinned here are
 * the ones whose failure costs the user something real: a second spend landing
 * for one click, a spend aimed at the wrong credit, and a failed read making a
 * stocked account look empty.
 */

const CODEX_HOME = '/home/tester/.codex';

function credit(overrides: Partial<CodexResetCredit> = {}): CodexResetCredit {
	return {
		id: 'credit-1',
		supportedByPlan: true,
		status: 'available',
		...overrides,
	};
}

let getCredits: ReturnType<typeof vi.fn>;
let consumeCredit: ReturnType<typeof vi.fn>;

describe('codexResetCreditsStore', () => {
	beforeEach(() => {
		useCodexResetCreditsStore.getState().__resetForTests();
		getCredits = vi.fn().mockResolvedValue({
			ok: true,
			detail: { credits: [credit()], available: 1, applicable: 1 },
		});
		consumeCredit = vi.fn().mockResolvedValue({ ok: true, windowsReset: 2 });
		(globalThis as { window?: unknown }).window = {
			maestro: {
				agents: {
					getCodexResetCredits: getCredits,
					consumeCodexResetCredit: consumeCredit,
				},
			},
		};
		// The usage bars are re-read after a spend; stub it so the store's
		// invalidation can be asserted without a second IPC surface.
		useCodexUsageStore.setState({ refresh: vi.fn().mockResolvedValue(undefined) });
	});

	describe('load', () => {
		it('stores the credits and both counts from a successful read', async () => {
			await useCodexResetCreditsStore.getState().load(CODEX_HOME);

			const entry = useCodexResetCreditsStore.getState().entries[CODEX_HOME];
			expect(entry?.credits).toHaveLength(1);
			expect(entry?.counts).toEqual({ available: 1, applicable: 1 });
			expect(entry?.error).toBeUndefined();
		});

		it('passes an absent applicable count through as undefined', async () => {
			// Unknown and zero drive different verdicts: coercing here would make
			// every spend on this account report as wasteful.
			getCredits.mockResolvedValue({
				ok: true,
				detail: { credits: [credit()], available: 1 },
			});

			await useCodexResetCreditsStore.getState().load(CODEX_HOME);

			expect(useCodexResetCreditsStore.getState().entries[CODEX_HOME]?.counts).toEqual({
				available: 1,
				applicable: undefined,
			});
		});

		it('keeps the last known credits when a read fails', async () => {
			await useCodexResetCreditsStore.getState().load(CODEX_HOME);
			getCredits.mockResolvedValue({ ok: false, error: 'Codex auth token was rejected.' });

			await useCodexResetCreditsStore.getState().load(CODEX_HOME);

			const entry = useCodexResetCreditsStore.getState().entries[CODEX_HOME];
			// Blanking the list would tell a user holding credits that they have
			// none, which is the one wrong answer that stops them redeeming.
			expect(entry?.credits).toHaveLength(1);
			expect(entry?.error).toBe('Codex auth token was rejected.');
		});

		it('never leaves the account stuck loading when the bridge throws', async () => {
			getCredits.mockRejectedValue(new Error('bridge is gone'));

			await useCodexResetCreditsStore.getState().load(CODEX_HOME);

			expect(useCodexResetCreditsStore.getState().loading[CODEX_HOME]).toBe(false);
		});
	});

	describe('redeem', () => {
		it('spends the soonest-to-expire credit when none is named', async () => {
			useCodexResetCreditsStore.setState({
				entries: {
					[CODEX_HOME]: {
						credits: [
							credit({ id: 'later', expiresAt: '2026-11-01T00:00:00.000Z' }),
							credit({ id: 'soon', expiresAt: '2026-09-20T00:00:00.000Z' }),
						],
						counts: { available: 2, applicable: 2 },
					},
				},
			});

			await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

			expect(consumeCredit).toHaveBeenCalledWith(CODEX_HOME, 'soon', expect.any(String));
		});

		it('redeems the named credit when the caller picks one', async () => {
			useCodexResetCreditsStore.setState({
				entries: {
					[CODEX_HOME]: {
						credits: [credit({ id: 'a' }), credit({ id: 'b' })],
						counts: { available: 2, applicable: 2 },
					},
				},
			});

			await useCodexResetCreditsStore.getState().redeem(CODEX_HOME, 'b');

			expect(consumeCredit).toHaveBeenCalledWith(CODEX_HOME, 'b', expect.any(String));
		});

		it('refuses a second spend while one is in flight', async () => {
			useCodexResetCreditsStore.setState({
				entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
			});
			let release: (value: { ok: boolean; windowsReset: number }) => void = () => {};
			consumeCredit.mockReturnValue(
				new Promise<{ ok: boolean; windowsReset: number }>((resolve) => {
					release = resolve;
				})
			);

			const first = useCodexResetCreditsStore.getState().redeem(CODEX_HOME);
			const second = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

			// The guard is claimed synchronously, so a double click cannot land two
			// spends for one credit.
			expect(second.attempted).toBe(false);
			expect(consumeCredit).toHaveBeenCalledTimes(1);

			release({ ok: true, windowsReset: 1 });
			await first;
			expect(useCodexResetCreditsStore.getState().redeeming[CODEX_HOME]).toBe(false);
		});

		it('leaves a different account free to redeem concurrently', async () => {
			const other = '/home/tester/.codex-work';
			useCodexResetCreditsStore.setState({
				entries: {
					[CODEX_HOME]: { credits: [credit()], counts: { available: 1 } },
					[other]: { credits: [credit({ id: 'credit-2' })], counts: { available: 1 } },
				},
				redeeming: { [CODEX_HOME]: true },
			});

			const result = await useCodexResetCreditsStore.getState().redeem(other);

			expect(result.attempted).toBe(true);
			expect(consumeCredit).toHaveBeenCalledWith(other, 'credit-2', expect.any(String));
		});

		it('reports no attempt when the account holds nothing spendable', async () => {
			useCodexResetCreditsStore.setState({
				entries: {
					[CODEX_HOME]: {
						credits: [credit({ status: 'redeemed' })],
						counts: { available: 0 },
					},
				},
			});

			const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

			expect(result.attempted).toBe(false);
			expect(consumeCredit).not.toHaveBeenCalled();
		});

		it('re-reads the credits and the usage bars after a successful spend', async () => {
			useCodexResetCreditsStore.setState({
				entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
			});

			const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

			expect(result).toMatchObject({ ok: true, windowsReset: 2, attempted: true });
			// Otherwise the panel keeps showing the exhausted windows the user just
			// paid to reopen, which reads as the redemption having failed.
			expect(getCredits).toHaveBeenCalledWith(CODEX_HOME);
			expect(useCodexUsageStore.getState().refresh).toHaveBeenCalled();
		});

		it('still re-reads after a refused spend, so a dead credit leaves the list', async () => {
			useCodexResetCreditsStore.setState({
				entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
			});
			consumeCredit.mockResolvedValue({
				ok: false,
				windowsReset: 0,
				code: 'no_credit',
				message: 'That reset credit is no longer available.',
			});

			const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

			expect(result).toMatchObject({ ok: false, attempted: true, code: 'no_credit' });
			expect(getCredits).toHaveBeenCalledWith(CODEX_HOME);
		});

		it('reports an undecided outcome and clears the guard when the bridge throws', async () => {
			useCodexResetCreditsStore.setState({
				entries: { [CODEX_HOME]: { credits: [credit()], counts: { available: 1 } } },
			});
			consumeCredit.mockRejectedValue(new Error('bridge is gone'));

			const result = await useCodexResetCreditsStore.getState().redeem(CODEX_HOME);

			// The request may have landed, so never claim the credit was preserved.
			expect(result).toMatchObject({ ok: false, attempted: true });
			expect(result.message).toContain('may or may not have been spent');
			expect(useCodexResetCreditsStore.getState().redeeming[CODEX_HOME]).toBe(false);
		});
	});
});
