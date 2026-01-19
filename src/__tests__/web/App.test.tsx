/**
 * Tests for web App helpers.
 *
 * @file src/__tests__/web/App.test.tsx
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMaestroModeContextValue } from '../../web/App';
import type { MaestroConfig } from '../../web/utils/config';

describe('createMaestroModeContextValue', () => {
	let originalLocation: Location;

	beforeEach(() => {
		originalLocation = window.location;
		const mockLocation = {
			origin: 'http://localhost',
			href: 'http://localhost/',
		} as Location;

		Object.defineProperty(window, 'location', {
			value: mockLocation,
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(window, 'location', {
			value: originalLocation,
			configurable: true,
		});
	});

	it('builds dashboard mode context from config', () => {
		const config: MaestroConfig = {
			securityToken: 'token-123',
			sessionId: null,
			apiBase: '/token-123/api',
			wsUrl: '/token-123/ws',
		};

		const context = createMaestroModeContextValue(config);

		expect(context.isDashboard).toBe(true);
		expect(context.isSession).toBe(false);
		expect(context.sessionId).toBeNull();
		expect(context.securityToken).toBe('token-123');

		context.goToDashboard();
		expect(window.location.href).toBe('http://localhost/token-123');
	});

	it('builds session mode context from config', () => {
		const config: MaestroConfig = {
			securityToken: 'token-456',
			sessionId: 'session-abc',
			apiBase: '/token-456/api',
			wsUrl: '/token-456/ws',
		};

		const context = createMaestroModeContextValue(config);

		expect(context.isDashboard).toBe(false);
		expect(context.isSession).toBe(true);
		expect(context.sessionId).toBe('session-abc');
		expect(context.securityToken).toBe('token-456');

		context.goToSession('session-xyz');
		expect(window.location.href).toBe('http://localhost/token-456/session/session-xyz');
	});
});
