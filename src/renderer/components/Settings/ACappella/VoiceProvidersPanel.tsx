/**
 * Voice Providers - which engines run, and where your audio goes.
 *
 * The one thing this panel must never get wrong is the privacy statement. A
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
 *   - The Conductor Brain picker shows the Brain in force. A model on one of the
 *     user's endpoints is chosen by assigning it to the Local Models
 *     `voice-routing` task, so picking one here writes that assignment, and an
 *     assignment made in Settings > Models or from the CLI shows up here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Radio, ShieldCheck } from 'lucide-react';

import {
	VOICE_CREDENTIALS,
	OPENAI_REALTIME_PROVIDER_ID,
	getVoiceProvider,
	summariseVoiceEgress,
	voiceProvidersForRole,
	type VoiceCredentialService,
} from '../../../../shared/acappella/provider-catalog';
import type { VoiceProviderRole } from '../../../../shared/acappella/providers';
import type { VoiceSlotReadiness } from '../../../../shared/acappella/readiness';
import { VOICE_ROUTING_TASK_ID } from '../../../../shared/acappella/voice-routing';
import { taskAssignmentLocation } from '../../../../shared/local-models/settings-location';
import type {
	CredentialState,
	CredentialValidation,
} from '../../../../main/acappella/providers/credentials';
import type { Theme } from '../../../types';
import { hostPlatform } from '../../../utils/platformUtils';
import { FormInput } from '../../ui/FormInput';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { useLocalModelEndpoints } from '../../../hooks/localModels';
import { AssignmentOptionElements } from '../tabs/LocalModelsTab/AssignmentOptionElements';
import type { AssignmentOptionGroup } from '../tabs/LocalModelsTab/assignmentOptions';
import { buildBrainOptionGroups } from './brainOptions';
import {
	SLOT_DEFINITIONS,
	useVoiceProviderSelection,
	type VoiceSetupMode,
} from './useVoiceProviderSelection';
import { useVoiceModels } from './useVoiceModels';

export interface VoiceProvidersPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
	onSelectionChanged?: () => void;
}

const SETUP_OPTIONS: Array<{ value: VoiceSetupMode; label: string }> = [
	{ value: 'local', label: 'On this computer' },
	{ value: 'cloud', label: 'Cloud' },
	{ value: 'custom', label: 'Custom' },
];

export function VoiceProvidersPanel({
	theme,
	enabled,
	onSelectionChanged,
}: VoiceProvidersPanelProps) {
	const selection = useVoiceProviderSelection(enabled);
	const models = useVoiceModels(enabled);
	// The user's own model servers, for the Conductor Brain's endpoint rows.
	// Mounting lists the models of each ENABLED endpoint and calls nothing else.
	const endpoints = useLocalModelEndpoints();
	const [credentials, setCredentials] = useState<CredentialState[]>([]);
	// Why the last Conductor Brain pick was refused, until the next pick.
	const [brainProblem, setBrainProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [setupProblem, setSetupProblem] = useState<string | null>(null);

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
				? [OPENAI_REALTIME_PROVIDER_ID]
				: [selection.providerIds.stt, selection.providerIds.tts, selection.providerIds.brain];
		return summariseVoiceEgress(ids, { endpointName: selection.brainSource?.endpointName });
	}, [selection.pipeline, selection.providerIds, selection.brainSource]);

	const brainGroups = useMemo(
		() =>
			buildBrainOptionGroups(selection.brainSource, {
				listings: models.listings,
				endpoints: endpoints.endpoints,
				endpointModels: endpoints.models,
			}),
		[selection.brainSource, models.listings, endpoints.endpoints, endpoints.models]
	);

	const handleProviderChange = useCallback(
		async (role: VoiceProviderRole, providerId: string) => {
			await selection.setProvider(role, providerId);
			onSelectionChanged?.();
			// Readiness is per provider: switching a slot changes which requirement
			// the gate is checking, so a stale verdict would describe the old engine.
			await models.refresh();
		},
		[selection, models, onSelectionChanged]
	);

	const handleBrainChange = useCallback(
		async (_role: VoiceProviderRole, value: string) => {
			setBrainProblem(await selection.setBrainChoice(value));
			onSelectionChanged?.();
			await models.refresh();
		},
		[selection, models, onSelectionChanged]
	);

	const handleSetupChange = async (mode: VoiceSetupMode) => {
		setSaving(true);
		setSetupProblem(null);
		setBrainProblem(null);
		try {
			await selection.setSetupMode(mode);
			onSelectionChanged?.();
			await models.refresh();
		} catch (error) {
			setSetupProblem(error instanceof Error ? error.message : 'Could not save the voice setup.');
		} finally {
			setSaving(false);
		}
	};

	return (
		<div data-setting-id="encore-a-cappella-voice-providers" className="select-none space-y-5">
			<SettingsSectionHeading
				icon={Radio}
				description="Choose a setup, or pick each provider yourself."
			>
				Voice setup
			</SettingsSectionHeading>

			{selection.notice && (
				<p className="text-xs" style={{ color: theme.colors.warning }}>
					{selection.notice}
				</p>
			)}

			<div data-setting-id="encore-a-cappella-pipeline">
				<SectionCard theme={theme}>
					<div>
						<ToggleButtonGroup
							options={SETUP_OPTIONS.map((option) =>
								option.value === 'local' && hostPlatform() === 'darwin'
									? { ...option, label: 'On this Mac' }
									: option
							)}
							value={selection.setupMode}
							onChange={(next) => void handleSetupChange(next)}
							theme={theme}
							disabled={!selection.loaded || saving}
						/>
						{setupProblem && (
							<p role="alert" className="text-xs mt-2" style={{ color: theme.colors.error }}>
								{setupProblem}
							</p>
						)}
						{models.error && (
							<p role="alert" className="text-xs mt-2" style={{ color: theme.colors.error }}>
								{models.error}
							</p>
						)}
					</div>
				</SectionCard>
			</div>

			{selection.setupMode === 'local' && (
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm">
							Everything runs on this {hostPlatform() === 'darwin' ? 'Mac' : 'computer'}
						</div>
						<p className="text-xs opacity-70 mt-0.5">
							Parakeet transcription, built-in request routing, and your system voice. Choose Custom
							to use Kokoro, VoiceStudio, or another provider.
						</p>
					</div>
					{models.readiness?.slots.map((slot) => (
						<SlotStatus
							key={slot.slot}
							theme={theme}
							readiness={slot}
							onDownload={(modelId) => void models.download(modelId)}
						/>
					))}
				</SectionCard>
			)}

			{selection.setupMode === 'custom' && (
				<SectionCard theme={theme}>
					<div data-setting-id="encore-a-cappella-stt">
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
					</div>
					<div data-setting-id="encore-a-cappella-brain">
						<div data-setting-id="encore-a-cappella-provider-brain">
							<SlotSelector
								theme={theme}
								role="brain"
								selection={selection}
								readiness={readinessBySlot.get('brain')}
								credentials={credentials}
								optionGroups={brainGroups}
								value={selection.brainChoice}
								problem={brainProblem}
								onChange={handleBrainChange}
								onCredentialsChanged={refreshCredentials}
								onDownload={(modelId) => void models.download(modelId)}
							/>
							{selection.routedBySystemOne && (
								<div
									className="text-xs opacity-70 mt-1"
									data-testid="voice-routing-system-one-note"
								>
									System One decides which agent and tab a request is for (
									{taskAssignmentLocation(VOICE_ROUTING_TASK_ID)}). This Brain still writes what is
									spoken, and routes a turn in conversational mode.
								</div>
							)}
						</div>
					</div>
					<div data-setting-id="encore-a-cappella-tts">
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
					</div>
				</SectionCard>
			)}

			{selection.pipeline === 'realtime' && (
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm">OpenAI Realtime</div>
						<p className="text-xs opacity-70 mt-0.5">
							One service handles your conversation and speaks in an OpenAI voice. Microphone audio
							is sent to OpenAI. Choose Custom to use ElevenLabs or a local voice.
						</p>
					</div>
					{models.readiness?.slots.map((slot) => (
						<SlotStatus
							key={slot.slot}
							theme={theme}
							readiness={slot}
							onDownload={(modelId) => void models.download(modelId)}
						/>
					))}
					<CredentialSection
						theme={theme}
						service="openai"
						credentials={credentials}
						onChanged={refreshCredentials}
					/>
				</SectionCard>
			)}

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
						Your agents use the providers configured for each agent.
					</p>
				</div>
			</div>

			{/* Which voice, how fast, and how loud live in the Voice and Speed panel
			    below, next to the HUD settings. Two voice pickers in one Settings tab
			    is one picker too many, and the one that drifts is always the one the
			    user is not looking at. */}
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
	/**
	 * The rows to offer, when they are more than the slot's catalog providers.
	 * Only the Conductor Brain passes it, to add the user's endpoint models.
	 */
	optionGroups?: readonly AssignmentOptionGroup[];
	/** The selected row's value, when it is not the provider id (see `optionGroups`). */
	value?: string;
	/** Why the last pick was refused, shown under the picker. */
	problem?: string | null;
	onChange: (role: VoiceProviderRole, value: string) => Promise<void>;
	onCredentialsChanged: () => Promise<void>;
	onDownload: (modelId: string) => void;
}

