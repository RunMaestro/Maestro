/**
 * Web Login session helpers.
 *
 * Two rules worth a test each: the sign-out POST is token-scoped and carries
 * the cookie (`credentials: 'same-origin'`, or the server cannot tell WHICH
 * session to revoke), and a failed POST still lands the user on the login page
 * rather than leaving them inside a session they have already left.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentWebLoginUser, signOutWebLogin } from '../../../renderer/services/webLoginSession';

const originalLocation = window.location;

function setConfig(config: unknown): void {
	(window as unknown as { __MAESTRO_CONFIG__?: unknown }).__MAESTRO_CONFIG__ = config;
}

function href(): string {
	return window.location.href;
}

describe('webLoginSession', () => {
	beforeEach(() => {
		Object.defineProperty(window, 'location', {
			configurable: true,
			writable: true,
			value: { ...originalLocation, href: '' },
		});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
	});

	afterEach(() => {
		delete (window as unknown as { __MAESTRO_CONFIG__?: unknown }).__MAESTRO_CONFIG__;
		Object.defineProperty(window, 'location', {
			configurable: true,
			writable: true,
			value: originalLocation,
		});
		vi.unstubAllGlobals();
	});

	describe('currentWebLoginUser', () => {
		it('returns the injected account', () => {
			setConfig({
				securityToken: 'tok',
				webLoginUser: { id: 'u1', username: 'ada', displayName: 'Ada' },
			});
			expect(currentWebLoginUser()).toEqual({ id: 'u1', username: 'ada', displayName: 'Ada' });
		});

		it('returns null with no config at all (the Electron desktop)', () => {
			expect(currentWebLoginUser()).toBeNull();
		});

		it('returns null when the page carries a config but no account', () => {
			setConfig({ securityToken: 'tok', webLoginUser: null });
			expect(currentWebLoginUser()).toBeNull();
		});

		it('returns null for a malformed account rather than a half-object', () => {
			setConfig({ securityToken: 'tok', webLoginUser: { id: 'u1' } });
			expect(currentWebLoginUser()).toBeNull();
		});
	});

	describe('signOutWebLogin', () => {
		it('posts to the token-scoped logout route with the cookie, then navigates', async () => {
			setConfig({
				securityToken: 'tok',
				webLoginUser: { id: 'u1', username: 'ada', displayName: 'Ada' },
			});

			await signOutWebLogin();

			expect(fetch).toHaveBeenCalledWith('/tok/auth/logout', {
				method: 'POST',
				credentials: 'same-origin',
			});
			expect(href()).toBe('/tok/login');
		});

		it('still navigates when the POST fails', async () => {
			setConfig({ securityToken: 'tok' });
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

			await expect(signOutWebLogin()).resolves.toBeUndefined();

			expect(href()).toBe('/tok/login');
		});

		it('does nothing without a security token - there is no route to call', async () => {
			await signOutWebLogin();

			expect(fetch).not.toHaveBeenCalled();
			expect(href()).toBe('');
		});
	});
});
