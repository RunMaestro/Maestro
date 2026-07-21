import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(),
	deleteSettingValue: vi.fn(),
	readSettings: vi.fn(),
	readAgentConfigs: vi.fn(),
	readAgentConfig: vi.fn(),
	readAgentConfigValue: vi.fn(),
	writeAgentConfigValue: vi.fn(),
	deleteAgentConfigValue: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((message: string) => `Error: ${message}`),
	formatSuccess: vi.fn((message: string) => `Success: ${message}`),
	formatWarning: vi.fn((message: string) => `Warning: ${message}`),
	formatSettingDetail: vi.fn(),
	formatSettingsList: vi.fn(),
}));

vi.mock('../../../cli/output/jsonl', () => ({ emitJsonl: vi.fn() }));

import {
	deleteAgentConfigValue,
	deleteSettingValue,
	readAgentConfigValue,
	readAgentConfigs,
	readSettingValue,
	readSettings,
	writeAgentConfigValue,
	writeSettingValue,
} from '../../../cli/services/storage';
import {
	settingsAgentGet,
	settingsAgentList,
	settingsAgentReset,
	settingsAgentSet,
} from '../../../cli/commands/settings-agent';
import { settingsGet } from '../../../cli/commands/settings-get';
import { settingsList } from '../../../cli/commands/settings-list';
import { settingsReset } from '../../../cli/commands/settings-reset';
import { settingsSet } from '../../../cli/commands/settings-set';

describe('settings command error envelopes', () => {
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.mocked(readSettingValue).mockReset();
		vi.mocked(writeSettingValue).mockReset();
		vi.mocked(deleteSettingValue).mockReset();
		vi.mocked(readSettings).mockReset();
		vi.mocked(readAgentConfigs).mockReset();
		vi.mocked(readAgentConfigValue).mockReset();
		vi.mocked(writeAgentConfigValue).mockReset();
		vi.mocked(deleteAgentConfigValue).mockReset();
		vi.clearAllMocks();
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it.each([
		{
			name: 'get',
			run: () => {
				vi.mocked(readSettingValue).mockImplementation(() => {
					throw new Error('get failed');
				});
				settingsGet('fontSize', { json: true });
			},
			expected: '{"error":"get failed"}',
		},
		{
			name: 'list',
			run: () => {
				vi.mocked(readSettings).mockImplementation(() => {
					throw new Error('list failed');
				});
				settingsList({});
			},
			expected: 'Error: Failed to list settings: list failed',
		},
		{
			name: 'set',
			run: () => {
				vi.mocked(writeSettingValue).mockImplementation(() => {
					throw new Error('set failed');
				});
				settingsSet('fontSize', '12', {});
			},
			expected: 'Error: Failed to set "fontSize": set failed',
		},
		{
			name: 'reset',
			run: () => {
				vi.mocked(deleteSettingValue).mockImplementation(() => {
					throw new Error('reset failed');
				});
				settingsReset('fontSize', {});
			},
			expected: 'Error: Failed to reset "fontSize": reset failed',
		},
		{
			name: 'agent list',
			run: () => {
				vi.mocked(readAgentConfigs).mockImplementation(() => {
					throw new Error('agent list failed');
				});
				settingsAgentList(undefined, {});
			},
			expected: 'Error: Failed to list agent configs: agent list failed',
		},
		{
			name: 'agent get',
			run: () => {
				vi.mocked(readAgentConfigValue).mockImplementation(() => {
					throw new Error('agent get failed');
				});
				settingsAgentGet('codex', 'model', { json: true });
			},
			expected: '{"error":"agent get failed"}',
		},
		{
			name: 'agent set',
			run: () => {
				vi.mocked(writeAgentConfigValue).mockImplementation(() => {
					throw new Error('agent set failed');
				});
				settingsAgentSet('codex', 'model', 'gpt', {});
			},
			expected: 'Error: Failed to set "codex.model": agent set failed',
		},
		{
			name: 'agent reset',
			run: () => {
				vi.mocked(deleteAgentConfigValue).mockReturnValue(false);
				settingsAgentReset('codex', 'model', {});
			},
			expected:
				'Error: Failed to reset "codex.model": Key "model" not found in agent "codex" config.',
		},
	])('preserves the %s error stream and exit code', ({ run, expected }) => {
		expect(run).toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith(expected);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