function SlotSelector({
	theme,
	role,
	selection,
	readiness,
	credentials,
	optionGroups,
	value,
	problem,
	onChange,
	onCredentialsChanged,
	onDownload,
}: SlotSelectorProps) {
	const definition = SLOT_DEFINITIONS.find((entry) => entry.slot === role)!;
	const providerId = selection.providerIds[role];
	const descriptor = getVoiceProvider(providerId);
	const groups = useMemo<readonly AssignmentOptionGroup[]>(
		() =>
			optionGroups ??
			(['local', 'cloud', 'mock'] as const)
				.map((tier) => ({
					label: tier === 'local' ? 'Local' : tier === 'cloud' ? 'Cloud' : 'Diagnostics',
					options: voiceProvidersForRole(role)
						.filter((option) => option.tier === tier)
						.map((option) => ({ value: option.id, label: option.label })),
				}))
				.filter((group) => group.options.length > 0),
		[optionGroups, role]
	);

	const requiresKey = descriptor?.requires.kind === 'api-key';
	const service = descriptor?.requires.kind === 'api-key' ? descriptor.requires.service : null;

	return (
		<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-4 items-start py-2">
			<div>
				<label htmlFor={`voice-provider-${role}`} className="font-medium text-sm">
					{role === 'stt' ? 'Transcription' : role === 'brain' ? 'Brain' : 'Voice'}
				</label>
				<p className="text-xs opacity-70 mt-0.5">
					{role === 'stt'
						? 'Turns your speech into text.'
						: role === 'brain'
							? 'Understands and routes requests.'
							: 'Speaks replies aloud.'}
				</p>
				{descriptor && <p className="text-xs opacity-70 mt-2">{descriptor.description}</p>}
				{problem && (
					<p className="text-xs mt-2 select-text" style={{ color: theme.colors.error }}>
						{problem}
					</p>
				)}
				{readiness && (
					<div className="mt-2">
						<SlotStatus theme={theme} readiness={readiness} onDownload={onDownload} />
					</div>
				)}
			</div>

			<div className="min-w-0 space-y-2">
				<select
					id={`voice-provider-${role}`}
					aria-label={`${definition.label} provider`}
					value={value ?? providerId}
					onChange={(event) => void onChange(role, event.target.value)}
					className="w-full px-2 py-1.5 rounded border text-sm"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textMain,
					}}
				>
					<AssignmentOptionElements groups={groups} />
				</select>
				{requiresKey && service && (
					<CredentialSection
						theme={theme}
						service={service}
						credentials={credentials}
						onChanged={onCredentialsChanged}
					/>
				)}
			</div>
		</div>
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
				placeholder={state?.configured ? 'Stored. Enter replacement key' : 'Paste your key'}
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
