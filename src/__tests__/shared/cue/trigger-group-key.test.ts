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

import { isSameTriggerGroup, triggerGroupKey } from '../../../shared/cue/trigger-group-key';
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

	it('separates triggers whose gate differs', () => {
		const gated = sub({ gate: 'the comment reports a bug' });
		expect(triggerGroupKey(sub())).not.toBe(triggerGroupKey(gated));
		expect(triggerGroupKey(gated)).not.toBe(
			triggerGroupKey(sub({ gate: 'the comment asks for a code change' }))
		);
		expect(triggerGroupKey(gated)).not.toBe(
			triggerGroupKey(sub({ gate: 'the comment reports a bug', gate_on_unavailable: 'skip' }))
		);
	});

	it('groups parallel branches that carry the same gate', () => {
		const a = sub({ name: 'p1', gate: 'the comment reports a bug' });
		const b = sub({ name: 'p1-chain-2', gate: 'the comment reports a bug' });
		expect(triggerGroupKey(a)).toBe(triggerGroupKey(b));
	});

	it('separates triggers whose injection screen differs', () => {
		expect(triggerGroupKey(sub())).not.toBe(triggerGroupKey(sub({ screen_injection: true })));
		expect(triggerGroupKey(sub({ screen_injection: true }))).not.toBe(
			triggerGroupKey(sub({ screen_injection: false }))
		);
		expect(triggerGroupKey(sub())).not.toBe(triggerGroupKey(sub({ injection_threshold: 0.5 })));
	});

	it('groups parallel branches that carry the same injection screen', () => {
		const a = sub({ name: 'p1', screen_injection: true, injection_threshold: 0.6 });
		const b = sub({ name: 'p1-chain-2', screen_injection: true, injection_threshold: 0.6 });
		expect(triggerGroupKey(a)).toBe(triggerGroupKey(b));
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

	it('separates one-shots that fire at different instants', () => {
		const once = (fire_at: string) =>
			sub({ event: 'time.once', repo: undefined, label: 'Renew the token', fire_at });
		expect(triggerGroupKey(once('2026-11-09T15:00:00.000Z'))).not.toBe(
			triggerGroupKey(once('2026-12-01T15:00:00.000Z'))
		);
	});

	it('groups the -prompt / -notify pair a scheduled task emits', () => {
		// `cue schedule --prompt --notify` writes two subs sharing one event,
		// one instant, and one label. They are one visual trigger with two
		// outgoing edges, so they must collapse onto a single node.
		const base = {
			event: 'time.once' as const,
			repo: undefined,
			label: 'Renew the token',
			fire_at: '2026-11-09T15:00:00.000Z',
		};
		expect(triggerGroupKey(sub({ ...base, name: 'renew-prompt' }))).toBe(
			triggerGroupKey(sub({ ...base, name: 'renew-notify', action: 'notify' }))
		);
	});
});

describe('isSameTriggerGroup', () => {
	it('matches the parallel branches of one trigger in one pipeline', () => {
		const anchor = sub({ name: 'p1', pipeline_name: 'P' });
		expect(isSameTriggerGroup(anchor, sub({ name: 'p1-cmd-a', pipeline_name: 'P' }))).toBe(true);
		expect(isSameTriggerGroup(anchor, anchor)).toBe(true);
	});

	it('leaves out another pipeline, a different trigger config, and a chain step', () => {
		const anchor = sub({ name: 'p1', pipeline_name: 'P' });
		expect(isSameTriggerGroup(anchor, sub({ name: 'q1', pipeline_name: 'Q' }))).toBe(false);
		expect(
			isSameTriggerGroup(anchor, sub({ name: 'p2', pipeline_name: 'P', repo: 'o/other' }))
		).toBe(false);
		expect(
			isSameTriggerGroup(
				anchor,
				sub({ name: 'p1-chain-1', pipeline_name: 'P', event: 'agent.completed' })
			)
		).toBe(false);
	});

	it('gives a chain step and an ungrouped subscription no siblings but themselves', () => {
		const chain = sub({ name: 'c1', pipeline_name: 'P', event: 'agent.completed' });
		expect(isSameTriggerGroup(chain, chain)).toBe(true);
		expect(
			isSameTriggerGroup(chain, sub({ name: 'c2', pipeline_name: 'P', event: 'agent.completed' }))
		).toBe(false);

		// No `pipeline_name` predates grouping: an identical twin is still a
		// different subscription.
		const legacy = sub({ name: 'legacy' });
		expect(isSameTriggerGroup(legacy, legacy)).toBe(true);
		expect(isSameTriggerGroup(legacy, sub({ name: 'legacy-2' }))).toBe(false);
	});
});
