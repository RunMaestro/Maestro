/**
 * The A Cappella settings blob, as a table.
 *
 * A Cappella keeps everything it persists in ONE settings object (`acappella`),
 * and every reader of it sanitises: a hand-edited NaN becomes the default, a
 * misspelled provider id reads as unset. That is the right rule for a READER,
 * and the wrong one for a writer that is not a form: `maestro-cli settings set
 * acappella.controls.turnSettleMs fast` used to store the word, report success,
 * and leave the user on the default with no way to learn why.
 *
 * This table is what a writer outside the Settings panels checks against. One
 * row per stored field: its path under `acappella`, its kind, its bounds, and
 * the value an unset field reads as. The bounds and defaults are the constants
 * the panels and the main-process readers already use, never a second copy.
 *
 * Pure and shared: the CLI validates with it offline, and `settings get` reads
 * an unset field's default from it.
 */

import { DEFAULT_BACKGROUND_ANNOUNCEMENT_SETTING } from './announcements';
import { DEFAULT_VOICE_LISTEN_MODE, VOICE_LISTEN_MODES } from './listen-mode';
import { LOCAL_PROVIDER_IDS, voiceProvidersForRole } from './provider-catalog';
import type { VoiceProviderRole } from './providers';
import {
	DEFAULT_CONVERSATIONAL_MODE,
	DEFAULT_HOLD_THRESHOLD_MS,
	DEFAULT_HOLD_UNTIL_SEND,
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_SEND_HOLD_MS,
	DEFAULT_SEND_PHRASES,
	DEFAULT_STOP_PHRASE,
	DEFAULT_TTS_RATE,
	DEFAULT_TTS_VOLUME,
	DEFAULT_TURN_SETTLE_MS,
	DEFAULT_WAKE_DEBOUNCE_MS,
	DEFAULT_WAKE_ENGINE,
	DEFAULT_WAKE_PHRASE,
	DEFAULT_WAKE_SENSITIVITY,
	MAX_HOLD_THRESHOLD_MS,
	MAX_IDLE_TIMEOUT_MS,
	MAX_SEND_HOLD_MS,
	MAX_TTS_RATE,
	MAX_TTS_VOLUME,
	MAX_TURN_SETTLE_MS,
	MIN_HOLD_THRESHOLD_MS,
	MIN_IDLE_TIMEOUT_MS,
	MIN_SEND_HOLD_MS,
	MIN_TTS_RATE,
	MIN_TTS_VOLUME,
	MIN_TURN_SETTLE_MS,
	formatSendPhrases,
} from './voice-controls';
import { isAssignedBrainProviderId } from './voice-routing';
import { DEFAULT_STUN_URLS } from './webrtc-host';

/** The settings key holding everything A Cappella persists. */
export const VOICE_SETTINGS_KEY = 'acappella';

/** The slots a stored provider id fills. `realtime` is the fused speech-to-speech tier. */
export const VOICE_PROVIDER_SLOTS = ['stt', 'tts', 'brain', 'realtime'] as const;
export type VoiceProviderSlot = (typeof VOICE_PROVIDER_SLOTS)[number];

export function isVoiceProviderSlot(value: string): value is VoiceProviderSlot {
	return (VOICE_PROVIDER_SLOTS as readonly string[]).includes(value);
}

/** One agent's wake phrase, as `controls.agentPhrases` stores it. */
export interface AgentWakePhrase {
	agentSessionId: string;
	phrase: string;
}

export type VoiceSettingField =
	| { kind: 'boolean'; default: boolean; description: string }
	| {
			kind: 'number';
			default: number | undefined;
			min?: number;
			max?: number;
			description: string;
	  }
	| {
			kind: 'string';
			default: string | undefined;
			/** Whether the empty string is a value of its own rather than "unset". */
			allowEmpty?: boolean;
			/** A secret: never printed back in full. */
			sensitive?: boolean;
			description: string;
	  }
	| {
			kind: 'enum';
			default: string | undefined;
			values: () => readonly string[];
			description: string;
	  }
	| { kind: 'string-list'; default: readonly string[]; description: string }
	| { kind: 'agent-phrases'; default: readonly AgentWakePhrase[]; description: string }
	| { kind: 'position'; default: null; description: string };

