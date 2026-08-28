/**
 * @file acappella-document-scope.test.ts
 *
 * Talking to a document. The three rules under test are the ones that turn a
 * pinned file into a conversation rather than a series of unrelated spoken
 * prompts: it stays with its agent, the opening turn hands the document over,
 * and every later turn lands in the tab that conversation opened in.
 */

import { describe, it, expect } from 'vitest';

import {
	applyDocumentScope,
	buildDocumentOpeningPrompt,
	documentScopeName,
	isDocumentScope,
	voiceScopeAgentId,
} from '../../shared/acappella/document-scope';
import type { DocumentVoiceScope } from '../../shared/acappella/protocol';
import type { RouteDecision } from '../../shared/acappella/route-decision';

const SCOPE: DocumentVoiceScope = {
	kind: 'document',
	sessionId: 'agent-backend',
	path: '/repo/api/docs/system-overview.md',
};

const DECISION: RouteDecision = {
	target: 'conductor',
	tabAction: 'current',
	prompt: 'add a diagram of the dispatch flow',
	confidence: 0.8,
};

describe('voiceScopeAgentId', () => {
	it('reports the agent for both bound scope kinds', () => {
		expect(voiceScopeAgentId({ kind: 'agent', sessionId: 'a1' })).toBe('a1');
		expect(voiceScopeAgentId(SCOPE)).toBe('agent-backend');
	});

	it('reports no agent for the conductor and for nothing at all', () => {
		expect(voiceScopeAgentId({ kind: 'conductor' })).toBeNull();
		expect(voiceScopeAgentId(null)).toBeNull();
		expect(voiceScopeAgentId(undefined)).toBeNull();
	});
});

describe('isDocumentScope', () => {
	it('narrows only a document binding', () => {
		expect(isDocumentScope(SCOPE)).toBe(true);
		expect(isDocumentScope({ kind: 'agent', sessionId: 'a1' })).toBe(false);
		expect(isDocumentScope({ kind: 'conductor' })).toBe(false);
		expect(isDocumentScope(null)).toBe(false);
	});
});

describe('documentScopeName', () => {
	it('is the leaf name, which is what the HUD and the tab are called', () => {
		expect(documentScopeName(SCOPE)).toBe('system-overview.md');
	});

	it('falls back to the whole path rather than to an empty label', () => {
		expect(documentScopeName({ ...SCOPE, path: 'notes.md' })).toBe('notes.md');
	});
});

describe('buildDocumentOpeningPrompt', () => {
	it('hands over the path and keeps the request intact', () => {
		const prompt = buildDocumentOpeningPrompt(SCOPE, 'add a diagram of the dispatch flow');

		expect(prompt).toContain('/repo/api/docs/system-overview.md');
		expect(prompt).toContain('add a diagram of the dispatch flow');
	});

	it('asks for spoken-shaped answers, since nobody is reading the reply', () => {
		expect(buildDocumentOpeningPrompt(SCOPE, 'what is this')).toContain('spoken conversation');
	});
});

describe('applyDocumentScope', () => {
	it('opens a new tab named after the document on the first turn', () => {
		const bound = applyDocumentScope(DECISION, SCOPE, null);

		expect(bound.tabAction).toBe('new');
		expect(bound.tabName).toBe('system-overview.md');
		expect(bound.target).toEqual({ sessionId: 'agent-backend' });
		expect(bound.prompt).toContain('/repo/api/docs/system-overview.md');
		expect(bound.prompt).toContain('add a diagram of the dispatch flow');
	});

	it('recalls the pinned tab afterwards rather than following the active one', () => {
		// `current` resolves to whatever tab the agent has active, and the user can
		// click away mid-conversation. Recall names the tab and also wakes it.
		const bound = applyDocumentScope(DECISION, SCOPE, 'tab-doc');

		expect(bound.tabAction).toBe('recall');
		expect(bound.tabId).toBe('tab-doc');
		expect(bound.target).toEqual({ sessionId: 'agent-backend' });
	});

	it('does not hand the document over a second time', () => {
		const bound = applyDocumentScope(DECISION, SCOPE, 'tab-doc');
		expect(bound.prompt).toBe('add a diagram of the dispatch flow');
	});

	it('overrides a Brain that re-targeted the conversation to another agent', () => {
		// The user pointed at a file inside ONE workspace. Another agent cannot see
		// it, so a spoken instruction about it there means nothing.
		const bound = applyDocumentScope(
			{ ...DECISION, target: { sessionId: 'agent-frontend' } },
			SCOPE,
			'tab-doc'
		);

		expect(bound.target).toEqual({ sessionId: 'agent-backend' });
	});

	it('reopens with the document when the pinned tab is gone', () => {
		// A fresh tab has never heard of the file, so handing it over again is the
		// only honest recovery.
		const bound = applyDocumentScope(DECISION, SCOPE, null);
		expect(bound.tabAction).toBe('new');
		expect(bound.prompt).toContain('Read it first');
	});

	it('keeps the confidence and the clarify the router produced', () => {
		const bound = applyDocumentScope({ ...DECISION, confidence: 0.42 }, SCOPE, 'tab-doc');
		expect(bound.confidence).toBe(0.42);
	});
});
