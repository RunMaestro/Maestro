/**
 * Context footprint audit (pure): what could be adding to an agent's prompt,
 * from the evidence Maestro has.
 *
 * Two kinds of finding, and neither is a measure of what a provider loaded:
 *
 * - INVENTORY: components found on disk (instruction files, memory, skills, MCP
 *   servers). A size says what a component WOULD cost if a provider loaded all
 *   of it. Maestro keeps no record of what a provider put in a prompt, so
 *   activation is `unknown` unless a caller brings a record bound to a launch or
 *   a session. Unknown is not "no".
 * - CONFIGURED: text Maestro's own settings add (its system prompt, the new
 *   session message, the nudge), sized on the text as configured NOW. A
 *   prompt rebuilt today, or a setting saved today, says nothing about what an
 *   earlier launch carried: the setting may have changed since, a resumed
 *   session does not get the first-message text again, and Maestro keeps no
 *   record of what it sent. So delivery and window membership are `unknown`
 *   unless a caller brings a record bound to the launch or session, and the
 *   additions are never summed: they arrive at different times.
 *
 * Nothing here is a saving. Every figure is an estimate, and no figure is added
 * to the realized compression counters (token proxy requests, the Models tab).
 * `contextFootprintReachability.test.ts` holds that line in both directions.
 *
 * The audit is a function of its input. Collecting the input (bounded, read
 * only) is `collectContextFootprint()` in `src/main/context-footprint.ts`.
 */

import { estimateTokenCount, estimateTokensFromBytes, formatCount } from './formatters';

export const FOOTPRINT_KINDS = [
	'instruction',
	'memory-index',
	'memory',
	'skill',
	'mcp-server',
] as const;
export type FootprintKind = (typeof FOOTPRINT_KINDS)[number];

/** `project`: found under the agent's project. `account`: under the provider account it runs as. */
export type FootprintScope = 'project' | 'account';

/** How often Maestro's settings add a text to what the agent reads. */
export type FootprintFrequency = 'each-spawn' | 'first-message' | 'every-message';

/**
 * One fact about the provider's context, as a record says. `unknown` is the
 * default and is not "no". The other state needs `boundTo`, the launch or
 * session the record is about, so evidence about one launch is never read as
 * evidence about another.
 */
export type FootprintRecord<State extends string> =
	| { state: 'unknown' }
	| { state: State; evidence: string; boundTo: string };

/** Whether a provider loaded an inventory component. */
export type FootprintActivation = FootprintRecord<'loaded'>;
/** Whether a configured text reached a provider. */
export type FootprintDelivery = FootprintRecord<'delivered'>;
/** Whether a configured text is in the provider's current context window. */
export type FootprintWindow = FootprintRecord<'in-window'>;

/** Something the audit could not establish, or a bound it hit. `code` is stable for a UI to key on. */
export interface FootprintNote {
	code: string;
	message: string;
}

export interface FootprintSubject {
	agentId: string;
	agentName?: string;
	toolType: string;
	projectRoot: string;
	accountDir?: string;
}

export interface FootprintComponentInput {
	kind: FootprintKind;
	scope: FootprintScope;
	/** Short display path: project-relative, or `<account>/...`. */
	label: string;
	/** Absolute path of the file it came from. */
	path: string;
	/** Which existing discovery found it. */
	discoveredBy: string;
	/** Size in bytes. Null when the source does not say (an MCP server's tool definitions). */
	bytes: number | null;
	/** Other names of the same file (a link to it). */
	aliases?: string[];
	activation?: FootprintActivation;
}

export interface FootprintComponent extends FootprintComponentInput {
	/** `<scope>:<kind>:<label>`. */
	id: string;
	/** From the file size. Null when the size is unknown. */
	estimatedTokens: number | null;
	activation: FootprintActivation;
}

export interface ConfiguredContributionInput {
	id: string;
	label: string;
	/** The text as configured now. The audit keeps its size and drops it. */
	text: string;
	frequency: FootprintFrequency;
	source: string;
	delivery?: FootprintDelivery;
	window?: FootprintWindow;
}

export interface ConfiguredContribution {
	id: string;
	label: string;
	chars: number;
	/** One occurrence of the text. Not a share of any window. */
	estimatedTokens: number;
	frequency: FootprintFrequency;
	source: string;
	/** What the figure rests on: the text as configured now, never a record of what was sent. */
	basis: 'configured-now';
	delivery: FootprintDelivery;
	window: FootprintWindow;
}

export interface FootprintKindTotal {
	kind: FootprintKind;
	count: number;
	bytes: number;
	estimatedTokens: number;
	/** Components whose size is unknown. They add nothing to the other figures. */
	unmeasured: number;
}

export interface FootprintCandidate {
	id: string;
	kind: FootprintKind;
	scope: FootprintScope;
	label: string;
	path: string;
	discoveredBy: string;
	activation: FootprintActivation;
	estimatedTokens: number;
	basis: 'file-size';
	reason: 'large-component';
}

