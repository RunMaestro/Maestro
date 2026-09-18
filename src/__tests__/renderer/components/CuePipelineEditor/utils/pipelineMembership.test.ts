/**
 * Tests for pipelinesForSession - which pipelines the Cue dashboard credits to
 * an agent.
 *
 * The predicate this replaced matched agent nodes only, which made a
 * command-only pipeline (trigger + shell node, no agent node) look ownerless:
 * the Sessions table printed its empty-dash placeholder and "View in Graph"
 * had nothing to select.
 */

import { describe, it, expect } from 'vitest';
import {
	pipelineInvolvesSession,
	pipelinesForSession,
} from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineMembership';
import type {
	CueGraphSession,
	CuePipeline,
	PipelineNode,
} from '../../../../../shared/cue-pipeline-types';

const agentNode = (id: string, sessionId: string): PipelineNode => ({
	id,
	type: 'agent',
	position: { x: 0, y: 0 },
	data: { sessionId, sessionName: sessionId, toolType: 'claude-code' },
});

const commandNode = (id: string, owningSessionId: string): PipelineNode => ({
	id,
	type: 'command',
	position: { x: 0, y: 0 },
	data: {
		name: id,
		mode: 'shell',
		shell: 'echo hi',
		owningSessionId,
		owningSessionName: owningSessionId,
	},
});

const triggerNode = (id: string): PipelineNode => ({
	id,
	type: 'trigger',
	position: { x: 0, y: 0 },
	data: { eventType: 'time.heartbeat', label: 'Heartbeat', config: {} },
});

const pipeline = (name: string, nodes: PipelineNode[]): CuePipeline => ({
	id: `pipeline-${name}`,
	name,
	color: '#8b5cf6',
	nodes,
	edges: [],
});

const graphSession = (sessionId: string, pipelineNames: string[]): CueGraphSession => ({
	sessionId,
	sessionName: sessionId,
	toolType: 'claude-code',
	subscriptions: pipelineNames.map((pipeline_name, i) => ({
		name: `sub-${i}`,
		event: 'time.heartbeat' as const,
		enabled: true,
		prompt: '',
		pipeline_name,
	})),
});

describe('pipelineInvolvesSession', () => {
	it('matches an agent node bound to the session', () => {
		expect(pipelineInvolvesSession(pipeline('P', [agentNode('a', 'sess-1')]), 'sess-1')).toBe(true);
	});

	it('matches a command node owned by the session', () => {
		const p = pipeline('P', [triggerNode('t'), commandNode('c', 'sess-1')]);
		expect(pipelineInvolvesSession(p, 'sess-1')).toBe(true);
	});

	it('does not match a pipeline belonging to another agent', () => {
		const p = pipeline('P', [triggerNode('t'), commandNode('c', 'sess-2')]);
		expect(pipelineInvolvesSession(p, 'sess-1')).toBe(false);
	});
});

describe('pipelinesForSession', () => {
	const mine = pipeline('Mine', [triggerNode('t1'), commandNode('c1', 'sess-1')]);
	const theirs = pipeline('Theirs', [triggerNode('t2'), agentNode('a2', 'sess-2')]);
	const declaredOnly = pipeline('Declared', [triggerNode('t3'), agentNode('a3', 'sess-2')]);

	it('returns the command-only pipeline the agent owns', () => {
		expect(pipelinesForSession('sess-1', [mine, theirs])).toEqual([mine]);
	});

	it('includes a pipeline declared in the agent cue.yaml that targets someone else', () => {
		const graph = [graphSession('sess-1', ['Declared'])];
		expect(pipelinesForSession('sess-1', [mine, theirs, declaredOnly], graph)).toEqual([
			mine,
			declaredOnly,
		]);
	});

	it('counts a pipeline once when the agent both declares and appears in it', () => {
		const graph = [graphSession('sess-1', ['Mine'])];
		expect(pipelinesForSession('sess-1', [mine, theirs], graph)).toEqual([mine]);
	});

	it('returns nothing when the agent owns no pipelines', () => {
		expect(pipelinesForSession('sess-3', [mine, theirs])).toEqual([]);
	});
});
