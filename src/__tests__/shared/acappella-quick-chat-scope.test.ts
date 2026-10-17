/**
 * @file acappella-quick-chat-scope.test.ts
 *
 * The Quick Chat binding: every sentence is the message, Quick Chat delivers
 * it, and the session cannot be re-bound in either direction.
 */

import { describe, it, expect } from 'vitest';

import { voiceScopeAgentId } from '../../shared/acappella/document-scope';
import { shouldSpeakBackgroundCompletions } from '../../shared/acappella/announcements';
import {
	QUICK_CHAT_VOICE_SCOPE,
	isQuickChatScope,
	quickChatScopeDecision,
	scopeRebindBlocker,
} from '../../shared/acappella/quick-chat-scope';
import { holdsTheFloor, routeTargetSessionId } from '../../shared/acappella/route-decision';

describe('isQuickChatScope', () => {
	it('narrows the Quick Chat scope and nothing else', () => {
		expect(isQuickChatScope(QUICK_CHAT_VOICE_SCOPE)).toBe(true);
		expect(isQuickChatScope({ kind: 'quick-chat' })).toBe(true);
		expect(isQuickChatScope({ kind: 'conductor' })).toBe(false);
		expect(isQuickChatScope({ kind: 'agent', sessionId: 'a1', tabId: 't1' })).toBe(false);
		expect(isQuickChatScope(null)).toBe(false);
		expect(isQuickChatScope(undefined)).toBe(false);
	});

	it('names no agent: Quick Chat picks its own, message by message', () => {
		expect(voiceScopeAgentId(QUICK_CHAT_VOICE_SCOPE)).toBeNull();
	});

	it('is not the Conductor, so other agents finishing are not announced over it', () => {
		expect(shouldSpeakBackgroundCompletions('auto', QUICK_CHAT_VOICE_SCOPE)).toBe(false);
		expect(shouldSpeakBackgroundCompletions(undefined, QUICK_CHAT_VOICE_SCOPE)).toBe(false);
	});
});

describe('quickChatScopeDecision', () => {
	it('sends the utterance whole, with nothing stripped', () => {
		const decision = quickChatScopeDecision('  tell the backend agent what day it is  ');

		expect(decision.prompt).toBe('tell the backend agent what day it is');
		expect(decision.confidence).toBe(1);
	});

	it('names no agent and no tab: Quick Chat resolves both when the message lands', () => {
		const decision = quickChatScopeDecision('what day is today');

		expect(routeTargetSessionId(decision.target)).toBeNull();
		expect(decision.tabAction).toBe('current');
		expect(decision.tabId).toBeUndefined();
	});

	it('is always a dispatch, never a question or a conversational reply', () => {
		expect(holdsTheFloor(quickChatScopeDecision('which agent do you mean'))).toBe(false);
	});
});

describe('scopeRebindBlocker', () => {
	it('refuses to move a Quick Chat session anywhere', () => {
		expect(scopeRebindBlocker(QUICK_CHAT_VOICE_SCOPE, { kind: 'conductor' })).toMatch(
			/locked to Quick Chat/
		);
		expect(scopeRebindBlocker(QUICK_CHAT_VOICE_SCOPE, { kind: 'agent', sessionId: 'a1' })).toMatch(
			/locked to Quick Chat/
		);
		expect(
			scopeRebindBlocker(QUICK_CHAT_VOICE_SCOPE, { kind: 'agent', sessionId: 'a1', tabId: 't1' })
		).toMatch(/locked to Quick Chat/);
	});

	it('refuses to switch another session INTO Quick Chat', () => {
		expect(scopeRebindBlocker({ kind: 'conductor' }, QUICK_CHAT_VOICE_SCOPE)).toMatch(
			/started from Quick Chat/
		);
		expect(scopeRebindBlocker({ kind: 'agent', sessionId: 'a1' }, QUICK_CHAT_VOICE_SCOPE)).toMatch(
			/started from Quick Chat/
		);
	});

	it('allows every switch the HUD offers', () => {
		expect(
			scopeRebindBlocker({ kind: 'conductor' }, { kind: 'agent', sessionId: 'a1' })
		).toBeNull();
		expect(
			scopeRebindBlocker(
				{ kind: 'agent', sessionId: 'a1' },
				{ kind: 'agent', sessionId: 'a1', tabId: 't1' }
			)
		).toBeNull();
		expect(
			scopeRebindBlocker(
				{ kind: 'document', sessionId: 'a1', path: '/a.md' },
				{ kind: 'conductor' }
			)
		).toBeNull();
		expect(scopeRebindBlocker(null, { kind: 'conductor' })).toBeNull();
	});
});
