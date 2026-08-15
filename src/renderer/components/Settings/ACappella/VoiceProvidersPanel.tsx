/**
 * Voice Providers - which engines run, and where your audio goes.
 *
 * The one thing this panel must never get wrong is the sentence at the top. A
 * user configuring a voice assistant has exactly one question that matters -
 * "does my microphone leave this machine" - and every other control here is
 * secondary to answering it correctly. So that line is COMPUTED from the current
 * selection (`summariseVoiceEgress`) rather than written as copy per slot, it is
 * always visible rather than living behind a tooltip, and it updates the moment a
 * slot changes.
 *
 * Everything else follows from three rules the rest of the subsystem already
 * enforces, and which this panel exists to make legible:
 *   - Each slot is configured and validated INDEPENDENTLY. A missing Whisper
 *     model does not stop you using a hosted Brain, and it never silently becomes
 *     one either.
 *   - A slot's status comes from the capability gate, so a blocked session and
 *     this panel can never disagree about why.
 *   - Realtime is a pipeline SHAPE, not a fourth provider. Choosing it replaces
 *     all three slots with one provider's speech-to-speech API, and the tradeoff
 *     is stated where the choice is made rather than in a help page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Radio, ShieldCheck, Sliders } from 'lucide-react';

import {
	VOICE_CREDENTIALS,
	getVoiceProvider,
	summariseVoiceEgress,
	voiceProvidersForRole,
	type VoiceCredentialService,
} from '../../../../shared/acappella/provider-catalog';
import type { VoicePipelineShape, VoiceProviderRole } from '../../../../shared/acappella/providers';
import type { VoiceSlotReadiness } from '../../../../shared/acappella/readiness';
import type {
	CredentialState,
	CredentialValidation,
} from '../../../../main/acappella/providers/credentials';
import type { Theme } from '../../../types';
import { FormInput } from '../../ui/FormInput';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { SLOT_DEFINITIONS, useVoiceProviderSelection } from './useVoiceProviderSelection';
import { useVoiceModels } from './useVoiceModels';

export interface VoiceProvidersPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

const PIPELINE_OPTIONS: Array<{ value: VoicePipelineShape; label: string }> = [
	{ value: 'cascade', label: 'Cascade' },
	{ value: 'realtime', label: 'Realtime' },
];

/** The line a Preview speaks. Fixed, so two voices can be compared fairly. */
const PREVIEW_LINE = 'Backend agent finished the migration and all tests pass.';

const RATE_MIN = 0.7;
const RATE_MAX = 1.4;
const RATE_STEP = 0.05;

