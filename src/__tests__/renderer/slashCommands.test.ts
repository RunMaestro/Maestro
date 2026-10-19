/**
 * Tests for buildSlashCommandList: what the composer's `/` picker offers, in
 * picker order. Shared by the app window's composer and a tab window's, which
 * leaves out the built-ins that act on the app window's active tab.
 */

import { describe, it, expect } from 'vitest';
import { buildSlashCommandList, slashCommands } from '../../renderer/slashCommands';

const custom = [{ command: '/review', description: 'Review', prompt: 'Review this' }];
const speckit = [{ command: '/speckit.plan', description: 'Plan', prompt: 'p' }];
const openspec = [{ command: '/openspec.apply', description: 'Apply', prompt: 'a' }];
const bmad = [{ command: '/bmad.story', description: 'Story', prompt: 'b' }];
const agentCommands = [{ command: '/compact', description: 'Compact' }];

describe('buildSlashCommandList', () => {
	it('lists built-ins, custom, the methodology sets, then agent commands', () => {
		const list = buildSlashCommandList({
			toolType: 'claude-code',
			customAICommands: custom,
			speckitCommands: speckit,
			openspecCommands: openspec,
			bmadCommands: bmad,
			agentCommands,
		});
		expect(list.map((c) => c.command)).toEqual([
			...slashCommands.map((c) => c.command),
			'/review',
			'/speckit.plan',
			'/openspec.apply',
			'/bmad.story',
			'/compact',
		]);
		expect(list.find((c) => c.command === '/review')).toEqual({
			command: '/review',
			description: 'Review',
			aiOnly: true,
			prompt: 'Review this',
		});
		expect(list.find((c) => c.command === '/compact')).toEqual({
			command: '/compact',
			description: 'Compact',
			aiOnly: true,
		});
	});

	it('drops a built-in meant for another agent type', () => {
		const list = buildSlashCommandList({ toolType: 'codex', customAICommands: [] });
		expect(list.map((c) => c.command)).not.toContain('/skills');
		expect(list.map((c) => c.command)).toContain('/history');
	});

	it('leaves out the built-ins a caller excludes (a tab window)', () => {
		const list = buildSlashCommandList({
			toolType: 'claude-code',
			customAICommands: custom,
			excludeBuiltIns: ['/history', '/wizard', '/skills'],
		});
		expect(list.map((c) => c.command)).toEqual([
			...slashCommands
				.map((c) => c.command)
				.filter((c) => !['/history', '/wizard', '/skills'].includes(c)),
			'/review',
		]);
	});
});
