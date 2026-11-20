/**
 * The A Cappella provider selection, persisted in the `acappella` settings blob.
 *
 * That blob is the same one `readVoiceProviderSettings()` reads in main, so this
 * hook writes what the provider registry and the capability gate already know how
 * to read. It deliberately does NOT add top-level settings keys: A Cappella's
 * configuration is one object, and splitting it across the settings store,
 * `settingsMetadata`, and `defaults.ts` would mean four places to keep in step
 * for a value only these panels and the voice session ever read.
 *
 * Provider ids come from the shared catalog rather than being spelled out here.
 * They used to be copied as literals because the capability gate reaches for
 * `electron` and the model store, which the renderer must not pull in; the
 * catalog is the pure-data half that both sides can import, and it is the only
 * reason a slot the gate blocks and a panel that says "ready" cannot disagree.
 *
 * The Conductor Brain has a second input, and it is NOT in that blob: the Local
 * Models `voice-routing` assignment. A local model or an endpoint routes
 * because it is assigned to that task, so this hook reads the assignment from
 * the settings store every other Local Models surface uses and writes it back
 * there. `providerIds.brain` is the Brain in force (the assigned one while the
 * assignment names a source), never a second stored copy of it. See
 * `shared/acappella/voice-routing.ts`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, MessageSquare, Volume2, type LucideIcon } from 'lucide-react';

import { PARAKEET_TDT_V2_ID } from '../../../../shared/local-models/model-catalog';
import {
	HOSTED_PROVIDER_IDS,
	LOCAL_PROVIDER_IDS,
	OPENAI_REALTIME_PROVIDER_ID,
	getVoiceProvider,
	voiceProviderRequirement,
} from '../../../../shared/acappella/provider-catalog';
import type { VoicePipelineShape, VoiceProviderRole } from '../../../../shared/acappella/providers';
import {
	DEFAULT_BACKGROUND_ANNOUNCEMENT_SETTING,
	type BackgroundAnnouncementSetting,
} from '../../../../shared/acappella/announcements';
import {
	DEFAULT_TTS_RATE,
	DEFAULT_TTS_VOLUME,
	clampTtsRate,
	clampTtsVolume,
} from '../../../../shared/acappella/voice-controls';
import {
	VOICE_ROUTING_TASK_ID,
	effectiveBrainProviderId,
	isAssignedBrainProviderId,
	isVoiceRoutingOnSystemOne,
	parseVoiceBrainChoice,
	resolveVoiceBrainSource,
	voiceBrainChoiceValue,
	type VoiceBrainSource,
} from '../../../../shared/acappella/voice-routing';
import {
	OFF_ASSIGNMENT,
	isSameLocalModelAssignment,
	localModelAssignmentProblem,
	resolveLocalModelAssignment,
	withLocalModelAssignment,
	type LocalModelAssignment,
} from '../../../../shared/local-models/tasks';
import { useSettingsStore } from '../../../stores/settingsStore';

/** Where a slot runs. `hosted` is a stated choice, never a fallback. */
export type VoiceSlotMode = 'local' | 'cloud';

export type VoiceSetupMode = 'local' | 'cloud' | 'custom';

/** Settings key holding everything A Cappella persists. Mirrors the main-side constant. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

/**
 * What an unconfigured slot runs.
 *
 * The LOCAL tier, mirroring `DEFAULT_PROVIDER_IDS` in the registry. The two must
 * agree exactly: this decides which pill the panel highlights, that decides what
 * a session actually spawns, and a panel showing "Local" over a session running
 * something else would be a comfortable lie about a privacy-relevant fact. Read
 * from the shared catalog rather than spelled out, so the ids cannot drift.
 */
export const DEFAULT_SLOT_PROVIDER_IDS: Record<VoiceProviderRole, string> = {
	stt: LOCAL_PROVIDER_IDS.stt,
	tts: LOCAL_PROVIDER_IDS.tts,
	brain: LOCAL_PROVIDER_IDS.brain,
};

