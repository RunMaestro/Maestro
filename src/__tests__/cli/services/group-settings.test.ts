/**
 * Tests for the Group Settings CLI service: the description of a stored group,
 * the readback guard, and the setting flags both verbs share.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Group } from '../../../shared/types';

vi.mock('../../../cli/services/storage', () => ({
	readGroups: vi.fn(() => [] as Group[]),
	resolveAgentId: vi.fn((id: string) => id),
	readLocalModelEndpoints: vi.fn(() => []),
	readSessions: vi.fn(() => []),
	readSettingValue: vi.fn(() => undefined),
	readSshRemotes: vi.fn(() => []),
}));

import { buildSshPatch, hasSshFlags } from '../../../cli/services/agent-setting-flags';
import {
	describeGroupSettings,
	groupSettingsBlocker,
	readGroupSettingsFlags,
	readLifecycleFlags,
	verifyPersistedGroupSettings,
} from '../../../cli/services/group-settings';
import { readGroups } from '../../../cli/services/storage';

const GROUP: Group = { id: 'g1', name: 'BACKEND TEAM', emoji: '🛠', collapsed: false };

describe('describeGroupSettings', () => {
	it('reports the automatic abbreviation as automatic and no defaults as null', () => {
		const report = describeGroupSettings(GROUP);
		expect(report).toMatchObject({
			id: 'g1',
			shortLabel: null,
			badgeLabelSource: 'automatic',
			defaults: null,
			kind: 'user',
		});
		expect(report.badgeLabel.length).toBeGreaterThan(0);
	});

	it('reports a hand-picked label as custom, and trims it', () => {
		const report = describeGroupSettings({ ...GROUP, shortLabel: '  BE ' });
		expect(report).toMatchObject({
			shortLabel: 'BE',
			badgeLabel: 'BE',
			badgeLabelSource: 'custom',
		});
	});

	it('treats an empty defaults object as none', () => {
		expect(describeGroupSettings({ ...GROUP, defaults: {} }).defaults).toBeNull();
	});

	it('reports no lifecycle as null, and a stored one normalized', () => {
		expect(describeGroupSettings(GROUP).lifecycle).toBeNull();
		const report = describeGroupSettings({
			...GROUP,
			lifecycle: { onboarding: { enabled: true, prompt: 'Set up', triggers: ['agent'] } },
		});
		expect(report.lifecycle).toEqual({
			onboarding: { enabled: true, prompt: 'Set up', triggers: ['agent'] },
		});
	});
});

describe('groupSettingsBlocker', () => {
	it('blocks a worktree group only', () => {
		expect(groupSettingsBlocker(GROUP)).toBeUndefined();
		expect(groupSettingsBlocker({ ...GROUP, kind: 'worktree' })).toContain('worktree group');
	});
});

describe('verifyPersistedGroupSettings', () => {
	beforeEach(() => vi.mocked(readGroups).mockReset());

	it('passes when the disk holds what the app reported', () => {
		vi.mocked(readGroups).mockReturnValue([
			{ ...GROUP, shortLabel: 'BE', defaults: { nudgeMessage: 'N' } },
		]);
		expect(
			verifyPersistedGroupSettings('g1', { defaults: { nudgeMessage: 'N' }, shortLabel: 'BE' })
		).toBeNull();
	});

	it('names a defaults mismatch and a label mismatch', () => {
		vi.mocked(readGroups).mockReturnValue([GROUP]);
		const message = verifyPersistedGroupSettings('g1', {
			defaults: { nudgeMessage: 'N' },
			shortLabel: 'BE',
		});
		expect(message).toContain('defaults on disk');
		expect(message).toContain('pill label');
	});

	it('names a lifecycle mismatch only when the app reported a lifecycle', () => {
		vi.mocked(readGroups).mockReturnValue([GROUP]);
		const stored = {
			onboarding: { enabled: true, prompt: 'Set up', triggers: ['agent' as const] },
		};
		expect(
			verifyPersistedGroupSettings('g1', { defaults: null, shortLabel: null, lifecycle: stored })
		).toContain('lifecycle prompts');
		expect(verifyPersistedGroupSettings('g1', { defaults: null, shortLabel: null })).toBeNull();
		expect(
			verifyPersistedGroupSettings('g1', { defaults: null, shortLabel: null, lifecycle: null })
		).toBeNull();
	});

	it('fails for a group that vanished', () => {
		vi.mocked(readGroups).mockReturnValue([]);
		expect(verifyPersistedGroupSettings('g1', { defaults: null, shortLabel: null })).toContain(
			'not found'
		);
	});
});

describe('readGroupSettingsFlags', () => {
	it('does not send the context window provenance marker, which a group does not store', () => {
		const request = readGroupSettingsFlags({ contextWindow: '500000' }, GROUP);
		expect(request.configPatch).toEqual({ customContextWindow: 500000 });
	});

	it('reads --model-source against the provider this same call sets', () => {
		// The saved sources are read from storage, which holds none: the id is
		// refused by name, which proves the provider was found.
		expect(() =>
			readGroupSettingsFlags({ provider: 'claude-code', modelSource: 'ollama:qwen3' }, GROUP)
		).toThrow(/ollama/);
	});

	it('keeps an SSH working directory as typed', () => {
		const request = readGroupSettingsFlags({ sshRemote: 'box', cwd: '/srv/app' }, GROUP);
		expect(request.configPatch).toEqual({ projectRoot: '/srv/app' });
		expect(request.sshPatch).toEqual({ enabled: true, remoteId: 'box' });
	});
});

describe('buildSshPatch', () => {
	it('builds only the keys that were passed', () => {
		expect(hasSshFlags({})).toBe(false);
		expect(hasSshFlags({ sshCwd: '/x' })).toBe(true);
		expect(buildSshPatch({ sshCwd: '/x' })).toEqual({ workingDirOverride: '/x' });
	});

	it('reverts to local execution for none, an empty string or null', () => {
		for (const word of ['none', '', 'null', 'NONE']) {
			expect(buildSshPatch({ sshRemote: word })).toEqual({ enabled: false, remoteId: null });
		}
	});

	it('reads the history sync as a boolean and names the flag when it is not one', () => {
		expect(buildSshPatch({ syncHistoryToRemote: 'yes' })).toEqual({ syncHistory: true });
		expect(() => buildSshPatch({ syncHistoryToRemote: 'maybe' })).toThrow(
			'--sync-history-to-remote'
		);
	});
});

describe('readLifecycleFlags', () => {
	it('reads nothing when no lifecycle flag was passed', () => {
		expect(readLifecycleFlags({})).toBeUndefined();
	});

	it('reads every flag of a stage into its patch', () => {
		expect(
			readLifecycleFlags({
				onboarding: 'on',
				onboardingPrompt: 'Set up {{AGENT_NAME}}',
				onboardingEvents: 'worktree, agent',
				onboardingRunsIn: 'steward',
				onboardingTab: ' Setup ',
				onboardingTier: 'LOW',
			})
		).toEqual({
			onboarding: {
				enabled: true,
				prompt: 'Set up {{AGENT_NAME}}',
				triggers: ['agent', 'worktree'],
				runsInAgentId: 'steward',
				tabName: 'Setup',
				tier: 'low',
			},
		});
	});

	it('resets the optional fields with self, an empty string and default', () => {
		expect(
			readLifecycleFlags({
				offboardingRunsIn: 'self',
				offboardingTab: '',
				offboardingTier: 'default',
				offboardingTimeout: '',
			})
		).toEqual({
			offboarding: { runsInAgentId: null, tabName: null, tier: null, timeoutMinutes: null },
		});
	});

	it('reads a prompt from a file named with @', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-flags-'));
		const file = path.join(dir, 'onboard.md');
		fs.writeFileSync(file, 'Copy the env file.');
		try {
			expect(readLifecycleFlags({ onboardingPrompt: `@${file}` })).toEqual({
				onboarding: { prompt: 'Copy the env file.' },
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('removes a stage with clear, alone', () => {
		expect(readLifecycleFlags({ offboarding: 'clear' })).toEqual({ offboarding: null });
		expect(() => readLifecycleFlags({ offboarding: 'clear', offboardingTab: 'x' })).toThrow(
			'--offboarding clear'
		);
	});

	it('names the flag when a word is not one it takes', () => {
		expect(() => readLifecycleFlags({ onboarding: 'maybe' })).toThrow('--onboarding');
		expect(() => readLifecycleFlags({ onboardingEvents: 'agent,moved' })).toThrow(
			'--onboarding-events'
		);
		expect(() => readLifecycleFlags({ offboardingTimeout: '2.5' })).toThrow(
			'--offboarding-timeout'
		);
	});

	it('rides in the update request, and a bad tier is refused by the shared parser', () => {
		const request = readGroupSettingsFlags({ onboardingPrompt: 'Hi' }, GROUP);
		expect(request.lifecyclePatch).toEqual({ onboarding: { prompt: 'Hi' } });
		expect(() => readGroupSettingsFlags({ onboardingTier: 'huge' }, GROUP)).toThrow('tier');
	});
});