/**
 * The provider ids a slot may store.
 *
 * A Brain that runs on an assigned model is never stored here: it is reached
 * by assigning a model to the `voice-routing` task, so its id is refused with
 * the verb that does that.
 */
export function storableVoiceProviderIds(slot: VoiceProviderSlot): string[] {
	return voiceProvidersForRole(slot)
		.map((provider) => provider.id)
		.filter((id) => slot !== 'brain' || !isAssignedBrainProviderId(id));
}

const providerField = (slot: VoiceProviderSlot, what: string): VoiceSettingField => ({
	kind: 'enum',
	default: slot === 'realtime' ? undefined : LOCAL_PROVIDER_IDS[slot as VoiceProviderRole],
	values: () => storableVoiceProviderIds(slot),
	description: what,
});

/**
 * Every stored field, keyed by its path under `acappella`.
 *
 * `providersVersion` is absent on purpose: it is the migration's own
 * bookkeeping, and a writer that could set it could skip a migration.
 */
export const VOICE_SETTING_FIELDS: Readonly<Record<string, VoiceSettingField>> = Object.freeze({
	'providers.stt': providerField('stt', 'Speech-to-Text provider.'),
	'providers.tts': providerField('tts', 'Text-to-Speech provider.'),
	'providers.brain': providerField(
		'brain',
		'Conductor Brain provider. A model Brain is set with "maestro-cli models assign voice-routing", not here.'
	),
	'providers.realtime': providerField(
		'realtime',
		'Speech-to-speech provider for the realtime pipeline.'
	),
	pipeline: {
		kind: 'enum',
		default: 'cascade',
		values: () => ['cascade', 'realtime'],
		description: 'Three separate engines (cascade) or one speech-to-speech service (realtime).',
	},
	'voice.voiceId': {
		kind: 'string',
		default: undefined,
		description:
			'The voice the Text-to-Speech provider speaks with. Unset is the provider default.',
	},
	'voice.rate': {
		kind: 'number',
		default: DEFAULT_TTS_RATE,
		min: MIN_TTS_RATE,
		max: MAX_TTS_RATE,
		description: 'Speaking rate, as a multiple of the natural pace.',
	},
	'voice.volume': {
		kind: 'number',
		default: DEFAULT_TTS_VOLUME,
		min: MIN_TTS_VOLUME,
		max: MAX_TTS_VOLUME,
		description: 'Output volume of the spoken reply.',
	},
	'speech.speakBackgroundCompletions': {
		kind: 'enum',
		default: DEFAULT_BACKGROUND_ANNOUNCEMENT_SETTING,
		values: () => ['on', 'off', 'auto'],
		description: 'Whether an agent finishing outside the current turn is spoken about.',
	},
	'audio.inputDeviceId': {
		kind: 'string',
		default: undefined,
		description: 'The microphone. Unset follows the system default.',
	},
	'controls.wakeWordEnabled': {
		kind: 'boolean',
		default: false,
		description: 'Whether the always-on wake word listens.',
	},
	'controls.wakePhrase': {
		kind: 'string',
		default: DEFAULT_WAKE_PHRASE,
		description: 'The phrase that wakes the Conductor.',
	},
	'controls.wakeSensitivity': {
		kind: 'number',
		default: DEFAULT_WAKE_SENSITIVITY,
		min: 0,
		max: 1,
		description: 'How easily the wake word fires. Higher fires more easily.',
	},
	'controls.wakeDebounceMs': {
		kind: 'number',
		default: DEFAULT_WAKE_DEBOUNCE_MS,
		min: 0,
		description: 'Shortest gap between two hits of the same wake phrase, in milliseconds.',
	},
	'controls.wakeEngine': {
		kind: 'enum',
		default: DEFAULT_WAKE_ENGINE,
		values: () => ['classifier', 'transcription'],
		description: 'A trained classifier, or matching the phrase in a transcript.',
	},
	'controls.agentPhrases': {
		kind: 'agent-phrases',
		default: [],
		description:
			'Per-agent wake phrases. Set one with "maestro-cli voice wake-phrase set", which rewrites one entry.',
	},
	'controls.stopPhrase': {
		kind: 'string',
		default: DEFAULT_STOP_PHRASE,
		description: 'The phrase that ends the session.',
	},
	'controls.stopWordEnabled': {
		kind: 'boolean',
		default: true,
		description: 'Whether the stop phrase is armed.',
	},
	'controls.holdThresholdMs': {
		kind: 'number',
		default: DEFAULT_HOLD_THRESHOLD_MS,
		min: MIN_HOLD_THRESHOLD_MS,
		max: MAX_HOLD_THRESHOLD_MS,
		description: 'Below this a hotkey press is a tap; above it, a hold. Milliseconds.',
	},
	'controls.turnSettleMs': {
		kind: 'number',
		default: DEFAULT_TURN_SETTLE_MS,
		min: MIN_TURN_SETTLE_MS,
		max: MAX_TURN_SETTLE_MS,
		description: 'Silence after a sentence before it counts as finished. Milliseconds.',
	},
	'controls.conversationalMode': {
		kind: 'boolean',
		default: DEFAULT_CONVERSATIONAL_MODE,
		description: 'Whether the Conductor talks with you before dispatching anything.',
	},
	'controls.holdUntilSend': {
		kind: 'boolean',
		default: DEFAULT_HOLD_UNTIL_SEND,
		description: 'Whether a request waits for a spoken send phrase rather than for silence.',
	},
	'controls.sendHoldMs': {
		kind: 'number',
		default: DEFAULT_SEND_HOLD_MS,
		min: MIN_SEND_HOLD_MS,
		max: MAX_SEND_HOLD_MS,
		description: 'The pause that sends a held request when no phrase was said. Milliseconds.',
	},
	'controls.sendPhrases': {
		kind: 'string',
		default: formatSendPhrases(DEFAULT_SEND_PHRASES),
		allowEmpty: true,
		description: 'Comma-separated phrases that mean "send it". Empty turns the spoken send off.',
	},
	'controls.idleTimeoutMs': {
		kind: 'number',
		default: DEFAULT_IDLE_TIMEOUT_MS,
		min: MIN_IDLE_TIMEOUT_MS,
		max: MAX_IDLE_TIMEOUT_MS,
		description: 'Listening silence that closes the session. Milliseconds.',
	},
	'ui.transcriptVisible': {
		kind: 'boolean',
		default: false,
		description: 'Whether the Voice HUD shows the live transcript.',
	},
	'ui.hudPosition': {
		kind: 'position',
		default: null,
		description: 'Where the Voice HUD was dragged ({"top":n,"left":n}), or null for bottom-right.',
	},
	'ui.minimizeBehavior': {
		kind: 'enum',
		default: 'manual',
		values: () => ['manual', 'auto-idle'],
		description: 'Whether the Voice HUD also collapses on its own when a session goes quiet.',
	},
	'ui.listenMode': {
		kind: 'enum',
		default: DEFAULT_VOICE_LISTEN_MODE,
		values: () => VOICE_LISTEN_MODES,
		description: 'Hands-free or push-to-talk.',
	},
	'ice.stunUrls': {
		kind: 'string-list',
		default: DEFAULT_STUN_URLS,
		description: 'STUN servers for a paired device, in preference order. Empty is LAN only.',
	},
	'ice.hostCandidates': {
		kind: 'boolean',
		default: true,
		description: 'Whether host candidates are advertised to a paired device.',
	},
	'ice.forceRelay': {
		kind: 'boolean',
		default: false,
		description: 'Refuse any connection to a paired device that is not through the TURN relay.',
	},
	'ice.turn.enabled': {
		kind: 'boolean',
		default: false,
		description: 'Whether the TURN relay is used.',
	},
	'ice.turn.url': {
		kind: 'string',
		default: '',
		allowEmpty: true,
		description: 'The TURN relay, as turn:host:3478 or turns:host:5349.',
	},
	'ice.turn.username': {
		kind: 'string',
		default: '',
		allowEmpty: true,
		description: 'The TURN relay user name.',
	},
	'ice.turn.credential': {
		kind: 'string',
		default: '',
		allowEmpty: true,
		sensitive: true,
		description: 'The TURN relay credential.',
	},
});

