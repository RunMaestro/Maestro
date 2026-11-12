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
	pipelineAgentScopes,
	pipelineInvolvesSession,
	pipelinesForSession,
	resolvePipelineHomes,
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

describe('resolvePipelineHomes', () => {
	it('files a pipeline under the agent whose cue.yaml declares it', () => {
		const p = pipeline('Fanout', [triggerNode('t'), agentNode('a', 'sess-2')]);
		const homes = resolvePipelineHomes([p], [graphSession('sess-1', ['Fanout'])]);
		expect(homes.get(p.id)).toEqual({ sessionId: 'sess-1', sessionName: 'sess-1' });
	});

	it('picks the agent declaring the most of a chained pipeline', () => {
		const p = pipeline('Chain', [agentNode('a', 'sess-1'), agentNode('b', 'sess-2')]);
		const graph = [graphSession('sess-1', ['Chain']), graphSession('sess-2', ['Chain', 'Chain'])];
		expect(resolvePipelineHomes([p], graph).get(p.id)?.sessionId).toBe('sess-2');
	});

	it('breaks a declaration tie toward the agent drawn in the pipeline', () => {
		const p = pipeline('Shared', [agentNode('a', 'sess-b')]);
		const graph = [graphSession('sess-a', ['Shared']), graphSession('sess-b', ['Shared'])];
		expect(resolvePipelineHomes([p], graph).get(p.id)?.sessionId).toBe('sess-b');
	});

	it('breaks a full tie alphabetically, so the result does not depend on input order', () => {
		const p = pipeline('Tied', [triggerNode('t')]);
		const forward = [graphSession('sess-a', ['Tied']), graphSession('sess-b', ['Tied'])];
		const reversed = [...forward].reverse();
		expect(resolvePipelineHomes([p], forward).get(p.id)?.sessionId).toBe('sess-a');
		expect(resolvePipelineHomes([p], reversed).get(p.id)?.sessionId).toBe('sess-a');
	});

	it('falls back to the first agent node when nobody declares the pipeline', () => {
		const p = pipeline('Unsaved', [triggerNode('t'), agentNode('a', 'sess-9')]);
		expect(resolvePipelineHomes([p]).get(p.id)?.sessionId).toBe('sess-9');
	});

	it('falls back to a command node owner', () => {
		const p = pipeline('Shell', [triggerNode('t'), commandNode('c', 'sess-4')]);
		expect(resolvePipelineHomes([p]).get(p.id)?.sessionId).toBe('sess-4');
	});

	it('leaves a pipeline with no agent anywhere out of the map', () => {
		const p = pipeline('Orphan', [triggerNode('t')]);
		expect(resolvePipelineHomes([p]).has(p.id)).toBe(false);
	});
});

describe('pipelineAgentScopes', () => {
	const mine = pipeline('Mine', [triggerNode('t1'), commandNode('c1', 'sess-1')]);
	const theirs = pipeline('Theirs', [triggerNode('t2'), agentNode('a2', 'sess-2')]);

	it('lists every agent that owns a pipeline, alphabetically, with its pipelines', () => {
		const sessions = [
			{ id: 'sess-2', name: 'Zed' },
			{ id: 'sess-1', name: 'Amy' },
			{ id: 'sess-3', name: 'Idle' },
		];
		expect(pipelineAgentScopes(sessions, [mine, theirs])).toEqual([
			{ sessionId: 'sess-1', sessionName: 'Amy', pipelineIds: [mine.id] },
			{ sessionId: 'sess-2', sessionName: 'Zed', pipelineIds: [theirs.id] },
		]);
	});

	it('counts pipelines the agent only declares', () => {
		const sessions = [{ id: 'sess-1', name: 'Amy' }];
		const graph = [graphSession('sess-1', ['Theirs'])];
		expect(pipelineAgentScopes(sessions, [mine, theirs], graph)[0].pipelineIds).toEqual([
			mine.id,
			theirs.id,
		]);
	});
});