export interface ContextFootprintInput {
	subject: FootprintSubject;
	components: readonly FootprintComponentInput[];
	configured: readonly ConfiguredContributionInput[];
	/** What the collector could not read or bounded. */
	notes: readonly FootprintNote[];
}

export interface ContextFootprintAudit {
	version: 1;
	subject: FootprintSubject;
	/** Each addition on its own. There is no total: they arrive at different times. */
	configured: { contributions: ConfiguredContribution[] };
	inventory: {
		components: FootprintComponent[];
		byKind: FootprintKindTotal[];
		estimatedTokens: number;
	};
	candidates: { items: FootprintCandidate[]; omitted: number; minTokens: number; limit: number };
	unknowns: FootprintNote[];
	/** The audit never feeds the compression counters. A literal, so a consumer can check it. */
	accounting: { countsAsSavings: false; note: string };
}

/** A component needs about this many estimated tokens to be listed as a candidate. */
export const CANDIDATE_MIN_TOKENS = 1_000;
/** The candidate list stays short: the largest this many. */
export const CANDIDATE_LIMIT = 10;

const ACCOUNTING_NOTE =
	'Estimates of files on disk and of text as configured now. Nothing here is added to token proxy savings or to any other realized compression counter.';

function byTokensThenId(
	a: { estimatedTokens: number | null; id: string },
	b: { estimatedTokens: number | null; id: string }
): number {
	const difference = (b.estimatedTokens ?? -1) - (a.estimatedTokens ?? -1);
	if (difference !== 0) return difference;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function copyRecord<State extends string>(
	record: FootprintRecord<State> | undefined
): FootprintRecord<State> {
	return record ? { ...record } : { state: 'unknown' };
}

function toComponent(input: FootprintComponentInput): FootprintComponent {
	return {
		...input,
		...(input.aliases ? { aliases: [...input.aliases] } : {}),
		id: `${input.scope}:${input.kind}:${input.label}`,
		estimatedTokens: input.bytes === null ? null : estimateTokensFromBytes(input.bytes),
		activation: copyRecord(input.activation),
	};
}

function toContribution(input: ConfiguredContributionInput): ConfiguredContribution {
	return {
		id: input.id,
		label: input.label,
		chars: input.text.length,
		estimatedTokens: estimateTokenCount(input.text),
		frequency: input.frequency,
		source: input.source,
		basis: 'configured-now',
		delivery: copyRecord(input.delivery),
		window: copyRecord(input.window),
	};
}

function totalsByKind(components: readonly FootprintComponent[]): FootprintKindTotal[] {
	const totals: FootprintKindTotal[] = [];
	for (const kind of FOOTPRINT_KINDS) {
		const inKind = components.filter((component) => component.kind === kind);
		if (inKind.length === 0) continue;
		totals.push({
			kind,
			count: inKind.length,
			bytes: inKind.reduce((sum, component) => sum + (component.bytes ?? 0), 0),
			estimatedTokens: inKind.reduce((sum, component) => sum + (component.estimatedTokens ?? 0), 0),
			unmeasured: inKind.filter((component) => component.bytes === null).length,
		});
	}
	return totals;
}

/** What the audit cannot know whatever the input: stated every time, so silence never reads as "none". */
function standingNotes(
	components: readonly FootprintComponent[],
	contributions: readonly ConfiguredContribution[]
): FootprintNote[] {
	const notes: FootprintNote[] = [];
	const unproven = components.filter((component) => component.activation.state === 'unknown');
	if (unproven.length > 0) {
		notes.push({
			code: 'activation-unknown',
			message: `${unproven.length} of ${components.length} inventory components have no record of whether a provider loads them. Their sizes are what they would cost if loaded in full, not what they cost.`,
		});
	}
	const undelivered = contributions.filter((entry) => entry.delivery.state === 'unknown');
	if (undelivered.length > 0) {
		notes.push({
			code: 'delivery-unknown',
			message: `${undelivered.length} of ${contributions.length} Maestro-added texts are sized as configured now, and no record shows they reached a provider. A setting changed after a launch is not in that launch, a resumed session does not get the first-message text again, and Maestro keeps no record of what it sent.`,
		});
	}
	const servers = components.filter((component) => component.kind === 'mcp-server').length;
	if (servers > 0) {
		notes.push({
			code: 'mcp-tool-definitions',
			message: `${servers} MCP server${servers === 1 ? ' is' : 's are'} declared. A provider loads each server's tool definitions, and the config does not contain them, so their size is unknown.`,
		});
	}
	notes.push({
		code: 'provider-prompt',
		message:
			"The provider's own system prompt, its built-in tool definitions and any hook output are not measured.",
	});
	return notes;
}

export function auditContextFootprint(input: ContextFootprintInput): ContextFootprintAudit {
	const components = input.components
		.map(toComponent)
		.sort(
			(a, b) =>
				FOOTPRINT_KINDS.indexOf(a.kind) - FOOTPRINT_KINDS.indexOf(b.kind) || byTokensThenId(a, b)
		);
	const contributions = input.configured.map(toContribution);

	const large = components
		.filter(
			(component) =>
				component.estimatedTokens !== null && component.estimatedTokens >= CANDIDATE_MIN_TOKENS
		)
		.sort(byTokensThenId);
	const items: FootprintCandidate[] = large.slice(0, CANDIDATE_LIMIT).map((component) => ({
		id: component.id,
		kind: component.kind,
		scope: component.scope,
		label: component.label,
		path: component.path,
		discoveredBy: component.discoveredBy,
		activation: component.activation,
		estimatedTokens: component.estimatedTokens as number,
		basis: 'file-size',
		reason: 'large-component',
	}));

	return {
		version: 1,
		subject: { ...input.subject },
		configured: { contributions },
		inventory: {
			components,
			byKind: totalsByKind(components),
			estimatedTokens: components.reduce((sum, c) => sum + (c.estimatedTokens ?? 0), 0),
		},
		candidates: {
			items,
			omitted: large.length - items.length,
			minTokens: CANDIDATE_MIN_TOKENS,
			limit: CANDIDATE_LIMIT,
		},
		unknowns: [...input.notes, ...standingNotes(components, contributions)],
		accounting: { countsAsSavings: false, note: ACCOUNTING_NOTE },
	};
}

const KIND_NAMES: Record<FootprintKind, readonly [string, string]> = {
	instruction: ['instruction file', 'instruction files'],
	'memory-index': ['memory index', 'memory indexes'],
	memory: ['memory entry', 'memory entries'],
	skill: ['skill', 'skills'],
	'mcp-server': ['MCP server', 'MCP servers'],
};

const FREQUENCY_NAMES: Record<FootprintFrequency, string> = {
	'each-spawn': 'each spawn',
	'first-message': 'first message of a new session',
	'every-message': 'every message',
};

function tokens(count: number): string {
	return `${formatCount(count)} token${count === 1 ? '' : 's'}`;
}

function describeRecord(record: FootprintRecord<string>): string {
	return 'evidence' in record
		? `${record.state} (record bound to ${record.boundTo}: ${record.evidence})`
		: 'unknown';
}

/**
 * The audit as plain text. Plain on purpose: an agent reads it out of a tool
 * result, and the continuity preview is plain for the same reason. It carries
 * paths and sizes, never file contents.
 */
export function formatContextFootprint(audit: ContextFootprintAudit): string {
	const { subject } = audit;
	const lines = [
		`CONTEXT FOOTPRINT  ${subject.agentName ?? subject.agentId} (${subject.toolType})`,
		`Project  ${subject.projectRoot}`,
		...(subject.accountDir ? [`Account  ${subject.accountDir}`] : []),
		'',
		'Estimates only. A token figure is a file size or a text length divided by about 4. Nothing here is counted as compression savings, and nothing here is a measure of what a provider loaded.',
		'',
		'MAESTRO-ADDED TEXT: sizes as configured now, one occurrence each',
	];
	if (audit.configured.contributions.length === 0) lines.push('  none configured');
	for (const entry of audit.configured.contributions) {
		lines.push(
			`  ${entry.label}  about ${tokens(entry.estimatedTokens)}  ${FREQUENCY_NAMES[entry.frequency]}`,
			`    source: ${entry.source}`,
			`    delivery ${describeRecord(entry.delivery)}  window ${describeRecord(entry.window)}`
		);
	}
	if (audit.configured.contributions.length > 0) {
		lines.push(
			'  These are separate additions and are not added together: they arrive at different times.'
		);
	}

	lines.push('', 'INVENTORY ON DISK: sizes of files found, not proof that a provider loads them');
	if (audit.inventory.byKind.length === 0) lines.push('  nothing found');
	for (const total of audit.inventory.byKind) {
		const [one, many] = KIND_NAMES[total.kind];
		const measured =
			total.unmeasured === total.count ? 'size unknown' : tokens(total.estimatedTokens);
		const partial =
			total.unmeasured > 0 && total.unmeasured < total.count
				? `, ${total.unmeasured} unmeasured`
				: '';
		lines.push(`  ${total.count} ${total.count === 1 ? one : many}: ${measured}${partial}`);
	}
	if (audit.inventory.byKind.length > 1) {
		lines.push(`  Total ${tokens(audit.inventory.estimatedTokens)} on disk`);
	}

	const { items, omitted, minTokens } = audit.candidates;
	lines.push(
		'',
		`CANDIDATE OVERHEAD: the largest inventory components, ${tokens(minTokens)} or more each. A candidate is not a finding.`
	);
	if (items.length === 0) lines.push('  none');
	items.forEach((item, index) => {
		lines.push(
			`  ${index + 1}. ${item.label}  [${item.kind}, ${item.scope}]  about ${tokens(item.estimatedTokens)} if loaded in full  activation ${describeRecord(item.activation)}`,
			`     ${item.path}  (found by ${item.discoveredBy})`
		);
	});
	if (omitted > 0) lines.push(`  ${omitted} more at or above that size are not listed.`);

	lines.push('', 'UNKNOWN');
	for (const note of audit.unknowns) lines.push(`  - ${note.message}`);
	return lines.join('\n');
}
