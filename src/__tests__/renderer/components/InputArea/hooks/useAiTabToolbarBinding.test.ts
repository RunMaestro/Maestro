import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAiTabToolbarBinding } from '../../../../../renderer/components/InputArea/hooks/useAiTabToolbarBinding';
import { createInputAreaSession } from '../_fixtures';
import type { AITab } from '../../../../../renderer/types';

const mockUpdateSessionWith = vi.fn();
const storeMocks = vi.hoisted(() => ({ sessions: [] as unknown[] }));
vi.mock('../../../../../renderer/stores/sessionStore', () => ({
	updateSessionWith: (...args: unknown[]) => mockUpdateSessionWith(...args),
	useSessionStore: { getState: () => ({ sessions: storeMocks.sessions }) },
	selectSessionById: (id: string) => (state: { sessions: { id: string }[] }) =>
		state.sessions.find((session) => session.id === id),
}));
const mockUpdateHostedTab = vi.fn();
vi.mock('../../../../../renderer/services/hostedTurns', () => ({
	updateHostedTab: (...args: unknown[]) => mockUpdateHostedTab(...args),
}));

describe('useAiTabToolbarBinding', () => {
	afterEach(() => {
		mockUpdateSessionWith.mockClear();
		mockUpdateHostedTab.mockClear();
		storeMocks.sessions = [];
	});

	function bind(tabOverrides: Partial<AITab> = {}) {
		const base = createInputAreaSession();
		const session = {
			...base,
			aiTabs: base.aiTabs.map((t) => (t.id === 'tab-1' ? { ...t, ...tabOverrides } : t)),
		};
		const activeTab = session.aiTabs.find((t) => t.id === session.activeTabId);
		const { result, rerender } = renderHook(({ tab }) => useAiTabToolbarBinding(session.id, tab), {
			initialProps: { tab: activeTab },
		});
		return { session, result, rerender, activeTab };
	}

	function lastUpdatedTab(session: ReturnType<typeof bind>['session']) {
		const [sessionId, updater] = mockUpdateSessionWith.mock.calls.at(-1)!;
		expect(sessionId).toBe(session.id);
		return updater(session).aiTabs.find((t: AITab) => t.id === 'tab-1');
	}

	it("reads the active tab's permission mode", () => {
		expect(bind().result.current.permissionMode).toBe('full');
		expect(bind({ readOnlyMode: true }).result.current.permissionMode).toBe('readonly');
		expect(bind({ permissionMode: 'standard' }).result.current.permissionMode).toBe('standard');
	});

	it('writes a permission mode with readOnlyMode in lockstep', () => {
		const { session, result } = bind();

		result.current.onPermissionModeChange('standard');
		expect(lastUpdatedTab(session)).toMatchObject({
			permissionMode: 'standard',
			readOnlyMode: false,
		});

		result.current.onPermissionModeChange('readonly');
		expect(lastUpdatedTab(session)).toMatchObject({
			permissionMode: 'readonly',
			readOnlyMode: true,
		});
	});

	it('writes a thinking mode by name', () => {
		const { session, result } = bind();

		result.current.onThinkingModeChange('sticky');

		expect(lastUpdatedTab(session).showThinking).toBe('sticky');
	});

	it('hands the thinking mode to the same tab on a hosted agent host (no-op for the others)', () => {
		const { session, result } = bind();
		storeMocks.sessions = [session];

		result.current.onThinkingModeChange('on');

		// updateHostedTab() is a no-op for a local or SSH agent, so every mode takes one path.
		expect(mockUpdateHostedTab).toHaveBeenCalledWith(session, 'tab-1', { thinking: 'on' });
	});

	it('writes nothing without an active tab', () => {
		const { result } = renderHook(() => useAiTabToolbarBinding('session-1', undefined));

		result.current.onPermissionModeChange('readonly');
		result.current.onThinkingModeChange('on');

		expect(mockUpdateSessionWith).not.toHaveBeenCalled();
	});

	it('keeps its callbacks across renders of the same tab', () => {
		const { result, rerender, activeTab } = bind();
		const first = result.current;

		rerender({ tab: activeTab ? { ...activeTab } : undefined });

		expect(result.current.onPermissionModeChange).toBe(first.onPermissionModeChange);
		expect(result.current.onThinkingModeChange).toBe(first.onThinkingModeChange);
	});
});
