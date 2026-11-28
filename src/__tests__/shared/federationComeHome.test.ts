/**
 * Tests for summarizeComeHomeReport: the one text the desktop's notice and `maestro-cli federation
 * auto` show after the job that brings moved agents home.
 */

import { describe, expect, it } from 'vitest';
import {
	summarizeComeHomeReport,
	type ComeHomeAgentOutcome,
} from '../../shared/federationComeHome';

const at = (ms: number) => `t${ms}`;
const report = (agents: ComeHomeAgentOutcome[]) => ({ startedAt: 1, finishedAt: 2, agents });

describe('summarizeComeHomeReport', () => {
	it('says nothing when there is no report, or no agent was moved', () => {
		expect(summarizeComeHomeReport(null)).toBeNull();
		expect(summarizeComeHomeReport(report([]))).toBeNull();
	});

	it('names an agent back online, and says when a turn on the host delayed it', () => {
		const summary = summarizeComeHomeReport(
			report([
				{
					id: 'a1',
					name: 'Docs',
					from: 'box:h1',
					result: 'online',
					waitedForHostTurn: true,
					notices: [],
				},
			]),
			at
		);
		expect(summary).toEqual({
			title: '1 agent moved back from its host',
			lines: [
				'"Docs" is an SSH agent again, with its conversations from box. It waited for a turn running on box to end.',
			],
			needsReview: false,
		});
	});

	it('for an agent back offline, says what may be missing, from when, and where it still is', () => {
		const summary = summarizeComeHomeReport(
			report([
				{
					id: 'a2',
					name: 'Api',
					from: 'box:h2',
					result: 'offline',
					missing: { peer: 'box', hostAgentId: 'h2', movedAt: 10, lastLocalRowAt: 20 },
					notices: ['The host did not answer: timed out'],
				},
			]),
			at
		);
		expect(summary?.needsReview).toBe(true);
		expect(summary?.lines[0]).toBe(
			`"Api" is an SSH agent again, from this machine's copy only. Anything written on box after t20 may be missing here: it is still on box, as agent h2. The host did not answer: timed out`
		);
		// No local row: the time of the move is the line.
		const moved = summarizeComeHomeReport(
			report([
				{
					id: 'a2',
					name: 'Api',
					from: 'box:h2',
					result: 'offline',
					missing: { peer: 'box', hostAgentId: 'h2', movedAt: 10 },
					notices: [],
				},
			]),
			at
		);
		expect(moved?.lines[0]).toContain('after t10');
	});

	it('counts an agent still on its host apart, and tells how to bring it back', () => {
		const summary = summarizeComeHomeReport(
			report([
				{ id: 'a1', name: 'Docs', from: 'box:h1', result: 'online', notices: [] },
				{ id: 'a3', name: 'Ops', from: 'gpu:h3', result: 'failed', notices: ['refused'] },
			]),
			at
		);
		expect(summary?.title).toBe('1 agent moved back from its host, 1 agent still on a host');
		expect(summary?.lines[1]).toBe(
			'"Ops" is still on gpu. Maestro tries again at the next launch, or run maestro-cli unlift "Ops". refused'
		);
		expect(summary?.needsReview).toBe(true);
	});
});
