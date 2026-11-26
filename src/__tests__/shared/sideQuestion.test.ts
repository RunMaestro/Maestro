import { describe, it, expect } from 'vitest';
import {
	buildSideQuestionPrompt,
	parseSideQuestion,
	resolveSideQuestionTarget,
	sideQuestionForkRefusal,
} from '../../shared/sideQuestion';

describe('parseSideQuestion', () => {
	it('returns the question after /btw', () => {
		expect(parseSideQuestion('/btw what did we rename?')).toBe('what did we rename?');
		expect(parseSideQuestion('  /btw   spaced out  ')).toBe('spaced out');
		expect(parseSideQuestion('/btw\nmulti\nline')).toBe('multi\nline');
	});

	it('returns an empty question for a bare /btw', () => {
		expect(parseSideQuestion('/btw')).toBe('');
	});

	it('ignores anything that is not the /btw command', () => {
		expect(parseSideQuestion('/btwx hello')).toBeNull();
		expect(parseSideQuestion('btw hello')).toBeNull();
		expect(parseSideQuestion('/history')).toBeNull();
	});
});

describe('buildSideQuestionPrompt', () => {
	it('frames the question so a mid-task session answers instead of resuming work', () => {
		const prompt = buildSideQuestionPrompt('which test failed?');
		expect(prompt).toContain('<side-question>');
		expect(prompt).toContain('Do not use tools');
		expect(prompt.endsWith('which test failed?')).toBe(true);
	});
});

describe('resolveSideQuestionTarget', () => {
	const agent = {
		name: 'Builder',
		toolType: 'claude-code',
		activeTabId: 't1',
		tabIds: ['t1', 't2'],
	};

	it('forks the named tab, else the active one', () => {
		expect(resolveSideQuestionTarget(agent, 't2')).toEqual({ ok: true, tabId: 't2' });
		expect(resolveSideQuestionTarget(agent)).toEqual({ ok: true, tabId: 't1' });
	});

	it('refuses a tab the agent does not have, and an agent with no tab', () => {
		expect(resolveSideQuestionTarget(agent, 'zz')).toEqual({
			ok: false,
			error: 'No AI tab zz on Builder',
		});
		expect(resolveSideQuestionTarget({ ...agent, activeTabId: undefined, tabIds: [] })).toEqual({
			ok: false,
			error: 'No AI tab to ask',
		});
	});

	it('answers for Claude Code agents only', () => {
		expect(resolveSideQuestionTarget({ ...agent, toolType: 'codex' })).toEqual({
			ok: false,
			error: 'Builder cannot answer side questions (Claude Code agents only)',
		});
	});
});

describe('sideQuestionForkRefusal', () => {
	const claude = {
		name: 'Claude Code',
		ephemeralForkArgs: ['--fork-session', '--no-session-persistence'],
		noPersistenceArgs: ['--no-session-persistence'],
	};

	it('allows a provider that forks a session and can save none', () => {
		expect(sideQuestionForkRefusal(claude, true)).toBeNull();
		expect(sideQuestionForkRefusal(claude, false)).toBeNull();
	});

	it('refuses a provider that would write into the real conversation, or leave one behind', () => {
		expect(sideQuestionForkRefusal({ name: 'Codex' }, true)).toContain('cannot fork a session');
		expect(sideQuestionForkRefusal({ ...claude, noPersistenceArgs: undefined }, false)).toContain(
			'without saving a session'
		);
	});
});
