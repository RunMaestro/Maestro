// Source: src/__tests__/renderer/utils/activeSessionPersistence.test.ts
// Source: src/__tests__/renderer/hooks/session/usePianolaAgentActiveFallback.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { vi } from 'vitest';
import { persistActiveSessionId } from '../../../renderer/utils/activeSessionPersistence';
import { readPersistedActiveSessionId } from '../../../renderer/utils/activeSessionPersistence';
import { WEB_ACTIVE_SESSION_STORAGE_KEY } from '../../../renderer/utils/activeSessionPersistence';
import { persistClientSessionView } from '../../../renderer/utils/activeSessionPersistence';
import { restoreClientSessionView } from '../../../renderer/utils/activeSessionPersistence';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';
import { installLocalStorageMock } from '../../helpers/mockLocalStorage';
import { installSessionStorageMock } from '../../helpers/mockLocalStorage';
import { createMockSession } from '../../helpers';
import { createMockAITab } from '../../helpers';
import { afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as persistence from '../../../renderer/utils/activeSessionPersistence';
import { usePianolaAgent } from '../../../renderer/hooks/session/usePianolaAgent';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSidebarNavStore } from '../../../renderer/stores/sidebarNavStore';
import { ENCORE_FEATURE_DEFAULTS } from '../../../shared/encoreFeatureDefaults';
import type { Session } from '../../../renderer/types';
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));
describe('activeSessionPersistence', () => {
	const asWebDesktop = (value: boolean) => vi.mocked(isWebDesktop).mockReturnValue(value);

	describe('activeSessionPersistence', () => {
		let setActiveSessionId: ReturnType<typeof vi.fn>;
		let getActiveSessionId: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			// Both tiers are mocked rather than cleared: this environment ships no
			// working Storage, so a bare `localStorage.clear()` throws and takes the
			// whole suite with it. Installing fresh mocks doubles as the per-test reset.
			installLocalStorageMock();
			installSessionStorageMock();
			asWebDesktop(false);
			setActiveSessionId = vi.fn().mockResolvedValue(undefined);
			getActiveSessionId = vi.fn().mockResolvedValue('desktop-agent');
			(window as unknown as { maestro: unknown }).maestro = {
				sessions: { setActiveSessionId, getActiveSessionId },
			};
		});

		describe('on the desktop', () => {
			it('writes the shared pointer', () => {
				persistActiveSessionId('agent-1');
				expect(setActiveSessionId).toHaveBeenCalledWith('agent-1');
				expect(localStorage.getItem(WEB_ACTIVE_SESSION_STORAGE_KEY)).toBeNull();
			});

			it('reads the shared pointer, ignoring any web-desktop leftover', async () => {
				localStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'browser-agent');
				sessionStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'browser-tab-agent');
				await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
			});
		});

		describe('in web-desktop', () => {
			beforeEach(() => asWebDesktop(true));

			it('records independent focus without replacing the host pointer', async () => {
				let hostFocus = 'host-agent';
				setActiveSessionId.mockImplementation(async (id) => {
					hostFocus = id;
				});
				getActiveSessionId.mockImplementation(async () => hostFocus);
				persistActiveSessionId('agent-2');
				expect(await readPersistedActiveSessionId()).toBe('agent-2');
				expect(hostFocus).toBe('host-agent');
			});

			it('restores what THIS tab was on, not what another tab moved to', async () => {
				// Two tabs share an origin and therefore share localStorage, so a
				// tab-scoped answer has to win or the bleed just moves one level down.
				sessionStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'this-tab-agent');
				localStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'other-tab-agent');
				await expect(readPersistedActiveSessionId()).resolves.toBe('this-tab-agent');
				expect(getActiveSessionId).not.toHaveBeenCalled();
			});

			it('opens a fresh tab on the last agent used in this browser', async () => {
				localStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'browser-agent');
				await expect(readPersistedActiveSessionId()).resolves.toBe('browser-agent');
				expect(getActiveSessionId).not.toHaveBeenCalled();
			});

			it('falls back to the desktop pointer on a first visit', async () => {
				await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
			});

			it('falls back when browser Storage refuses reads', async () => {
				const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
					throw new DOMException('SecurityError');
				});
				try {
					await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
				} finally {
					blocked.mockRestore();
				}
			});

			it('never falls back to shared host writes when Storage refuses client focus', async () => {
				let hostFocus = 'host-agent';
				setActiveSessionId.mockImplementation(async (id) => {
					hostFocus = id;
				});
				getActiveSessionId.mockImplementation(async () => hostFocus);
				const blockedSession = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
					throw new DOMException('QuotaExceededError');
				});
				const blockedLocal = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
					throw new DOMException('QuotaExceededError');
				});
				try {
					persistActiveSessionId('agent-3');
					expect(await readPersistedActiveSessionId()).toBe('host-agent');
					expect(hostFocus).toBe('host-agent');
				} finally {
					blockedSession.mockRestore();
					blockedLocal.mockRestore();
				}
			});
			it('restores this client draft and tab after rebootstrap without copying host drafts', () => {
				const host = createMockSession({
					id: 'shared',
					activeTabId: 'host-tab',
					aiTabs: [createMockAITab({ id: 'one' })],
				});
				const own = {
					...host,
					activeTabId: 'my-tab',
					terminalDraftInput: 'my terminal draft',
					aiTabs: [{ ...host.aiTabs[0], inputValue: 'my unsent prompt' }],
				};
				persistClientSessionView(own);
				const restored = restoreClientSessionView({
					...host,
					aiTabs: [{ ...host.aiTabs[0], inputValue: 'host unsent prompt' }],
				});
				expect(restored.activeTabId).toBe('my-tab');
				expect(restored.aiTabs[0].inputValue).toBe('my unsent prompt');
				expect(restored.terminalDraftInput).toBe('my terminal draft');
				sessionStorage.clear();
				expect(restoreClientSessionView(own).aiTabs[0].inputValue).toBe('');
			});
			it('preserves a native client draft across view recreation without borrowing another window draft', async () => {
				const originalUrl = window.location.href;
				const host = createMockSession({
					id: 'shared',
					aiTabs: [createMockAITab({ id: 'one', inputValue: 'host draft' })],
				});
				try {
					window.history.replaceState(null, '', '?liteClientId=first-window');
					persistClientSessionView({
						...host,
						activeGroupId: 'first-group',
						aiTabs: [{ ...host.aiTabs[0], inputValue: 'first draft' }],
					});
					persistActiveSessionId('first-agent');
					sessionStorage.clear();
					window.history.replaceState(null, '', '?liteClientId=second-window');
					expect(restoreClientSessionView(host).aiTabs[0].inputValue).toBe('');
					persistClientSessionView({
						...host,
						aiTabs: [{ ...host.aiTabs[0], inputValue: 'second draft' }],
					});
					persistActiveSessionId('second-agent');
					sessionStorage.clear();
					window.history.replaceState(null, '', '?liteClientId=first-window');
					expect(restoreClientSessionView(host).aiTabs[0].inputValue).toBe('first draft');
					expect(restoreClientSessionView(host).activeGroupId).toBe('first-group');
					expect(await readPersistedActiveSessionId()).toBe('first-agent');
				} finally {
					window.history.replaceState(null, '', originalUrl);
				}
			});
		});

		it('returns an empty id when there is no bridge at all', async () => {
			(window as unknown as { maestro: unknown }).maestro = {};
			await expect(readPersistedActiveSessionId()).resolves.toBe('');
		});
	});
});
describe('usePianolaAgentActiveFallback', () => {
	const agent = (id: string, isPianola = false) =>
		({ id, name: id, isPianola }) as unknown as Session;

	/**
	 * The Pianola agent outlives its Encore flag in the session store. If it is the
	 * active agent while the flag is off, the main panel shows an agent with no
	 * Left Bar row, so the hook moves the selection to a visible one.
	 */
	describe('usePianolaAgent: active agent while the flag is off', () => {
		afterEach(() => vi.restoreAllMocks());
		beforeEach(() => {
			vi.spyOn(persistence, 'persistActiveSessionId').mockReturnValue(undefined);
			vi.spyOn(persistence, 'readPersistedActiveSessionId').mockResolvedValue('');
			useSidebarNavStore.setState({ visibleSessions: [] });
			useSessionStore.setState({
				sessions: [agent('pianola', true), agent('alpha'), agent('beta')],
				activeSessionId: 'pianola',
				sessionsLoaded: true,
			});
		});

		it('moves off the hidden Pianola agent to the first visible agent', () => {
			useSidebarNavStore.setState({ visibleSessions: [agent('beta'), agent('alpha')] });

			renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: false }));

			expect(useSessionStore.getState().activeSessionId).toBe('beta');
		});

		it('falls back to any other agent when the Left Bar list is not built yet', () => {
			renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: false }));

			expect(useSessionStore.getState().activeSessionId).toBe('alpha');
		});

		it('leaves the selection alone while Pianola is on', () => {
			renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: true }));

			expect(useSessionStore.getState().activeSessionId).toBe('pianola');
		});

		it('stays put when Pianola is the only agent', () => {
			useSessionStore.setState({ sessions: [agent('pianola', true)] });

			renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: false }));

			expect(useSessionStore.getState().activeSessionId).toBe('pianola');
		});
	});
});
