/**
 * Voice Setup - the panel that has to earn a download before it takes one.
 *
 * The rule this component exists to honour: **mounting it issues zero network
 * calls.** Every number on screen (size, hash, revision, license, install path)
 * comes from the frozen catalog in `src/shared/acappella/model-catalog.ts` plus
 * one disk stat. The only thing that opens a connection is the Download button,
 * and `VoiceSetupPanel.test.tsx` asserts exactly that.
 *
 * Three independent slots, each defaulting to Local, plus a wake-word row that
 * is always local and always required for hands-free. Independent matters: a
 * user who wants local speech recognition but an API model for routing should
 * not have to download 1 GB to get it, and a user who wants everything local
 * should not have their microphone quietly routed to a service because one file
 * is missing. The capability gate refuses instead of substituting; this panel is
 * where the refusal is explained and fixed.
 */

import { useCallback, useMemo, useState } from 'react';
import { Mic, ShieldCheck } from 'lucide-react';

import {
	MODEL_SETS,
	OPENWAKEWORD_BASE_ID,
	type VoiceModelSetId,
} from '../../../../shared/acappella/model-catalog';
import { formatSize } from '../../../../shared/formatters';
import type { VoiceProviderRole } from '../../../../shared/acappella/providers';
import type { Theme } from '../../../types';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { VoiceModelRow } from './VoiceModelRow';
import { useVoiceModels } from './useVoiceModels';
import { VoiceInputPicker, useVoiceInputDevices } from '../../ACappella';
import {
	SLOT_DEFINITIONS,
	useVoiceProviderSelection,
	type VoiceSlotMode,
} from './useVoiceProviderSelection';

export interface VoiceSetupPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

const MODE_OPTIONS: Array<{ value: VoiceSlotMode; label: string }> = [
	{ value: 'local', label: 'Local' },
	{ value: 'cloud', label: 'Cloud' },
];

