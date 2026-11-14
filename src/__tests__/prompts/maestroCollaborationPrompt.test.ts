/** Collaboration setup must be discoverable before an agent has any peers. */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { assembleMaestroSystemPrompt } from '../../shared/maestroSystemPrompt';

const template = readFileSync(
	path.join(__dirname, '../../prompts/maestro-system-prompt.md'),
	'utf-8'
);

describe('Maestro collaboration setup prompt', () => {
	const prompt = assembleMaestroSystemPrompt({
		template,
		context: {
			session: { id: 'coordinator-id', name: 'Coordinator', toolType: 'codex', cwd: '/project' },
			peerRoster: [],
		},
	});

	test('offers the CLI setup procedure even when no peer roster is rendered', () => {
		expect(prompt).not.toMatch(/^## Peer Agents$/m);
		expect(prompt).toContain('### Set Up Agent Collaboration');
		expect(prompt).toContain('maestro-cli prompts get _maestro-cli');
		expect(prompt).toContain('Resolve names to agent GUIDs');
		expect(prompt).toContain('delegation graph --json');
	});

	test('routes natural language collaboration requests to setup rather than a one-time send', () => {
		const primitives = readFileSync(
			path.join(__dirname, '../../prompts/_interface-primitives.md'),
			'utf-8'
		);
		const row = primitives
			.split('\n')
			.find((line) => line.includes('Configure agent relationships'));
		expect(row).toContain('make these agents peers');
		expect(row).toContain('let these agents collaborate');
		expect(row).toContain('maestro-cli prompts get _maestro-cli');
		expect(row).toContain('Ask about missing Consult/Delegate access and direction');
		expect(row).toContain('update-agent --peer');
		expect(row).toContain('Verify the live rosters');
	});

	test('requires decisions on ambiguous access and direction, without repeated approval', () => {
		expect(prompt).toContain('ask the user in the conversation before changing grants');
		expect(prompt).toContain('Consult (R), Delegate (W), or both');
		expect(prompt).toContain('one-way or reciprocal');
		expect(prompt).toContain(
			'R/W controls asking questions and handing off work, not filesystem access'
		);
		expect(prompt).toContain(
			'Apply access and direction the user already specified without asking again'
		);
		expect(prompt).toContain(
			'An unattended run must report missing decisions and leave those grants unchanged'
		);
	});

	test('separates persistent setup from one-time work and verifies changes before use', () => {
		expect(prompt).toContain('a one-time request does not authorize a persistent peer grant');
		expect(prompt).toContain('write the reverse edge only if authorized');
		expect(prompt).toContain('group and worktree grants include future members');
		expect(prompt).toContain('Read back every affected agent and the graph');
		expect(prompt).toContain('verify a changed grant with CLI before using it in the same turn');
		expect(prompt).toContain('--new-tab --notify-on-complete coordinator-id --background');
		expect(prompt).toContain(
			'Do not launch work when the user asked only to configure relationships'
		);
	});
});