/** Every settable path under `acappella`, in table order. */
export const VOICE_SETTING_PATHS: readonly string[] = Object.freeze(
	Object.keys(VOICE_SETTING_FIELDS)
);

/** `acappella.controls.wakePhrase` or `controls.wakePhrase` as the path under the blob. */
export function voiceSettingPath(key: string): string {
	return key === VOICE_SETTINGS_KEY
		? ''
		: key.startsWith(`${VOICE_SETTINGS_KEY}.`)
			? key.slice(VOICE_SETTINGS_KEY.length + 1)
			: key;
}

/** Keys the blob carries that are not settings: the migration's own bookkeeping. */
const VOICE_BOOKKEEPING_KEYS: readonly string[] = ['providersVersion', 'handsFree'];

/**
 * Whether a path under `acappella` names something stored: one field, a
 * section that holds fields (`controls`), or the whole blob (the empty path).
 */
export function isVoiceSettingPath(path: string): boolean {
	if (!path || path in VOICE_SETTING_FIELDS || VOICE_BOOKKEEPING_KEYS.includes(path)) return true;
	return VOICE_SETTING_PATHS.some((candidate) => candidate.startsWith(`${path}.`));
}

/** What a caller is told about a path the table does not hold. */
export function unknownVoiceSettingMessage(path: string): string {
	return `${VOICE_SETTINGS_KEY}.${path} is not an A Cappella setting. Known settings: ${VOICE_SETTING_PATHS.join(', ')}.`;
}

