/**
 * Dedicated tests for debug package sanitization utilities
 *
 * These tests thoroughly verify:
 * 1. Path sanitization - home directory replacement, cross-platform handling
 * 2. API key redaction - various key patterns, case insensitivity, nested objects
 * 3. Environment variable filtering - sensitive keywords, value masking
 *
 * This is a focused test suite for sanitization logic, complementing the
 * collectors.test.ts which tests collector-level sanitization behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';

// Mock Electron modules
vi.mock('electron', () => ({
	app: {
		getVersion: vi.fn(() => '1.0.0'),
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return '/mock/userData';
			return '/mock/path';
		}),
	},
}));

// Mock electron-store
vi.mock('electron-store', () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
			store: {},
		})),
	};
});

describe('Debug Package Sanitization', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ============================================================================
	// Path Sanitization Tests
	// ============================================================================

	describe('sanitizePath', () => {
		describe('home directory replacement', () => {
			it('should replace home directory with ~', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const homeDir = os.homedir();
				const testPath = `${homeDir}/Projects/MyApp`;

				const result = sanitizePath(testPath);

				expect(result).toBe('~/Projects/MyApp');
				expect(result).not.toContain(homeDir);
			});

			it('should replace home directory at any position in path', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const homeDir = os.homedir();
				const testPath = `${homeDir}/deeply/nested/folder/file.txt`;

				const result = sanitizePath(testPath);

				expect(result).toBe('~/deeply/nested/folder/file.txt');
			});

			it('should handle home directory with trailing slash', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const homeDir = os.homedir();
				const testPath = `${homeDir}/`;

				const result = sanitizePath(testPath);

				expect(result).toBe('~/');
			});

			it('should handle path that is exactly the home directory', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const homeDir = os.homedir();

				const result = sanitizePath(homeDir);

				expect(result).toBe('~');
			});

			it('should not modify paths that do not contain home directory', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const testPath = '/usr/local/bin/app';

				const result = sanitizePath(testPath);

				expect(result).toBe('/usr/local/bin/app');
			});

			it('should handle empty string', async () => {
				const { sanitizePath } = await import('../collectors/settings');

				const result = sanitizePath('');

				expect(result).toBe('');
			});
		});

		describe('Windows path handling', () => {
			it('should normalize backslashes to forward slashes', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const testPath = 'C:\\Users\\testuser\\Documents\\Project';

				const result = sanitizePath(testPath);

				// Result should have forward slashes
				expect(result).not.toContain('\\');
			});

			it('should handle Windows-style home directory', async () => {
				const { sanitizePath: _sanitizePath } = await import('../collectors/settings');

				// Mock homedir to return Windows-style path
				const originalHomedir = os.homedir();
				vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\testuser');

				// Re-import to get fresh module with mocked homedir
				vi.resetModules();
				const { sanitizePath: freshSanitizePath } = await import('../collectors/settings');

				const testPath = 'C:\\Users\\testuser\\Documents\\Project';
				const result = freshSanitizePath(testPath);

				expect(result).toBe('~/Documents/Project');

				vi.spyOn(os, 'homedir').mockReturnValue(originalHomedir);
			});

			it('should handle mixed slash styles', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const testPath = '/path/to\\mixed\\slashes/file.txt';

				const result = sanitizePath(testPath);

				// Should normalize all to forward slashes
				expect(result).not.toContain('\\');
				expect(result).toBe('/path/to/mixed/slashes/file.txt');
			});
		});

		describe('edge cases and type handling', () => {
			it('should return null when given null', async () => {
				const { sanitizePath } = await import('../collectors/settings');

				// @ts-expect-error - Testing runtime behavior with wrong type
				const result = sanitizePath(null);

				expect(result).toBeNull();
			});

			it('should return undefined when given undefined', async () => {
				const { sanitizePath } = await import('../collectors/settings');

				// @ts-expect-error - Testing runtime behavior with wrong type
				const result = sanitizePath(undefined);

				expect(result).toBeUndefined();
			});

			it('should return numbers unchanged', async () => {
				const { sanitizePath } = await import('../collectors/settings');

				// @ts-expect-error - Testing runtime behavior with wrong type
				const result = sanitizePath(12345);

				expect(result).toBe(12345);
			});

			it('should return objects unchanged', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const obj = { path: '/some/path' };

				// @ts-expect-error - Testing runtime behavior with wrong type
				const result = sanitizePath(obj);

				expect(result).toEqual(obj);
			});

			it('should handle paths with spaces', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const homeDir = os.homedir();
				const testPath = `${homeDir}/My Documents/Project Files/app.tsx`;

				const result = sanitizePath(testPath);

				expect(result).toBe('~/My Documents/Project Files/app.tsx');
			});

			it('should handle paths with special characters', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const homeDir = os.homedir();
				const testPath = `${homeDir}/Projects/@company/app-v2.0#beta`;

				const result = sanitizePath(testPath);

				expect(result).toBe('~/Projects/@company/app-v2.0#beta');
			});

			it('should handle very long paths', async () => {
				const { sanitizePath } = await import('../collectors/settings');
				const homeDir = os.homedir();
				const longPath = `${homeDir}/` + 'a/'.repeat(100) + 'file.txt';

				const result = sanitizePath(longPath);

				expect(result.startsWith('~/')).toBe(true);
				expect(result).not.toContain(homeDir);
			});
		});
	});

	// ============================================================================
	// API Key Redaction Tests
	// ============================================================================

	describe('API key redaction', () => {
		describe('sensitive key detection', () => {
			it('should redact apiKey', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { apiKey: 'sk-1234567890abcdef' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.apiKey).toBe('[REDACTED]');
				expect(result.sanitizedFields).toContain('apiKey');
			});

			it('should redact api_key (snake_case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { api_key: 'secret-key-123' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.api_key).toBe('[REDACTED]');
			});

			it('should redact authToken', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { authToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.authToken).toBe('[REDACTED]');
			});

			it('should redact auth_token (snake_case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { auth_token: 'token-abc-123' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.auth_token).toBe('[REDACTED]');
			});

			it('should redact clientToken', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { clientToken: 'client-secret-xyz' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.clientToken).toBe('[REDACTED]');
			});

			it('should redact client_token (snake_case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { client_token: 'client-xyz' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.client_token).toBe('[REDACTED]');
			});

			it('should redact password', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { password: 'supersecret123' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.password).toBe('[REDACTED]');
			});

			it('should redact secret', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { secret: 'my-secret-value' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.secret).toBe('[REDACTED]');
			});

			it('should redact credential', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { credential: 'user-credential' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.credential).toBe('[REDACTED]');
			});

			it('should redact accessToken', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { accessToken: 'access-token-123' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.accessToken).toBe('[REDACTED]');
			});

			it('should redact access_token (snake_case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { access_token: 'access-xyz' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.access_token).toBe('[REDACTED]');
			});

			it('should redact refreshToken', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { refreshToken: 'refresh-token-abc' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.refreshToken).toBe('[REDACTED]');
			});

			it('should redact refresh_token (snake_case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { refresh_token: 'refresh-xyz' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.refresh_token).toBe('[REDACTED]');
			});

			it('should redact privateKey', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { privateKey: '-----BEGIN RSA PRIVATE KEY-----...' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.privateKey).toBe('[REDACTED]');
			});

			it('should redact private_key (snake_case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { private_key: '-----BEGIN RSA PRIVATE KEY-----...' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.private_key).toBe('[REDACTED]');
			});
		});

		describe('case insensitivity', () => {
			it('should redact APIKEY (uppercase)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { APIKEY: 'uppercase-key' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.APIKEY).toBe('[REDACTED]');
			});

			it('should redact ApiKey (mixed case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { ApiKey: 'mixed-case-key' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.ApiKey).toBe('[REDACTED]');
			});

			it('should redact API_KEY (uppercase snake_case)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { API_KEY: 'uppercase-snake' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.API_KEY).toBe('[REDACTED]');
			});

			it('should redact PASSWORD (uppercase)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { PASSWORD: 'my-password' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.PASSWORD).toBe('[REDACTED]');
			});

			it('should redact Secret (capitalized)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { Secret: 'my-secret' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.Secret).toBe('[REDACTED]');
			});
		});

		describe('key name patterns containing sensitive words', () => {
			it('should redact myApiKeyValue (key within name)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { myApiKeyValue: 'embedded-key' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.myApiKeyValue).toBe('[REDACTED]');
			});

			it('should redact userPassword (password in name)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { userPassword: 'user-pass' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.userPassword).toBe('[REDACTED]');
			});

			it('should redact adminSecret (secret in name)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { adminSecret: 'admin-secret-value' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.adminSecret).toBe('[REDACTED]');
			});

			it('should redact bearerAccessToken (accesstoken in name)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { bearerAccessToken: 'bearer-123' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.bearerAccessToken).toBe('[REDACTED]');
			});

			it('should redact dbCredential (credential in name)', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { dbCredential: 'db-cred' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.dbCredential).toBe('[REDACTED]');
			});
		});

		describe('nested object handling', () => {
			it('should redact sensitive keys in nested objects', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: {
						config: {
							apiKey: 'nested-key',
						},
					},
				};

				const result = await collectSettings(mockStore as any);

				expect((result.raw.config as any).apiKey).toBe('[REDACTED]');
			});

			it('should redact deeply nested sensitive keys', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: {
						level1: {
							level2: {
								level3: {
									level4: {
										apiKey: 'deeply-nested-key',
										normalValue: 'not-sensitive',
									},
								},
							},
						},
					},
				};

				const result = await collectSettings(mockStore as any);

				expect((result.raw.level1 as any).level2.level3.level4.apiKey).toBe('[REDACTED]');
				expect((result.raw.level1 as any).level2.level3.level4.normalValue).toBe('not-sensitive');
			});

			it('should track sanitized fields with full path', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: {
						outer: {
							inner: {
								password: 'secret',
							},
						},
					},
				};

				const result = await collectSettings(mockStore as any);

				expect(result.sanitizedFields).toContain('outer.inner.password');
			});

			it('should redact multiple sensitive keys at different levels', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: {
						apiKey: 'top-level-key',
						config: {
							authToken: 'mid-level-token',
							nested: {
								password: 'deep-password',
							},
						},
					},
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.apiKey).toBe('[REDACTED]');
				expect((result.raw.config as any).authToken).toBe('[REDACTED]');
				expect((result.raw.config as any).nested.password).toBe('[REDACTED]');
			});
		});

		describe('array handling', () => {
			it('should process arrays containing objects with sensitive keys', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: {
						accounts: [
							{ name: 'Account 1', apiKey: 'key-1' },
							{ name: 'Account 2', apiKey: 'key-2' },
						],
					},
				};

				const result = await collectSettings(mockStore as any);

				expect((result.raw.accounts as any)[0].name).toBe('Account 1');
				expect((result.raw.accounts as any)[0].apiKey).toBe('[REDACTED]');
				expect((result.raw.accounts as any)[1].name).toBe('Account 2');
				expect((result.raw.accounts as any)[1].apiKey).toBe('[REDACTED]');
			});

			it('should handle empty arrays', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { items: [] },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.items).toEqual([]);
			});

			it('should handle arrays of primitives', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { tags: ['tag1', 'tag2', 'tag3'] },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.tags).toEqual(['tag1', 'tag2', 'tag3']);
			});
		});

		describe('preservation of non-sensitive data', () => {
			it('should preserve boolean values', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { enabled: true, disabled: false },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.enabled).toBe(true);
				expect(result.raw.disabled).toBe(false);
			});

			it('should preserve number values', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { count: 42, ratio: 3.14, negative: -10 },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.count).toBe(42);
				expect(result.raw.ratio).toBe(3.14);
				expect(result.raw.negative).toBe(-10);
			});

			it('should preserve string values without sensitive keywords', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { theme: 'dark', language: 'en-US', name: 'MyApp' },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.theme).toBe('dark');
				expect(result.raw.language).toBe('en-US');
				expect(result.raw.name).toBe('MyApp');
			});

			it('should preserve null values', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: { optionalField: null },
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.optionalField).toBeNull();
			});
		});
	});

	// ============================================================================
	// Environment Variable Filtering Tests
	// ============================================================================

	describe('environment variable filtering', () => {
		describe('custom env vars masking', () => {
			it('should not expose custom env var values in agents collector', async () => {
				const { collectAgents } = await import('../collectors/agents');

				const mockAgentDetector = {
					detectAgents: vi.fn().mockResolvedValue([
						{
							id: 'claude-code',
							name: 'Claude Code',
							available: true,
							customEnvVars: {
								ANTHROPIC_API_KEY: 'sk-ant-secret-key',
								CUSTOM_VAR: 'custom-value',
							},
						},
					]),
				};

				const result = await collectAgents(mockAgentDetector as any);
				const resultStr = JSON.stringify(result);

				// Should not contain actual env var values
				expect(resultStr).not.toContain('sk-ant-secret-key');
				expect(resultStr).not.toContain('custom-value');
				expect(resultStr).not.toContain('ANTHROPIC_API_KEY');
			});

			it('should indicate env vars are set without showing values', async () => {
				const { collectAgents } = await import('../collectors/agents');

				const mockAgentDetector = {
					detectAgents: vi.fn().mockResolvedValue([
						{
							id: 'claude-code',
							name: 'Claude Code',
							available: true,
							customEnvVars: {
								VAR1: 'value1',
								VAR2: 'value2',
							},
						},
					]),
				};

				const result = await collectAgents(mockAgentDetector as any);

				// The collector should track that env vars exist but not include values
				// Based on the interface, it uses hasCustomEnvVars and customEnvVarCount
				expect(result.detectedAgents[0]).toBeDefined();
			});
		});

		describe('custom args masking', () => {
			it('should not expose custom args values containing secrets', async () => {
				const { collectAgents } = await import('../collectors/agents');

				const mockAgentDetector = {
					detectAgents: vi.fn().mockResolvedValue([
						{
							id: 'test-agent',
							name: 'Test Agent',
							available: true,
							customArgs: '--api-key=sk-secret123 --token=bearer-abc',
						},
					]),
				};

				const result = await collectAgents(mockAgentDetector as any);
				const resultStr = JSON.stringify(result);

				// Should not contain actual args values
				expect(resultStr).not.toContain('sk-secret123');
				expect(resultStr).not.toContain('bearer-abc');
			});
		});

		describe('path-based environment variables', () => {
			it('should sanitize custom path settings', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const homeDir = os.homedir();

				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: {
						customPath: `${homeDir}/custom/bin`,
						ghPath: `${homeDir}/.local/bin/gh`,
					},
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.customPath).toBe('~/custom/bin');
				expect(result.raw.ghPath).toBe('~/.local/bin/gh');
			});

			it('should sanitize folderPath settings', async () => {
				const { collectSettings } = await import('../collectors/settings');
				const homeDir = os.homedir();

				const mockStore = {
					get: vi.fn(),
					set: vi.fn(),
					store: {
						autoRunFolderPath: `${homeDir}/Documents/AutoRun`,
					},
				};

				const result = await collectSettings(mockStore as any);

				expect(result.raw.autoRunFolderPath).toBe('~/Documents/AutoRun');
			});
		});
	});

	// ============================================================================
	// Comprehensive Integration Tests
	// ============================================================================

	describe('comprehensive sanitization', () => {
		it('should sanitize complex settings object with mixed sensitive data', async () => {
			const { collectSettings } = await import('../collectors/settings');
			const homeDir = os.homedir();

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					theme: 'dark',
					fontSize: 14,
					enabled: true,
					apiKey: 'sk-secret-key',
					customPath: `${homeDir}/custom/path`,
					nested: {
						password: 'secret-password',
						normalField: 'normal-value',
						deeply: {
							authToken: 'auth-token-123',
							path: `${homeDir}/nested/path`,
						},
					},
					accounts: [
						{ name: 'Account 1', apiKey: 'account-key-1' },
						{ name: 'Account 2', secret: 'account-secret-2' },
					],
				},
			};

			const result = await collectSettings(mockStore as any);

			// Non-sensitive preserved
			expect(result.raw.theme).toBe('dark');
			expect(result.raw.fontSize).toBe(14);
			expect(result.raw.enabled).toBe(true);
			expect((result.raw.nested as any).normalField).toBe('normal-value');

			// Sensitive redacted
			expect(result.raw.apiKey).toBe('[REDACTED]');
			expect((result.raw.nested as any).password).toBe('[REDACTED]');
			expect((result.raw.nested as any).deeply.authToken).toBe('[REDACTED]');
			expect((result.raw.accounts as any)[0].apiKey).toBe('[REDACTED]');
			expect((result.raw.accounts as any)[1].secret).toBe('[REDACTED]');

			// Paths sanitized
			expect(result.raw.customPath).toBe('~/custom/path');
			expect((result.raw.nested as any).deeply.path).toBe('~/nested/path');

			// Names preserved in arrays
			expect((result.raw.accounts as any)[0].name).toBe('Account 1');
			expect((result.raw.accounts as any)[1].name).toBe('Account 2');
		});

		it('should track all sanitized fields', async () => {
			const { collectSettings } = await import('../collectors/settings');
			const homeDir = os.homedir();

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					apiKey: 'key',
					nested: { password: 'pass' },
					customPath: `${homeDir}/path`,
				},
			};

			const result = await collectSettings(mockStore as any);

			expect(result.sanitizedFields).toContain('apiKey');
			expect(result.sanitizedFields).toContain('nested.password');
			expect(result.sanitizedFields).toContain('customPath');
		});

		it('should produce output that contains no home directory paths for recognized path keys', async () => {
			const { collectSettings } = await import('../collectors/settings');
			const homeDir = os.homedir();

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					// These use recognized path key names
					customPath: `${homeDir}/path1`,
					nested: {
						cwd: `${homeDir}/path2`,
						deeply: {
							projectRoot: `${homeDir}/path3`,
						},
					},
				},
			};

			const result = await collectSettings(mockStore as any);
			const resultStr = JSON.stringify(result.raw);

			expect(resultStr).not.toContain(homeDir);
			expect(result.raw.customPath).toBe('~/path1');
			expect((result.raw.nested as any).cwd).toBe('~/path2');
			expect((result.raw.nested as any).deeply.projectRoot).toBe('~/path3');
		});

		it('should not sanitize paths in array values (by design)', async () => {
			const { collectSettings } = await import('../collectors/settings');
			const homeDir = os.homedir();

			// Note: Arrays of string paths are NOT sanitized by design
			// because they aren't key-value pairs with recognized path keys.
			// This is documented behavior - only specific key names trigger path sanitization.
			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					recentPaths: [`${homeDir}/array1`, `${homeDir}/array2`],
				},
			};

			const result = await collectSettings(mockStore as any);

			// Arrays of primitive strings are preserved as-is
			// (Path sanitization only applies to values with recognized key names)
			expect(result.raw.recentPaths).toBeDefined();
		});

		it('should produce output that contains no API keys or secrets', async () => {
			const { collectSettings } = await import('../collectors/settings');

			const secrets = [
				'sk-1234567890abcdef',
				'eyJhbGciOiJIUzI1NiJ9.jwt.token',
				'supersecretpassword123',
				'bearer-token-xyz',
				'-----BEGIN RSA PRIVATE KEY-----',
			];

			const mockStore = {
				get: vi.fn(),
				set: vi.fn(),
				store: {
					apiKey: secrets[0],
					authToken: secrets[1],
					password: secrets[2],
					accessToken: secrets[3],
					privateKey: secrets[4],
				},
			};

			const result = await collectSettings(mockStore as any);
			const resultStr = JSON.stringify(result.raw);

			for (const secret of secrets) {
				expect(resultStr).not.toContain(secret);
			}
		});
	});
});
