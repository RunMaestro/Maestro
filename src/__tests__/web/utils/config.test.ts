/**
 * Tests for src/web/utils/config.ts
 *
 * Configuration utilities for the Maestro web client.
 * Tests all exported functions and the MaestroConfig interface behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getMaestroConfig,
	isDashboardMode,
	isSessionMode,
	getCurrentSessionId,
	buildApiUrl,
	buildWebSocketUrl,
	getDashboardUrl,
	getSessionUrl,
	type MaestroConfig,
} from '../../../web/utils/config';
import { webLogger } from '../../../web/utils/logger';

// Mock the webLogger to capture warning calls
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('config.ts', () => {
	// Store original window properties
	let originalLocation: Location;
	let originalMaestroConfig: MaestroConfig | undefined;

	beforeEach(() => {
		// Store originals
		originalLocation = window.location;
		originalMaestroConfig = window.__MAESTRO_CONFIG__;

		// Reset mocks
		vi.clearAllMocks();

		// Default mock for window.location
		Object.defineProperty(window, 'location', {
			writable: true,
			value: {
				protocol: 'http:',
				host: 'localhost:3000',
				origin: 'http://localhost:3000',
				pathname: '/abc123-def456/dashboard',
				href: 'http://localhost:3000/abc123-def456/dashboard',
			},
		});

		// Clear config by default
		delete window.__MAESTRO_CONFIG__;
	});

	afterEach(() => {
		// Restore originals
		Object.defineProperty(window, 'location', {
			writable: true,
			value: originalLocation,
		});
		if (originalMaestroConfig) {
			window.__MAESTRO_CONFIG__ = originalMaestroConfig;
		} else {
			delete window.__MAESTRO_CONFIG__;
		}
	});

	describe('MaestroConfig interface', () => {
		it('should have all required properties when injected', () => {
			const config: MaestroConfig = {
				securityToken: 'test-token-123',
				sessionId: 'session-456',
				apiBase: '/test-token-123/api',
				wsUrl: '/test-token-123/ws',
			};

			window.__MAESTRO_CONFIG__ = config;

			expect(config.securityToken).toBe('test-token-123');
			expect(config.sessionId).toBe('session-456');
			expect(config.apiBase).toBe('/test-token-123/api');
			expect(config.wsUrl).toBe('/test-token-123/ws');
		});

		it('should allow null sessionId for dashboard mode', () => {
			const config: MaestroConfig = {
				securityToken: 'test-token',
				sessionId: null,
				apiBase: '/test-token/api',
				wsUrl: '/test-token/ws',
			};

			window.__MAESTRO_CONFIG__ = config;

			expect(config.sessionId).toBeNull();
		});
	});

	describe('getMaestroConfig()', () => {
		describe('with injected config', () => {
			it('should return injected config when available', () => {
				const injectedConfig: MaestroConfig = {
					securityToken: 'injected-token',
					sessionId: 'injected-session',
					apiBase: '/injected-token/api',
					wsUrl: '/injected-token/ws',
				};

				window.__MAESTRO_CONFIG__ = injectedConfig;

				const result = getMaestroConfig();

				expect(result).toEqual(injectedConfig);
				expect(webLogger.warn).not.toHaveBeenCalled();
			});

			it('should return exact reference to injected config', () => {
				const injectedConfig: MaestroConfig = {
					securityToken: 'ref-test',
					sessionId: null,
					apiBase: '/ref-test/api',
					wsUrl: '/ref-test/ws',
				};

				window.__MAESTRO_CONFIG__ = injectedConfig;

				const result = getMaestroConfig();

				expect(result).toBe(injectedConfig);
			});

			it('should handle various security token formats', () => {
				const tokens = [
					'simple',
					'uuid-format-1234-5678-abcd',
					'with.dots.in.token',
					'with_underscores',
					'UPPERCASE',
					'MixedCase123',
					'123numeric',
					'a', // single char
				];

				for (const token of tokens) {
					window.__MAESTRO_CONFIG__ = {
						securityToken: token,
						sessionId: null,
						apiBase: `/${token}/api`,
						wsUrl: `/${token}/ws`,
					};

					const result = getMaestroConfig();
					expect(result.securityToken).toBe(token);
				}
			});
		});

		describe('development fallback', () => {
			it('should use development fallback when no config is injected', () => {
				Object.defineProperty(window, 'location', {
					writable: true,
					value: {
						protocol: 'http:',
						host: 'localhost:3000',
						origin: 'http://localhost:3000',
						pathname: '/my-dev-token/dashboard',
						href: 'http://localhost:3000/my-dev-token/dashboard',
					},
				});

				const result = getMaestroConfig();

				expect(result.securityToken).toBe('my-dev-token');
				expect(result.sessionId).toBeNull();
				expect(result.apiBase).toBe('/my-dev-token/api');
				expect(result.wsUrl).toBe('/my-dev-token/ws');
				expect(webLogger.warn).toHaveBeenCalledWith(
					'No __MAESTRO_CONFIG__ found, using development defaults',
					'Config'
				);
			});

			it('should extract token from first path segment', () => {
				Object.defineProperty(window, 'location', {
					writable: true,
					value: {
						protocol: 'http:',
						host: 'localhost:3000',
						origin: 'http://localhost:3000',
						pathname: '/extracted-token/some/deep/path',
						href: 'http://localhost:3000/extracted-token/some/deep/path',
					},
				});

				const result = getMaestroConfig();

				expect(result.securityToken).toBe('extracted-token');
			});

			it('should use dev-token when path is empty', () => {
				Object.defineProperty(window, 'location', {
					writable: true,
					value: {
						protocol: 'http:',
						host: 'localhost:3000',
						origin: 'http://localhost:3000',
						pathname: '/',
						href: 'http://localhost:3000/',
					},
				});

				const result = getMaestroConfig();

				expect(result.securityToken).toBe('dev-token');
				expect(result.apiBase).toBe('/dev-token/api');
				expect(result.wsUrl).toBe('/dev-token/ws');
			});

			it('should extract sessionId from session route', () => {
				Object.defineProperty(window, 'location', {
					writable: true,
					value: {
						protocol: 'http:',
						host: 'localhost:3000',
						origin: 'http://localhost:3000',
						pathname: '/token123/session/sess-456',
						href: 'http://localhost:3000/token123/session/sess-456',
					},
				});

				const result = getMaestroConfig();

				expect(result.securityToken).toBe('token123');
				expect(result.sessionId).toBe('sess-456');
			});

			it('should return null sessionId for non-session routes', () => {
				Object.defineProperty(window, 'location', {
					writable: true,
					value: {
						protocol: 'http:',
						host: 'localhost:3000',
						origin: 'http://localhost:3000',
						pathname: '/token123/dashboard',
						href: 'http://localhost:3000/token123/dashboard',
					},
				});

				const result = getMaestroConfig();

				expect(result.sessionId).toBeNull();
			});

			it('should return null sessionId when session path has no ID', () => {
				Object.defineProperty(window, 'location', {
					writable: true,
					value: {
						protocol: 'http:',
						host: 'localhost:3000',
						origin: 'http://localhost:3000',
						pathname: '/token123/session',
						href: 'http://localhost:3000/token123/session',
					},
				});

				const result = getMaestroConfig();

				// pathParts = ['token123', 'session'], pathParts[2] is undefined -> null
				expect(result.sessionId).toBeNull();
			});

			it('should handle path with multiple slashes', () => {
				Object.defineProperty(window, 'location', {
					writable: true,
					value: {
						protocol: 'http:',
						host: 'localhost:3000',
						origin: 'http://localhost:3000',
						pathname: '///token///session///sess-id///',
						href: 'http://localhost:3000///token///session///sess-id///',
					},
				});

				const result = getMaestroConfig();

				// filter(Boolean) removes empty strings
				expect(result.securityToken).toBe('token');
				expect(result.sessionId).toBe('sess-id');
			});
		});
	});

	describe('isDashboardMode()', () => {
		it('should return true when sessionId is null', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: null,
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(isDashboardMode()).toBe(true);
		});

		it('should return false when sessionId is set', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: 'session-123',
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(isDashboardMode()).toBe(false);
		});

		it('should return true for development fallback on dashboard route', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'http:',
					host: 'localhost:3000',
					origin: 'http://localhost:3000',
					pathname: '/token/dashboard',
					href: 'http://localhost:3000/token/dashboard',
				},
			});

			expect(isDashboardMode()).toBe(true);
		});
	});

	describe('isSessionMode()', () => {
		it('should return true when sessionId is set', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: 'active-session',
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(isSessionMode()).toBe(true);
		});

		it('should return false when sessionId is null', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: null,
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(isSessionMode()).toBe(false);
		});

		it('should be inverse of isDashboardMode', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: null,
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(isDashboardMode()).toBe(true);
			expect(isSessionMode()).toBe(false);
			expect(isDashboardMode()).not.toBe(isSessionMode());

			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: 'some-session',
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(isDashboardMode()).toBe(false);
			expect(isSessionMode()).toBe(true);
			expect(isDashboardMode()).not.toBe(isSessionMode());
		});
	});

	describe('getCurrentSessionId()', () => {
		it('should return sessionId from config', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: 'current-session-id',
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(getCurrentSessionId()).toBe('current-session-id');
		});

		it('should return null when no session', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: null,
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(getCurrentSessionId()).toBeNull();
		});

		it('should extract from URL in development mode', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'http:',
					host: 'localhost:3000',
					origin: 'http://localhost:3000',
					pathname: '/token/session/url-session-id',
					href: 'http://localhost:3000/token/session/url-session-id',
				},
			});

			expect(getCurrentSessionId()).toBe('url-session-id');
		});
	});

	describe('buildApiUrl()', () => {
		beforeEach(() => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'api-token',
				sessionId: null,
				apiBase: '/api-token/api',
				wsUrl: '/api-token/ws',
			};
		});

		it('should build URL with leading slash in endpoint', () => {
			const result = buildApiUrl('/sessions');
			expect(result).toBe('http://localhost:3000/api-token/api/sessions');
		});

		it('should build URL without leading slash in endpoint', () => {
			const result = buildApiUrl('sessions');
			expect(result).toBe('http://localhost:3000/api-token/api/sessions');
		});

		it('should handle nested endpoint paths', () => {
			const result = buildApiUrl('/sessions/123/logs');
			expect(result).toBe('http://localhost:3000/api-token/api/sessions/123/logs');
		});

		it('should handle apiBase with trailing slash', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: null,
				apiBase: '/token/api/',
				wsUrl: '/token/ws',
			};

			const result = buildApiUrl('/endpoint');
			expect(result).toBe('http://localhost:3000/token/api/endpoint');
		});

		it('should handle empty endpoint', () => {
			const result = buildApiUrl('');
			expect(result).toBe('http://localhost:3000/api-token/api/');
		});

		it('should handle endpoint with query parameters', () => {
			const result = buildApiUrl('/search?q=test&limit=10');
			expect(result).toBe('http://localhost:3000/api-token/api/search?q=test&limit=10');
		});

		it('should use origin from window.location', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'https:',
					host: 'maestro.example.com',
					origin: 'https://maestro.example.com',
					pathname: '/token/dashboard',
					href: 'https://maestro.example.com/token/dashboard',
				},
			});

			const result = buildApiUrl('/status');
			expect(result).toBe('https://maestro.example.com/api-token/api/status');
		});
	});

	describe('buildWebSocketUrl()', () => {
		beforeEach(() => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'ws-token',
				sessionId: null,
				apiBase: '/ws-token/api',
				wsUrl: '/ws-token/ws',
			};
		});

		it('should build WebSocket URL without sessionId', () => {
			const result = buildWebSocketUrl();
			expect(result).toBe('ws://localhost:3000/ws-token/ws');
		});

		it('should build WebSocket URL with sessionId', () => {
			const result = buildWebSocketUrl('sess-123');
			expect(result).toBe('ws://localhost:3000/ws-token/ws?sessionId=sess-123');
		});

		it('should use wss: for https: protocol', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'https:',
					host: 'secure.example.com',
					origin: 'https://secure.example.com',
					pathname: '/token/dashboard',
					href: 'https://secure.example.com/token/dashboard',
				},
			});

			const result = buildWebSocketUrl();
			expect(result).toBe('wss://secure.example.com/ws-token/ws');
		});

		it('should use ws: for http: protocol', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'http:',
					host: 'localhost:8080',
					origin: 'http://localhost:8080',
					pathname: '/token/dashboard',
					href: 'http://localhost:8080/token/dashboard',
				},
			});

			const result = buildWebSocketUrl();
			expect(result).toBe('ws://localhost:8080/ws-token/ws');
		});

		it('should URL encode sessionId', () => {
			const result = buildWebSocketUrl('session with spaces');
			expect(result).toBe('ws://localhost:3000/ws-token/ws?sessionId=session%20with%20spaces');
		});

		it('should handle special characters in sessionId', () => {
			const result = buildWebSocketUrl('sess+123&foo=bar');
			expect(result).toBe('ws://localhost:3000/ws-token/ws?sessionId=sess%2B123%26foo%3Dbar');
		});

		it('should handle undefined sessionId', () => {
			const result = buildWebSocketUrl(undefined);
			expect(result).toBe('ws://localhost:3000/ws-token/ws');
		});

		it('should handle empty string sessionId', () => {
			const result = buildWebSocketUrl('');
			// Empty string is falsy, so no query param added
			expect(result).toBe('ws://localhost:3000/ws-token/ws');
		});
	});

	describe('getDashboardUrl()', () => {
		it('should return dashboard URL with security token', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'dash-token',
				sessionId: null,
				apiBase: '/dash-token/api',
				wsUrl: '/dash-token/ws',
			};

			const result = getDashboardUrl();
			expect(result).toBe('http://localhost:3000/dash-token');
		});

		it('should use origin from window.location', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: null,
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'https:',
					host: 'app.maestro.io',
					origin: 'https://app.maestro.io',
					pathname: '/token/session/123',
					href: 'https://app.maestro.io/token/session/123',
				},
			});

			const result = getDashboardUrl();
			expect(result).toBe('https://app.maestro.io/token');
		});

		it('should work from session mode', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'return-token',
				sessionId: 'current-session',
				apiBase: '/return-token/api',
				wsUrl: '/return-token/ws',
			};

			const result = getDashboardUrl();
			expect(result).toBe('http://localhost:3000/return-token');
		});
	});

	describe('getSessionUrl()', () => {
		beforeEach(() => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'sess-url-token',
				sessionId: null,
				apiBase: '/sess-url-token/api',
				wsUrl: '/sess-url-token/ws',
			};
		});

		it('should return session URL with security token and sessionId', () => {
			const result = getSessionUrl('session-abc');
			expect(result).toBe('http://localhost:3000/sess-url-token/session/session-abc');
		});

		it('should handle different sessionId values', () => {
			const sessionIds = ['123', 'uuid-format', 'session_1', 'a', 'very-long-session-id-here'];

			for (const sessionId of sessionIds) {
				const result = getSessionUrl(sessionId);
				expect(result).toBe(`http://localhost:3000/sess-url-token/session/${sessionId}`);
			}
		});

		it('should use origin from window.location', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'https:',
					host: 'production.example.com:443',
					origin: 'https://production.example.com:443',
					pathname: '/token/dashboard',
					href: 'https://production.example.com:443/token/dashboard',
				},
			});

			const result = getSessionUrl('prod-session');
			expect(result).toBe('https://production.example.com:443/sess-url-token/session/prod-session');
		});

		it('should work from another session context', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'multi-token',
				sessionId: 'current-session-1',
				apiBase: '/multi-token/api',
				wsUrl: '/multi-token/ws',
			};

			// Generating URL to switch to a different session
			const result = getSessionUrl('other-session-2');
			expect(result).toBe('http://localhost:3000/multi-token/session/other-session-2');
		});
	});

	describe('Integration scenarios', () => {
		it('should support full navigation flow: dashboard -> session -> dashboard', () => {
			// Start on dashboard
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'nav-token',
				sessionId: null,
				apiBase: '/nav-token/api',
				wsUrl: '/nav-token/ws',
			};

			expect(isDashboardMode()).toBe(true);
			expect(isSessionMode()).toBe(false);
			expect(getCurrentSessionId()).toBeNull();

			// Navigate to session
			const sessionUrl = getSessionUrl('session-1');
			expect(sessionUrl).toBe('http://localhost:3000/nav-token/session/session-1');

			// Simulate being on session page
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'nav-token',
				sessionId: 'session-1',
				apiBase: '/nav-token/api',
				wsUrl: '/nav-token/ws',
			};

			expect(isDashboardMode()).toBe(false);
			expect(isSessionMode()).toBe(true);
			expect(getCurrentSessionId()).toBe('session-1');

			// Navigate back to dashboard
			const dashboardUrl = getDashboardUrl();
			expect(dashboardUrl).toBe('http://localhost:3000/nav-token');
		});

		it('should support API and WebSocket communication from session', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'comm-token',
				sessionId: 'active-session',
				apiBase: '/comm-token/api',
				wsUrl: '/comm-token/ws',
			};

			// Build API URL for fetching session data
			const apiUrl = buildApiUrl(`/sessions/${getCurrentSessionId()}`);
			expect(apiUrl).toBe('http://localhost:3000/comm-token/api/sessions/active-session');

			// Build WebSocket URL for real-time updates
			const wsUrl = buildWebSocketUrl(getCurrentSessionId()!);
			expect(wsUrl).toBe('ws://localhost:3000/comm-token/ws?sessionId=active-session');
		});

		it('should handle HTTPS production environment', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'https:',
					host: 'maestro.cloud.example.com',
					origin: 'https://maestro.cloud.example.com',
					pathname: '/secure-token/session/prod-session',
					href: 'https://maestro.cloud.example.com/secure-token/session/prod-session',
				},
			});

			window.__MAESTRO_CONFIG__ = {
				securityToken: 'secure-token',
				sessionId: 'prod-session',
				apiBase: '/secure-token/api',
				wsUrl: '/secure-token/ws',
			};

			// All URLs should be secure
			const apiUrl = buildApiUrl('/health');
			expect(apiUrl).toBe('https://maestro.cloud.example.com/secure-token/api/health');

			const wsUrl = buildWebSocketUrl('prod-session');
			expect(wsUrl).toBe('wss://maestro.cloud.example.com/secure-token/ws?sessionId=prod-session');

			const dashUrl = getDashboardUrl();
			expect(dashUrl).toBe('https://maestro.cloud.example.com/secure-token');
		});

		it('should work with development fallback for full workflow', () => {
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'http:',
					host: 'localhost:5173',
					origin: 'http://localhost:5173',
					pathname: '/dev-token-123/session/dev-session',
					href: 'http://localhost:5173/dev-token-123/session/dev-session',
				},
			});

			// Without injected config
			const config = getMaestroConfig();

			expect(config.securityToken).toBe('dev-token-123');
			expect(config.sessionId).toBe('dev-session');
			expect(webLogger.warn).toHaveBeenCalled();

			// API and WS should still work
			expect(buildApiUrl('/test')).toBe('http://localhost:5173/dev-token-123/api/test');
			expect(buildWebSocketUrl()).toBe('ws://localhost:5173/dev-token-123/ws');
		});
	});

	describe('Edge cases', () => {
		it('should handle config with empty string sessionId correctly', () => {
			// Empty string is truthy for isSessionMode check but semantically invalid
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: '',
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			// Empty string is not null, so technically not dashboard mode
			expect(isDashboardMode()).toBe(false);
			expect(isSessionMode()).toBe(true);
			expect(getCurrentSessionId()).toBe('');
		});

		it('should handle very long security tokens', () => {
			const longToken = 'a'.repeat(500);

			window.__MAESTRO_CONFIG__ = {
				securityToken: longToken,
				sessionId: null,
				apiBase: `/${longToken}/api`,
				wsUrl: `/${longToken}/ws`,
			};

			const config = getMaestroConfig();
			expect(config.securityToken).toBe(longToken);
			expect(buildApiUrl('/test').length).toBeGreaterThan(500);
		});

		it('should handle unicode in session IDs', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'token',
				sessionId: 'セッション-123',
				apiBase: '/token/api',
				wsUrl: '/token/ws',
			};

			expect(getCurrentSessionId()).toBe('セッション-123');

			const wsUrl = buildWebSocketUrl('セッション-123');
			expect(wsUrl).toContain('sessionId=');
			// Should be URL encoded
			expect(wsUrl).toBe(
				'ws://localhost:3000/token/ws?sessionId=%E3%82%BB%E3%83%83%E3%82%B7%E3%83%A7%E3%83%B3-123'
			);
		});

		it('should handle rapid config access', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'rapid-token',
				sessionId: 'rapid-session',
				apiBase: '/rapid-token/api',
				wsUrl: '/rapid-token/ws',
			};

			// Multiple rapid accesses should all succeed
			const results: MaestroConfig[] = [];
			for (let i = 0; i < 100; i++) {
				results.push(getMaestroConfig());
			}

			// All should be identical
			expect(new Set(results.map((r) => r.securityToken)).size).toBe(1);
		});

		it('should handle endpoints with hash fragments', () => {
			window.__MAESTRO_CONFIG__ = {
				securityToken: 'hash-token',
				sessionId: null,
				apiBase: '/hash-token/api',
				wsUrl: '/hash-token/ws',
			};

			// Hash fragments typically don't go to server but let's ensure they're preserved
			const result = buildApiUrl('/page#section');
			expect(result).toBe('http://localhost:3000/hash-token/api/page#section');
		});

		it('should handle config being mutated externally', () => {
			const mutableConfig: MaestroConfig = {
				securityToken: 'original',
				sessionId: null,
				apiBase: '/original/api',
				wsUrl: '/original/ws',
			};

			window.__MAESTRO_CONFIG__ = mutableConfig;

			const firstResult = getMaestroConfig();
			expect(firstResult.securityToken).toBe('original');

			// External mutation
			mutableConfig.securityToken = 'mutated';

			// Since getMaestroConfig returns the reference, it should reflect mutation
			const secondResult = getMaestroConfig();
			expect(secondResult.securityToken).toBe('mutated');
		});
	});
});