/** The value an unset field reads as, or undefined for a path the table does not hold. */
export function voiceSettingDefault(path: string): unknown {
	const field = VOICE_SETTING_FIELDS[path];
	if (!field) return undefined;
	if (field.kind === 'string-list' || field.kind === 'agent-phrases') return [...field.default];
	return field.default;
}

/** Whether a path holds a secret, so a reader masks it. */
export function isSensitiveVoiceSetting(path: string): boolean {
	const field = VOICE_SETTING_FIELDS[path];
	return field?.kind === 'string' && field.sensitive === true;
}

/** What a masked secret is printed as. The mask `settings list` uses. */
export const VOICE_SETTING_MASK = '***';

/**
 * `value`, as read at `path` under `acappella`, with every secret inside it
 * masked. A read of the secret field itself is returned as it is: naming the
 * field is asking for it. An empty secret is not masked, so "not set" stays
 * visible.
 */
export function redactVoiceSettings(path: string, value: unknown): unknown {
	if (isSensitiveVoiceSetting(path) || !isRecord(value)) return value;
	const redacted: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		redacted[key] =
			isSensitiveVoiceSetting(childPath) && typeof entry === 'string' && entry
				? VOICE_SETTING_MASK
				: redactVoiceSettings(childPath, entry);
	}
	return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeRange(field: Extract<VoiceSettingField, { kind: 'number' }>): string {
	if (field.min !== undefined && field.max !== undefined) {
		return `a number from ${field.min} to ${field.max}`;
	}
	if (field.min !== undefined) return `a number of ${field.min} or more`;
	if (field.max !== undefined) return `a number of ${field.max} or less`;
	return 'a number';
}

