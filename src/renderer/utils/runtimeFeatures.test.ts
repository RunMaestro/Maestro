import { describe, expect, it } from 'vitest';
import type { AgentRuntimeFeatureState } from '../../shared/agent-runtime-features';
import type { Session } from '../types';
import { resolveRuntimeFeatures } from './runtimeFeatures';

function featureState(marker: string): AgentRuntimeFeatureState {
	return {
		controls: [{ id: 'thinking-level', label: marker, kind: 'select' }],
		tree: null,
		todos: null,
		subagents: null,
		stats: null,
	};
}

interface SessionSeed {
	sessionFeatures?: AgentRuntimeFeatureState | null;
	activeTabId?: string;
	tabs?: { id: string; runtimeFeatures?: AgentRuntimeFeatureState | null }[];
}

function makeSession(seed: SessionSeed): Session {
	// Cast: resolveRuntimeFeatures reads only id/activeTabId/aiTabs/runtimeFeatures,
	// so a minimal seed stands in for the full Session shape.
	return {
		id: 'session-1',
		activeTabId: seed.activeTabId,
		aiTabs: seed.tabs?.map((tab) => ({ id: tab.id, runtimeFeatures: tab.runtimeFeatures })),
		runtimeFeatures: seed.sessionFeatures,
	} as unknown as Session;
}

describe('resolveRuntimeFeatures', () => {
	it('prefers the active tab projection and addresses actions to that tab', () => {
		const tabFeatures = featureState('tab-a');
		const resolved = resolveRuntimeFeatures(
			makeSession({
				sessionFeatures: featureState('base'),
				activeTabId: 'tab-a',
				tabs: [
					{ id: 'tab-a', runtimeFeatures: tabFeatures },
					{ id: 'tab-b', runtimeFeatures: featureState('tab-b') },
				],
			})
		);
		expect(resolved).toEqual({ features: tabFeatures, ownerId: 'session-1-ai-tab-a' });
	});

	it('switches owner when the active tab switches', () => {
		const session = makeSession({
			sessionFeatures: featureState('base'),
			activeTabId: 'tab-b',
			tabs: [
				{ id: 'tab-a', runtimeFeatures: featureState('tab-a') },
				{ id: 'tab-b', runtimeFeatures: featureState('tab-b') },
			],
		});
		expect(resolveRuntimeFeatures(session)?.ownerId).toBe('session-1-ai-tab-b');
		expect(resolveRuntimeFeatures(session)?.features.controls[0].label).toBe('tab-b');
	});

	it('falls back to the base session only when it owns a projection', () => {
		const baseFeatures = featureState('base');
		const resolved = resolveRuntimeFeatures(
			makeSession({
				sessionFeatures: baseFeatures,
				activeTabId: 'tab-a',
				tabs: [{ id: 'tab-a', runtimeFeatures: undefined }],
			})
		);
		expect(resolved).toEqual({ features: baseFeatures, ownerId: 'session-1' });
	});

	it('never leaks another tab projection to a cleared active tab', () => {
		const resolved = resolveRuntimeFeatures(
			makeSession({
				sessionFeatures: undefined,
				activeTabId: 'tab-a',
				tabs: [
					{ id: 'tab-a', runtimeFeatures: undefined },
					{ id: 'tab-b', runtimeFeatures: featureState('tab-b') },
				],
			})
		);
		expect(resolved).toBeNull();
	});

	it('returns null when nothing owns a projection', () => {
		expect(resolveRuntimeFeatures(makeSession({}))).toBeNull();
	});
});
