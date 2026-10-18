/**
 * Tests for activeSessionPersistence.
 *
 * Which agent a client has in front of it is per-client view state. A
 * web-desktop browser tab reloads on every refocus, and while it shared the
 * desktop's stored pointer that reload dropped the user onto the desktop's agent
 * instead of the one they had been working in (issue #1398).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	persistActiveSessionId,
	readPersistedActiveSessionId,
	WEB_ACTIVE_SESSION_STORAGE_KEY,
	persistClientSessionView,
	restoreClientSessionView,
} from '../../../renderer/utils/activeSessionPersistence';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';
import { installLocalStorageMock, installSessionStorageMock } from '../../helpers/mockLocalStorage';
import { createMockSession, createMockAITab } from '../../helpers';

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));

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
