/**
 * Grammar-constrained routing: the shared `RouteDecision` JSON Schema compiled
 * into something a model cannot violate.
 *
 * A router that asks a 1.7B model for JSON and hopes gets three failure modes
 * for free: a fenced code block, an invented `tabAction`, and a `sessionId` for
 * an agent that does not exist. The first is a parsing problem. The third is the
 * one that matters - a spoken instruction landing in the wrong repository - and
 * no amount of prompt wording fixes it, because the model is sampling from a
 * distribution that contains plausible-looking ids.
 *
 * So the schema is compiled ONCE into a node tree, and that tree is rendered two
 * ways:
 *
 *   - {@link CompiledRouteGrammar.gbnf} - a GBNF grammar for `node-llama-cpp`.
 *     llama.cpp masks the sampler against it, so the local Brain is structurally
 *     incapable of emitting malformed JSON, an out-of-set enum, or an id that is
 *     not in the roster.
 *   - {@link CompiledRouteGrammar.validate} - the same rules as a validator, for
 *     hosted Brains (whose structured-output modes are a request, not a
 *     guarantee) and for anything that reaches the executor.
 *
 * One tree, two renderers, deliberately: a grammar and a validator maintained
 * separately drift, and the drift is invisible until the day the grammar allows
 * something the validator rejects and a turn dies for no visible reason.
 *
 * The id sets are injected rather than described in the prompt. "Never invent an
 * id" is an instruction; `"a1" | "a2" | "a3"` is a constraint.
 */

import type { RosterAgent } from '../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import {
	isConversationalReply,
	ROUTE_DECISION_JSON_SCHEMA,
} from '../../../shared/acappella/route-decision';

// ---------------------------------------------------------------------------
// The node tree
// ---------------------------------------------------------------------------

/**
 * The subset of JSON Schema `RouteDecision` uses. Everything outside it throws
 * at compile time rather than being skipped: a construct the compiler silently
 * ignored would produce a grammar that permits more than the schema does, which
 * is the one outcome worse than a compile failure.
 */
type GrammarNode =
	| { kind: 'object'; properties: Array<{ name: string; node: GrammarNode; required: boolean }> }
	| { kind: 'string' }
	| { kind: 'literal'; value: string }
	| { kind: 'enum'; values: readonly string[] }
	| { kind: 'number'; minimum?: number; maximum?: number }
	| { kind: 'union'; options: GrammarNode[] };

/** Thrown when the schema grows a construct the compiler does not model. */
export class UnsupportedSchemaError extends Error {
	constructor(detail: string) {
		super(`RouteDecision schema uses an unsupported construct: ${detail}`);
		this.name = 'UnsupportedSchemaError';
	}
}

type JsonSchemaNode = Record<string, unknown>;

function compileNode(schema: JsonSchemaNode, path: string): GrammarNode {
	if (Array.isArray(schema.oneOf)) {
		const options = (schema.oneOf as JsonSchemaNode[]).map((option, index) =>
			compileNode(option, `${path}.oneOf[${index}]`)
		);
		return { kind: 'union', options };
	}

	const type = schema.type;
	if (type === 'object') {
		if (schema.additionalProperties !== false) {
			// An open object cannot be expressed as a closed grammar, and pretending
			// otherwise would let the model add fields nothing validates.
			throw new UnsupportedSchemaError(`${path} must set additionalProperties: false`);
		}
		const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
		const required = new Set((schema.required as string[] | undefined) ?? []);
		const entries = Object.entries(properties).map(([name, child]) => ({
			name,
			node: compileNode(child, `${path}.${name}`),
			required: required.has(name),
		}));
		if (entries.length === 0) throw new UnsupportedSchemaError(`${path} has no properties`);
		if (!entries[0].required) {
			// The emitted grammar puts the separating comma INSIDE each optional
			// group, which only works when something required comes first.
			throw new UnsupportedSchemaError(`${path}'s first property must be required`);
		}
		return { kind: 'object', properties: entries };
	}

	if (type === 'string') {
		if (typeof schema.const === 'string') return { kind: 'literal', value: schema.const };
		if (Array.isArray(schema.enum)) return { kind: 'enum', values: schema.enum as string[] };
		return { kind: 'string' };
	}

	if (type === 'number') {
		return {
			kind: 'number',
			minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
			maximum: typeof schema.maximum === 'number' ? schema.maximum : undefined,
		};
	}

	throw new UnsupportedSchemaError(`${path} has type '${String(type)}'`);
}

