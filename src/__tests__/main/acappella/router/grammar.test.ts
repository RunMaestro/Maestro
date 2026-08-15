/**
 * @file grammar.test.ts
 *
 * The compiled `RouteDecision` grammar, from both ends.
 *
 * The GBNF text is asserted structurally (it is what llama.cpp masks its sampler
 * against, and a missing id alternative there is invisible until a model invents
 * an agent), and the acceptance rules are asserted through `validate`, which is
 * rendered from the SAME compiled node tree. That is the point of the two
 * renderers: the suite can prove "the grammar rejects an unknown session id"
 * without embedding a GBNF engine, and a drift between the grammar and the
 * validator would have to be a drift within one tree.
 */

import { describe, it, expect } from 'vitest';

import {
	compileRouteDecisionGrammar,
	rosterScope,
	routeDecisionSchema,
	validateRouteDecision,
} from '../../../../main/acappella/router/grammar';
import type { RosterAgent } from '../../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [
			{ id: 'tab-auth', name: 'Auth', lastActiveAt: 10 },
			{ id: 'tab-db', name: 'DB', lastActiveAt: 20 },
		],
	},
	{
		sessionId: 'agent-frontend',
		name: 'Frontend',
		agentType: 'codex',
		cwd: '/repo/web',
		tabs: [{ id: 'tab-ui', name: 'Sidebar', lastActiveAt: 30 }],
	},
];

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		target: { sessionId: 'agent-backend' },
		tabAction: 'current',
		prompt: 'run the tests',
		confidence: 0.9,
		...overrides,
	};
}

describe('compileRouteDecisionGrammar - GBNF', () => {
	it('emits a root rule and the JSON lexical prelude', () => {
		const { gbnf } = compileRouteDecisionGrammar();

		expect(gbnf).toMatch(/^root ::= /);
		for (const rule of ['ws ::=', 'string ::=', 'number ::=', 'char ::=', 'hex ::=']) {
			expect(gbnf).toContain(rule);
		}
	});

	it('constrains the ids to exactly the ones in the roster', () => {
		const { gbnf } = compileRouteDecisionGrammar(rosterScope(ROSTER));

		expect(gbnf).toContain('"\\"agent-backend\\""');
		expect(gbnf).toContain('"\\"agent-frontend\\""');
		expect(gbnf).toContain('"\\"tab-auth\\""');
		// Nothing that is not in the roster may appear as an alternative.
		expect(gbnf).not.toContain('agent-ghost');
	});

	it('closes the tab action to the three known values', () => {
		const { gbnf } = compileRouteDecisionGrammar();

		expect(gbnf).toContain('"\\"current\\"" | "\\"new\\"" | "\\"recall\\""');
	});

	it('marks the optional fields optional and the required ones not', () => {
		const { gbnf } = compileRouteDecisionGrammar();

		// `tabId` may be omitted; `prompt` may not.
		expect(gbnf).toMatch(/\("," ws "\\"tabId\\"" ws ":" ws string\)\?/);
		expect(gbnf).toMatch(/"," ws "\\"prompt\\"" ws ":" ws string/);
		expect(gbnf).not.toMatch(/\("," ws "\\"prompt\\""[^)]*\)\?/);
	});
});