export function VoiceProvidersPanel({ theme, enabled }: VoiceProvidersPanelProps) {
	const selection = useVoiceProviderSelection(enabled);
	const models = useVoiceModels(enabled);
	const [credentials, setCredentials] = useState<CredentialState[]>([]);

	const refreshCredentials = useCallback(async () => {
		const states = await window.maestro.voice.credentials.list().catch(() => []);
		setCredentials(states);
	}, []);

	useEffect(() => {
		void refreshCredentials();
	}, [refreshCredentials]);

	/** Readiness per slot, from the capability gate. */
	const readinessBySlot = useMemo(() => {
		const map = new Map<string, VoiceSlotReadiness>();
		for (const slot of models.readiness?.slots ?? []) map.set(slot.slot, slot);
		return map;
	}, [models.readiness]);

	/**
	 * Where audio and text go under the CURRENT selection. Realtime is one
	 * provider in all three slots, so it is summarised as one.
	 */
	const egress = useMemo(() => {
		const ids =
			selection.pipeline === 'realtime'
				? ['openai-realtime']
				: [selection.providerIds.stt, selection.providerIds.tts, selection.providerIds.brain];
		return summariseVoiceEgress(ids);
	}, [selection.pipeline, selection.providerIds]);

	const handleProviderChange = useCallback(
		async (role: VoiceProviderRole, providerId: string) => {
			await selection.setProvider(role, providerId);
			// Readiness is per provider: switching a slot changes which requirement
			// the gate is checking, so a stale verdict would describe the old engine.
			await models.refresh();
		},
		[selection, models]
	);

	return (
		<div data-setting-id="encore-a-cappella-voice-providers" className="select-none space-y-5">
			<SettingsSectionHeading icon={Radio}>Voice Providers</SettingsSectionHeading>

			{/*
			 * First, always visible, never behind a disclosure. This is the fact the
			 * user needs, and it is computed from the selection rather than written.
			 */}
			<div
				data-setting-id="encore-a-cappella-audio-destination"
				className="p-3 rounded border flex items-start gap-2"
				style={{
					borderColor: egress.audioLeaves ? theme.colors.warning : theme.colors.success,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<ShieldCheck
					size={16}
					className="mt-0.5 shrink-0"
					style={{ color: egress.audioLeaves ? theme.colors.warning : theme.colors.success }}
				/>
				<div>
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{egress.statement}
					</div>
					<p className="text-xs opacity-70 mt-0.5">
						This is worked out from the engines selected below. It changes the moment you change
						one.
					</p>
				</div>
			</div>

			{selection.notice && (
				<p className="text-xs" style={{ color: theme.colors.warning }}>
					{selection.notice}
				</p>
			)}

			<div data-setting-id="encore-a-cappella-pipeline">
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Pipeline
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">
							Cascade runs three engines in series and is the only shape a local install or an
							ElevenLabs voice can take. Realtime is the lowest latency, but it speaks in that
							provider&apos;s voice and sends your audio to their servers.
						</p>
						<ToggleButtonGroup
							options={PIPELINE_OPTIONS}
							value={selection.pipeline}
							onChange={(next) => void selection.setPipeline(next)}
							theme={theme}
						/>
					</div>
				</SectionCard>
			</div>

			{selection.pipeline === 'cascade' && (
				<>
					<div data-setting-id="encore-a-cappella-provider-stt">
						<SlotSelector
							theme={theme}
							role="stt"
							selection={selection}
							readiness={readinessBySlot.get('stt')}
							credentials={credentials}
							onChange={handleProviderChange}
							onCredentialsChanged={refreshCredentials}
							onDownload={(modelId) => void models.download(modelId)}
						/>
					</div>
					<div data-setting-id="encore-a-cappella-provider-tts">
						<SlotSelector
							theme={theme}
							role="tts"
							selection={selection}
							readiness={readinessBySlot.get('tts')}
							credentials={credentials}
							onChange={handleProviderChange}
							onCredentialsChanged={refreshCredentials}
							onDownload={(modelId) => void models.download(modelId)}
						/>
					</div>
					<div data-setting-id="encore-a-cappella-provider-brain">
						<SlotSelector
							theme={theme}
							role="brain"
							selection={selection}
							readiness={readinessBySlot.get('brain')}
							credentials={credentials}
							onChange={handleProviderChange}
							onCredentialsChanged={refreshCredentials}
							onDownload={(modelId) => void models.download(modelId)}
						/>
					</div>
				</>
			)}

			{selection.pipeline === 'realtime' && (
				<SectionCard theme={theme}>
					<div className="text-xs opacity-70">
						The realtime tier replaces all three slots with one provider&apos;s speech-to-speech
						API. Routing stays with Maestro: the model asks for an agent and a tab through a tool
						call, and Maestro validates and performs it.
					</div>
					<CredentialSection
						theme={theme}
						service="openai"
						credentials={credentials}
						onChanged={refreshCredentials}
					/>
				</SectionCard>
			)}

			<div data-setting-id="encore-a-cappella-voice-picker">
				<VoicePicker theme={theme} selection={selection} enabled={enabled} />
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

interface SlotSelectorProps {
	theme: Theme;
	role: VoiceProviderRole;
	selection: ReturnType<typeof useVoiceProviderSelection>;
	readiness?: VoiceSlotReadiness;
	credentials: CredentialState[];
	onChange: (role: VoiceProviderRole, providerId: string) => Promise<void>;
	onCredentialsChanged: () => Promise<void>;
	onDownload: (modelId: string) => void;
}

function SlotSelector({
	theme,
	role,
	selection,
	readiness,
	credentials,
	onChange,
	onCredentialsChanged,
	onDownload,
}: SlotSelectorProps) {
	const definition = SLOT_DEFINITIONS.find((entry) => entry.slot === role)!;
	const providerId = selection.providerIds[role];
	const descriptor = getVoiceProvider(providerId);
	const options = voiceProvidersForRole(role);
	const Icon = definition.icon;

	const requiresKey = descriptor?.requires.kind === 'api-key';
	const service = descriptor?.requires.kind === 'api-key' ? descriptor.requires.service : null;

	return (
		<>
			<SettingsSectionHeading icon={Icon}>{definition.label}</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div>
					<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
						{definition.title}
					</div>
					<p className="text-xs opacity-70 mt-0.5 mb-2">{definition.description}</p>

					<select
						aria-label={`${definition.label} provider`}
						value={providerId}
						onChange={(event) => void onChange(role, event.target.value)}
						className="w-full px-2 py-1.5 rounded border text-sm"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
						}}
					>
						{options.map((option) => (
							<option key={option.id} value={option.id}>
								{option.label}
							</option>
						))}
					</select>

					{descriptor && <p className="text-xs opacity-60 mt-1.5">{descriptor.description}</p>}
				</div>

				<SlotStatus theme={theme} readiness={readiness} onDownload={onDownload} />

				{requiresKey && service && (
					<CredentialSection
						theme={theme}
						service={service}
						credentials={credentials}
						onChanged={onCredentialsChanged}
					/>
				)}
			</SectionCard>
		</>
	);
}

/**
 * One slot's verdict, straight from the capability gate.
 *
 * The gate already carries a sentence naming the missing piece and a suggested
 * action for every unsatisfied reason, so this renders those rather than writing
 * its own: a second wording would be a second thing to keep true.
 */
function SlotStatus({
	theme,
	readiness,
	onDownload,
}: {
	theme: Theme;
	readiness?: VoiceSlotReadiness;
	onDownload: (modelId: string) => void;
}) {
	if (!readiness) return null;

	if (readiness.satisfied) {
		return (
			<div className="text-xs" style={{ color: theme.colors.success }}>
				Ready.
			</div>
		);
	}

	return (
		<div className="text-xs space-y-1" style={{ color: theme.colors.warning }}>
			<div>{readiness.detail}</div>
			{readiness.suggestedAction && <div className="opacity-80">{readiness.suggestedAction}</div>}
			{readiness.requiredModelId && (
				<button
					type="button"
					onClick={() => onDownload(readiness.requiredModelId!)}
					className="px-2 py-1 rounded border text-xs"
					style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
				>
					Download the model
				</button>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface CredentialSectionProps {
	theme: Theme;
	service: VoiceCredentialService;
	credentials: CredentialState[];
	onChanged: () => Promise<void>;
}

/**
 * The key field, wrapped in a literal `data-setting-id` per service.
 *
 * Written out as three branches rather than one computed attribute because
 * `searchableSettings.test.ts` proves registry/DOM parity by scanning source
 * text, and an id built from a variable is invisible to it - which would mean
 * these fields silently stopped being findable in Settings search.
 */
function CredentialSection({ theme, service, credentials, onChanged }: CredentialSectionProps) {
	const field = (
		<CredentialField
			theme={theme}
			service={service}
			credentials={credentials}
			onChanged={onChanged}
		/>
	);

	if (service === 'openai') {
		return <div data-setting-id="encore-a-cappella-key-openai">{field}</div>;
	}
	if (service === 'elevenlabs') {
		return <div data-setting-id="encore-a-cappella-key-elevenlabs">{field}</div>;
	}
	return <div data-setting-id="encore-a-cappella-key-anthropic">{field}</div>;
}

/**
 * A masked key field with a Test button.
 *
 * The field is write-only. A stored key is never read back into the renderer, so
 * the input shows a placeholder rather than the value: there is no capability
 * here that needs the secret in a browser heap, and plenty of ways for it to
 * escape one.
 */
function CredentialField({
	theme,
	service,
	credentials,
	onChanged,
}: {
	theme: Theme;
	service: VoiceCredentialService;
	credentials: CredentialState[];
	onChanged: () => Promise<void>;
}) {
	const descriptor = VOICE_CREDENTIALS[service];
	const state = credentials.find((entry) => entry.service === service);
	const [draft, setDraft] = useState('');
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<CredentialValidation | null>(null);

	const handleSave = useCallback(async () => {
		setBusy(true);
		try {
			const saved = await window.maestro.voice.credentials.set(service, draft);
			if (!saved.ok) {
				setResult({ service, status: 'network-error', message: saved.error ?? 'Could not save.' });
				return;
			}
			setDraft('');
			setResult(null);
			await onChanged();
		} finally {
			setBusy(false);
		}
	}, [draft, onChanged, service]);

	const handleTest = useCallback(async () => {
		setBusy(true);
		try {
			// The draft is tested WITHOUT being stored, so a user can find out a key is
			// wrong before committing it to their keychain.
			setResult(await window.maestro.voice.credentials.validate(service, draft || undefined));
		} finally {
			setBusy(false);
		}
	}, [draft, service]);

	const statusColor =
		result?.status === 'valid'
			? theme.colors.success
			: result?.status === 'rate-limited'
				? theme.colors.warning
				: theme.colors.error;

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-1.5 text-xs" style={{ color: theme.colors.textMain }}>
				<KeyRound size={13} />
				<span>{descriptor.label} API key</span>
				{state?.configured && <span style={{ color: theme.colors.success }}>stored</span>}
			</div>

			<FormInput
				theme={theme}
				type="password"
				value={draft}
				onChange={setDraft}
				onSubmit={() => void handleSave()}
				placeholder={
					state?.configured ? 'A key is stored. Type a new one to replace it.' : 'Paste your key'
				}
				monospace
			/>

			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					disabled={busy || !draft}
					onClick={() => void handleSave()}
					className="px-2 py-1 rounded border text-xs disabled:opacity-50"
					style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
				>
					Save
				</button>
				<button
					type="button"
					disabled={busy || (!draft && !state?.configured)}
					onClick={() => void handleTest()}
					className="px-2 py-1 rounded border text-xs disabled:opacity-50"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					Test
				</button>
				{state?.configured && (
					<button
						type="button"
						disabled={busy}
						onClick={() => {
							setDraft('');
							void window.maestro.voice.credentials.set(service, '').then(onChanged);
						}}
						className="px-2 py-1 rounded border text-xs disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Remove
					</button>
				)}
				<a
					href={descriptor.consoleUrl}
					className="text-xs underline opacity-70"
					style={{ color: theme.colors.textMain }}
				>
					Get a key
				</a>
			</div>

			{state && !state.keyringAvailable && (
				<p className="text-xs" style={{ color: theme.colors.warning }}>
					This machine has no credential store Maestro can use, so keys cannot be saved. They are
					never written to disk in plain text.
				</p>
			)}

			{result && (
				<p className="text-xs" style={{ color: statusColor }}>
					{result.message}
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Voice and speed
// ---------------------------------------------------------------------------

function VoicePicker({
	theme,
	selection,
	enabled,
}: {
	theme: Theme;
	selection: ReturnType<typeof useVoiceProviderSelection>;
	enabled: boolean;
}) {
	const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
	const [preview, setPreview] = useState<string | null>(null);

	const ttsProviderId = selection.providerIds.tts;

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			// Listing voices is an authenticated request for a hosted provider, so it
			// is not made until the feature is on and a provider that HAS voices is
			// selected: drawing a settings panel must not spend an API call.
			if (!enabled) return;
			const listed = await window.maestro.voice.listVoices().catch(() => []);
			if (!cancelled) setVoices(listed);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled, ttsProviderId]);

	const handlePreview = useCallback(async () => {
		setPreview('Speaking...');
		const spoken = await window.maestro.voice.previewVoice(PREVIEW_LINE).catch((error: Error) => {
			setPreview(error.message);
			return false;
		});
		setPreview(spoken ? null : 'That voice could not be previewed.');
	}, []);

	return (
		<>
			<SettingsSectionHeading icon={Sliders}>Voice</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div>
					<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
						Which voice, and how fast
					</div>
					<p className="text-xs opacity-70 mt-0.5 mb-2">
						Preview speaks one fixed line, so two voices can be compared on the same words.
					</p>

					<select
						aria-label="Voice"
						value={selection.voiceId ?? ''}
						onChange={(event) => void selection.setVoiceId(event.target.value)}
						disabled={voices.length === 0}
						className="w-full px-2 py-1.5 rounded border text-sm disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
						}}
					>
						<option value="">Provider default</option>
						{voices.map((voice) => (
							<option key={voice.id} value={voice.id}>
								{voice.name}
							</option>
						))}
					</select>
				</div>

				<div className="flex items-center gap-3">
					<label className="text-xs opacity-70" htmlFor="acappella-rate">
						Speed
					</label>
					<input
						id="acappella-rate"
						type="range"
						min={RATE_MIN}
						max={RATE_MAX}
						step={RATE_STEP}
						value={selection.rate}
						onChange={(event) => void selection.setRate(Number(event.target.value))}
						className="flex-1"
					/>
					<span className="text-xs tabular-nums opacity-70">{selection.rate.toFixed(2)}x</span>
				</div>

				<div className="flex items-center gap-2">
					<button
						type="button"
						disabled={!enabled}
						onClick={() => void handlePreview()}
						className="px-2 py-1 rounded border text-xs disabled:opacity-50"
						style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
					>
						Preview
					</button>
					{preview && <span className="text-xs opacity-70">{preview}</span>}
				</div>
			</SectionCard>
		</>
	);
}
