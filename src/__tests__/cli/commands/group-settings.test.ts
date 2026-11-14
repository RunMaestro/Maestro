/**
 * @file group-settings.test.ts
 * @description Tests for the group-settings read verb: the defaults of a group,
 * its pill label, and whether that label is the user's or Maestro's.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { Group } from '../../../shared/types';

vi.mock('../../../cli/services/storage', () => ({
	resolveGroupId: vi.fn((id: string) => id),
	resolveAgentId: vi.fn((id: string) => id),
	readActiveAgentId: vi.fn(() => undefined),
	readGroups: vi.fn(() => [] as Group[]),
	readLocalModelEndpoints: vi.fn(() => []),
	readSessions: vi.fn(() => []),
	readSettingValue: vi.fn(() => undefined),
	readSshRemotes: vi.fn(() => []),
}));

import { groupSettings } from '../../../cli/commands/group-settings';
import { readGroups, resolveGroupId } from '../../../cli/services/storage';

function stored(group: Partial<Group>): void {
	vi.mocked(readGroups).mockReturnValue([
		{ id: 'g1', name: 'BACKEND TEAM', emoji: '🛠', collapsed: false, ...group } as Group,
	]);
}

describe('group-settings command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveGroupId).mockImplementation((id: string) => id);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('says "no defaults" and labels the automatic abbreviation as automatic', () => {
		stored({});

		groupSettings('g1', {});

		const out = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
		expect(out).toContain('no defaults');
		expect(out).toContain('automatic');
	});

	it('shows a hand-picked label as custom', () => {
		stored({ shortLabel: 'BE' });

		groupSettings('g1', { json: true });

		const parsed = JSON.parse(logSpy.mock.calls[0][0]);
		expect(parsed.group).toMatchObject({
			shortLabel: 'BE',
			badgeLabel: 'BE',
			badgeLabelSource: 'custom',
			defaults: null,
		});
	});

	it('lists each default under the label the dialog uses, without env values', () => {
		stored({
			defaults: {
				toolType: 'claude-code',
				customModel: 'opus',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/secret/place' },
				nudgeMessage: 'Be brief.',
			},
		});

		groupSettings('g1', {});

		const out = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
		expect(out).toContain('Provider');
		expect(out).toContain('claude-code');
		expect(out).toContain('Model');
		expect(out).toContain('opus');
		expect(out).toContain('CLAUDE_CONFIG_DIR');
		expect(out).not.toContain('/secret/place');
	});

	it('prints the raw defaults in JSON, the automatic badge included', () => {
		stored({ defaults: { customModel: 'opus' } });

		groupSettings('g1', { json: true });

		const parsed = JSON.parse(logSpy.mock.calls[0][0]);
		expect(parsed.success).toBe(true);
		expect(parsed.group.defaults).toEqual({ customModel: 'opus' });
		expect(parsed.group.badgeLabelSource).toBe('automatic');
		expect(parsed.group.badgeLabel).toEqual(expect.any(String));
	});

	it('fails for a group that does not exist', () => {
		vi.mocked(resolveGroupId).mockImplementation(() => {
			throw new Error('Group not found: nope');
		});

		groupSettings('nope', {});

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalled();
	});
});
