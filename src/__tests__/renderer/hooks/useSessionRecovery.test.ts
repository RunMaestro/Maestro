import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSessionRecovery } from '../../../renderer/hooks/agent/useSessionRecovery';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { contextGroomingService } from '../../../renderer/services/contextGroomer';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

vi.mock('../../../renderer/services/contextGroomer', () => ({
	contextGroomingService: { groomContexts: vi.fn() },
	buildContextTransferPrompt: vi.fn(() => 'Recover context'),
}));

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 'recovery-agent',
				toolType: 'claude-code',
				providerOverrides: { codex: { customModel: 'gpt-work' } },
				activeTabId: 'recovery-tab',
				aiTabs: [
					createMockAITab({
						id: 'recovery-tab',
						tabProvider: 'claude-code',
						turnProvider: 'codex',
						agentSessionId: null,
						logs: [{ id: 'u1', timestamp: 1, source: 'user', text: 'Prior work' }],
					}),
				],
			}),
		],
	});
});

describe('Ensemble session recovery', () => {
	it('pins the failed provider while grooming and focus change', async () => {
		let finish!: (value: never) => void;
		vi.mocked(contextGroomingService.groomContexts).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const processInputRef = { current: vi.fn() };
		const { result } = renderHook(() => useSessionRecovery({ processInputRef }));
		await act(async () => {
			const recovery = result.current.startRecovery({
				sessionId: 'recovery-agent',
				tabId: 'recovery-tab',
				lastUserPrompt: 'continue',
				groomContext: true,
			});
			useSessionStore.setState({ activeSessionId: 'another-agent' });
			finish({ success: true, groomedLogs: [{ source: 'user', text: 'Prior work' }] } as never);
			await recovery;
		});
		expect(contextGroomingService.groomContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				targetAgent: 'codex',
				sources: [expect.objectContaining({ agentType: 'codex' })],
			}),
			expect.any(Function)
		);
		expect(processInputRef.current).toHaveBeenCalledWith(
			'continue',
			expect.objectContaining({
				sessionId: 'recovery-agent',
				tabId: 'recovery-tab',
				turnSettings: expect.objectContaining({ provider: 'codex', model: 'gpt-work' }),
			})
		);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].tabProvider).toBe('claude-code');
	});

	it('does not resend into another tab when the recovery tab closes during grooming', async () => {
		vi.mocked(contextGroomingService.groomContexts).mockImplementationOnce(async () => {
			useSessionStore.setState({ sessions: [] });
			return { success: true, groomedLogs: [] } as never;
		});
		const processInputRef = { current: vi.fn() };
		const { result } = renderHook(() => useSessionRecovery({ processInputRef }));
		await act(async () => {
			await result.current.startRecovery({
				sessionId: 'recovery-agent',
				tabId: 'recovery-tab',
				lastUserPrompt: 'continue',
				groomContext: true,
			});
		});
		expect(processInputRef.current).not.toHaveBeenCalled();
		expect(result.current.recoveryError).toBe('Recovery tab was closed');
	});
});
