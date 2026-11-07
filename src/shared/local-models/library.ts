/**
 * How the Library lists models: in sections, and inside a section in groups.
 *
 * A section is one tab of Settings > Models > Library (Engines, Agent Models,
 * Housekeeping, Speech, Search & Safety, Custom). Engines comes first because
 * nothing in the other sections runs without one. A group is one card
 * inside a section: a text model's role, the user's own models, or a non-text
 * kind. A single-group section draws its rows under the section heading; a
 * section of several kinds draws one card per kind.
 *
 * A text model is listed once. A model that passed the agent qualification is
 * an agent model; every other text model is a housekeeping model, and its other
 * roles (a fast judge, it reads images) are badges on its row, not groups of
 * their own. A model the user added has no role and gets its own group.
 *
 * Settings > Models > Library and `maestro-cli models list` both group through
 * this module, so the two cannot sort or name a model differently.
 */

import { getAgentDisplayName } from '../agentMetadata';
import {
	BGE_SMALL_EN_ID,
	DEBERTA_INJECTION_V2_ID,
	GEMMA_4_E4B_ID,
	GPT_OSS_120B_ID,
	GPT_OSS_20B_ID,
	KOKORO_82M_ID,
	LOCAL_MODEL_KIND_LABELS,
	LOCAL_MODEL_KIND_ORDER,
	PARAKEET_TDT_V2_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
	QWEN3_5_4B_ID,
	QWEN3_CODER_30B_A3B_ID,
	QWEN3_CODER_NEXT_ID,
	WHISPER_BASE_EN_ID,
} from './model-catalog';
import { modelFit, type HardwareProfile } from './model-fit';
import {
	LOCAL_MODEL_ROLES,
	type LocalModelEntry,
	type LocalModelKind,
	type LocalModelRole,
} from './types';

/** A text model's group: it can run an agent, or it does Maestro's own background work. */
export type LocalModelTextGroupId = Extract<LocalModelRole, 'agent' | 'housekeeping'>;

/** A group in the Library: a text model's role, the user's own models, or a non-text kind. */
export type LocalModelLibraryGroupId =
	| LocalModelTextGroupId
	| 'user'
	| Exclude<LocalModelKind, 'text-gen'>;

/** The tabs of Settings > Models > Library, in strip order. */
export const LOCAL_MODEL_LIBRARY_SECTION_IDS = [
	'engines',
	'agents',
	'housekeeping',
	'speech',
	'search',
	'custom',
] as const;

export type LocalModelLibrarySectionId = (typeof LOCAL_MODEL_LIBRARY_SECTION_IDS)[number];

/**
 * What each role is called on a row badge. "Agent-ready" rather than a verb
 * phrase: it is a property of the model, read as "this model is ready to be the
 * model behind an agent".
 */
export const LOCAL_MODEL_ROLE_LABELS: Readonly<Record<LocalModelRole, string>> = Object.freeze({
	agent: 'Agent-ready',
	housekeeping: 'Housekeeping',
	judge: 'Judge',
	vision: 'Vision',
});

export interface LocalModelLibrarySection {
	readonly id: LocalModelLibrarySectionId;
	/** The tab label and the section heading. */
	readonly label: string;
	/** One or two sentences under the heading. */
	readonly description: string;
	/** The groups listed in this section, in order. Empty for Engines, which lists no model. */
	readonly groups: readonly LocalModelLibraryGroupId[];
}

/** Every Library section, by id. */
export const LOCAL_MODEL_LIBRARY_SECTIONS: Readonly<
	Record<LocalModelLibrarySectionId, LocalModelLibrarySection>