export function VoiceSetupPanel({ theme, enabled }: VoiceSetupPanelProps) {
	const models = useVoiceModels(enabled);
	// The same hook and the same persisted setting the HUD's quick picker writes,
	// so the two can never disagree about which microphone is chosen.
	const inputDevices = useVoiceInputDevices(enabled);
	const { modes, setMode, loaded } = useVoiceProviderSelection(enabled);
	const [pendingSet, setPendingSet] = useState(false);

	// Everything local means the fully-local set; a cloud Brain drops it to the
	// hands-free set. Derived rather than stored: the set IS the slot choices.
	const setId: VoiceModelSetId = modes.brain === 'local' ? 'fully-local' : 'hands-free-local';

	const listingsById = useMemo(
		() => new Map(models.listings.map((listing) => [listing.entry.id, listing])),
		[models.listings]
	);

	/** Models the current slot choices need but that are not installed yet. */
	const missingForSet = useMemo(() => {
		return MODEL_SETS[setId].modelIds.filter((id) => {
			const listing = listingsById.get(id);
			if (!listing) return false;
			// A model with a live job is already being fetched; counting it again
			// would inflate the button's number and re-issue its download.
			if (models.progress[id]?.phase === 'downloading') return false;
			return listing.status.status !== 'installed';
		});
	}, [setId, listingsById, models.progress]);

	const missingBytes = useMemo(
		() => missingForSet.reduce((total, id) => total + (listingsById.get(id)?.entry.bytes ?? 0), 0),
		[missingForSet, listingsById]
	);

	const handleDownloadSet = useCallback(async () => {
		setPendingSet(true);
		try {
			await models.downloadMany([...missingForSet]);
		} finally {
			setPendingSet(false);
		}
	}, [models, missingForSet]);

	const wakeWord = listingsById.get(OPENWAKEWORD_BASE_ID);

	/** One provider slot: the Local/Cloud choice plus its model row. */
	const renderSlot = (role: VoiceProviderRole) => {
		const slot = SLOT_DEFINITIONS.find((candidate) => candidate.slot === role)!;
		const listing = listingsById.get(slot.modelId);
		const Icon = slot.icon;
		return (
			<>
				<SettingsSectionHeading icon={Icon}>{slot.label}</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							{slot.title}
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">{slot.description}</p>
						<ToggleButtonGroup
							options={MODE_OPTIONS}
							value={modes[role]}
							onChange={(next) => void setMode(role, next)}
							theme={theme}
						/>
						{modes[role] === 'cloud' && (
							<p className="text-[11px] opacity-55 mt-2">
								A cloud provider needs its own API key and sends audio or text off this machine.
								Voice mode will refuse to start until the key is set; it never falls back to a
								provider you did not pick.
							</p>
						)}
					</div>

					{modes[role] === 'local' && listing && (
						<VoiceModelRow
							theme={theme}
							listing={listing}
							progress={models.progress[slot.modelId]}
							verifyResult={models.verifyResults[slot.modelId]}
							onDownload={(id) => void models.download(id)}
							onPause={(id) => void models.pause(id)}
							onResume={(id) => void models.resume(id)}
							onCancel={(id) => void models.cancel(id)}
							onVerify={(id) => void models.verify(id)}
						/>
					)}
				</SectionCard>
			</>
		);
	};

	return (
		<div data-setting-id="encore-a-cappella-voice-setup" className="select-none space-y-5">
			<div>
				<SettingsSectionHeading icon={Mic}>Voice Setup</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<p className="text-xs opacity-70">
						Nothing is downloaded until you press Download. Every model below is listed with its
						exact size, its license, and where it lands on disk.
					</p>

					{/* Above the models on purpose: which microphone is open decides whether
					    ANY of them will hear you, and it is the one thing on this panel that
					    costs nothing to get right. */}
					<VoiceInputPicker theme={theme} devices={inputDevices} />

					{!loaded && <p className="text-xs opacity-55">Loading your selection...</p>}

					{models.error && (
						<p className="text-xs" style={{ color: theme.colors.error }}>
							{models.error}
						</p>
					)}

					{models.readiness && !models.readiness.canStartSession && (
						<div className="space-y-1" style={{ color: theme.colors.warning }}>
							{models.readiness.blocking.map((slot) => (
								<div key={slot.slot} className="text-xs">
									{slot.detail} {slot.suggestedAction}
								</div>
							))}
						</div>
					)}

					<div className="flex flex-wrap items-center gap-3">
						<button
							type="button"
							data-setting-id="encore-a-cappella-download-set"
							disabled={missingForSet.length === 0 || pendingSet || !enabled}
							onClick={handleDownloadSet}
							className="px-3 py-2 rounded border text-sm font-medium disabled:opacity-55"
							style={{
								borderColor: theme.colors.accent,
								backgroundColor: theme.colors.accentDim,
								color: theme.colors.textMain,
							}}
						>
							{missingForSet.length === 0
								? `${MODEL_SETS[setId].displayName} is installed`
								: `Download (${formatSize(missingBytes)})`}
						</button>
						<span className="text-[11px] opacity-55">{MODEL_SETS[setId].description}</span>
					</div>
				</SectionCard>
			</div>

			{/*
			 * The three wrappers are written out rather than mapped so each
			 * `data-setting-id` is a literal. `searchableSettings.test.ts` proves
			 * registry/DOM parity by scanning source text for the attribute, and an
			 * id computed from a variable is invisible to it - which would mean these
			 * sections silently stopped being findable in Settings search.
			 */}
			<div data-setting-id="encore-a-cappella-stt">{renderSlot('stt')}</div>
			<div data-setting-id="encore-a-cappella-tts">{renderSlot('tts')}</div>
			<div data-setting-id="encore-a-cappella-brain">{renderSlot('brain')}</div>

			<div data-setting-id="encore-a-cappella-wake-word">
				<SettingsSectionHeading icon={ShieldCheck}>Wake word</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Always local, always required for hands-free
						</div>
						<p className="text-xs opacity-70 mt-0.5">
							Hands-free means something is listening all the time. That something runs on this
							machine and there is no cloud option for it, by design.
						</p>
					</div>
					{wakeWord && (
						<VoiceModelRow
							theme={theme}
							listing={wakeWord}
							progress={models.progress[OPENWAKEWORD_BASE_ID]}
							verifyResult={models.verifyResults[OPENWAKEWORD_BASE_ID]}
							onDownload={(id) => void models.download(id)}
							onPause={(id) => void models.pause(id)}
							onResume={(id) => void models.resume(id)}
							onCancel={(id) => void models.cancel(id)}
							onVerify={(id) => void models.verify(id)}
						/>
					)}
				</SectionCard>
			</div>
		</div>
	);
}
