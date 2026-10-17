/**
 * @file acappella-voice-mode.test.ts
 *
 * The three ways to talk to Maestro - Tab, Agent, Conductor - and the binding
 * rules each one imposes on a routing decision.
 */

import { describe, it, expect } from 'vitest';

import {
	SWITCHABLE_VOICE_MODES,
	TAB_SCOPE_ROUTER_ID,
	applyAgentScope,
	isSameVoiceScope,
	isScopeRouterId,
	scopeFollowingFocus,
	scopeForMode,
	scopeRouterId,
	stepSwitchableVoiceMode,
	switchableVoiceMode,
	tabScopeDecision,
	voiceScopeMode,
	voiceScopeTabId,
	type ModeTargetContext,
} from '../../shared/acappella/voice-mode';
import { QUICK_CHAT_SCOPE_ROUTER_ID } from '../../shared/acappella/quick-chat-scope';
import type { RosterAgent } from '../../shared/acappella/protocol';
import type { RouteDecision } from '../../shared/acappella/route-decision';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'philosopher',
		name: 'Philosopher',
		agentType: 'claude-code',
		cwd: '/p',
		tabs: [
			{ id: 'p-main', name: 'Main', lastActiveAt: 1 },
			{ id: 'p-ideas', name: 'Ideas', lastActiveAt: 2 },
		],
	},
	{
		sessionId: 'backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/b',
		tabs: [{ id: 'b-auth', name: 'Auth', lastActiveAt: 3 }],
	},
];

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		target: { sessionId: 'philosopher' },
		tabAction: 'current',
		prompt: 'summarize the thread',
		confidence: 0.8,
		...overrides,
	};
}

