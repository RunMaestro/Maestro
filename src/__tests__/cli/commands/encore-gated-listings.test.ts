/**
 * @file encore-gated-listings.test.ts
 * @description The CLI lists an agent browses leave out a switched-off Encore
 * Feature: `open --list` (surfaces and their tabs) and `prompts list` /
 * `prompts get`, the same as the app's own pickers.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
	readSettings: vi.fn(() => ({})),
	readEncoreFlags: vi.fn(() => ({})),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/prompt-loader', () => ({
	getCliPrompt: vi.fn(async (id: string) => `content of ${id}`),
}));

import { openModal } from '../../../cli/commands/open-modal';
import { promptsGet, promptsList } from '../../../cli/commands/prompts-get';
import { readSettingValue, readSettings } from '../../../cli/services/storage';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ENCORE_FEATURE_DEFAULTS } from '../../../shared/encoreFeatureDefaults';

const allFlags = (value: boolean) =>
	Object.fromEntries(Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, value]));

let logSpy: MockInstance;

function lastJson(): unknown {
	return JSON.parse(String(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]));
}

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => vi.restoreAllMocks());

describe('open --list', () => {
	type Listed = { id: string; tabs: string[] };

	it('leaves out the surfaces and tabs of switched-off features', async () => {
		vi.mocked(readSettingValue).mockReturnValue(allFlags(false));
		await openModal(undefined, { list: true, json: true });
		const listed = lastJson() as Listed[];
		const ids = listed.map((surface) => surface.id);
		expect(ids).toContain('settings');
		expect(ids).not.toContain('cue');
		expect(ids).not.toContain('usage-dashboard');
		expect(ids).not.toContain('computer-history');
	});

	it('lists them, tabs included, while the features are on', async () => {
		vi.mocked(readSettingValue).mockReturnValue(allFlags(true));
		await openModal(undefined, { list: true, json: true });
		const listed = lastJson() as Listed[];
		expect(listed.map((surface) => surface.id)).toContain('cue');
		expect(listed.find((surface) => surface.id === 'usage-dashboard')?.tabs).toContain('cue');
	});

	it('drops a gated tab of a surface that is itself on', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ usageStats: true, maestroCue: false });
		await openModal(undefined, { list: true, json: true });
		const dashboard = (lastJson() as Listed[]).find((surface) => surface.id === 'usage-dashboard');
		expect(dashboard?.tabs).not.toContain('cue');
	});

	it('refuses to open a switched-off surface without asking the app', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ maestroCue: false });
		await expect(openModal('cue', { json: true })).rejects.toThrow('__exit__');
		expect(lastJson()).toMatchObject({ success: false, code: 'MAESTRO_CUE_DISABLED' });
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});

describe('prompts list / get', () => {
	it('leaves out the prompts of switched-off features', () => {
		vi.mocked(readSettingValue).mockReturnValue(allFlags(false));
		promptsList({ json: true });
		const ids = (lastJson() as Array<{ id: string }>).map((prompt) => prompt.id);
		expect(ids).toContain('maestro-system-prompt');
		expect(ids).not.toContain('_maestro-cue');
		expect(ids).not.toContain('cue-system');
		expect(ids).not.toContain('_computer-history');
		expect(ids).not.toContain('_concerto');
	});

	it('will not serve one either', async () => {
		vi.mocked(readSettingValue).mockReturnValue(allFlags(false));
		await expect(promptsGet('_maestro-cue', { json: true })).rejects.toThrow('__exit__');
	});

	it('serves it while the feature is on', async () => {
		vi.mocked(readSettingValue).mockReturnValue(allFlags(true));
		await promptsGet('_maestro-cue', { json: true });
		expect(lastJson()).toMatchObject({ id: '_maestro-cue', content: 'content of _maestro-cue' });
	});
});
