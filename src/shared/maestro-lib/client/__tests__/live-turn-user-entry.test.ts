/**
 * A user entry a host announces again mid-turn (a steer whose outcome it stamped since) takes its
 * own place in the live turn, never drawn twice (CodeRabbit on #2171, R51).
 */
import { describe, expect, it } from 'vitest';

import { foldLiveTurn, type LiveTurn } from '../live-turn';
import type { TurnEvent } from '../types';

const ctx = { newId: () => 'id' };

describe('foldLiveTurn: a user entry announced again', () => {
	it('replaces the entry with the same id, in place', () => {
		const steer = {
			id: 's1',
			timestamp: 2,
			source: 'user',
			text: 'Also the README',
			steered: true,
			steerState: 'pending' as const,
		};
		let live: LiveTurn | undefined;
		for (const event of [
			{ kind: 'user', at: 1, entry: { id: 'u1', timestamp: 1, source: 'user', text: 'Go' } },
			{ kind: 'user', at: 2, entry: steer },
			{ kind: 'user', at: 3, entry: { ...steer, steerState: 'queued' as const } },
		] as TurnEvent[]) {
			live = foldLiveTurn(live, event, ctx) ?? live;
		}
		expect(live?.entries.map((entry) => [entry.id, entry.steerState])).toEqual([
			['u1', undefined],
			['s1', 'queued'],
		]);
	});
});