export interface VoiceSlotDefinition {
	slot: VoiceProviderRole;
	label: string;
	title: string;
	description: string;
	/**
	 * The catalog model the LOCAL choice downloads, when it downloads one.
	 * Absent for a slot whose local engine needs nothing (the system voice, the
	 * built-in router), in which case `localNote` says so where the row would be.
	 */
	modelId?: string;
	/** What the local choice runs on when there is no model row to show. */
	localNote?: string;
	icon: LucideIcon;
}

/** The three independent slots, in the order the panels render them. */
export const SLOT_DEFINITIONS: readonly VoiceSlotDefinition[] = [
	{
		slot: 'stt',
		label: 'Speech-to-Text',
		title: 'Where your speech is transcribed',
		description:
			'Local keeps every sample of your voice on this machine. Hosted sends audio to a service you configure.',
		modelId: PARAKEET_TDT_V2_ID,
		icon: MessageSquare,
	},
	{
		slot: 'tts',
		label: 'Text-to-Speech',
		title: 'Where replies are spoken from',
		description:
			"Local speaks with your computer's own voice. Hosted streams audio back from a service you configure.",
		localNote: 'Uses the voice built into this computer. Nothing to download.',
		icon: Volume2,
	},
	{
		slot: 'brain',
		label: 'Conductor Brain',
		title: 'What decides which agent you meant',
		description:
			'Local routes by agent name with no model, or with a model you assign to Voice routing. Hosted uses an API model, which understands more and costs per request.',
		localNote:
			'Picks the agent you named, or the one you are talking to, and reads replies back as written. Nothing to download.',
		icon: Brain,
	},
];

/**
 * The model a slot's LOCAL choice needs, given what the slot is set to.
 *
 * The selected provider's own requirement wins, so a user who picked Whisper
 * sees the Whisper row rather than the default recogniser's. A slot set to a
 * provider that needs no model (or to a cloud one) shows the slot's default.
 */
export function localModelIdForSlot(
	slot: VoiceSlotDefinition,
	providerId: string | undefined
): string | undefined {
	const requirement = providerId ? voiceProviderRequirement(providerId) : undefined;
	return requirement?.kind === 'model' ? requirement.modelId : slot.modelId;
}

export interface VoiceProviderSelection {
	/**
	 * What each slot runs. Unset slots report the default tier's id, and the
	 * Brain reports the assigned one while `voice-routing` names a source.
	 */
	providerIds: Record<VoiceProviderRole, string>;
	/**
	 * Pick a provider for a slot. For the Brain this is a voice-specific choice
	 * (built-in, hosted), so it also switches a MODEL `voice-routing` assignment
	 * off: one left on would keep deciding the slot. A System One assignment
	 * fills no slot and is left as it is.
	 */
	setProvider: (slot: VoiceProviderRole, providerId: string) => Promise<void>;
	/** The model the `voice-routing` assignment names, or null when it names none. */
	brainSource: VoiceBrainSource | null;
	/**
	 * System One decides which agent and tab a request is for, and the Brain in
	 * the slot only speaks. The Brain row says so beside the picker.
	 */
	routedBySystemOne: boolean;
	/** The Conductor Brain picker's value for the Brain in force. */
	brainChoice: string;
	/**
	 * Apply a Conductor Brain picker value: an assignment spec assigns that model
	 * to `voice-routing`, a provider id goes through {@link setProvider}.
	 * Resolves to the reason a model was refused, or null when it was saved.
	 */
	setBrainChoice: (value: string) => Promise<string | null>;
	pipeline: VoicePipelineShape;
	setPipeline: (shape: VoicePipelineShape) => Promise<void>;
	setupMode: VoiceSetupMode;
	setSetupMode: (mode: VoiceSetupMode) => Promise<void>;
	/** Voice for the TTS slot, when its provider offers a choice. */
	voiceId: string | null;
	setVoiceId: (voiceId: string) => Promise<void>;
	/** Speech rate. 1 is the provider's natural pace. */
	rate: number;
	setRate: (rate: number) => Promise<void>;
	/** Output volume for the assistant's voice, 0 to 1. */
	volume: number;
	setVolume: (volume: number) => Promise<void>;
	/**
	 * Whether an agent finishing outside the current turn is spoken about.
	 * `auto` is on for the Conductor scope and off inside a focused agent.
	 */
	backgroundAnnouncements: BackgroundAnnouncementSetting;
	setBackgroundAnnouncements: (setting: BackgroundAnnouncementSetting) => Promise<void>;
	/** Local or cloud per slot, derived from the selected provider's tier. */
	modes: Record<VoiceProviderRole, VoiceSlotMode>;
	setMode: (slot: VoiceProviderRole, mode: VoiceSlotMode) => Promise<void>;
	/** False until the stored blob has been read, so a panel can say so. */
	loaded: boolean;
	/**
	 * Set when the running session refused to pick the change up yet. The setting
	 * IS saved; it takes effect at the end of the turn.
	 */
	notice: string | null;
}

