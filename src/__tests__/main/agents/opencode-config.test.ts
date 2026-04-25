/**
 * Tests for OpenCode config utilities
 *
 * Verifies config path resolution, model extraction from provider definitions,
 * and local config file discovery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	getOpenCodeConfigPaths,
	getOpenCodeCommandDirs,
	parseOpenCodeConfig,
	extractModelsFromConfig,
	discoverModelsFromLocalConfigs,
} from '../../../main/agents/opencode-config';

// Mock fs
vi.mock('fs', () => ({
	promises: {
		readFile: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock platformDetection
vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
}));

import * as fs from 'fs';
import { isWindows } from '../../../shared/platformDetection';

describe('opencode-config', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('parseOpenCodeConfig', () => {
		it('should parse valid JSON config', () => {
			const config = parseOpenCodeConfig('{"model": "ollama/qwen3:8b"}');
			expect(config).toEqual({ model: 'ollama/qwen3:8b' });
		});

		it('should return null for invalid JSON', () => {
			expect(parseOpenCodeConfig('not json')).toBeNull();
			expect(parseOpenCodeConfig('')).toBeNull();
		});
	});

	describe('extractModelsFromConfig', () => {
		it('should extract models from provider definitions', () => {
			const config = {
				provider: {
					ollama: {
						models: {
							'gpt-oss:latest': { name: 'GPT OSS' },
							'qwen3:8b': { name: 'Qwen3' },
						},
					},
					anthropic: {
						models: {
							'claude-sonnet-4-20250514': { name: 'Claude Sonnet' },
						},
					},
				},
			};
			const models = extractModelsFromConfig(config);
			expect(models).toEqual([
				'ollama/gpt-oss:latest',
				'ollama/qwen3:8b',
				'anthropic/claude-sonnet-4-20250514',
			]);
		});

		it('should include top-level model override', () => {
			const config = {
				model: 'anthropic/claude-sonnet-4-20250514',
				provider: {
					ollama: {
						models: {
							'qwen3:8b': { name: 'Qwen3' },
						},
					},
				},
			};
			const models = extractModelsFromConfig(config);
			expect(models).toEqual(['anthropic/claude-sonnet-4-20250514', 'ollama/qwen3:8b']);
		});

		it('should deduplicate top-level model when it matches a provider model', () => {
			const config = {
				model: 'ollama/qwen3:8b',
				provider: {
					ollama: {
						models: {
							'qwen3:8b': { name: 'Qwen3' },
						},
					},
				},
			};
			const models = extractModelsFromConfig(config);
			expect(models).toEqual(['ollama/qwen3:8b']);
		});

		it('should return empty array for config without providers or model', () => {
			expect(extractModelsFromConfig({})).toEqual([]);
			expect(extractModelsFromConfig({ provider: {} })).toEqual([]);
		});

		it('should skip providers without models property', () => {
			const config = {
				provider: {
					ollama: { npm: '@ai-sdk/openai-compatible' },
				},
			};
			expect(extractModelsFromConfig(config)).toEqual([]);
		});

		it('should ignore empty or whitespace model override', () => {
			expect(extractModelsFromConfig({ model: '' })).toEqual([]);
			expect(extractModelsFromConfig({ model: '   ' })).toEqual([]);
		});
	});

	describe('getOpenCodeConfigPaths', () => {
		it('should return POSIX paths in correct order', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const paths = getOpenCodeConfigPaths('/project', {});
			expect(paths).toEqual([
				'/project/opencode.json',
				expect.stringContaining('.opencode/opencode.json'),
				expect.stringContaining('.opencode.json'),
				expect.stringContaining('.config/opencode/opencode.json'),
			]);
		});

		it('should prepend OPENCODE_CONFIG env var when set', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const paths = getOpenCodeConfigPaths('/project', {
				OPENCODE_CONFIG: '/custom/opencode.json',
			});
			expect(paths[0]).toBe('/custom/opencode.json');
			expect(paths.length).toBe(5);
		});

		it('should return paths without project-local when cwd is undefined', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const paths = getOpenCodeConfigPaths(undefined, {});
			expect(paths.every((p) => !p.includes('undefined'))).toBe(true);
			expect(paths.length).toBe(3);
		});
	});

	describe('getOpenCodeCommandDirs', () => {
		it('should return POSIX dirs in correct order', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const dirs = getOpenCodeCommandDirs('/project');
			expect(dirs).toEqual([
				'/project/.opencode/commands',
				expect.stringContaining('.opencode/commands'),
				expect.stringContaining('.config/opencode/commands'),
			]);
		});

		it('should exclude project dir when cwd is undefined', () => {
			vi.mocked(isWindows).mockReturnValue(false);
			const dirs = getOpenCodeCommandDirs(undefined);
			expect(dirs.length).toBe(2);
		});
	});

	describe('discoverModelsFromLocalConfigs', () => {
		it('should merge models from multiple config files', async () => {
			// Simulate two config files found
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				if (p.includes('.opencode/opencode.json')) {
					return JSON.stringify({
						provider: {
							ollama: {
								models: {
									'qwen3:8b': { name: 'Qwen3' },
								},
							},
						},
					});
				}
				if (p.includes('.config/opencode/opencode.json')) {
					return JSON.stringify({
						provider: {
							anthropic: {
								models: {
									'claude-sonnet-4-20250514': { name: 'Claude Sonnet' },
								},
							},
						},
					});
				}
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs('/project');
			expect(models).toContain('ollama/qwen3:8b');
			expect(models).toContain('anthropic/claude-sonnet-4-20250514');
		});

		it('should deduplicate models across config files', async () => {
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				if (p.includes('.opencode/opencode.json') || p.includes('.config/opencode/opencode.json')) {
					return JSON.stringify({
						provider: {
							ollama: {
								models: { 'qwen3:8b': { name: 'Qwen3' } },
							},
						},
					});
				}
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs('/project');
			const count = models.filter((m) => m === 'ollama/qwen3:8b').length;
			expect(count).toBe(1);
		});

		it('should return empty array when no config files exist', async () => {
			vi.mocked(fs.promises.readFile).mockImplementation(async () => {
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs();
			expect(models).toEqual([]);
		});

		it('should skip invalid JSON config files', async () => {
			vi.mocked(fs.promises.readFile).mockImplementation(async (filePath: any) => {
				const p = String(filePath);
				if (p.includes('.opencode/opencode.json')) {
					return 'not valid json';
				}
				const err: any = new Error('ENOENT');
				err.code = 'ENOENT';
				throw err;
			});

			const models = await discoverModelsFromLocalConfigs();
			expect(models).toEqual([]);
		});
	});
});
