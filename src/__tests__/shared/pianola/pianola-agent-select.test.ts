/**
 * @file pianola-agent-select.test.ts
 * @description Unit tests for the pure Pianola agent selector.
 */

import { describe, it, expect } from 'vitest';
import {
	selectAgentForTask,
	type AgentCandidate,
} from '../../../shared/pianola/pianola-agent-select';
import { DEFAULT_CAPABILITIES, type AgentCapabilities } from '../../../shared/types';
import type { PianolaTask } from '../../../shared/pianola/pianola-tasks';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';

function task(over: Partial<PianolaTask> = {}): PianolaTask {
	return { id: 't1', title: 'T1', prompt: 'do it', dependsOn: [], status: 'pending', ...over };
}

function caps(over: Partial<AgentCapabilities> = {}): AgentCapabilities {
	return { ...DEFAULT_CAPABILITIES, ...over };
}

function candidate(over: Partial<AgentCandidate> = {}): AgentCandidate {
	return { agentId: 'a', capabilities: caps(), status: 'ok', busy: false, inFlight: 0, ...over };
}

describe('selectAgentForTask', () => {
	it('chooses a ready, capable, not-busy agent', () => {
		const sel = selectAgentForTask(task(), [candidate({ agentId: 'claude-code' })]);
		expect(sel).toEqual({ agentId: 'claude-code' });
	});

	it('filters out a candidate missing a required capability', () => {
		const sel = selectAgentForTask(
			task(),
			[
				candidate({ agentId: 'no-images', capabilities: caps({ supportsImageInput: false }) }),
				candidate({ agentId: 'images', capabilities: caps({ supportsImageInput: true }) }),
			],
			{ required: ['supportsImageInput'] }
		);
		expect(sel).toEqual({ agentId: 'images' });
	});

	it('avoids a busy agent in favor of a free one', () => {
		const sel = selectAgentForTask(task(), [
			candidate({ agentId: 'busy-one', busy: true }),
			candidate({ agentId: 'free-one', busy: false }),
		]);
		expect(sel).toEqual({ agentId: 'free-one' });
	});

	it('prefers the lowest inFlight load', () => {
		const sel = selectAgentForTask(task(), [
			candidate({ agentId: 'loaded', inFlight: 3 }),
			candidate({ agentId: 'light', inFlight: 1 }),
		]);
		expect(sel).toEqual({ agentId: 'light' });
	});

	it('breaks an inFlight tie deterministically by agent id', () => {
		const sel = selectAgentForTask(task(), [
			candidate({ agentId: 'zeta', inFlight: 2 }),
			candidate({ agentId: 'alpha', inFlight: 2 }),
		]);
		expect(sel).toEqual({ agentId: 'alpha' });
	});

	it('escalates when there are no candidates', () => {
		const sel = selectAgentForTask(task(), []);
		expect('escalate' in sel).toBe(true);
	});

	it('escalates when every candidate is unready (status not ok)', () => {
		const sel = selectAgentForTask(task(), [
			candidate({ agentId: 'a', status: 'auth_required' }),
			candidate({ agentId: 'b', status: 'not_installed' }),
		]);
		expect('escalate' in sel).toBe(true);
	});

	it('escalates when every ready candidate is busy', () => {
		const sel = selectAgentForTask(task(), [
			candidate({ agentId: 'a', busy: true }),
			candidate({ agentId: 'b', busy: true }),
		]);
		expect('escalate' in sel).toBe(true);
	});

	it('escalates when no candidate supports a required capability', () => {
		const sel = selectAgentForTask(
			task(),
			[candidate({ agentId: 'a' }), candidate({ agentId: 'b' })],
			{
				required: ['supportsImageInput'],
			}
		);
		expect('escalate' in sel).toBe(true);
	});

	it('keeps a stable binding when the task is pinned to an eligible agent', () => {
		const sel = selectAgentForTask(task({ agentId: 'pinned' }), [
			candidate({ agentId: 'lighter', inFlight: 0 }),
			candidate({ agentId: 'pinned', inFlight: 5 }),
		]);
		expect(sel).toEqual({ agentId: 'pinned' });
	});

	it('ignores a pinned agent that is not eligible and selects another', () => {
		const sel = selectAgentForTask(task({ agentId: 'pinned-busy' }), [
			candidate({ agentId: 'pinned-busy', busy: true }),
			candidate({ agentId: 'free', busy: false }),
		]);
		expect(sel).toEqual({ agentId: 'free' });
	});
});

