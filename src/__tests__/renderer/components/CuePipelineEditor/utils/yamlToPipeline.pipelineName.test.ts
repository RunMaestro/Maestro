/**
 * Regression tests for `pipeline_name`-based grouping.
 *
 * Before this change, subscriptions were grouped into pipelines by
 * stripping the `-chain-N` / `-fanin` suffix off their `name` field. If
 * the user edited a subscription's `name` in YAML (the most natural way
 * to rename a pipeline), pipelines would split or lose chain links on
 * reload — what the user saw in the UI no longer matched the YAML.
 *
 * With `pipeline_name` as an explicit, authoritative field, subscription
 * `name` is just a unique ID and can be freely edited without breaking
 * pipeline membership. Legacy YAML (no `pipeline_name`) still loads via
 * the suffix convention.
 */

import { describe, it, expect } from 'vitest';

import { subscriptionsToPipelines } from '../../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline';
import type { CueSubscription } from '../../../../../shared/cue/contracts';

function makeSessions(entries: Array<[string, string]>) {
	return entries.map(([id, name]) => ({ id, name, toolType: 'claude-code' as const }));
}

describe('pipeline_name-based grouping', () => {
	it('groups subscriptions by explicit pipeline_name even when subscription names diverge', () => {
		// User edited the trigger subscription's `name` from "Pipeline 1"
		// to "Morning Run" but left the chain subs untouched. With
		// suffix-based grouping this used to split the pipeline into two
		// (trigger-only and chain-only) and break rendering.
		const subs: CueSubscription[] = [
			{
				name: 'Morning Run',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-a',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['A'],
				source_session_ids: ['sess-a'],
				agent_id: 'sess-b',
				pipeline_name: 'Pipeline 1',
			},
			{
				name: 'Pipeline 1-chain-2',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['B'],
				source_session_ids: ['sess-b'],
				agent_id: 'sess-c',
				pipeline_name: 'Pipeline 1',
			},
		];
		const sessions = makeSessions([
			['sess-a', 'A'],
			['sess-b', 'B'],
			['sess-c', 'C'],
		]);

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);
		expect(pipelines[0].name).toBe('Pipeline 1');
		const agentNames = pipelines[0].nodes
			.filter((n) => n.type === 'agent')
			.map((n) => (n.data as { sessionName: string }).sessionName);
		expect(agentNames).toEqual(expect.arrayContaining(['A', 'B', 'C']));
	});

	it('groups subscriptions by pipeline_name when `name`s collide across pipelines', () => {
		// Two pipelines where every subscription is named "Work" — would be
		// impossible to disambiguate via suffix convention. pipeline_name
		// makes this trivial.
		const subs: CueSubscription[] = [
			{
				name: 'Work',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-a',
				pipeline_name: 'Alpha',
			},
			{
				name: 'Work',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-b',
				pipeline_name: 'Bravo',
			},
		];
		const sessions = makeSessions([
			['sess-a', 'A'],
			['sess-b', 'B'],
		]);

		const pipelines = subscriptionsToPipelines(subs, sessions);
		const names = pipelines.map((p) => p.name).sort();
		expect(names).toEqual(['Alpha', 'Bravo']);
	});

	it('falls back to suffix-based grouping for legacy YAML (no pipeline_name)', () => {
		const subs: CueSubscription[] = [
			{
				name: 'legacy',
				event: 'time.heartbeat',
				enabled: true,
				prompt: '',
				interval_minutes: 5,
				agent_id: 'sess-a',
			},
			{
				name: 'legacy-chain-1',
				event: 'agent.completed',
				enabled: true,
				prompt: '',
				source_session: ['A'],
				agent_id: 'sess-b',
			},
		];
		const sessions = makeSessions([
			['sess-a', 'A'],
			['sess-b', 'B'],
		]);

		const pipelines = subscriptionsToPipelines(subs, sessions);
		expect(pipelines).toHaveLength(1);
		expect(pipelines[0].name).toBe('legacy');
	});
});