describe('voiceScopeMode', () => {
	it('tells the five bindings apart', () => {
		expect(voiceScopeMode({ kind: 'quick-chat' })).toBe('quick-chat');
		expect(voiceScopeMode({ kind: 'conductor' })).toBe('conductor');
		expect(voiceScopeMode(null)).toBe('conductor');
		expect(voiceScopeMode({ kind: 'agent', sessionId: 'philosopher' })).toBe('agent');
		expect(voiceScopeMode({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' })).toBe(
			'tab'
		);
		expect(voiceScopeMode({ kind: 'document', sessionId: 'philosopher', path: '/a.md' })).toBe(
			'document'
		);
		expect(voiceScopeTabId({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' })).toBe(
			'p-main'
		);
		expect(voiceScopeTabId({ kind: 'agent', sessionId: 'philosopher' })).toBeNull();
	});
});

describe('scopeRouterId', () => {
	it('names the scopes that send the utterance as the message, with no Brain', () => {
		expect(scopeRouterId({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' })).toBe(
			TAB_SCOPE_ROUTER_ID
		);
		expect(scopeRouterId({ kind: 'quick-chat' })).toBe(QUICK_CHAT_SCOPE_ROUTER_ID);
	});

	it('is null wherever a Brain routes the turn', () => {
		expect(scopeRouterId({ kind: 'conductor' })).toBeNull();
		expect(scopeRouterId(null)).toBeNull();
		expect(scopeRouterId({ kind: 'agent', sessionId: 'philosopher' })).toBeNull();
		expect(scopeRouterId({ kind: 'document', sessionId: 'philosopher', path: '/a.md' })).toBeNull();
	});

	it('recognises its own stamps, so the routing log skips those turns', () => {
		expect(isScopeRouterId(TAB_SCOPE_ROUTER_ID)).toBe(true);
		expect(isScopeRouterId(QUICK_CHAT_SCOPE_ROUTER_ID)).toBe(true);
		expect(isScopeRouterId('mock-brain')).toBe(false);
	});
});

describe('isSameVoiceScope', () => {
	it('compares the kind, the agent, the tab and the document', () => {
		expect(isSameVoiceScope({ kind: 'conductor' }, { kind: 'conductor' })).toBe(true);
		expect(isSameVoiceScope({ kind: 'quick-chat' }, { kind: 'quick-chat' })).toBe(true);
		expect(
			isSameVoiceScope(
				{ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
				{ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' }
			)
		).toBe(true);
		expect(
			isSameVoiceScope(
				{ kind: 'document', sessionId: 'philosopher', path: '/a.md' },
				{ kind: 'document', sessionId: 'philosopher', path: '/a.md' }
			)
		).toBe(true);
	});

	it('tells Agent mode from Tab mode, and one tab or file from another', () => {
		expect(
			isSameVoiceScope(
				{ kind: 'agent', sessionId: 'philosopher' },
				{ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' }
			)
		).toBe(false);
		expect(
			isSameVoiceScope(
				{ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
				{ kind: 'agent', sessionId: 'philosopher', tabId: 'p-ideas' }
			)
		).toBe(false);
		expect(
			isSameVoiceScope(
				{ kind: 'document', sessionId: 'philosopher', path: '/a.md' },
				{ kind: 'document', sessionId: 'philosopher', path: '/b.md' }
			)
		).toBe(false);
		expect(isSameVoiceScope({ kind: 'conductor' }, { kind: 'quick-chat' })).toBe(false);
	});

	it('never matches a missing scope: no session is not a binding to resume', () => {
		expect(isSameVoiceScope(null, null)).toBe(false);
		expect(isSameVoiceScope({ kind: 'quick-chat' }, null)).toBe(false);
		expect(isSameVoiceScope(undefined, { kind: 'conductor' })).toBe(false);
	});
});

describe('tabScopeDecision', () => {
	it('sends the utterance verbatim to the pinned tab', () => {
		// Nothing is stripped: in Tab mode there is no routing chatter, so "In one
		// sentence, ask the backend agent" is a message for this tab, all of it.
		expect(
			tabScopeDecision('  In one sentence, ask the backend agent about auth ', {
				kind: 'agent',
				sessionId: 'philosopher',
				tabId: 'p-ideas',
			})
		).toEqual({
			target: { sessionId: 'philosopher' },
			tabAction: 'recall',
			tabId: 'p-ideas',
			prompt: 'In one sentence, ask the backend agent about auth',
			confidence: 1,
		});
	});
});

describe('applyAgentScope', () => {
	const scope = { kind: 'agent' as const, sessionId: 'philosopher' };

	it('keeps a request that names another agent with the bound agent', () => {
		// The Brain cut "Backend" out of its prompt because it thought Backend was
		// the recipient. Philosopher needs the name to act on the request.
		const bound = applyAgentScope(
			decision({ target: { sessionId: 'backend' }, prompt: 'in one word, what is two plus two?' }),
			scope,
			ROSTER,
			'Ask Backend, in one word, what is two plus two?'
		);

		expect(bound.target).toEqual({ sessionId: 'philosopher' });
		expect(bound.tabAction).toBe('current');
		expect(bound.prompt).toBe('Ask Backend, in one word, what is two plus two?');
	});

	it('keeps the Brain’s tab choice: a new tab, with its name', () => {
		const bound = applyAgentScope(
			decision({ tabAction: 'new', tabName: 'Auth Refactor' }),
			scope,
			ROSTER,
			'open a new tab about the auth refactor'
		);

		expect(bound).toMatchObject({ tabAction: 'new', tabName: 'Auth Refactor' });
	});

	it('keeps a recall of one of the agent’s own tabs', () => {
		const bound = applyAgentScope(
			decision({ tabAction: 'recall', tabId: 'p-ideas' }),
			scope,
			ROSTER,
			'back to the ideas tab'
		);

		expect(bound).toMatchObject({ tabAction: 'recall', tabId: 'p-ideas' });
	});

	it('degrades a recall of another agent’s tab to the current tab', () => {
		const bound = applyAgentScope(
			decision({ target: { sessionId: 'backend' }, tabAction: 'recall', tabId: 'b-auth' }),
			scope,
			ROSTER,
			'back to the auth tab'
		);

		expect(bound.target).toEqual({ sessionId: 'philosopher' });
		expect(bound.tabAction).toBe('current');
		expect(bound.tabId).toBeUndefined();
	});

	it('sends a would-be clarification or conversational reply to the agent instead', () => {
		const clarified = applyAgentScope(
			decision({ target: 'conductor', clarify: 'Which agent?' }),
			scope,
			ROSTER,
			'fix it'
		);
		expect(clarified.clarify).toBeUndefined();
		expect(clarified.target).toEqual({ sessionId: 'philosopher' });

		const conversed = applyAgentScope(
			decision({ target: 'conductor', reply: 'Sure, tell me more.', prompt: '' }),
			scope,
			ROSTER,
			'I am thinking about the auth design'
		);
		expect(conversed.reply).toBeUndefined();
		expect(conversed.prompt).toBe('I am thinking about the auth design');
	});
});

describe('scopeForMode', () => {
	function context(overrides: Partial<ModeTargetContext> = {}): ModeTargetContext {
		return {
			scope: { kind: 'conductor' },
			lastDispatch: null,
			focusedAgentId: null,
			activeTabOf: () => null,
			...overrides,
		};
	}

	it('switches to the Conductor without needing an agent', () => {
		expect(scopeForMode('conductor', context())).toEqual({ kind: 'conductor' });
	});

	it('binds Agent mode to the agent on screen, before the one already bound or last sent to', () => {
		// Picking Agent means "this agent". The bound agent and the last dispatch
		// are where the session HAS been, not where the user is.
		expect(
			scopeForMode(
				'agent',
				context({
					scope: { kind: 'agent', sessionId: 'archivist', tabId: 'a-main' },
					lastDispatch: { agentSessionId: 'backend', tabId: 'b-auth' },
					focusedAgentId: 'philosopher',
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'philosopher' });
	});

	it('with no agent on screen, falls back to the bound agent, then the last one sent to', () => {
		expect(
			scopeForMode(
				'agent',
				context({
					scope: { kind: 'agent', sessionId: 'archivist', tabId: 'a-main' },
					lastDispatch: { agentSessionId: 'backend', tabId: 'b-auth' },
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'archivist' });
		expect(
			scopeForMode(
				'agent',
				context({ lastDispatch: { agentSessionId: 'backend', tabId: 'b-auth' } })
			)
		).toEqual({ kind: 'agent', sessionId: 'backend' });
	});

	it('refuses Agent and Tab mode when there is no agent at all', () => {
		expect(scopeForMode('agent', context())).toBeNull();
		expect(scopeForMode('tab', context())).toBeNull();
	});

	it('binds Tab mode to the tab in front, not the tab the last request landed in', () => {
		// The failure this replaced: looking at one conversation, picking Tab, and
		// pinning a different one because an earlier request went there.
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher' },
					lastDispatch: { agentSessionId: 'philosopher', tabId: 'p-ideas' },
					focusedAgentId: 'philosopher',
					activeTabOf: () => 'p-main',
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' });
	});

	it('binds Tab mode to the on-screen agent’s tab, leaving the bound agent behind', () => {
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
					focusedAgentId: 'backend',
					activeTabOf: (agent) => (agent === 'backend' ? 'b-auth' : 'p-main'),
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'backend', tabId: 'b-auth' });
	});

	it('with no conversation in front, keeps the pinned tab, then the last one sent to', () => {
		// A tiled file pane has no conversation behind it. The mode still binds.
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
					lastDispatch: { agentSessionId: 'philosopher', tabId: 'p-ideas' },
					focusedAgentId: 'philosopher',
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' });
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher' },
					lastDispatch: { agentSessionId: 'philosopher', tabId: 'p-ideas' },
					focusedAgentId: 'philosopher',
				})
			)
		).toEqual({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-ideas' });
	});

	it('never borrows a tab from a different agent', () => {
		// The pin and the last dispatch belong to other agents, and the agent on
		// screen has no conversation in front: there is nothing to bind to.
		expect(
			scopeForMode(
				'tab',
				context({
					scope: { kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
					lastDispatch: { agentSessionId: 'archivist', tabId: 'a-main' },
					focusedAgentId: 'backend',
				})
			)
		).toBeNull();
	});
});

describe('scopeFollowingFocus', () => {
	it('moves Agent mode to the agent the user switched to', () => {
		expect(
			scopeFollowingFocus(
				{ kind: 'agent', sessionId: 'philosopher' },
				{ agentSessionId: 'backend', tabId: 'b-auth' }
			)
		).toEqual({ kind: 'agent', sessionId: 'backend' });
	});

	it('leaves Agent mode alone when only the tab changed', () => {
		// Agent mode has no tab to follow: the Conductor picks it per sentence.
		expect(
			scopeFollowingFocus(
				{ kind: 'agent', sessionId: 'philosopher' },
				{ agentSessionId: 'philosopher', tabId: 'p-ideas' }
			)
		).toBeNull();
	});

	it('moves Tab mode to another tab of the same agent, and to another agent’s tab', () => {
		const pinned = { kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' } as const;

		expect(
			scopeFollowingFocus(pinned, { agentSessionId: 'philosopher', tabId: 'p-ideas' })
		).toEqual({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-ideas' });
		expect(scopeFollowingFocus(pinned, { agentSessionId: 'backend', tabId: 'b-auth' })).toEqual({
			kind: 'agent',
			sessionId: 'backend',
			tabId: 'b-auth',
		});
	});

	it('sends nothing when the focus is already what the session is bound to', () => {
		// Re-binding clears the Conductor's pending question, so an identical scope
		// is not a harmless write. This is also what makes a dispatch that brings
		// its own tab to the front a no-op.
		expect(
			scopeFollowingFocus(
				{ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
				{ agentSessionId: 'philosopher', tabId: 'p-main' }
			)
		).toBeNull();
	});

	it('keeps a Tab pin when no conversation is in front, rather than dropping to Agent mode', () => {
		expect(
			scopeFollowingFocus(
				{ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' },
				{ agentSessionId: 'backend', tabId: null }
			)
		).toBeNull();
	});

	it('never moves the Conductor or a document conversation', () => {
		const focus = { agentSessionId: 'backend', tabId: 'b-auth' };

		expect(scopeFollowingFocus({ kind: 'conductor' }, focus)).toBeNull();
		expect(scopeFollowingFocus(null, focus)).toBeNull();
		// A document conversation is about a file, and stays with it.
		expect(
			scopeFollowingFocus({ kind: 'document', sessionId: 'philosopher', path: '/a.md' }, focus)
		).toBeNull();
		// A Quick Chat session is locked to the Quick Chat conversation.
		expect(scopeFollowingFocus({ kind: 'quick-chat' }, focus)).toBeNull();
	});

	it('stays put when no agent is on screen', () => {
		expect(
			scopeFollowingFocus(
				{ kind: 'agent', sessionId: 'philosopher' },
				{ agentSessionId: null, tabId: null }
			)
		).toBeNull();
	});
});

describe('stepping through the modes (the Tab key)', () => {
	it('walks them in the order the switch draws them, wrapping at both ends', () => {
		expect(SWITCHABLE_VOICE_MODES).toEqual(['tab', 'agent', 'conductor']);

		expect(stepSwitchableVoiceMode('tab')).toBe('agent');
		expect(stepSwitchableVoiceMode('agent')).toBe('conductor');
		expect(stepSwitchableVoiceMode('conductor')).toBe('tab');

		expect(stepSwitchableVoiceMode('tab', -1)).toBe('conductor');
		expect(stepSwitchableVoiceMode('conductor', -1)).toBe('agent');
	});

	it('reads a document conversation as Tab, which is where the switch shows it', () => {
		expect(switchableVoiceMode(null)).toBe('conductor');
		expect(switchableVoiceMode({ kind: 'agent', sessionId: 'philosopher' })).toBe('agent');
		expect(switchableVoiceMode({ kind: 'agent', sessionId: 'philosopher', tabId: 'p-main' })).toBe(
			'tab'
		);
		expect(
			switchableVoiceMode({ kind: 'document', sessionId: 'philosopher', path: '/p/notes.md' })
		).toBe('tab');
	});

	it('reads a Quick Chat session as Tab: every sentence goes to one conversation', () => {
		expect(switchableVoiceMode({ kind: 'quick-chat' })).toBe('tab');
	});
});
