/**
 * Director's Notes narrative bucketing.
 *
 * The agent emits a flat list of bullets per section, each optionally tagged
 * with the `agent` it came from. Read as a flat list, a 27-bullet
 * Accomplishments section makes the reader re-derive who did what on every
 * line. This module buckets those bullets for presentation: by the agent's
 * GROUP when it belongs to one, and by the agent itself when it does not.
 *
 * The mapping is deterministic and comes from Maestro's own session/group
 * state, never from the model: the agent only has to name which session a
 * bullet belongs to, which it already does. That is the whole reason this is
 * not a new field in the prompt contract - a model-authored group name would
 * be one more thing that can be invented.
 *
 * Pure and dependency-free so both the Rich Mode renderer and the markdown
 * (Plain Mode / Copy / Save) path can share one bucketing rule, and so it can
 * be unit-tested in isolation.
 */

import type { NarrativeItem } from './directorNotesNarrative';

/** Bucket label used for bullets the agent left unattributed. */
export const UNATTRIBUTED_BUCKET_LABEL = 'General';

/** One agent's group membership, as known to Maestro (not to the model). */
export interface NarrativeAgentGroupEntry {
	/** The agent's display name, as it appears in the synopsis manifest. */
	agent: string;
	/** The group's display name, or absent/blank when the agent is ungrouped. */
	group?: string;
	/** The group's emoji, when it has one. */
	emoji?: string;
}

/** Resolves an agent name to its group, or `null` when it has none. */
export type NarrativeGroupLookup = (agentName: string) => { name: string; emoji?: string } | null;

/** A run of bullets that share a group (or, ungrouped, an agent). */
export interface NarrativeBucket {
	/** Header text: the group name, the agent name, or {@link UNATTRIBUTED_BUCKET_LABEL}. */
	label: string;
	/** The group's emoji when this bucket is a group. */
	emoji?: string;
	/** True when `label` names a group rather than a single agent. */
	isGroup: boolean;
	/** True for the catch-all bucket of bullets with no `agent` tag. */
	isUnattributed: boolean;
	/** The bullets, in the order the agent emitted them. */
	items: NarrativeItem[];
}

/**
 * Normalize a name for matching. The manifest hands the model a sanitized
 * display name (markdown punctuation stripped, whitespace collapsed), so the
 * string that comes back rarely matches a session's stored name byte for byte.
 * Matching on the stripped, case-folded form is what makes "Maestro Cue Main"
 * find the session it names.
 */
export function normalizeAgentKey(name: string): string {
	return name
		.replace(/[#*_`~[\]()!|>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * Build a lookup from Maestro's live session/group state. Entries whose group
 * is absent or blank simply resolve to `null`, which buckets that agent under
 * its own name.
 */
export function buildNarrativeGroupLookup(
	entries: readonly NarrativeAgentGroupEntry[]
): NarrativeGroupLookup {
	const map = new Map<string, { name: string; emoji?: string }>();
	for (const entry of entries) {
		const group = entry.group?.trim();
		if (!group) continue;
		const key = normalizeAgentKey(entry.agent);
		if (!key || map.has(key)) continue;
		map.set(key, { name: group, emoji: entry.emoji });
	}
	return (agentName: string) => map.get(normalizeAgentKey(agentName)) ?? null;
}

/**
 * Split a section's items into buckets.
 *
 * Bucket order follows first appearance, so the model's own ordering (most
 * active first) survives; the unattributed catch-all always sorts last because
 * it is the one bucket that says nothing about ownership.
 */
export function bucketNarrativeItems(
	items: readonly NarrativeItem[],
	lookup?: NarrativeGroupLookup | null
): NarrativeBucket[] {
	const buckets: NarrativeBucket[] = [];
	const byKey = new Map<string, NarrativeBucket>();

	for (const item of items) {
		// `|| undefined` and not `?.trim()` alone: a blank `agent` string is the
		// same statement as no agent at all, and an empty label would render as
		// a headerless bucket that looks like a rendering fault.
		const agent = item.agent?.trim() || undefined;
		const group = agent && lookup ? lookup(agent) : null;

		const label = group ? group.name : (agent ?? UNATTRIBUTED_BUCKET_LABEL);
		const key = group
			? `group:${normalizeAgentKey(group.name)}`
			: `agent:${normalizeAgentKey(label)}`;

		let bucket = byKey.get(key);
		if (!bucket) {
			bucket = {
				label,
				emoji: group?.emoji,
				isGroup: Boolean(group),
				isUnattributed: !agent,
				items: [],
			};
			byKey.set(key, bucket);
			buckets.push(bucket);
		}
		bucket.items.push(item);
	}

	const attributed = buckets.filter((b) => !b.isUnattributed);
	const unattributed = buckets.filter((b) => b.isUnattributed);
	return [...attributed, ...unattributed];
}

/**
 * Whether bucket headers are worth drawing. One bucket means every bullet in
 * the section shares an owner, and a header over the whole list only repeats
 * what the single agent pill already says.
 */
export function shouldRenderBuckets(buckets: readonly NarrativeBucket[]): boolean {
	return buckets.length > 1;
}
