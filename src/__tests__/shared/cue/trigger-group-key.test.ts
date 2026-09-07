/**
 * Tests for the shared `triggerGroupKey` identity used by the pipeline loader,
 * the engine's manual-trigger dispatch, and the Cue dashboard's Run Now.
 *
 * The contract these guard: subs that represent parallel branches of ONE
 * visual trigger produce the same key, and any divergence in event-specific
 * config produces a different one. The three call sites used to carry
 * hand-mirrored copies of this function, and the two runtime copies had
 * drifted - the re-trigger cases below are the ones they got wrong.
 */

import { describe, it, expect } from 'vitest';

import { triggerGroupKey } from '../../../shared/cue/trigger-group-key';
import type { CueSubscription } from '../../../shared/cue';

function sub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'watch-prs',
		event: 'github.pull_request',
		enabled: true,
		prompt: 'review it',
		repo: 'owner/repo',
		...overrides,
	};
}

describe('triggerGroupKey', () => {
	it('groups parallel branches that share the trigger config', () => {
		expect(triggerGroupKey(sub({ name: 'p1' }))).toBe(triggerGroupKey(sub({ name: 'p1-chain-2' })));
	});

	it('separates triggers whose event config differs', () => {
		expect(triggerGroupKey(sub())).not.toBe(triggerGroupKey(sub({ poll_minutes: 10 })));
		expect(triggerGroupKey(sub())).not.toBe(triggerGroupKey(sub({ repo: 'other/repo' })));
		expect(triggerGroupKey(sub())).not.toBe(triggerGroupKey(sub({ event: 'github.issue' })));
	});

	it('ignores filter key order', () => {
		const a = sub({ filter: { author: 'alice', draft: false } });
		const b = sub({ filter: { draft: false, author: 'alice' } });
		expect(triggerGroupKey(a)).toBe(triggerGroupKey(b));
	});

	it('separates on the re-trigger fields the runtime copies used to ignore', () => {
		expect(triggerGroupKey(sub())).not.toBe(triggerGroupKey(sub({ retrigger_on_comments: true })));
		expect(triggerGroupKey(sub({ retrigger_on_comments: true }))).not.toBe(
			triggerGroupKey(sub({ retrigger_on_comments: true, max_notifications: 3 }))
		);
	});

	it('separates github.label triggers that watch different kinds or labels', () => {
		const base = sub({ event: 'github.label' });
		expect(triggerGroupKey(base)).not.toBe(
			triggerGroupKey(sub({ event: 'github.label', gh_label_target: 'pr' }))
		);
		expect(triggerGroupKey(sub({ event: 'github.label', gh_labels: ['bug'] }))).not.toBe(
			triggerGroupKey(sub({ event: 'github.label', gh_labels: ['triage'] }))
		);
	});
});
