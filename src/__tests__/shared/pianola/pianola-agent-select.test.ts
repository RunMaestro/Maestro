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
