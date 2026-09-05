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
} from '../../../renderer/utils/activeSessionPersistence';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
	isElectronDesktop: vi.fn(() => true),
}));

const asWebDesktop = (value: boolean) => vi.mocked(isWebDesktop).mockReturnValue(value);

describe('activeSessionPersistence', () => {
	let setActiveSessionId: ReturnType<typeof vi.fn>;
	let getActiveSessionId: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		localStorage.clear();
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
			await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
		});
	});

	describe('in web-desktop', () => {
		beforeEach(() => asWebDesktop(true));

		it('records its own pointer while still reporting to the shared one', () => {
			persistActiveSessionId('agent-2');
			expect(localStorage.getItem(WEB_ACTIVE_SESSION_STORAGE_KEY)).toBe('agent-2');
			// Still reported: plugin `session.activated` and the CLI's current-agent
			// answer are built on the shared value. Only the READ is per-client.
			expect(setActiveSessionId).toHaveBeenCalledWith('agent-2');
		});

		it('restores the agent this browser was last on', async () => {
			localStorage.setItem(WEB_ACTIVE_SESSION_STORAGE_KEY, 'browser-agent');
			await expect(readPersistedActiveSessionId()).resolves.toBe('browser-agent');
			expect(getActiveSessionId).not.toHaveBeenCalled();
		});

		it('falls back to the desktop pointer on a first visit', async () => {
			await expect(readPersistedActiveSessionId()).resolves.toBe('desktop-agent');
		});
	});

	it('returns an empty id when there is no bridge at all', async () => {
		(window as unknown as { maestro: unknown }).maestro = {};
		await expect(readPersistedActiveSessionId()).resolves.toBe('');
	});
});
