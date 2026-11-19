/**
 * The playbook concierge's pure rules: when the guided interview may run
 * (the D5 economics rule), how many questions it may ask, and how its JSON
 * `parameters` array becomes proposals the configure form can badge.
 *
 * The interview itself (prompt, agent turns) lives in
 * `src/renderer/services/playbookConcierge.ts`; this module spawns nothing,
 * so every rule here is computed before any token is spent.
 *
 * Vocabulary, as in the proposal:
 * - OPEN (`U`): declared parameters with no usable stored answer and no
 *   usable author default. The interviewer may only propose into these.
 * - UNRESOLVED: open parameters the zero-cost facts pass
 *   (`proposeFromFacts()`) left without a value. The question cap counts them.
 * - DISCOVERABLE (`F`): unresolved parameters the workspace could plausibly
 *   answer, so an agent that can read it has a reason to exist.
 */

import type { PlaybookFacts } from './playbookFacts';
import {
	describePlaybookParamProvenance,
	isPlaceholderDefault,
	validatePlaybookParamValue,
	type PlaybookParamProposals,
	type PlaybookParamSpec,
	type PlaybookParamValues,
} from './playbookParams';
import type { PlaybookInteraction } from './types';

/** How the interviewer came by a value. */
export type ConciergeParameterSource = 'detected' | 'asked' | 'default';

/** One entry of the interviewer's `parameters` array, validated. */
export interface ConciergeParameterProposal {
	name: string;
	value: string;
	source: ConciergeParameterSource;
	evidence?: string;
	/** 0-100. */
	confidence: number;
}

/**
 * What the configure step does about the interview:
 * - `interview`: open on the chat (a `guided` playbook with something to ask)
 * - `offer`: draw the form with a "Help me fill this in" button
 * - `none`: draw the form only
 */
export type PlaybookConciergeMode = 'interview' | 'offer' | 'none';

/** Why the decision came out the way it did, for logs and tests. */
export type PlaybookConciergeReason =
	| 'guided'
	| 'discoverable'
	| 'nothing-open'
	| 'facts-answered'
	| 'nothing-discoverable'
	| 'no-agent'
	| 'offline';

export interface PlaybookConciergeDecision {
	mode: PlaybookConciergeMode;
	reason: PlaybookConciergeReason;
	/** Names the interviewer may propose into (`U`). */
	open: string[];
	/** Open names the facts pass left without a value. */
	unresolved: string[];
	/** Unresolved names the workspace could plausibly answer (`F`). */
	discoverable: string[];
	/** Questions the interviewer may ask: unresolved count plus one. */
	questionCap: number;
}

export interface PlaybookConciergeDecisionInput {
	specs: PlaybookParamSpec[];
	/** The user's stored answers (the playbook record's `parameterValues`). */
	stored: PlaybookParamValues;
	/** Proposals from `proposeFromFacts()`. */
	factProposals: PlaybookParamProposals;
	/** The facts pack, or null while it is still loading or when it failed. */
	facts: PlaybookFacts | null;
	interaction: PlaybookInteraction | undefined;
	/** The target agent exists and can run a read-only turn. */
	agentReady: boolean;
	online: boolean;
}

/** The question cap: one question per unresolved parameter, plus one to clarify. */
export function conciergeQuestionCap(unresolvedCount: number): number {
	return Math.max(0, unresolvedCount) + 1;
}

/** Open parameters (`U`): no usable stored answer and no usable author default. */
export function collectOpenPlaybookParams(
	specs: PlaybookParamSpec[],
	stored: PlaybookParamValues
): PlaybookParamSpec[] {
	return specs.filter(
		(spec) => describePlaybookParamProvenance(spec, stored, undefined) === 'unresolved'
	);
}

/** Name segments that point at the git repository or its host. */
const GIT_SEGMENTS = new Set([
	'BRANCH',
	'COMMIT',
	'ISSUE',
	'ORG',
	'ORIGIN',
	'OWNER',
	'PR',
	'PULL',
	'REMOTE',
	'REPO',
	'REPOSITORY',
]);

/** Name segments that point at the files in the working directory. */
const WORKSPACE_SEGMENTS = new Set([
	'APP',
	'CWD',
	'DIR',
	'DIRECTORY',
	'FILE',
	'FILES',
	'FOLDER',
	'FRAMEWORK',
	'LANGUAGE',
	'MODULE',
	'PACKAGE',
	'PATH',
	'PROJECT',
	'ROOT',
	'SERVICE',
	'SOURCE',
	'SRC',
	'TEST',
	'TESTS',
	'VAULT',
	'WORKSPACE',
]);

/**
 * Whether an agent that can read the workspace could plausibly answer this
 * parameter. Decided by the name's `_` segments: a repository word needs a
 * repository (a branch or a remote in the facts), a workspace word needs a
 * working directory. A preference such as `MARKET_TOPIC` or
 * `AUTO_FIX_SEVERITY` matches neither, so it is asked in the form, not by a
 * paid agent.
 */
