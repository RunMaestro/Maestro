/**
 * Tests for claude-mode-selector.ts
 *
 * Exhaustive coverage of every rule branch in `selectMode`, including the
 * precedence layers (global pin > per-tab user pin > auto-resolver), the
 * limit-threshold boundary, sticky-limit semantics, and the input-mutation
 * invariant.
 */

import { describe, it, expect } from 'vitest';
import {
	selectMode,
	LIMIT_THRESHOLD_PERCENT,
	type SelectModeInput,
	type UsageSnapshot,
} from '../../../main/agents/claude-mode-selector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-05-15T12:00:00.000Z');
const ONE_HOUR_LATER = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
const ONE_HOUR_EARLIER = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		sampledAt: '2026-05-15T11:55:00.000Z',
		configDirKey: '/Users/test/.claude',
		session: { percent: 10, resetsAt: ONE_HOUR_LATER },
		weekAllModels: { percent: 20, resetsAt: ONE_HOUR_LATER },
		weekSonnetOnly: { percent: 5, resetsAt: ONE_HOUR_LATER },
		...overrides,
	};
}

function input(overrides: Partial<SelectModeInput> = {}): SelectModeInput {
	return {
		headlessMode: 'auto',
		perTabReason: 'auto',
		perTabMode: 'api',
		usageSnapshot: null,
		autoFallbackOnLimit: true,
		now: NOW,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('claude-mode-selector', () => {
	describe('LIMIT_THRESHOLD_PERCENT', () => {
		it('is exported as 95', () => {
			expect(LIMIT_THRESHOLD_PERCENT).toBe(95);
		});
	});

	describe('rule 1: global headlessMode pin wins absolutely', () => {
		it('returns interactive/user when headlessMode === "interactive"', () => {
			expect(selectMode(input({ headlessMode: 'interactive' }))).toEqual({
				mode: 'interactive',
				reason: 'user',
			});
		});

		it('returns api/user when headlessMode === "api"', () => {
			expect(selectMode(input({ headlessMode: 'api' }))).toEqual({
				mode: 'api',
				reason: 'user',
			});
		});

		it('overrides a per-tab user pin pointing the other way (interactive setting beats api per-tab)', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'interactive',
						perTabReason: 'user',
						perTabMode: 'api',
					})
				)
			).toEqual({ mode: 'interactive', reason: 'user' });
		});

		it('overrides a per-tab user pin pointing the other way (api setting beats interactive per-tab)', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'api',
						perTabReason: 'user',
						perTabMode: 'interactive',
					})
				)
			).toEqual({ mode: 'api', reason: 'user' });
		});

		it('overrides a sticky-limit state when pinned to interactive', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'interactive',
						perTabReason: 'limit',
						perTabMode: 'api',
						usageSnapshot: snapshot({
							session: { percent: 99, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'user' });
		});
	});

	describe('rule 2: per-tab user pin wins over auto-resolver', () => {
		it('returns interactive/user when perTabReason === "user" and perTabMode === "interactive"', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'auto',
						perTabReason: 'user',
						perTabMode: 'interactive',
					})
				)
			).toEqual({ mode: 'interactive', reason: 'user' });
		});

		it('returns api/user when perTabReason === "user" and perTabMode === "api"', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'auto',
						perTabReason: 'user',
						perTabMode: 'api',
					})
				)
			).toEqual({ mode: 'api', reason: 'user' });
		});

		it('beats a limit-triggering snapshot when the user has manually pinned', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'auto',
						perTabReason: 'user',
						perTabMode: 'interactive',
						usageSnapshot: snapshot({
							session: { percent: 99, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'user' });
		});
	});

	describe('rule 3a: auto + null snapshot defaults to interactive/auto', () => {
		it('null snapshot, no per-tab pin, autoFallback either value -> interactive/auto', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'auto',
						perTabReason: 'auto',
						usageSnapshot: null,
						autoFallbackOnLimit: true,
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });

			expect(
				selectMode(
					input({
						headlessMode: 'auto',
						perTabReason: 'auto',
						usageSnapshot: null,
						autoFallbackOnLimit: false,
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('null snapshot with sticky perTabReason "limit" falls through to interactive/auto (cannot verify the window is still open)', () => {
			expect(
				selectMode(
					input({
						headlessMode: 'auto',
						perTabReason: 'limit',
						perTabMode: 'api',
						usageSnapshot: null,
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('rule 3b: limit threshold triggers fallback when autoFallback is true', () => {
		it('session.percent >= 95 with window open and autoFallback true -> api/limit', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							session: { percent: 95, resetsAt: ONE_HOUR_LATER },
						}),
						autoFallbackOnLimit: true,
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('weekAllModels.percent >= 95 with window open and autoFallback true -> api/limit', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							weekAllModels: { percent: 99.9, resetsAt: ONE_HOUR_LATER },
						}),
						autoFallbackOnLimit: true,
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('both session and week over threshold -> still single api/limit', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							session: { percent: 100, resetsAt: ONE_HOUR_LATER },
							weekAllModels: { percent: 100, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('weekSonnetOnly >= 95 alone does NOT trigger (selector ignores it)', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							weekSonnetOnly: { percent: 99, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('session at threshold but window already reset -> no trigger', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							session: { percent: 99, resetsAt: ONE_HOUR_EARLIER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('rule 3c: autoFallbackOnLimit false respects the user opt-out', () => {
		it('session over threshold with autoFallback false -> interactive/auto (no fallback)', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							session: { percent: 99, resetsAt: ONE_HOUR_LATER },
						}),
						autoFallbackOnLimit: false,
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('weekAllModels over threshold with autoFallback false -> interactive/auto', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							weekAllModels: { percent: 100, resetsAt: ONE_HOUR_LATER },
						}),
						autoFallbackOnLimit: false,
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('rule 3d: post-reset transition flips back to auto-interactive', () => {
		it('perTabReason "limit" with BOTH reset windows in the past -> interactive/auto', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						perTabMode: 'api',
						usageSnapshot: snapshot({
							session: { percent: 99, resetsAt: ONE_HOUR_EARLIER },
							weekAllModels: { percent: 99, resetsAt: ONE_HOUR_EARLIER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('percent dropping below threshold mid-window does NOT break sticky-limit (only window reset does)', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						perTabMode: 'api',
						usageSnapshot: snapshot({
							session: { percent: 1, resetsAt: ONE_HOUR_LATER },
							weekAllModels: { percent: 1, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});
	});

	describe('rule 3e: boundary conditions at LIMIT_THRESHOLD_PERCENT', () => {
		it('exactly 95% triggers (>= comparison)', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							session: { percent: 95, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('94.9% does NOT trigger', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							session: { percent: 94.9, resetsAt: ONE_HOUR_LATER },
							weekAllModels: { percent: 94.9, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('0% does not trigger', () => {
			expect(
				selectMode(
					input({
						usageSnapshot: snapshot({
							session: { percent: 0, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('rule 3f: sticky-limit stays api until BOTH windows reset', () => {
		it('perTabReason "limit", session window past, week window still open -> stays api/limit', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						perTabMode: 'api',
						usageSnapshot: snapshot({
							session: { percent: 50, resetsAt: ONE_HOUR_EARLIER },
							weekAllModels: { percent: 50, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "limit", session still open, week reset -> stays api/limit', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						perTabMode: 'api',
						usageSnapshot: snapshot({
							session: { percent: 50, resetsAt: ONE_HOUR_LATER },
							weekAllModels: { percent: 50, resetsAt: ONE_HOUR_EARLIER },
						}),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "limit", both windows reset -> flips back to interactive/auto', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						perTabMode: 'api',
						usageSnapshot: snapshot({
							session: { percent: 50, resetsAt: ONE_HOUR_EARLIER },
							weekAllModels: { percent: 50, resetsAt: ONE_HOUR_EARLIER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('sticky-limit ignores autoFallbackOnLimit=false (commitment was made at trigger time)', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						perTabMode: 'api',
						autoFallbackOnLimit: false,
						usageSnapshot: snapshot({
							session: { percent: 50, resetsAt: ONE_HOUR_LATER },
							weekAllModels: { percent: 50, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'api', reason: 'limit' });
		});

		it('perTabReason "auto" with windows open but percents under threshold -> interactive/auto (not sticky)', () => {
			expect(
				selectMode(
					input({
						perTabReason: 'auto',
						usageSnapshot: snapshot({
							session: { percent: 50, resetsAt: ONE_HOUR_LATER },
							weekAllModels: { percent: 50, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});

		it('fresh trigger beats sticky check when both could apply (still api/limit either way, but verifies precedence)', () => {
			// percent>=95 with window open is a fresh trigger; perTabReason==='limit' is
			// also true. Fresh trigger evaluates first and respects autoFallback=false.
			expect(
				selectMode(
					input({
						perTabReason: 'limit',
						perTabMode: 'api',
						autoFallbackOnLimit: false,
						usageSnapshot: snapshot({
							session: { percent: 99, resetsAt: ONE_HOUR_LATER },
							weekAllModels: { percent: 50, resetsAt: ONE_HOUR_LATER },
						}),
					})
				)
			).toEqual({ mode: 'interactive', reason: 'auto' });
		});
	});

	describe('purity', () => {
		it('does not mutate its input', () => {
			const snap = snapshot({
				session: { percent: 99, resetsAt: ONE_HOUR_LATER },
				weekAllModels: { percent: 99, resetsAt: ONE_HOUR_LATER },
				weekSonnetOnly: { percent: 99, resetsAt: ONE_HOUR_LATER },
			});
			const inp: SelectModeInput = {
				headlessMode: 'auto',
				perTabReason: 'limit',
				perTabMode: 'api',
				usageSnapshot: snap,
				autoFallbackOnLimit: true,
				now: NOW,
			};
			const before = JSON.parse(JSON.stringify(inp));
			selectMode(inp);
			expect(JSON.parse(JSON.stringify(inp))).toEqual(before);
		});

		it('returns the same result for the same input (determinism)', () => {
			const inp = input({
				usageSnapshot: snapshot({
					session: { percent: 96, resetsAt: ONE_HOUR_LATER },
				}),
			});
			const a = selectMode(inp);
			const b = selectMode(inp);
			expect(a).toEqual(b);
		});
	});
});
