import { describe, expect, it } from 'vitest';
import {
	buildAgentMentionSuggestions,
	buildKnownMentionNameSet,
	consultQuestionOf,
	escapeResolvedMentions,
	filterAgentMentionSuggestions,
	mentionableAgentsOf,
	mentionableGroupsOf,
	planMentions,
	resolveMentionedTargetSessionIds,
	type MentionableAgent,
	type MentionableGroup,
} from '../roster';
import { getAtMentionTrigger, spliceMentionLiteral } from '../trigger';

const agent = (
	id: string,
	name: string,
	extra: Partial<MentionableAgent> = {}
): MentionableAgent => ({
	id,
	name,
	toolType: 'claude-code',
	...extra,
});

const AGENTS: MentionableAgent[] = [
	agent('src', 'Frontend'),
	agent('be', 'Backend', { groupId: 'g-core' }),
	agent('docs', 'Docs Writer', { groupId: 'g-core' }),
	agent('rev', 'Review Bot', { sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } }),
	agent('sh', 'Shell', { toolType: 'terminal' }),
];
const GROUPS: MentionableGroup[] = [
	{ id: 'g-core', name: 'Core' },
	{ id: 'g-empty', name: 'Nobody' },
];

describe('the mention roster', () => {
	it('lists other agents and groups, never the asker, a terminal, or an empty group', () => {
		const rows = buildAgentMentionSuggestions(AGENTS, GROUPS, 'src');
		expect(rows.map((row) => `${row.kind}:${row.displayText}`)).toEqual([
			'group:Core',
			'agent:Backend',
			'agent:Docs Writer',
			'agent:Review Bot',
		]);
		expect(rows.find((row) => row.displayText === 'Review Bot')).toMatchObject({
			isSshRemote: true,
			sshRemoteId: 'r1',
		});
	});

	it('expands a group into every member token and never into a target of its own (XM-1)', () => {
		const group = buildAgentMentionSuggestions(AGENTS, GROUPS, 'src')[0]!;
		expect(group.memberMentionValue).toBe('@Backend @Docs-Writer ');
		// The expansion resolves to the members, the group name alone to nothing.
		expect(
			resolveMentionedTargetSessionIds(group.memberMentionValue!, AGENTS, GROUPS, 'src')
		).toEqual(['be', 'docs']);
		expect(resolveMentionedTargetSessionIds('@Core hello', AGENTS, GROUPS, 'src')).toEqual([]);
		expect(buildKnownMentionNameSet(AGENTS, GROUPS, 'src').has('core')).toBe(false);
	});

	it('ranks a fuzzy filter best first and lists everything for a bare @', () => {
		const items = buildAgentMentionSuggestions(AGENTS, GROUPS, 'src');
		expect(filterAgentMentionSuggestions(items, '')).toHaveLength(4);
		expect(filterAgentMentionSuggestions(items, 'rev').map((row) => row.displayText)).toEqual([
			'Review Bot',
		]);
		expect(filterAgentMentionSuggestions(items, 'zzz')).toEqual([]);
	});
});

describe('planning a message', () => {
	it('has no plan when nothing resolves, and never targets the asker', () => {
		expect(planMentions('hello there', AGENTS, GROUPS, 'src')).toBeNull();
		expect(planMentions('@Nobody-Here hi', AGENTS, GROUPS, 'src')).toBeNull();
		expect(planMentions('@Frontend hi', AGENTS, GROUPS, 'src')).toBeNull();
	});

	it('suppresses the local send only when the message LEADS with a mention', () => {
		expect(planMentions('@Backend which branch?', AGENTS, GROUPS, 'src')).toEqual({
			targetAgentIds: ['be'],
			suppressLocal: true,
		});
		expect(planMentions('ask @Backend which branch?', AGENTS, GROUPS, 'src')).toEqual({
			targetAgentIds: ['be'],
			suppressLocal: false,
		});
	});

	it('fans out to several agents in first-seen order, once each', () => {
		const plan = planMentions('@Docs-Writer @Backend @Docs-Writer compare', AGENTS, GROUPS, 'src');
		expect(plan?.targetAgentIds).toEqual(['docs', 'be']);
	});

	it('asks the question without the resolved mention tokens and keeps unknown @words', () => {
		expect(consultQuestionOf('@Backend  which branch, @todo?', AGENTS, GROUPS, 'src')).toBe(
			'which branch, @todo?'
		);
		expect(consultQuestionOf('@Backend', AGENTS, GROUPS, 'src')).toBe('');
	});

	it('quotes every resolved mention so a second consult is not raised downstream', () => {
		const escaped = escapeResolvedMentions('see @Backend and @Nope', AGENTS, GROUPS, 'src');
		expect(escaped).toBe('see "@Backend" and @Nope');
		// The quoted form is literal text to the scanner: nothing resolves from it.
		expect(planMentions(escaped, AGENTS, GROUPS, 'src')).toBeNull();
	});
});

describe('records as the roster', () => {
	it('reads a record without trusting its unknown fields', () => {
		const roster = mentionableAgentsOf([
			{
				id: 'a',
				name: 'A',
				toolType: 'codex',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r' },
			},
			{ id: 'b', name: 'B', toolType: 'codex', sessionSshRemoteConfig: 'nonsense' },
		]);
		expect(roster[0]!.sessionSshRemoteConfig).toEqual({ enabled: true, remoteId: 'r' });
		expect(roster[1]!.sessionSshRemoteConfig).toBeUndefined();
		expect(mentionableGroupsOf([{ id: 'g', name: 'G', emoji: 'x' }])).toEqual([
			{ id: 'g', name: 'G' },
		]);
	});
});

describe('the @ trigger', () => {
	it('opens at a word start and reports what follows the @', () => {
		expect(getAtMentionTrigger('ask @Back', 9)).toEqual({
			open: true,
			filter: 'Back',
			startIndex: 4,
		});
		expect(getAtMentionTrigger('mail a@b.c', 10)).toBeNull();
		expect(getAtMentionTrigger('@Backend done ', 14)).toBeNull();
	});

	it('splices a literal over the @filter and parks the caret after it', () => {
		expect(spliceMentionLiteral('ask @Ba now', 4, 'Ba', '@Backend ')).toEqual({
			value: 'ask @Backend  now',
			caretPos: 13,
		});
	});
});