export function isPlausiblyDiscoverable(spec: PlaybookParamSpec, facts: PlaybookFacts): boolean {
	const segments = spec.name.split('_');
	const inRepo = Boolean(facts.gitBranch || facts.gitRemoteUrl);
	if (inRepo && segments.some((segment) => GIT_SEGMENTS.has(segment))) return true;
	return Boolean(facts.cwd) && segments.some((segment) => WORKSPACE_SEGMENTS.has(segment));
}

/**
 * The D5 rule: whether the interview can earn its tokens. Computed before
 * any spawn.
 *
 * - nothing open (a re-run, or every parameter has a default): never
 * - no agent, or offline: never
 * - the facts pass answered every open parameter: never
 * - a `guided` playbook: interview, scoped to the open parameters
 * - a `form` playbook: offer the button only when something unresolved is
 *   discoverable; otherwise the agent would ask exactly what the form asks
 */
export function decidePlaybookConcierge(
	input: PlaybookConciergeDecisionInput
): PlaybookConciergeDecision {
	const open = collectOpenPlaybookParams(input.specs, input.stored);
	const unresolved = open.filter((spec) => !input.factProposals[spec.name]);
	const facts = input.facts;
	const discoverable = facts
		? unresolved.filter((spec) => isPlausiblyDiscoverable(spec, facts))
		: [];
	const base = {
		open: open.map((spec) => spec.name),
		unresolved: unresolved.map((spec) => spec.name),
		discoverable: discoverable.map((spec) => spec.name),
		questionCap: conciergeQuestionCap(unresolved.length),
	};
	const decide = (mode: PlaybookConciergeMode, reason: PlaybookConciergeReason) => ({
		...base,
		mode,
		reason,
	});

	if (open.length === 0) return decide('none', 'nothing-open');
	if (!input.agentReady) return decide('none', 'no-agent');
	if (!input.online) return decide('none', 'offline');
	if (unresolved.length === 0) return decide('none', 'facts-answered');
	if (input.interaction === 'guided') return decide('interview', 'guided');
	if (discoverable.length > 0) return decide('offer', 'discoverable');
	return decide('none', 'nothing-discoverable');
}

/**
 * Whether the interview is over: the agent says it is ready, or it has used
 * every question it was allowed.
 */
export function isConciergeFinished(input: {
	ready: boolean;
	questionsAsked: number;
	questionCap: number;
}): boolean {
	return input.ready || input.questionsAsked >= input.questionCap;
}

const SOURCES: ReadonlySet<string> = new Set<ConciergeParameterSource>([
	'detected',
	'asked',
	'default',
]);

function asText(value: unknown): string | null {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	if (typeof value === 'boolean') return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
		return value
			.map((item) => item.trim())
			.filter(Boolean)
			.join(', ');
	}
	return null;
}

function clampConfidence(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
	return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Read the interviewer's `parameters` array out of untrusted JSON. An entry
 * is kept only when it names an OPEN parameter, carries a non-placeholder
 * value, and passes that parameter's own validation; everything else is
 * dropped, so the agent can never write into a stored answer or an author
 * default, or hand the form a value it would reject. A later entry for the
 * same name replaces an earlier one. An unknown `source` reads as `asked`.
 */
export function readConciergeParameters(
	raw: unknown,
	specs: PlaybookParamSpec[],
	openNames: ReadonlySet<string>
): ConciergeParameterProposal[] {
	if (!Array.isArray(raw)) return [];
	const byName = new Map(specs.map((spec) => [spec.name, spec]));
	const accepted = new Map<string, ConciergeParameterProposal>();
	for (const entry of raw) {
		if (typeof entry !== 'object' || entry === null) continue;
		const item = entry as Record<string, unknown>;
		const name = typeof item.name === 'string' ? item.name.trim() : '';
		const spec = byName.get(name);
		if (!spec || !openNames.has(name)) continue;
		const value = asText(item.value);
		if (!value || isPlaceholderDefault(value)) continue;
		if (validatePlaybookParamValue(spec, value) !== null) continue;
		const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
		accepted.set(name, {
			name,
			value,
			source:
				typeof item.source === 'string' && SOURCES.has(item.source)
					? (item.source as ConciergeParameterSource)
					: 'asked',
			evidence: evidence || undefined,
			confidence: clampConfidence(item.confidence),
		});
	}
	return [...accepted.values()];
}

/** The evidence a form row shows on hover when the interviewer gave none. */
const FALLBACK_EVIDENCE: Record<ConciergeParameterSource, string> = {
	detected: 'Found by the guided interview',
	asked: 'Your answer in the guided interview',
	default: 'Suggested by the playbook, confirmed in the guided interview',
};

/**
 * The interviewer's proposals layered over the facts pass's, as the form's
 * proposal map: the interviewer wins for a name both answered, because it
 * saw the facts and the user. Inputs are not mutated.
 */
export function mergeConciergeProposals(
	factProposals: PlaybookParamProposals,
	conciergeProposals: ConciergeParameterProposal[]
): PlaybookParamProposals {
	const merged: PlaybookParamProposals = { ...factProposals };
	for (const proposal of conciergeProposals) {
		merged[proposal.name] = {
			value: proposal.value,
			evidence: proposal.evidence ?? FALLBACK_EVIDENCE[proposal.source],
		};
	}
	return merged;
}
