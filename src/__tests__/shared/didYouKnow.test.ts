import { describe, expect, expectTypeOf, it } from 'vitest';
import { DID_YOU_KNOW_TIPS, PINNED_TIP_IDS } from '../../shared/didYouKnow';
import type { DidYouKnowTip } from '../../shared/didYouKnow';
import type { UiSurfaceEncoreFlag } from '../../shared/uiSurfaces';

describe('Did You Know tip model', () => {
	it('preserves the editorial order and permanent ids of the five pinned tips', () => {
		expect(PINNED_TIP_IDS).toEqual([
			'maestro-cue',
			'auto-run',
			'cross-agent-mentions',
			'group-chat',
			'remote-agents',
		]);
	});

	it('allows an icon plate without artwork or optional actions', () => {
		expectTypeOf<{
			id: string;
			title: string;
			headline: string;
			body: string[];
			icon: string;
		}>().toExtend<DidYouKnowTip>();
		expectTypeOf<DidYouKnowTip['encore']>().toEqualTypeOf<UiSurfaceEncoreFlag | undefined>();
		expectTypeOf(DID_YOU_KNOW_TIPS).toEqualTypeOf<readonly DidYouKnowTip[]>();
		expectTypeOf(PINNED_TIP_IDS).toEqualTypeOf<readonly string[]>();
	});
});
