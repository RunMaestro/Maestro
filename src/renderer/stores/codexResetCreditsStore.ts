/**
 * codexResetCreditsStore - the renderer's view of each Codex account's reset
 * credits, and the one path that spends one.
 *
 * The COUNT already arrives free on every usage snapshot
 * (`CodexUsageSnapshot.resetCredits`), so this store exists for the two things
 * the count cannot answer: WHICH credits exist (ids, titles, expiry) and what
 * happens when one is redeemed.
 *
 * Three rules the store holds so no component has to:
 *
 *  1. **One redemption at a time, per account.** `redeeming` is keyed by
 *     CODEX_HOME. A credit is finite and irreversible, so a double-click, a
 *     second dashboard window, or an automatic trigger racing a manual click
 *     must not each land a spend. The guard is checked and set in the same
 *     synchronous tick before any await.
 *
 *  2. **The idempotency key belongs to the SPEND, not to the request.** It is
 *     minted once when the user commits and reused if that spend is retried,
 *     which is what makes a network failure recoverable without costing a
 *     second credit.
 *
 *  3. **A successful redemption invalidates the usage bars.** Main re-samples
 *     before answering, so this pulls both stores afterwards - otherwise the
 *     panel keeps showing the exhausted windows the user just paid to reopen,
 *     which reads as the redemption having failed.
 */

import { create } from 'zustand';

import type {
	CodexResetCredit,
	CodexResetCreditConsumeResult,
	CodexResetCreditCounts,
	CodexResetCreditsDetail,
} from '../../shared/codexResetCredits';
import { nextCreditToSpend } from '../../shared/codexResetCredits';
import { useCodexUsageStore } from './codexUsageStore';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[CodexResetCredits]';

/** What we know about one account's credits, plus how that read went. */
export interface CodexResetCreditsEntry {
	credits: CodexResetCredit[];
	counts: CodexResetCreditCounts;
	/** Ready-to-render explanation when the last read failed. */
	error?: string;
	/** Epoch ms of the last completed read, for staleness display. */
	fetchedAt?: number;
}

interface CodexResetCreditsState {
	/** Keyed by canonical CODEX_HOME. */
	entries: Record<string, CodexResetCreditsEntry>;
	/** Accounts with a read in flight. */
	loading: Record<string, boolean>;
	/** Accounts with a redemption in flight. Also the double-spend guard. */
	redeeming: Record<string, boolean>;

	/** READ one account's credits into the store. Resolves even on failure. */
	load: (codexHomeKey: string) => Promise<void>;
	/**
	 * WRITE: redeem a credit for one account.
	 *
	 * Omit `creditId` to spend the soonest-to-expire spendable credit. Returns
	 * the outcome so the caller can flash, toast, or log it; never throws.
	 */
	redeem: (
		codexHomeKey: string,
		creditId?: string
	) => Promise<CodexResetCreditConsumeResult & { attempted: boolean }>;
	__resetForTests: () => void;
}

const initial = {
	entries: {} as Record<string, CodexResetCreditsEntry>,
	loading: {} as Record<string, boolean>,
	redeeming: {} as Record<string, boolean>,
};

export const useCodexResetCreditsStore = create<CodexResetCreditsState>((set, get) => ({
	...initial,

	load: async (codexHomeKey) => {
		if (get().loading[codexHomeKey]) return;
		set((s) => ({ loading: { ...s.loading, [codexHomeKey]: true } }));
		try {
			const result = await window.maestro.agents.getCodexResetCredits(codexHomeKey);
			set((s) => ({
				entries: {
					...s.entries,
					[codexHomeKey]: result.ok
						? {
								credits: result.detail?.credits ?? [],
								counts: toCounts(result.detail),
								fetchedAt: Date.now(),
							}
						: {
								// Keep whatever we last knew rather than blanking the list: a
								// transient read failure must not make an account look like it
								// owns nothing, which is the one wrong answer that would stop
								// a user redeeming a credit they actually have.
								credits: s.entries[codexHomeKey]?.credits ?? [],
								counts: s.entries[codexHomeKey]?.counts ?? { available: 0 },
								error: result.error,
								fetchedAt: s.entries[codexHomeKey]?.fetchedAt,
							},
				},
			}));
		} catch (error) {
			logger.warn('Failed to read Codex reset credits', LOG_CONTEXT, { codexHomeKey, error });
		} finally {
			set((s) => ({ loading: { ...s.loading, [codexHomeKey]: false } }));
		}
	},

	redeem: async (codexHomeKey, creditId) => {
		// Guard and claim in one synchronous step, before any await, so two
		// callers in the same tick cannot both get through.
		if (get().redeeming[codexHomeKey]) {
			return {
				ok: false,
				windowsReset: 0,
				attempted: false,
				message: 'A reset is already running.',
			};
		}

		const entry = get().entries[codexHomeKey];
		const target = creditId ?? nextCreditToSpend(entry?.credits ?? [])?.id;
		if (!target) {
			return {
				ok: false,
				windowsReset: 0,
				attempted: false,
				message: 'No reset credit available on this account.',
			};
		}

		set((s) => ({ redeeming: { ...s.redeeming, [codexHomeKey]: true } }));
		// One key per logical spend: a retry of THIS spend reuses it, so a dropped
		// connection cannot cost a second credit.
		const idempotencyKey = generateId();
		try {
			const result = await window.maestro.agents.consumeCodexResetCredit(
				codexHomeKey,
				target,
				idempotencyKey
			);
			if (result.ok) {
				logger.info('Redeemed Codex reset credit', LOG_CONTEXT, {
					codexHomeKey,
					windowsReset: result.windowsReset,
				});
			}
			// Re-read both sides regardless of outcome: a failed redemption often
			// means the credit was already gone, and leaving it on screen invites
			// the user to click a button that can never work.
			await Promise.all([get().load(codexHomeKey), useCodexUsageStore.getState().refresh()]).catch(
				() => {
					/* Refresh is cosmetic - never turn a good spend into a reported error. */
				}
			);
			return { ...result, attempted: true };
		} catch (error) {
			logger.error('Codex reset credit redemption threw', LOG_CONTEXT, error);
			return {
				ok: false,
				windowsReset: 0,
				attempted: true,
				message: 'The reset request failed. It may or may not have been spent.',
			};
		} finally {
			set((s) => ({ redeeming: { ...s.redeeming, [codexHomeKey]: false } }));
		}
	},

	__resetForTests: () => set({ ...initial }),
}));

/**
 * Counts from a detail read, falling back to the list length.
 *
 * `applicable` is passed through UNTOUCHED, including when it is absent: an
 * account whose API did not report it is UNKNOWN, and coercing that to 0 would
 * tell the user every credit they own is useless.
 */
function toCounts(detail: CodexResetCreditsDetail | undefined): CodexResetCreditCounts {
	if (!detail) return { available: 0 };
	return { available: detail.available, applicable: detail.applicable };
}

/** One account's entry, or `undefined` when it has never been read. */
export function selectResetCreditsEntry(codexHomeKey: string) {
	return (s: CodexResetCreditsState): CodexResetCreditsEntry | undefined => s.entries[codexHomeKey];
}