interface StoredBlob {
	providers?: Record<string, unknown>;
	pipeline?: unknown;
	setupMode?: unknown;
	voice?: { voiceId?: unknown; rate?: unknown; volume?: unknown };
	speech?: { speakBackgroundCompletions?: unknown };
	[key: string]: unknown;
}

function modeForProviderId(providerId: string): VoiceSlotMode {
	return getVoiceProvider(providerId)?.tier === 'cloud' ? 'cloud' : 'local';
}

export function useVoiceProviderSelection(
	enabled: boolean,
	selectionVersion = 0
): VoiceProviderSelection {
	const [providerIds, setProviderIds] =
		useState<Record<VoiceProviderRole, string>>(DEFAULT_SLOT_PROVIDER_IDS);
	const [pipeline, setPipelineState] = useState<VoicePipelineShape>('cascade');
	const [preferredSetupMode, setPreferredSetupMode] = useState<VoiceSetupMode>();
	const [voiceId, setVoiceIdState] = useState<string | null>(null);
	const [rate, setRateState] = useState(DEFAULT_TTS_RATE);
	const [volume, setVolumeState] = useState(DEFAULT_TTS_VOLUME);
	const [backgroundAnnouncements, setBackgroundAnnouncementsState] =
		useState<BackgroundAnnouncementSetting>(DEFAULT_BACKGROUND_ANNOUNCEMENT_SETTING);
	const [loaded, setLoaded] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const stored = (await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) as
				| StoredBlob
				| undefined;
			if (cancelled) return;

			const providers = stored?.providers ?? {};
			setProviderIds({
				stt: asId(providers.stt) ?? DEFAULT_SLOT_PROVIDER_IDS.stt,
				tts: asId(providers.tts) ?? DEFAULT_SLOT_PROVIDER_IDS.tts,
				brain: asId(providers.brain) ?? DEFAULT_SLOT_PROVIDER_IDS.brain,
			});
			setPipelineState(stored?.pipeline === 'realtime' ? 'realtime' : 'cascade');
			setPreferredSetupMode(
				stored?.setupMode === 'custom' || stored?.setupMode === 'local'
					? stored.setupMode
					: undefined
			);
			setVoiceIdState(asId(stored?.voice?.voiceId) ?? null);
			setRateState(clampTtsRate(stored?.voice?.rate));
			setVolumeState(clampTtsVolume(stored?.voice?.volume));
			setBackgroundAnnouncementsState(
				asAnnouncementSetting(stored?.speech?.speakBackgroundCompletions)
			);
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled, selectionVersion]);

	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	const setLocalModelAssignments = useSettingsStore((s) => s.setLocalModelAssignments);
	const brainSource = useMemo(
		() => resolveVoiceBrainSource(assignments, endpoints),
		[assignments, endpoints]
	);
	const routedBySystemOne = useMemo(() => isVoiceRoutingOnSystemOne(assignments), [assignments]);
	/** The Brain in force: `providerIds` holds only the stored voice-specific one. */
	const effectiveProviderIds = useMemo(
		() => ({
			...providerIds,
			brain: effectiveBrainProviderId(brainSource, providerIds.brain) ?? providerIds.brain,
		}),
		[providerIds, brainSource]
	);
	// Existing non-default configurations remain editable after the UI upgrade.
	const setupMode: VoiceSetupMode =
		pipeline === 'realtime'
			? 'cloud'
			: preferredSetupMode !== 'custom' &&
				  !brainSource &&
				  !routedBySystemOne &&
				  SLOT_DEFINITIONS.every(
						({ slot }) => effectiveProviderIds[slot] === DEFAULT_SLOT_PROVIDER_IDS[slot]
				  )
				? 'local'
				: 'custom';

	/**
	 * Tell the running app to pick a change up. The setting is saved either way;
	 * what can be refused is applying it to a session that is mid-turn. That
	 * refusal is surfaced rather than swallowed: a user who changed a voice and
	 * heard the old one needs to know why.
	 */
	const applyToRunningSession = useCallback(async () => {
		const applied = await window.maestro.voice
			.applyProviders()
			.catch(() => ({ status: 'unchanged' as const, reason: undefined }));
		setNotice(applied.status === 'refused' ? (applied.reason ?? null) : null);
	}, []);

	/** Write the `voice-routing` assignment, when it is not already that. */
	const writeBrainAssignment = useCallback(
		(assignment: LocalModelAssignment) => {
			const current = resolveLocalModelAssignment(assignments, VOICE_ROUTING_TASK_ID);
			if (isSameLocalModelAssignment(assignment, current)) return;
			setLocalModelAssignments(
				withLocalModelAssignment(assignments, VOICE_ROUTING_TASK_ID, assignment)
			);
		},
		[assignments, setLocalModelAssignments]
	);

	/**
	 * Read-modify-write against the whole blob, then tell the running app.
	 *
	 * A Cappella keeps more than providers in there, so writing only the field
	 * being changed would drop the rest. The `applyProviders` call is what makes a
	 * change take effect without a restart; it can come back refused, which is
	 * correct and which the panel surfaces rather than retrying.
	 */
	const persist = useCallback(
		async (mutate: (blob: StoredBlob) => void, onSaved?: () => void) => {
			const stored = ((await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) ??
				{}) as StoredBlob;
			const next: StoredBlob = { ...stored, providers: { ...(stored.providers ?? {}) } };
			mutate(next);
			await window.maestro.settings.set(ACAPPELLA_SETTINGS_KEY, next);
			onSaved?.();
			await applyToRunningSession();
		},
		[applyToRunningSession]
	);

	const setProvider = useCallback(
		async (slot: VoiceProviderRole, providerId: string) => {
			if (slot === 'brain') {
				// An assigned Brain is never a stored provider: it is reached by
				// assigning a model, so there is nothing to write under this id.
				if (isAssignedBrainProviderId(providerId)) return;
				// Sent before the blob so main has both by the time it is asked to
				// apply: an assignment left on would keep deciding the slot. Only a
				// MODEL assignment fills the slot, so only that is cleared: System
				// One routes beside the Brain chosen here, which still does the
				// speaking, and picking that Brain must not switch the routing off.
				if (brainSource) writeBrainAssignment(OFF_ASSIGNMENT);
			}
			setProviderIds((prev) => ({ ...prev, [slot]: providerId }));
			await persist((blob) => {
				blob.providers = { ...(blob.providers ?? {}), [slot]: providerId };
			});
		},
		[persist, writeBrainAssignment, brainSource]
	);

	const setBrainChoice = useCallback(
		async (value: string): Promise<string | null> => {
			const choice = parseVoiceBrainChoice(value);
			if (choice.kind === 'provider') {
				await setProvider('brain', choice.providerId);
				return null;
			}
			const problem = localModelAssignmentProblem(VOICE_ROUTING_TASK_ID, choice.assignment);
			if (problem) return problem;
			writeBrainAssignment(choice.assignment);
			await applyToRunningSession();
			return null;
		},
		[setProvider, writeBrainAssignment, applyToRunningSession]
	);

	const setPipeline = useCallback(
		async (shape: VoicePipelineShape) => {
			setPipelineState(shape);
			await persist((blob) => {
				blob.pipeline = shape;
			});
		},
		[persist]
	);

	const setSetupMode = useCallback(
		async (mode: VoiceSetupMode) => {
			if (mode === setupMode) return;
			const shape = mode === 'cloud' ? 'realtime' : 'cascade';
			// Save a preset in one update, then apply it once to the running session.
			await persist(
				(blob) => {
					blob.pipeline = shape;
					blob.setupMode = mode;
					if (mode === 'local') {
						blob.providers = { ...blob.providers, ...DEFAULT_SLOT_PROVIDER_IDS };
					} else if (mode === 'cloud') {
						blob.providers = { ...blob.providers, realtime: OPENAI_REALTIME_PROVIDER_ID };
					}
				},
				() => {
					if (mode === 'local') {
						// Clear routing assignments after saving, before applying the preset.
						writeBrainAssignment(OFF_ASSIGNMENT);
						setProviderIds(DEFAULT_SLOT_PROVIDER_IDS);
					}
					setPreferredSetupMode(mode);
					setPipelineState(shape);
				}
			);
		},
		[setupMode, writeBrainAssignment, persist]
	);

	const setVoiceId = useCallback(
		async (next: string) => {
			setVoiceIdState(next);
			await persist((blob) => {
				blob.voice = { ...(blob.voice ?? {}), voiceId: next };
			});
		},
		[persist]
	);

	const setRate = useCallback(
		async (next: number) => {
			setRateState(next);
			await persist((blob) => {
				blob.voice = { ...(blob.voice ?? {}), rate: next };
			});
		},
		[persist]
	);

	/**
	 * Volume is saved AND applied. `applyProviders` (inside `persist`) rebuilds
	 * engines when the selection changed and does nothing here, so the live
	 * output would keep its old gain until the next session without this second
	 * call - which is exactly the "restart to hear your own setting" behaviour
	 * these controls are meant to avoid.
	 */
	const setVolume = useCallback(
		async (next: number) => {
			setVolumeState(next);
			await persist((blob) => {
				blob.voice = { ...(blob.voice ?? {}), volume: next };
			});
			await window.maestro.voice.setVolume(next).catch(() => undefined);
		},
		[persist]
	);

	const setBackgroundAnnouncements = useCallback(
		async (next: BackgroundAnnouncementSetting) => {
			setBackgroundAnnouncementsState(next);
			await persist((blob) => {
				blob.speech = { ...(blob.speech ?? {}), speakBackgroundCompletions: next };
			});
		},
		[persist]
	);

	const modes = useMemo(
		() => ({
			stt: modeForProviderId(effectiveProviderIds.stt),
			tts: modeForProviderId(effectiveProviderIds.tts),
			brain: modeForProviderId(effectiveProviderIds.brain),
		}),
		[effectiveProviderIds]
	);

	const setMode = useCallback(
		async (slot: VoiceProviderRole, mode: VoiceSlotMode) => {
			// The toggle reports a click on the pill that is already lit. For a Brain
			// on an assigned model that click must not be read as "reset to the
			// built-in router": it would switch off an assignment the user made.
			if (slot === 'brain' && brainSource && modes.brain === mode) return;
			await setProvider(
				slot,
				mode === 'cloud' ? HOSTED_PROVIDER_IDS[slot] : LOCAL_PROVIDER_IDS[slot]
			);
		},
		[setProvider, brainSource, modes.brain]
	);

	return {
		providerIds: effectiveProviderIds,
		setProvider,
		brainSource,
		routedBySystemOne,
		brainChoice: voiceBrainChoiceValue(brainSource, effectiveProviderIds.brain),
		setBrainChoice,
		pipeline,
		setPipeline,
		setupMode,
		setSetupMode,
		voiceId,
		setVoiceId,
		rate,
		setRate,
		volume,
		setVolume,
		backgroundAnnouncements,
		setBackgroundAnnouncements,
		modes,
		setMode,
		loaded,
		notice,
	};
}

function asId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Anything not one of the three legal values reads as the default. */
function asAnnouncementSetting(value: unknown): BackgroundAnnouncementSetting {
	return value === 'on' || value === 'off' || value === 'auto'
		? value
		: DEFAULT_BACKGROUND_ANNOUNCEMENT_SETTING;
}
