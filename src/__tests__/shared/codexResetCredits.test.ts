import { describe, expect, it } from 'vitest';

import {
	asResetCreditStatus,
	describeCreditExpiry,
	describeCreditSpend,
	isSpendableCredit,
	nextCreditToSpend,
	shouldAutoSpendCredit,
	spendableCredits,
	type CodexResetCredit,
} from '../../shared/codexResetCredits';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');

function credit(overrides: Partial<CodexResetCredit> = {}): CodexResetCredit {
	return {
		id: overrides.id ?? 'RateLimitResetCredit_1',
		supportedByPlan: overrides.supportedByPlan ?? true,
		status: overrides.status ?? 'available',
		...overrides,
	};
}

describe('isSpendableCredit', () => {
	it('accepts an available credit the plan supports', () => {
		expect(isSpendableCredit(credit())).toBe(true);
	});

	it('rejects a credit already redeemed or expired', () => {
		expect(isSpendableCredit(credit({ status: 'redeemed' }))).toBe(false);
		expect(isSpendableCredit(credit({ status: 'expired' }))).toBe(false);
	});

	// A second consume for an id whose first is still in flight is the one way to
	// lose two credits for one reset.
	it('rejects a credit mid-redemption', () => {
		expect(isSpendableCredit(credit({ status: 'redeeming' }))).toBe(false);
	});

	it('rejects a credit the plan cannot redeem', () => {
		expect(isSpendableCredit(credit({ supportedByPlan: false }))).toBe(false);
	});
});

describe('spendableCredits / nextCreditToSpend', () => {
	it('spends the soonest-to-expire credit first', () => {
		const soon = credit({ id: 'soon', expiresAt: '2026-09-20T00:00:00.000Z' });
		const later = credit({ id: 'later', expiresAt: '2026-10-30T00:00:00.000Z' });

		expect(nextCreditToSpend([later, soon])?.id).toBe('soon');
		expect(spendableCredits([later, soon]).map((c) => c.id)).toEqual(['soon', 'later']);
	});

	// A known expiry is more urgent than one we do not know about, so undated
	// credits sort last rather than being burned first.
	it('sorts undated credits after dated ones', () => {
		const dated = credit({ id: 'dated', expiresAt: '2026-10-01T00:00:00.000Z' });
		const undated = credit({ id: 'undated' });

		expect(spendableCredits([undated, dated]).map((c) => c.id)).toEqual(['dated', 'undated']);
	});

	it('returns nothing when every credit is unspendable', () => {
		expect(nextCreditToSpend([credit({ status: 'redeemed' })])).toBeUndefined();
	});
});

describe('describeCreditSpend', () => {
	it('reports no-credits when the account holds none', () => {
		const result = describeCreditSpend({ available: 0, applicable: 0 }, []);
		expect(result.verdict).toBe('no-credits');
		expect(result.canSpend).toBe(false);
	});

	it('reports effective when a credit would reopen a window', () => {
		const result = describeCreditSpend({ available: 2, applicable: 2 }, [credit()]);
		expect(result.verdict).toBe('effective');
		expect(result.canSpend).toBe(true);
	});

	// The real shape observed from the API: two credits owned, none of which
	// would do anything because no window is consumed.
	it('reports wasteful when credits exist but none would take effect', () => {
		const result = describeCreditSpend({ available: 2, applicable: 0 }, [credit()]);
		expect(result.verdict).toBe('wasteful');
		// Still the user's credit to burn - the verdict buys an honest
		// confirmation, not a veto.
		expect(result.canSpend).toBe(true);
		expect(result.reason).toContain('spent for nothing');
	});

	// Unknown and zero are different answers; coercing the first into the second
	// would tell a user every credit they own is useless.
	it('reports unknown when the applicable count is absent', () => {
		const result = describeCreditSpend({ available: 1 }, [credit()]);
		expect(result.verdict).toBe('unknown');
		expect(result.canSpend).toBe(true);
	});

	it('falls back to the count when the credit list could not be read', () => {
		expect(describeCreditSpend({ available: 1, applicable: 1 }, []).verdict).toBe('effective');
	});

	it('reports no-credits when the list holds only unspendable credits', () => {
		const result = describeCreditSpend({ available: 1, applicable: 1 }, [
			credit({ status: 'redeemed' }),
		]);
		expect(result.verdict).toBe('no-credits');
	});
});

describe('shouldAutoSpendCredit', () => {
	it('fires only on an effective verdict', () => {
		expect(shouldAutoSpendCredit({ available: 1, applicable: 1 }, [credit()])).toBe(true);
	});

	// The automation is strictly narrower than the manual path: a credit is
	// finite and irreversible, so unattended spending needs confirmation that the
	// reset would actually take effect.
	it('refuses a wasteful spend the manual path would still offer', () => {
		expect(shouldAutoSpendCredit({ available: 2, applicable: 0 }, [credit()])).toBe(false);
	});

	it('refuses when the applicable count is unknown', () => {
		expect(shouldAutoSpendCredit({ available: 2 }, [credit()])).toBe(false);
	});

	it('refuses when there is nothing to spend', () => {
		expect(shouldAutoSpendCredit({ available: 0, applicable: 0 }, [])).toBe(false);
	});
});

describe('describeCreditExpiry', () => {
	it('names a credit that never expires', () => {
		expect(describeCreditExpiry(credit(), NOW)).toBe('Does not expire');
	});

	it('names today, tomorrow, and a day count', () => {
		expect(describeCreditExpiry(credit({ expiresAt: '2026-09-16T20:00:00.000Z' }), NOW)).toBe(
			'Expires today'
		);
		expect(describeCreditExpiry(credit({ expiresAt: '2026-09-17T18:00:00.000Z' }), NOW)).toBe(
			'Expires tomorrow'
		);
		expect(describeCreditExpiry(credit({ expiresAt: '2026-10-04T12:00:00.000Z' }), NOW)).toBe(
			'Expires in 18 days'
		);
	});

	it('names an already-lapsed credit', () => {
		expect(describeCreditExpiry(credit({ expiresAt: '2026-09-01T00:00:00.000Z' }), NOW)).toBe(
			'Expired'
		);
	});
});

describe('asResetCreditStatus', () => {
	it('narrows known statuses and defaults the rest to unknown', () => {
		expect(asResetCreditStatus('available')).toBe('available');
		expect(asResetCreditStatus('redeeming')).toBe('redeeming');
		expect(asResetCreditStatus('something_new')).toBe('unknown');
		expect(asResetCreditStatus(undefined)).toBe('unknown');
	});
});
