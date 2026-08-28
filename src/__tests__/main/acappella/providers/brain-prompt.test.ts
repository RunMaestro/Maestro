/**
 * @file brain-prompt.test.ts
 *
 * The parser every Brain shares. It exists because a model asked for JSON will
 * eventually return a fenced block, a preamble, an agent id that closed while it
 * was thinking, or a confidence of 7 - and none of those may become a dispatch.
 * Sending a spoken instruction to the wrong agent is the worst thing this feature
 * can do, and it is worse than doing nothing.
 */

import { describe, it, expect } from 'vitest';

import {
	buildRouteUserPrompt,
	extractJsonObject,
	limitSpokenReply,
	parseRouteDecision,
} from '../../../../main/acappella/providers/brain-prompt';
import type { RosterAgent } from '../../../../shared/acappella/protocol';
import type { VoiceRouteContext } from '../../../../shared/acappella/providers';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [
			{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 },
			{ id: 'tab-db', name: 'Migrations', lastActiveAt: 2 },
		],
	},
];

const CONTEXT: VoiceRouteContext = { roster: ROSTER, scope: { kind: 'conductor' } };

describe('extractJsonObject', () => {
	it('finds an object inside a fenced block with a preamble', () => {
		const raw = 'Sure! Here you go:\n```json\n{"target":"conductor"}\n```';
		expect(extractJsonObject(raw)).toEqual({ target: 'conductor' });
	});

	it('keeps braces that belong to a string value', () => {
		// The non-greedy regex that "worked" would truncate here.
		const raw = '{"prompt":"replace {old} with {new}","confidence":0.5}';
		expect(extractJsonObject(raw)).toMatchObject({ prompt: 'replace {old} with {new}' });
	});

	it('returns null for text with no object in it', () => {
		expect(extractJsonObject('I think you want the backend agent.')).toBeNull();
	});

	it('returns null rather than throwing on malformed JSON', () => {
		expect(extractJsonObject('{"target": }')).toBeNull();
	});
});

describe('parseRouteDecision', () => {
	it('accepts a well-formed decision for a running agent', () => {
		const decision = parseRouteDecision(
			JSON.stringify({
				target: { sessionId: 'agent-backend' },
				tabAction: 'recall',
				tabId: 'tab-auth',
				prompt: 'what happened to auth',
				confidence: 0.82,
			}),
			CONTEXT,
			'fallback'
		);

		expect(decision).toEqual({
			target: { sessionId: 'agent-backend' },
			tabAction: 'recall',
			tabId: 'tab-auth',
			tabName: undefined,
			prompt: 'what happened to auth',
			confidence: 0.82,
		});
	});

	it('sends an unknown agent id to the conductor', () => {
		const decision = parseRouteDecision(
			JSON.stringify({ target: { sessionId: 'ghost' }, tabAction: 'current', prompt: 'x' }),
			CONTEXT,
			'fallback'
		);

		expect(decision.target).toBe('conductor');
	});

	it('downgrades a recall of a tab that does not exist', () => {
		const decision = parseRouteDecision(
			JSON.stringify({
				target: { sessionId: 'agent-backend' },
				tabAction: 'recall',
				tabId: 'tab-that-closed',
				prompt: 'x',
			}),
			CONTEXT,
			'fallback'
		);

		// A recall the executor cannot perform fails the turn; the tab the user is
		// already looking at is the honest downgrade.
		expect(decision.tabAction).toBe('current');
		expect(decision.tabId).toBeUndefined();
	});

	it('drops a tabId on an action that does not take one', () => {
		const decision = parseRouteDecision(
			JSON.stringify({ target: 'conductor', tabAction: 'new', tabId: 'tab-auth', prompt: 'x' }),
			CONTEXT,
			'fallback'
		);

		expect(decision.tabId).toBeUndefined();
	});

	it('falls back to current for an action it has never heard of', () => {
		const decision = parseRouteDecision(
			JSON.stringify({ target: 'conductor', tabAction: 'teleport', prompt: 'x' }),
			CONTEXT,
			'fallback'
		);

		expect(decision.tabAction).toBe('current');
	});

	it('uses the user own words when the model gave no prompt', () => {
		const decision = parseRouteDecision(
			JSON.stringify({ target: 'conductor', tabAction: 'current' }),
			CONTEXT,
			'  open the auth tab  '
		);

		// A verbatim utterance is a worse prompt than a cleaned one and an
		// infinitely better outcome than a turn that silently did nothing.
		expect(decision.prompt).toBe('open the auth tab');
	});

	it('clamps a confidence outside 0 to 1', () => {
		const high = parseRouteDecision(
			JSON.stringify({ target: 'conductor', tabAction: 'current', prompt: 'x', confidence: 7 }),
			CONTEXT,
			'x'
		);
		const missing = parseRouteDecision(
			JSON.stringify({ target: 'conductor', tabAction: 'current', prompt: 'x' }),
			CONTEXT,
			'x'
		);

		expect(high.confidence).toBe(1);
		expect(missing.confidence).toBe(0.5);
	});

	it('survives a response with no JSON at all', () => {
		const decision = parseRouteDecision('I could not decide.', CONTEXT, 'open the auth tab');

		expect(decision.target).toBe('conductor');
		expect(decision.prompt).toBe('open the auth tab');
	});
});

describe('buildRouteUserPrompt', () => {
	it('names every running agent and its tabs', () => {
		const prompt = buildRouteUserPrompt('open auth', CONTEXT);

		expect(prompt).toContain('agent-backend');
		expect(prompt).toContain('tab-auth');
		expect(prompt).toContain('Utterance: open auth');
	});

	it('says which agent the session is bound to', () => {
		const prompt = buildRouteUserPrompt('do it', {
			roster: ROSTER,
			scope: { kind: 'agent', sessionId: 'agent-backend' },
		});

		expect(prompt).toContain('bound to agent agent-backend');
	});

	it('binds a document scope to its agent, exactly like an agent scope', () => {
		// Two of the three scope kinds carry an agent. A prompt that only knew about
		// one would tell the model nothing is bound and drop the routing bias.
		const prompt = buildRouteUserPrompt('do it', {
			roster: ROSTER,
			scope: { kind: 'document', sessionId: 'agent-backend', path: '/repo/api/README.md' },
		});

		expect(prompt).toContain('bound to agent agent-backend');
	});

	it('names the document a document conversation is about', () => {
		const prompt = buildRouteUserPrompt('add a diagram', {
			roster: ROSTER,
			scope: { kind: 'document', sessionId: 'agent-backend', path: '/repo/api/README.md' },
			document: { path: '/repo/api/README.md', name: 'README.md' },
		});

		expect(prompt).toContain('conversation about the document README.md');
		expect(prompt).toContain('/repo/api/README.md');
	});

	it('says nothing about a document outside a document conversation', () => {
		expect(buildRouteUserPrompt('open auth', CONTEXT)).not.toContain(
			'conversation about the document'
		);
	});

	it('says so plainly when nothing is running', () => {
		expect(buildRouteUserPrompt('hello', { roster: [], scope: { kind: 'conductor' } })).toContain(
			'(none)'
		);
	});
});

describe('limitSpokenReply', () => {
	it('strips markdown and trims to the budget', () => {
		expect(limitSpokenReply('**One.** Two. Three.', 2)).toBe('One. Two.');
	});

	it('returns nothing for a reply with nothing in it', () => {
		expect(limitSpokenReply('   ', 2)).toBe('');
	});
});
