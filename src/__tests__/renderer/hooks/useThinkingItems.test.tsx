import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useThinkingItems } from '../../../renderer/hooks/session/useThinkingItems';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockAITab, createMockSession } from '../../helpers';

describe('useThinkingItems provider ownership', () => {
	beforeEach(() => useSessionStore.setState({ sessions: [] }));

	it.each([false, true])(
		'refreshes captured owners for orphan=%s without token changes',
		(orphan) => {
			const tab = createMockAITab({ id: 'running', state: 'busy', turnProvider: 'claude-code' });
			const session = createMockSession({
				state: 'busy',
				busySource: 'ai',
				aiTabs: orphan ? [] : [tab],
				orphanedThinkingTabs: orphan ? [tab] : [],
			});
			useSessionStore.setState({ sessions: [session] });
			const { result } = renderHook(() => useThinkingItems());
			expect(result.current[0].tab?.turnProvider).toBe('claude-code');
			act(() =>
				useSessionStore.setState({
					sessions: [
						{
							...session,
							[orphan ? 'orphanedThinkingTabs' : 'aiTabs']: [
								{
									...tab,
									tabProvider: 'opencode',
									turnProvider: 'codex',
									turnSessionId: 'codex-native',
								},
							],
						},
					],
				})
			);
			expect(result.current[0].tab?.turnProvider).toBe('codex');
			expect(result.current[0].tab?.turnSessionId).toBe('codex-native');
			act(() =>
				useSessionStore.setState((state) => ({
					sessions: state.sessions.map((s) => ({
						...s,
						[orphan ? 'orphanedThinkingTabs' : 'aiTabs']: [
							{ ...result.current[0].tab!, turnSessionId: 'replacement-native' },
						],
					})),
				}))
			);
			expect(result.current[0].tab?.turnSessionId).toBe('replacement-native');
		}
	);
});