> = Object.freeze({
	agents: Object.freeze({
		id: 'agents',
		label: 'Agent Models',
		description:
			"Models strong enough to be the model behind an agent. Each one fixed a bug in a test repository through the harness its badge names, so it can stand in for the provider's own model. Pick one as an agent's Run on target in its settings.",
		groups: Object.freeze(['agent'] as const),
	}),
	housekeeping: Object.freeze({
		id: 'housekeeping',
		label: 'Housekeeping',
		description:
			"Smaller text models for Maestro's own background work: tab names, summaries, shell commands, pull request drafts, fast yes or no decisions, and reading images. Assign one to a task in System One or System Two.",
		groups: Object.freeze(['housekeeping'] as const),
	}),
	speech: Object.freeze({
		id: 'speech',
		label: 'Speech',
		description: 'Hearing, speaking, and the wake word, for voice and dictation.',
		groups: Object.freeze(['stt', 'tts', 'wake-word'] as const),
	}),
	search: Object.freeze({
		id: 'search',
		label: 'Search & Safety',
		description:
			'Embeddings for search by meaning, and classifiers that screen text for prompt injection.',
		groups: Object.freeze(['embedding', 'classifier'] as const),
	}),
	custom: Object.freeze({
		id: 'custom',
		label: 'Custom',
		description:
			'Text models you add from Hugging Face. Each is pinned to a revision and checked against the hash Hugging Face reports, but Maestro has not tested it.',
		groups: Object.freeze(['user'] as const),
	}),
	engines: Object.freeze({
		id: 'engines',
		label: 'Engines',
		description:
			'The engines that run models inside Maestro: llama.cpp for text, ONNX Runtime for speech, embeddings and classifiers. Downloading a model installs its in-app engine. Hosting text models for agents also needs llama-server, installed separately in Models > Sources.',
		groups: Object.freeze([] as const),
	}),
});

export interface LocalModelLibraryGroup {
	readonly id: LocalModelLibraryGroupId;
	readonly label: string;
	/** One sentence under the heading. Absent for a kind group, whose line names the tasks that use it. */
	readonly description?: string;
	/** The model kind, for a group that is one. */
	readonly kind?: LocalModelKind;
	/** The Library section (tab) the group is listed in. */
	readonly section: LocalModelLibrarySectionId;
}

/** The section a group is listed in. Every group is in exactly one. */
function sectionOfGroup(id: LocalModelLibraryGroupId): LocalModelLibrarySectionId {
	return LOCAL_MODEL_LIBRARY_SECTION_IDS.find((section) =>
		(LOCAL_MODEL_LIBRARY_SECTIONS[section].groups as readonly string[]).includes(id)
	)!;
}

const TEXT_GROUP_IDS: readonly LocalModelTextGroupId[] = ['agent', 'housekeeping'];

/** Every Library group, in the order they are listed. */
export const LOCAL_MODEL_LIBRARY_GROUPS: readonly LocalModelLibraryGroup[] = Object.freeze([
	...TEXT_GROUP_IDS.map((id) =>
		Object.freeze({
			id,
			label: LOCAL_MODEL_LIBRARY_SECTIONS[sectionOfGroup(id)].label,
			description: LOCAL_MODEL_LIBRARY_SECTIONS[sectionOfGroup(id)].description,
			section: sectionOfGroup(id),
		})
	),
	Object.freeze({
		id: 'user' as const,
		label: 'Added from Hugging Face',
		description: LOCAL_MODEL_LIBRARY_SECTIONS.custom.description,
		section: 'custom' as const,
	}),
	...LOCAL_MODEL_KIND_ORDER.filter(
		(kind): kind is Exclude<LocalModelKind, 'text-gen'> => kind !== 'text-gen'
	).map((kind) =>
		Object.freeze({
			id: kind,
			label: LOCAL_MODEL_KIND_LABELS[kind],
			kind,
			section: sectionOfGroup(kind),
		})
	),
]);

/** The one group a model is listed under. */
export function localModelLibraryGroup(entry: LocalModelEntry): LocalModelLibraryGroupId {
	if (entry.kind !== 'text-gen') return entry.kind;
	if (entry.userAdded) return 'user';
	return entry.roles?.includes('agent') ? 'agent' : 'housekeeping';
}

/** The one Library section (tab) a model is listed in. */
export function localModelLibrarySection(entry: LocalModelEntry): LocalModelLibrarySectionId {
	return sectionOfGroup(localModelLibraryGroup(entry));
}

/**
 * Group items for the Library in {@link LOCAL_MODEL_LIBRARY_GROUPS} order,
 * keeping each group in the order given. `entryOf` reads the catalog entry off
 * whatever the caller holds. Groups with no item are left out, and so is every
 * group outside `section` when one is named.
 */
export function groupLocalModelsForLibrary<T>(
	items: readonly T[],
	entryOf: (item: T) => LocalModelEntry,
	section?: LocalModelLibrarySectionId
): { group: LocalModelLibraryGroup; items: T[] }[] {
	return LOCAL_MODEL_LIBRARY_GROUPS.filter(
		(group) => section === undefined || group.section === section
	)
		.map((group) => ({
			group,
			items: items.filter((item) => localModelLibraryGroup(entryOf(item)) === group.id),
		}))
		.filter((entry) => entry.items.length > 0);
}