/**
 * Grok enters the shared selector through its REAL capability
 * record (getAgentCapabilities), never a hand-written one, so a flag the
 * registry says Grok lacks excludes it and a flag it has keeps it. No branch
 * of the selector names a provider; these prove a Grok candidate is ranked by
 * the same readiness, busy, load, and pin rules as any sibling.
 */
describe('selectAgentForTask with Grok candidates', () => {
	const grok = (over: Partial<AgentCandidate> = {}): AgentCandidate =>
		candidate({ agentId: 'grok', capabilities: getAgentCapabilities('grok'), ...over });
	const claude = (over: Partial<AgentCandidate> = {}): AgentCandidate =>
		candidate({
			agentId: 'claude-code',
			capabilities: getAgentCapabilities('claude-code'),
			...over,
		});

	it('picks a ready Grok agent with its real capabilities when it is the least loaded', () => {
		const sel = selectAgentForTask(task(), [claude({ inFlight: 2 }), grok({ inFlight: 1 })]);
		expect(sel).toEqual({ agentId: 'grok' });
	});

	it('keeps Grok for required flags its registry record supports', () => {
		const sel = selectAgentForTask(task(), [claude({ inFlight: 1 }), grok({ inFlight: 0 })], {
			required: ['supportsBatchMode', 'supportsUsageStats', 'supportsResume', 'supportsJsonOutput'],
		});
		expect(sel).toEqual({ agentId: 'grok' });
	});

	it('excludes Grok for a required flag its registry record lacks, even when lighter', () => {
		expect(getAgentCapabilities('grok').supportsStreamJsonInput).toBe(false);
		const sel = selectAgentForTask(task(), [grok({ inFlight: 0 }), claude({ inFlight: 4 })], {
			required: ['supportsStreamJsonInput'],
		});
		expect(sel).toEqual({ agentId: 'claude-code' });
	});

	it('escalates, naming the task, when only Grok is offered and it lacks a required flag', () => {
		expect(getAgentCapabilities('grok').supportsGroupChatModeration).toBe(false);
		const sel = selectAgentForTask(task({ id: 'needs-moderation' }), [grok()], {
			required: ['supportsGroupChatModeration'],
		});
		expect(sel).toEqual({
			escalate:
				'no ready, capable agent for task "needs-moderation": every candidate is busy, unready, or lacks a required capability',
		});
	});

	it.each(['not_installed', 'auth_required', 'not_configured', 'probing', 'failed'] as const)(
		'never picks a Grok agent whose status is %s',
		(status) => {
			expect(selectAgentForTask(task(), [grok({ status })])).toHaveProperty('escalate');
			expect(selectAgentForTask(task(), [grok({ status }), claude({ inFlight: 9 })])).toEqual({
				agentId: 'claude-code',
			});
		}
	);

	it('passes over a busy Grok agent and escalates when Grok is the only one and busy', () => {
		expect(selectAgentForTask(task(), [grok({ busy: true }), claude({ inFlight: 3 })])).toEqual({
			agentId: 'claude-code',
		});
		expect(selectAgentForTask(task(), [grok({ busy: true })])).toHaveProperty('escalate');
	});

	it('keeps a task pinned to an eligible Grok agent over a lighter sibling', () => {
		const sel = selectAgentForTask(task({ agentId: 'grok', agentType: 'grok' }), [
			claude({ inFlight: 0 }),
			grok({ inFlight: 5 }),
		]);
		expect(sel).toEqual({ agentId: 'grok' });
	});

	it('drops a Grok pin that lost a required flag or went busy, rather than dispatching to it', () => {
		const pinned = task({ agentId: 'grok', agentType: 'grok' });
		expect(
			selectAgentForTask(pinned, [grok(), claude({ inFlight: 2 })], {
				required: ['supportsSlashCommands'],
			})
		).toEqual({ agentId: 'claude-code' });
		expect(selectAgentForTask(pinned, [grok({ busy: true }), claude({ inFlight: 2 })])).toEqual({
			agentId: 'claude-code',
		});
	});

	it('breaks a Grok load tie by agent id and leaves the candidate list untouched', () => {
		const candidates = [
			grok({ agentId: 'grok-b', inFlight: 1 }),
			grok({ agentId: 'grok-a', inFlight: 1 }),
		];
		const snapshot = JSON.parse(JSON.stringify(candidates));
		expect(selectAgentForTask(task(), candidates)).toEqual({ agentId: 'grok-a' });
		expect(candidates).toEqual(snapshot);
	});
});
