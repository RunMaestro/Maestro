import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRuntimeFeaturesListener } from '../../../../../renderer/hooks/agent/internal/useRuntimeFeaturesListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import type { AgentRuntimeFeatureState } from '../../../../../shared/agent-runtime-features';
import type { Session } from '../../../../../renderer/types';

const { ownedGate, openInSystemBrowser } = vi.hoisted(() => ({
	ownedGate: { current: (sessionId: string) => sessionId.startsWith('owned-session') },
	openInSystemBrowser: vi.fn(),
}));
let onOpenExternalUrl: ((sessionId: string, url: string) => void) | undefined;
let onRuntimeFeatures:
	| ((sessionId: string, features: AgentRuntimeFeatureState | null) => void)
	| undefined;

vi.mock('../../../../../renderer/hooks/agent/internal/useOwnedSessionGate', () => ({
	useOwnedSessionGate: () => ownedGate,
}));
vi.mock('../../../../../renderer/utils/openUrl', () => ({ openInSystemBrowser }));

const unsubscribe = vi.fn();
const mockProcess = {
	onRuntimeFeatures: vi.fn(
		(handler: (sessionId: string, features: AgentRuntimeFeatureState | null) => void) => {
			onRuntimeFeatures = handler;
			return unsubscribe;
		}
	),
	onApprovalRequest: vi.fn(() => unsubscribe),
	onApprovalCancelled: vi.fn(() => unsubscribe),
	onOpenExternalUrl: vi.fn((handler: (sessionId: string, url: string) => void) => {
		onOpenExternalUrl = handler;
		return unsubscribe;
	}),
	onComposerText: vi.fn(() => unsubscribe),
	onSessionTitle: vi.fn(() => unsubscribe),
};

function featureState(marker: string): AgentRuntimeFeatureState {
	return {
		controls: [{ id: 'thinking-level', label: marker, kind: 'select' }],
		tree: null,
		todos: null,
		subagents: null,
		stats: null,
	};
}

function seedSession(): void {
	// Cast: the listener touches only id/aiTabs/runtimeFeatures/pendingApprovals,
	// so a minimal session shape is sufficient.
	const session = {
		id: 'owned-session',
		activeTabId: 'tab-a',
		aiTabs: [
			{ id: 'tab-a', runtimeFeatures: featureState('seed-a') },
			{ id: 'tab-b', runtimeFeatures: featureState('seed-b') },
		],
		runtimeFeatures: featureState('seed-base'),
		pendingApprovals: [],
	} as unknown as Session;
	useSessionStore.setState({ sessions: [session] });
}

function storedSession(): Session {
	return useSessionStore.getState().sessions[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	onOpenExternalUrl = undefined;
	onRuntimeFeatures = undefined;
	// Cast: the hook only subscribes to these six process listeners; the rest of
	// the preload bridge surface is irrelevant to this suite.
	const processBridge = mockProcess as unknown as typeof window.maestro.process;
	window.maestro = { ...window.maestro, process: processBridge };
	seedSession();
});

describe('useRuntimeFeaturesListener', () => {
	it('opens broadcast URLs only in the owning Maestro window', () => {
		renderHook(() => useRuntimeFeaturesListener());

		onOpenExternalUrl!('foreign-session', 'https://example.com/foreign');
		expect(openInSystemBrowser).not.toHaveBeenCalled();

		onOpenExternalUrl!('owned-session', 'https://example.com/owned');
		expect(openInSystemBrowser).toHaveBeenCalledOnce();
		expect(openInSystemBrowser).toHaveBeenCalledWith('https://example.com/owned');
	});

	it('applies tab-scoped feature events only to the owning tab', () => {
		renderHook(() => useRuntimeFeaturesListener());
		const next = featureState('live-b');

		onRuntimeFeatures!('owned-session-ai-tab-b', next);

		const session = storedSession();
		expect(session.aiTabs[1].runtimeFeatures).toEqual(next);
		// Neither the base session nor the sibling tab is touched.
		expect(session.runtimeFeatures?.controls[0].label).toBe('seed-base');
		expect(session.aiTabs[0].runtimeFeatures?.controls[0].label).toBe('seed-a');
	});

	it('clearing inactive tab A never clears live tab B or the base projection', () => {
		renderHook(() => useRuntimeFeaturesListener());

		onRuntimeFeatures!('owned-session-ai-tab-a', null);

		const session = storedSession();
		expect(session.aiTabs[0].runtimeFeatures).toBeUndefined();
		expect(session.aiTabs[1].runtimeFeatures?.controls[0].label).toBe('seed-b');
		expect(session.runtimeFeatures?.controls[0].label).toBe('seed-base');
	});

	it('applies base-scoped feature events only to the base session', () => {
		renderHook(() => useRuntimeFeaturesListener());
		const next = featureState('live-base');

		onRuntimeFeatures!('owned-session', next);

		const session = storedSession();
		expect(session.runtimeFeatures).toEqual(next);
		expect(session.aiTabs[0].runtimeFeatures?.controls[0].label).toBe('seed-a');
		expect(session.aiTabs[1].runtimeFeatures?.controls[0].label).toBe('seed-b');
	});

	it('ignores feature events for sessions this window does not own', () => {
		renderHook(() => useRuntimeFeaturesListener());

		onRuntimeFeatures!('foreign-session-ai-tab-a', featureState('foreign'));

		const session = storedSession();
		expect(session.aiTabs[0].runtimeFeatures?.controls[0].label).toBe('seed-a');
	});
});