/**
 * The badges a row carries: every role the model has, in Library order, with
 * the agent badge naming the harnesses it qualified with ("Agent-ready: Claude
 * Code, Codex"). Empty for a model with no role.
 */
export function localModelRoleBadges(entry: LocalModelEntry): string[] {
	const roles = entry.roles ?? [];
	return LOCAL_MODEL_ROLES.filter((role) => roles.includes(role)).map((role) => {
		const harnesses = role === 'agent' ? (entry.agentHarnesses ?? []) : [];
		return harnesses.length > 0
			? `${LOCAL_MODEL_ROLE_LABELS.agent}: ${harnesses.map(getAgentDisplayName).join(', ')}`
			: LOCAL_MODEL_ROLE_LABELS[role];
	});
}

/**
 * Curated starting points, in preference order within each job. Fit is a memory
 * estimate, not a speed benchmark: more RAM does not make a larger background
 * model the better default. Wake-word entries are complementary parts, not
 * alternatives, and user-added models have no reviewed recommendation.
 */
const LIBRARY_RECOMMENDATIONS: readonly {
	ids: readonly string[];
	reason: string;
}[] = [
	{
		ids: [
			GPT_OSS_120B_ID,
			QWEN3_CODER_NEXT_ID,
			QWEN3_CODER_30B_A3B_ID,
			GPT_OSS_20B_ID,
			GEMMA_4_E4B_ID,
		],
		reason: 'Our first agent pick among the curated choices that fit this computer comfortably.',
	},
	{
		ids: [QWEN3_5_4B_ID, QWEN3_1_7B_ID],
		reason:
			'A small housekeeping model for quick background work, chosen from models that fit this computer comfortably.',
	},
	{
		ids: [PARAKEET_TDT_V2_ID, WHISPER_BASE_EN_ID],
		reason:
			'Our first English dictation pick that fits this computer comfortably. Parakeet handles names and punctuation; Whisper is the smaller fallback.',
	},
	{
		ids: [KOKORO_82M_ID],
		reason: 'Local speech synthesis that fits this computer comfortably.',
	},
	{
		ids: [BGE_SMALL_EN_ID],
		reason:
			'Quick English semantic search with a small CPU and memory footprint. More RAM alone does not make a larger embedding model faster.',
	},
	{
		ids: [PROMPT_GUARD_2_22M_ID, DEBERTA_INJECTION_V2_ID],
		reason:
			'Our first prompt-injection screening pick that fits this computer comfortably, favoring the smaller classifier.',
	},
];

/** Recommendation explanation by model id. No hardware reading means no recommendation. */
export function recommendedLocalModelsForHardware(
	entries: readonly LocalModelEntry[],
	profile: HardwareProfile | null
): Record<string, string> {
	const recommendations: Record<string, string> = {};
	if (!profile) return recommendations;
	for (const { ids, reason } of LIBRARY_RECOMMENDATIONS) {
		for (const id of ids) {
			const entry = entries.find((candidate) => candidate.id === id);
			if (!entry || entry.userAdded || entry.pending || modelFit(entry, profile).fit !== 'fits') {
				continue;
			}
			recommendations[id] =
				`${reason} This is a hardware-fit recommendation, not a benchmark on this machine.`;
			break;
		}
	}
	return recommendations;
}

/**
 * Models too large to offer for download on a desktop. They are reached through
 * their provider's API, with the user's own key, from Sources. Checked on
 * 2026-10-11: the smallest of them is 155 GB at 4-bit.
 */
export const CLOUD_ONLY_MODELS: readonly string[] = Object.freeze([
	'DeepSeek V4',
	'Kimi K3',
	'Kimi K2.7 Code',
	'GLM-5.3',
]);

/** The "Cloud only" note in Settings > Models > Sources, as one sentence. */
export const CLOUD_ONLY_NOTE = `${CLOUD_ONLY_MODELS.slice(0, -1).join(', ')} and ${CLOUD_ONLY_MODELS[CLOUD_ONLY_MODELS.length - 1]} are too large to run on a desktop. Use them through their provider's API, with your own key.`;