/** Why `value` cannot be stored in one field, or null when it can. */
function fieldProblem(path: string, field: VoiceSettingField, value: unknown): string | null {
	const name = `${VOICE_SETTINGS_KEY}.${path}`;
	switch (field.kind) {
		case 'boolean':
			return typeof value === 'boolean' ? null : `${name} expects true or false.`;
		case 'number': {
			const inRange =
				typeof value === 'number' &&
				Number.isFinite(value) &&
				(field.min === undefined || value >= field.min) &&
				(field.max === undefined || value <= field.max);
			return inRange ? null : `${name} expects ${describeRange(field)}.`;
		}
		case 'string':
			if (typeof value !== 'string') return `${name} expects text.`;
			return value.trim() || field.allowEmpty
				? null
				: `${name} cannot be empty. Reset it to return to the default.`;
		case 'enum': {
			const values = field.values();
			if (typeof value === 'string' && values.includes(value)) return null;
			if (
				path === 'providers.brain' &&
				typeof value === 'string' &&
				isAssignedBrainProviderId(value)
			) {
				return `${name}: "${value}" runs on an assigned model. Assign one with "maestro-cli models assign voice-routing <source>".`;
			}
			return `${name} expects one of: ${values.join(', ')}.`;
		}
		case 'string-list':
			return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
				? null
				: `${name} expects a JSON array of strings.`;
		case 'agent-phrases':
			return Array.isArray(value) &&
				value.every(
					(entry) =>
						isRecord(entry) &&
						typeof entry.agentSessionId === 'string' &&
						!!entry.agentSessionId &&
						typeof entry.phrase === 'string' &&
						!!entry.phrase.trim()
				)
				? null
				: `${name} expects a JSON array of {"agentSessionId","phrase"} entries.`;
		case 'position':
			if (value === null) return null;
			return isRecord(value) &&
				typeof value.top === 'number' &&
				Number.isFinite(value.top) &&
				typeof value.left === 'number' &&
				Number.isFinite(value.left)
				? null
				: `${name} expects {"top":<number>,"left":<number>} or null.`;
	}
}

/**
 * Why `value` cannot be written at `path` (a path under `acappella`, or the
 * empty string for the whole blob), or null when it can.
 *
 * A path that names a section (`controls`) takes an object and every field in
 * it is checked. A path the table does not hold is refused with the paths it
 * does, because a stored field nothing reads is a setting that silently does
 * nothing.
 */
export function voiceSettingProblem(path: string, value: unknown): string | null {
	const field = VOICE_SETTING_FIELDS[path];
	if (field) return fieldProblem(path, field, value);

	const prefix = path ? `${path}.` : '';
	const children = VOICE_SETTING_PATHS.filter((candidate) => candidate.startsWith(prefix));
	if (children.length === 0) {
		return unknownVoiceSettingMessage(path);
	}
	if (!isRecord(value)) {
		return `${path ? `${VOICE_SETTINGS_KEY}.${path}` : VOICE_SETTINGS_KEY} holds several settings and expects a JSON object.`;
	}
	return objectProblem(path, value);
}

/** Check every leaf of an object written at a section path. */
function objectProblem(path: string, value: Record<string, unknown>): string | null {
	for (const [key, entry] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		// The migration's bookkeeping rides in the blob; a whole-blob write keeps it.
		if (VOICE_BOOKKEEPING_KEYS.includes(childPath)) continue;
		const field = VOICE_SETTING_FIELDS[childPath];
		if (field) {
			// An absent field in a section write is "unset", which is always legal.
			if (entry === undefined) continue;
			const problem = fieldProblem(childPath, field, entry);
			if (problem) return problem;
			continue;
		}
		if (isRecord(entry)) {
			const problem = voiceSettingProblem(childPath, entry);
			if (problem) return problem;
			continue;
		}
		return unknownVoiceSettingMessage(childPath);
	}
	return null;
}

/**
 * One agent's wake phrase written into the stored list.
 *
 * A blank phrase removes the assignment rather than storing an empty one: a
 * phrase nobody can say would arm a classifier that never fires. Every other
 * agent's entry is left as it is, which is the whole reason this exists: a
 * writer that replaced the array would drop them.
 */
export function withAgentWakePhrase(
	phrases: readonly AgentWakePhrase[],
	agentSessionId: string,
	phrase: string
): AgentWakePhrase[] {
	const rest = phrases.filter((entry) => entry.agentSessionId !== agentSessionId);
	const trimmed = phrase.trim();
	return trimmed ? [...rest, { agentSessionId, phrase: trimmed }] : rest;
}

/** Widen a stored `controls.agentPhrases` value into a list. Anything malformed is dropped. */
export function readAgentWakePhrases(value: unknown): AgentWakePhrase[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(entry): entry is AgentWakePhrase =>
				isRecord(entry) &&
				typeof entry.agentSessionId === 'string' &&
				typeof entry.phrase === 'string'
		)
		.map((entry) => ({ agentSessionId: entry.agentSessionId, phrase: entry.phrase }));
}
