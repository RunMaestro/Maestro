/**
 * Tests for the main-authoritative TTSR repeat/injection store (Gate B).
 *
 * Covers `once` vs `after-gap` eligibility across turn boundaries, the pending
 * provider-session-id bucket being folded in once the id lands, and
 * snapshot/hydrate round-tripping (the Phase 3 persistence seam).
 */

import { describe, it, expect } from 'vitest';
import {
	TtsrStateStore,
	ttsrConversationKey,
	TTSR_PENDING_PROVIDER_ID,
} from '../../../main/ttsr/ttsr-state-store';

const ONCE = { name: 'once-rule', repeatMode: 'once' as const, repeatGap: 3 };
const GAP = { name: 'gap-rule', repeatMode: 'after-gap' as const, repeatGap: 3 };

describe('ttsrConversationKey', () => {
	it('falls back to the pending provider id before the session-id event', () => {
		expect(ttsrConversationKey('s1')).toBe(`s1|${TTSR_PENDING_PROVIDER_ID}`);
		expect(ttsrConversationKey('s1', 'prov-1')).toBe('s1|prov-1');
	});
});

describe('TtsrStateStore repeat policy', () => {
	it('treats an unfired rule as eligible', () => {
		const store = new TtsrStateStore();
		expect(store.isEligible(ONCE, 'k')).toBe(true);
		expect(store.isEligible(GAP, 'k')).toBe(true);
	});

	it('never re-fires a once rule, even after many turns', () => {
		const store = new TtsrStateStore();
		store.noteInjection('k', ONCE.name);
		expect(store.isEligible(ONCE, 'k')).toBe(false);
		for (let i = 0; i < 10; i++) store.noteTurnEnd('k');
		expect(store.isEligible(ONCE, 'k')).toBe(false);
	});

	it('re-fires an after-gap rule only once the gap has elapsed', () => {
		const store = new TtsrStateStore();
		store.noteInjection('k', GAP.name);
		expect(store.isEligible(GAP, 'k')).toBe(false);
		store.noteTurnEnd('k');
		store.noteTurnEnd('k');
		expect(store.isEligible(GAP, 'k')).toBe(false);
		store.noteTurnEnd('k');
		expect(store.isEligible(GAP, 'k')).toBe(true);
	});

	it('restarts the cooldown on each injection and counts firings', () => {
		const store = new TtsrStateStore();
		store.noteInjection('k', GAP.name);
		for (let i = 0; i < 3; i++) store.noteTurnEnd('k');
		store.noteInjection('k', GAP.name);
		expect(store.isEligible(GAP, 'k')).toBe(false);
		expect(store.getRuleState('k', GAP.name)).toEqual({ lastInjectedAt: 3, injectionCount: 2 });
	});

	it('keeps conversations independent', () => {
		const store = new TtsrStateStore();
		store.noteInjection('a', ONCE.name);
		expect(store.isEligible(ONCE, 'a')).toBe(false);
		expect(store.isEligible(ONCE, 'b')).toBe(true);
	});

	it('forgets a cleared conversation', () => {
		const store = new TtsrStateStore();
		store.noteInjection('k', ONCE.name);
		store.clearConversation('k');
		expect(store.isEligible(ONCE, 'k')).toBe(true);
		expect(store.getMessageCount('k')).toBe(0);
	});
});

describe('TtsrStateStore.adoptProviderSessionId', () => {
	it('moves state recorded before the session-id event onto the real conversation', () => {
		const store = new TtsrStateStore();
		store.noteInjection(ttsrConversationKey('s1'), ONCE.name);

		store.adoptProviderSessionId('s1', 'prov-1');

		expect(store.isEligible(ONCE, ttsrConversationKey('s1'))).toBe(true);
		expect(store.isEligible(ONCE, ttsrConversationKey('s1', 'prov-1'))).toBe(false);
	});

	it('merges into an existing conversation instead of clobbering it', () => {
		const store = new TtsrStateStore();
		const resumed = ttsrConversationKey('s1', 'prov-1');
		store.noteInjection(resumed, GAP.name);
		store.noteTurnEnd(resumed);
		store.noteTurnEnd(resumed);
		store.noteInjection(ttsrConversationKey('s1'), GAP.name);

		store.adoptProviderSessionId('s1', 'prov-1');

		expect(store.getRuleState(resumed, GAP.name)).toEqual({
			lastInjectedAt: 0,
			injectionCount: 2,
		});
		expect(store.getMessageCount(resumed)).toBe(2);
	});

	it('is a no-op without a pending bucket or a real id', () => {
		const store = new TtsrStateStore();
		store.noteInjection(ttsrConversationKey('s1', 'prov-1'), ONCE.name);
		store.adoptProviderSessionId('s1', 'prov-1');
		store.adoptProviderSessionId('s1', '');
		expect(store.isEligible(ONCE, ttsrConversationKey('s1', 'prov-1'))).toBe(false);
	});
});

describe('TtsrStateStore persistence', () => {
	it('round-trips through snapshot/hydrate so once survives a reload', () => {
		const store = new TtsrStateStore();
		const key = ttsrConversationKey('s1', 'prov-1');
		store.noteInjection(key, ONCE.name);
		store.noteTurnEnd(key);

		const restored = new TtsrStateStore();
		restored.hydrate(JSON.parse(JSON.stringify(store.snapshot())));

		expect(restored.getMessageCount(key)).toBe(1);
		expect(restored.isEligible(ONCE, key)).toBe(false);
	});

	it('ignores malformed persisted entries rather than throwing', () => {
		const store = new TtsrStateStore();
		store.hydrate({
			good: { messageCount: 2, rules: { r: { lastInjectedAt: 1, injectionCount: 1 } } },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			bad: null as any,
		});
		expect(store.getMessageCount('good')).toBe(2);
		expect(store.getMessageCount('bad')).toBe(0);
	});
});
