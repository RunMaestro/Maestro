import { describe, expect, it } from 'vitest';
import { buildSettingsSnapshot, type SettingsInput } from '../../../shared/maestro-lib';
import { PROFILE_PREVIEW_LINES, settingsLines } from '../lines';

const snapshotOf = (input: Partial<SettingsInput> = {}) =>
	buildSettingsSnapshot({
		settings: {},
		agentConfigs: {},
		sshRemotes: [],
		promptStore: {},
		source: 'host',
		...input,
	});

const text = (input?: Partial<SettingsInput>) =>
	settingsLines(snapshotOf(input))
		.map((line) => `${line.label} ${line.text}`.trim())
		.join('\n');

describe('settingsLines (ST-1)', () => {
	it('prints every section, with the empty ones said plainly', () => {
		const out = text();
		for (const heading of [
			'Source: the desktop (live)',
			'Provider defaults',
			'Agent configs by provider',
			'SSH remotes',
			'Conductor profile',
			'Prompt customizations',
			'Encore features',
		]) {
			expect(out).toContain(heading);
		}
		expect(out).toContain('No provider has a stored config.');
		expect(out).toContain('None configured.');
		expect(out).toContain('Not set.');
		expect(out).toContain('No prompt has been edited.');
	});

	it('shows provider configs under the provider name and never a raw secret', () => {
		const out = text({
			agentConfigs: { 'claude-code': { customPath: '/opt/claude', apiKey: 'sk-do-not-print-me' } },
			settings: { shellEnvVars: { GITHUB_TOKEN: 'ghp_abcdefghijklmnop' } },
		});
		expect(out).toContain('Claude Code');
		expect(out).toContain('customPath /opt/claude');
		expect(out).not.toContain('do-not-print-me');
		expect(out).not.toContain('abcdefghijkl');
	});

	it('lists the Encore flags as on or off, a default included', () => {
		const out = text({ settings: { encoreFeatures: { maestroCue: false, pianola: true } } });
		expect(out).toContain('Maestro Cue off');
		expect(out).toContain('Pianola on');
		expect(out).toContain('Usage Dashboard on');
	});

	it('previews a long conductor profile and counts what it left out', () => {
		const profile = Array.from({ length: PROFILE_PREVIEW_LINES + 4 }, (_, i) => `rule ${i}`).join(
			'\n'
		);
		const out = text({ settings: { conductorProfile: profile } });
		expect(out).toContain('rule 0');
		expect(out).toContain(`rule ${PROFILE_PREVIEW_LINES - 1}`);
		expect(out).not.toContain(`rule ${PROFILE_PREVIEW_LINES}\n`);
		expect(out).toContain('... 4 more lines');
	});

	it('says when the settings came from files, and surfaces a host note and file problems', () => {
		const out = text({
			source: 'files',
			note: 'Host: busy. Showing files.',
			problems: ['Settings file is corrupt: x'],
		});
		expect(out).toContain('Source: settings files on disk');
		expect(out).toContain('Host: busy. Showing files.');
		expect(out).toContain('Settings file is corrupt: x');
	});

	it('gives every line a unique key', () => {
		const keys = settingsLines(snapshotOf()).map((line) => line.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