// ---------------------------------------------------------------------------
// GBNF
// ---------------------------------------------------------------------------

/** Shared lexical rules, emitted once per grammar. */
const GBNF_PRELUDE = [
	'ws ::= [ \\t\\n]*',
	'hex ::= [0-9a-fA-F]',
	'char ::= [^"\\\\] | "\\\\" (["\\\\/bfnrt] | "u" hex hex hex hex)',
	'string ::= "\\"" char* "\\""',
	'number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?',
].join('\n');

/** A JSON string literal as a GBNF terminal: the quotes are part of the match. */
function gbnfStringLiteral(value: string): string {
	const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `"\\"${escaped}\\""`;
}

function nodeToGbnf(node: GrammarNode): string {
	switch (node.kind) {
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'literal':
			return gbnfStringLiteral(node.value);
		case 'enum':
			if (node.values.length === 0) {
				// An empty id set means "no agents are running". Emitting an empty
				// alternation would be a grammar that matches nothing at all, so the
				// field falls back to a free string and validation refuses the value.
				return 'string';
			}
			return `(${node.values.map(gbnfStringLiteral).join(' | ')})`;
		case 'union':
			return `(${node.options.map(nodeToGbnf).join(' | ')})`;
		case 'object': {
			const parts = node.properties.map((property, index) => {
				const body = `${gbnfStringLiteral(property.name)} ws ":" ws ${nodeToGbnf(property.node)}`;
				const separated = index === 0 ? body : `"," ws ${body}`;
				return property.required ? separated : `(${separated})?`;
			});
			return `"{" ws ${parts.join(' ')} ws "}"`;
		}
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface GrammarValidation {
	ok: boolean;
	/** Every problem, not just the first: a retry prompt is better for knowing all of them. */
	errors: string[];
}

function validateNode(node: GrammarNode, value: unknown, path: string, errors: string[]): void {
	switch (node.kind) {
		case 'string':
			if (typeof value !== 'string') errors.push(`${path} must be a string`);
			return;
		case 'literal':
			if (value !== node.value) errors.push(`${path} must be "${node.value}"`);
			return;
		case 'enum':
			if (typeof value !== 'string' || !node.values.includes(value)) {
				errors.push(
					node.values.length === 0
						? `${path} has no valid values right now`
						: `${path} must be one of ${node.values.map((v) => `"${v}"`).join(', ')}`
				);
			}
			return;
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				errors.push(`${path} must be a number`);
				return;
			}
			if (node.minimum !== undefined && value < node.minimum) {
				errors.push(`${path} must be at least ${node.minimum}`);
			}
			if (node.maximum !== undefined && value > node.maximum) {
				errors.push(`${path} must be at most ${node.maximum}`);
			}
			return;
		case 'union': {
			// A union reports its own failure rather than every branch's: "target is
			// not one of the allowed shapes" is readable, and eight nested branch
			// errors are not.
			const matched = node.options.some((option) => {
				const branch: string[] = [];
				validateNode(option, value, path, branch);
				return branch.length === 0;
			});
			if (!matched) errors.push(`${path} does not match any allowed shape`);
			return;
		}
		case 'object': {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				errors.push(`${path} must be an object`);
				return;
			}
			const record = value as Record<string, unknown>;
			const known = new Set(node.properties.map((property) => property.name));
			for (const key of Object.keys(record)) {
				if (!known.has(key)) errors.push(`${path}.${key} is not an allowed field`);
			}
			for (const property of node.properties) {
				const child = record[property.name];
				if (child === undefined) {
					if (property.required) errors.push(`${path}.${property.name} is required`);
					continue;
				}
				validateNode(property.node, child, `${path}.${property.name}`, errors);
			}
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The id sets a decision is allowed to name. Empty means "unconstrained". */
export interface RouteGrammarScope {
	sessionIds?: readonly string[];
	tabIds?: readonly string[];
}

export interface CompiledRouteGrammar {
	/** GBNF text for `node-llama-cpp`'s `createGrammar`. */
	readonly gbnf: string;
	/** The roster-constrained JSON Schema, for hosted structured outputs. */
	readonly schema: Record<string, unknown>;
	/** The same rules as the grammar, applied to an already-parsed value. */
	validate(value: unknown): GrammarValidation;
}

/**
 * Narrow the shared schema to the ids that actually exist right now.
 *
 * Exported because hosted providers need the schema itself: OpenAI takes it as
 * `json_schema`, Anthropic as a tool's `input_schema`. Both go through the same
 * narrowing, so a hosted Brain gets the same "you may not invent an id"
 * constraint the local one does, and both are validated afterwards regardless.
 */
export function routeDecisionSchema(scope: RouteGrammarScope = {}): Record<string, unknown> {
	const schema = structuredClone(ROUTE_DECISION_JSON_SCHEMA) as unknown as JsonSchemaNode;
	const properties = schema.properties as Record<string, JsonSchemaNode>;

	if (scope.sessionIds && scope.sessionIds.length > 0) {
		const target = properties.target as { oneOf: JsonSchemaNode[] };
		const agentShape = target.oneOf.find((option) => option.type === 'object');
		const agentProperties = agentShape?.properties as Record<string, JsonSchemaNode> | undefined;
		if (agentProperties?.sessionId) {
			agentProperties.sessionId = { type: 'string', enum: [...scope.sessionIds] };
		}
	}

	if (scope.tabIds && scope.tabIds.length > 0) {
		properties.tabId = { type: 'string', enum: [...scope.tabIds] };
	}

	return schema as Record<string, unknown>;
}

/** Compile the schema, narrowed to `scope`, into a grammar and its validator. */
export function compileRouteDecisionGrammar(scope: RouteGrammarScope = {}): CompiledRouteGrammar {
	const schema = routeDecisionSchema(scope);
	const root = compileNode(schema as JsonSchemaNode, 'decision');

	return {
		gbnf: `root ::= ${nodeToGbnf(root)}\n${GBNF_PRELUDE}\n`,
		schema,
		validate(value: unknown): GrammarValidation {
			const errors: string[] = [];
			validateNode(root, value, 'decision', errors);
			return { ok: errors.length === 0, errors };
		},
	};
}

/** The ids a roster makes legal, in the shape {@link compileRouteDecisionGrammar} wants. */
export function rosterScope(roster: readonly RosterAgent[]): RouteGrammarScope {
	return {
		sessionIds: roster.map((agent) => agent.sessionId),
		tabIds: roster.flatMap((agent) => agent.tabs.map((tab) => tab.id)),
	};
}

/**
 * Validate a decision against the roster it will be executed on.
 *
 * Run for EVERY provider, grammar-constrained or not. A grammar guarantees a
 * well-formed id and a structured-output mode guarantees a shape; neither
 * guarantees that the agent still exists, because the user can close a tab while
 * the model is thinking. This is the last check before anything is dispatched.
 */
export function validateRouteDecision(
	decision: RouteDecision,
	roster: readonly RosterAgent[]
): GrammarValidation {
	const grammar = compileRouteDecisionGrammar(rosterScope(roster));
	// Round-tripped so `undefined` optional fields disappear the way they do on
	// the wire, rather than tripping the "is not an allowed field" check.
	const result = grammar.validate(JSON.parse(JSON.stringify(decision)) as unknown);
	const errors = [...result.errors];

	// A conversational reply reaches no agent, so its tab fields are decoration:
	// the model still has to emit `tabAction` to satisfy the grammar, and holding
	// it to a tab id nobody will read would reject a perfectly good spoken line.
	if (decision.tabAction === 'recall' && !isConversationalReply(decision)) {
		const targetId = typeof decision.target === 'string' ? null : decision.target.sessionId;
		const agent = roster.find((candidate) => candidate.sessionId === targetId);
		if (!decision.tabId) {
			errors.push('decision.tabId is required when tabAction is "recall"');
		} else if (agent && !agent.tabs.some((tab) => tab.id === decision.tabId)) {
			// A tab id that belongs to a DIFFERENT agent passes the flat id check and
			// would then fail at dispatch, after the user was told where it went.
			errors.push(`decision.tabId "${decision.tabId}" is not a tab on "${agent.name}"`);
		}
	}

	return { ok: errors.length === 0, errors };
}
