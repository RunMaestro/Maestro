import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAiTabToolbarBinding } from '../../../../../renderer/components/InputArea/hooks/useAiTabToolbarBinding';
import { createInputAreaSession } from '../_fixtures';
import type { AITab } from '../../../../../renderer/types';
import { AGENT_MODES, agentModeFields } from '../../../../helpers/mockSession';

const mockUpdateSessionWith = vi.fn();
vi.mock('../../../../../renderer/stores/sessionStore', () => ({
	updateSessionWith: (...args: unknown[]) => mockUpdateSessionWith(...args),
}));
// The thinking write (and its hand-off to a hosted agent's host) is the shared service, covered in
// tabThinkingMode.test; this binding only routes the pick there.
const mockSetTabThinkingMode = vi.fn();
vi.mock('../../../../../renderer/services/tabThinkingMode', () => ({
	setTabThinkingMode: (...args: unknown[]) => mockSetTabThinkingMode(...args),
}));

describe('useAiTabToolbarBinding', () => {
	afterEach(() => {
		mockUpdateSessionWith.mockClear();
		mockSetTabThinkingMode.mockClear();
	});

	function bind(tabOverrides: Partial<AITab> = {}, mode: (typeof AGENT_MODES)[number] = 'local') {
		const base = createInputAreaSession(agentModeFields(mode));
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

	it('writes a thinking mode by name through the shared write', () => {
		const { session, result } = bind();

		result.current.onThinkingModeChange('sticky');

		expect(mockSetTabThinkingMode).toHaveBeenCalledWith(session.id, 'tab-1', 'sticky');
	});

	it('sets the thinking and permission pills the same way in every mode (mode parity)', () => {
		// docs/parity/agent-ux-parity.md, Composer: one binding for every mode. The host
		// hand-off lives in the shared thinking write, a no-op for a local or SSH agent.
		const outcomes = AGENT_MODES.map((mode) => {
			mockUpdateSessionWith.mockClear();
			mockSetTabThinkingMode.mockClear();
			const { session, result } = bind({}, mode);
			result.current.onThinkingModeChange('sticky');
			result.current.onPermissionModeChange('readonly');
			const { permissionMode, readOnlyMode } = lastUpdatedTab(session);
			return {
				thinking: mockSetTabThinkingMode.mock.calls.map((call) => call.slice(1)),
				permissionMode,
				readOnlyMode,
			};
		});
		expect(outcomes[0]).toEqual({
			thinking: [['tab-1', 'sticky']],
			permissionMode: 'readonly',
			readOnlyMode: true,
		});
		expect(outcomes[1]).toEqual(outcomes[0]);
		expect(outcomes[2]).toEqual(outcomes[0]);
	});

	it('writes nothing without an active tab', () => {
		const { result } = renderHook(() => useAiTabToolbarBinding('session-1', undefined));

		result.current.onPermissionModeChange('readonly');
		result.current.onThinkingModeChange('on');

		expect(mockUpdateSessionWith).not.toHaveBeenCalled();
		expect(mockSetTabThinkingMode).not.toHaveBeenCalled();
	});

	it('keeps its callbacks across renders of the same tab', () => {
		const { result, rerender, activeTab } = bind();
		const first = result.current;

		rerender({ tab: activeTab ? { ...activeTab } : undefined });

		expect(result.current.onPermissionModeChange).toBe(first.onPermissionModeChange);
		expect(result.current.onThinkingModeChange).toBe(first.onThinkingModeChange);
	});
});