describe('compileRouteDecisionGrammar - acceptance', () => {
	const grammar = compileRouteDecisionGrammar(rosterScope(ROSTER));

	it('accepts a well-formed decision', () => {
		expect(grammar.validate(decision()).ok).toBe(true);
	});

	it('accepts the conductor as a target', () => {
		expect(grammar.validate(decision({ target: 'conductor' })).ok).toBe(true);
	});

	it('rejects a value that is not an object at all', () => {
		expect(grammar.validate('sure, here you go: {}').ok).toBe(false);
		expect(grammar.validate(null).ok).toBe(false);
		expect(grammar.validate([decision()]).ok).toBe(false);
	});

	it('rejects an out-of-set tab action', () => {
		const result = grammar.validate(decision({ tabAction: 'switch' as never }));

		expect(result.ok).toBe(false);
		expect(result.errors.join(' ')).toContain('decision.tabAction');
	});

	it('rejects an invented session id', () => {
		const result = grammar.validate(decision({ target: { sessionId: 'agent-ghost' } }));

		expect(result.ok).toBe(false);
		expect(result.errors.join(' ')).toContain('decision.target');
	});

	it('rejects an invented tab id', () => {
		const result = grammar.validate(decision({ tabAction: 'recall', tabId: 'tab-ghost' }));

		expect(result.ok).toBe(false);
		expect(result.errors.join(' ')).toContain('decision.tabId');
	});

	it('rejects a missing required field', () => {
		const { prompt, ...withoutPrompt } = decision();
		void prompt;

		const result = grammar.validate(withoutPrompt);

		expect(result.ok).toBe(false);
		expect(result.errors.join(' ')).toContain('decision.prompt is required');
	});

	it('rejects a confidence outside 0 to 1', () => {
		expect(grammar.validate(decision({ confidence: 7 })).ok).toBe(false);
		expect(grammar.validate(decision({ confidence: -1 })).ok).toBe(false);
	});

	it('rejects a field nobody declared', () => {
		const result = grammar.validate({ ...decision(), reasoning: 'because' });

		expect(result.ok).toBe(false);
		expect(result.errors.join(' ')).toContain('reasoning');
	});

	it('leaves the ids free when the roster is empty', () => {
		// An empty alternation would be a grammar that matches nothing, so an
		// empty roster falls back to a plain string and validation carries the
		// refusal instead.
		const empty = compileRouteDecisionGrammar(rosterScope([]));

		expect(empty.gbnf).not.toContain('()');
		expect(empty.validate(decision()).ok).toBe(true);
	});
});

describe('routeDecisionSchema', () => {
	it('narrows the hosted schema to the roster, leaving the shape intact', () => {
		const schema = routeDecisionSchema(rosterScope(ROSTER)) as any;

		expect(schema.properties.tabId.enum).toEqual(['tab-auth', 'tab-db', 'tab-ui']);
		const agentShape = schema.properties.target.oneOf.find((o: any) => o.type === 'object');
		expect(agentShape.properties.sessionId.enum).toEqual(['agent-backend', 'agent-frontend']);
		expect(schema.required).toEqual(['target', 'tabAction', 'prompt', 'confidence']);
	});

	it('does not mutate the shared schema', () => {
		const first = routeDecisionSchema(rosterScope(ROSTER)) as any;
		const second = routeDecisionSchema() as any;

		expect(first.properties.tabId.enum).toBeDefined();
		expect(second.properties.tabId.enum).toBeUndefined();
	});
});

describe('validateRouteDecision', () => {
	it('runs for every provider, hosted ones included', () => {
		// The hosted tier asks for a structured output and gets one; the roster is
		// still the only thing that knows whether the id is real.
		const fromHostedProvider = decision({ target: { sessionId: 'agent-ghost' } });

		expect(validateRouteDecision(fromHostedProvider, ROSTER).ok).toBe(false);
	});

	it('rejects a recall whose tab belongs to a different agent', () => {
		const result = validateRouteDecision(
			decision({ target: { sessionId: 'agent-backend' }, tabAction: 'recall', tabId: 'tab-ui' }),
			ROSTER
		);

		expect(result.ok).toBe(false);
		expect(result.errors.join(' ')).toContain('is not a tab on "Backend"');
	});

	it('rejects a recall with no tab id', () => {
		const result = validateRouteDecision(decision({ tabAction: 'recall' }), ROSTER);

		expect(result.ok).toBe(false);
		expect(result.errors.join(' ')).toContain('tabId is required');
	});

	it('accepts a decision carrying a clarification', () => {
		const result = validateRouteDecision(
			decision({ target: 'conductor', confidence: 0.2, clarify: 'Backend or Frontend?' }),
			ROSTER
		);

		expect(result.ok).toBe(true);
	});

	it('ignores undefined optional fields rather than calling them unknown', () => {
		const result = validateRouteDecision(
			{ ...decision(), tabId: undefined, tabName: undefined, clarify: undefined },
			ROSTER
		);

		expect(result.ok).toBe(true);
	});
});
