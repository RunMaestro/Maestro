/**
 * Tests for src/shared/usageQuota.ts
 *
 * These predicates gate two things that must agree: whether the Usage
 * Dashboard renders a provider tab, and whether the main-process warm-up
 * considers that provider cold enough to sample on boot. A disagreement means
 * either a permanently empty tab or a `maestro-p --status` spawn on every
 * launch, so the edge cases are pinned here.
 */

import { describe, it, expect } from 'vitest';

import {
	hasValidQuotaWindow,
	hasUsefulAnthropicQuotaDetails,
	hasUsefulCodexQuotaDetails,
} from '../../shared/usageQuota';

const WINDOW = { percent: 42, resetsAt: '2026-01-01T00:00:00.000Z' };

describe('hasValidQuotaWindow', () => {
	it('accepts a finite percent paired with a reset timestamp', () => {
		expect(hasValidQuotaWindow(WINDOW)).toBe(true);
		expect(hasValidQuotaWindow({ percent: 0, resetsAt: WINDOW.resetsAt })).toBe(true);
	});

	it('rejects a missing window', () => {
		expect(hasValidQuotaWindow(undefined)).toBe(false);
	});

	it('rejects non-finite or negative percentages', () => {
		expect(hasValidQuotaWindow({ percent: NaN, resetsAt: WINDOW.resetsAt })).toBe(false);
		expect(hasValidQuotaWindow({ percent: Infinity, resetsAt: WINDOW.resetsAt })).toBe(false);
		expect(hasValidQuotaWindow({ percent: -1, resetsAt: WINDOW.resetsAt })).toBe(false);
	});

	it('rejects a missing or empty reset timestamp', () => {
		expect(hasValidQuotaWindow({ percent: 42 })).toBe(false);
		expect(hasValidQuotaWindow({ percent: 42, resetsAt: '' })).toBe(false);
	});
});

describe('hasUsefulAnthropicQuotaDetails', () => {
	it('accepts a snapshot with any one valid window', () => {
		expect(hasUsefulAnthropicQuotaDetails({ session: WINDOW })).toBe(true);
		expect(hasUsefulAnthropicQuotaDetails({ weekAllModels: WINDOW })).toBe(true);
		expect(hasUsefulAnthropicQuotaDetails({ weekSonnetOnly: WINDOW })).toBe(true);
	});

	it('treats a missing authState as authenticated (back-compat)', () => {
		expect(hasUsefulAnthropicQuotaDetails({ session: WINDOW })).toBe(true);
	});

	it('rejects an explicitly unauthenticated snapshot even with windows', () => {
		expect(hasUsefulAnthropicQuotaDetails({ authState: 'unauthenticated', session: WINDOW })).toBe(
			false
		);
	});

	it('rejects a snapshot with no usable window', () => {
		expect(hasUsefulAnthropicQuotaDetails({})).toBe(false);
		expect(hasUsefulAnthropicQuotaDetails({ session: { percent: 42 } })).toBe(false);
	});
});

describe('hasUsefulCodexQuotaDetails', () => {
	it('accepts an authenticated snapshot with any one valid window', () => {
		expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated', session: WINDOW })).toBe(true);
		expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated', weekly: WINDOW })).toBe(true);
		expect(
			hasUsefulCodexQuotaDetails({ authState: 'authenticated', additionalLimits: [WINDOW] })
		).toBe(true);
	});

	it('requires an explicit authenticated state', () => {
		expect(hasUsefulCodexQuotaDetails({ authState: 'missing_auth', session: WINDOW })).toBe(false);
		expect(hasUsefulCodexQuotaDetails({ authState: 'error', session: WINDOW })).toBe(false);
	});

	it('rejects an authenticated snapshot with nothing to render', () => {
		expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated' })).toBe(false);
		expect(hasUsefulCodexQuotaDetails({ authState: 'authenticated', additionalLimits: [] })).toBe(
			false
		);
	});
});
