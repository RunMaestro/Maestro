/**
 * Voice and Speed - what the assistant sounds like, and how the HUD behaves.
 *
 * Everything here applies to the NEXT SPOKEN SENTENCE, not the next session.
 * That is the whole design constraint: a voice you have to restart a
 * conversation to audition is a voice nobody tunes, so the voice, the rate, and
 * the volume are read per sentence by the speech scheduler
 * (`getSpeechOptions`), and the volume is additionally pushed straight at the
 * live audio host.
 *
 * The audio-destination statement is repeated at the top on purpose. It also
 * appears in Voice Providers, and the duplication is deliberate rather than
 * sloppy: this is the panel someone opens to change a voice, and "which voice"
 * is exactly the choice that quietly moves audio off the machine when it swaps a
 * local engine for a hosted one. Computed from the live selection through
 * `summariseVoiceEgress`, never written as copy.
 */

import { useCallback, useEffect, useState } from 'react';
import { Play, RotateCcw, Sliders } from 'lucide-react';

import { summariseVoiceEgress } from '../../../../shared/acappella/provider-catalog';
import type { BackgroundAnnouncementSetting } from '../../../../shared/acappella/announcements';
import type { VoiceHudMinimizeBehavior } from '../../../../shared/acappella/ui-prefs';
import {
	MAX_IDLE_TIMEOUT_MS,
	MAX_TTS_RATE,
	MAX_TTS_VOLUME,
	MIN_IDLE_TIMEOUT_MS,
	MIN_TTS_RATE,
	MIN_TTS_VOLUME,
	TTS_RATE_STEP,
	TTS_VOLUME_STEP,
} from '../../../../shared/acappella/voice-controls';
import type { Theme } from '../../../types';
import { useVoiceUiStore } from '../../../stores/voiceUiStore';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { useVoiceControls } from './useVoiceControls';
import { useVoiceProviderSelection } from './useVoiceProviderSelection';

export interface VoiceOutputPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

/** The line a Preview speaks. Fixed, so two voices can be compared fairly. */
export const VOICE_PREVIEW_LINE = 'Backend agent finished the migration and all tests pass.';

const ANNOUNCEMENT_OPTIONS: Array<{ value: BackgroundAnnouncementSetting; label: string }> = [
	{ value: 'auto', label: 'Auto' },
	{ value: 'on', label: 'Always' },
	{ value: 'off', label: 'Never' },
];

const MINIMIZE_OPTIONS: Array<{ value: VoiceHudMinimizeBehavior; label: string }> = [
	{ value: 'manual', label: 'Only when I ask' },
	{ value: 'auto-idle', label: 'When the turn ends' },
];

export function VoiceOutputPanel({ theme, enabled }: VoiceOutputPanelProps) {
	const selection = useVoiceProviderSelection(enabled);
	const controls = useVoiceControls(enabled);
	const ui = useVoiceUiStore();

	const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
	const [previewNote, setPreviewNote] = useState<string | null>(null);

	const ttsProviderId = selection.providerIds.tts;

	// Read through `getState()` rather than the subscribed `ui` object: `load` is
	// stable on the store, but depending on `ui` would re-read settings from disk
	// on every state change the panel makes.
	useEffect(() => {
		void useVoiceUiStore.getState().load();
	}, []);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			// Listing voices is an authenticated request for a hosted provider, so it
			// is not made until the feature is on: drawing a settings panel must not
			// spend an API call.
			if (!enabled) return;
			const listed = await window.maestro.voice.listVoices().catch(() => []);
			if (!cancelled) setVoices(listed);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled, ttsProviderId]);

	const preview = useCallback(async (voiceId?: string) => {
		setPreviewNote('Speaking...');
		const spoke = await window.maestro.voice
			.previewVoice(VOICE_PREVIEW_LINE, voiceId)
			.catch((error: Error) => {
				setPreviewNote(error.message);
				return null;
			});
		if (spoke === null) return;
		setPreviewNote(spoke ? null : 'That voice could not be previewed.');
	}, []);

	const egress = summariseVoiceEgress([selection.providerIds.tts]);

	return (
		<div className="select-none space-y-5">
			<SettingsSectionHeading icon={Sliders}>Voice and Speed</SettingsSectionHeading>

			{/* Where the audio goes, computed from the TTS slot rather than written.
			    Repeated from Voice Providers because this is the panel where someone
			    swaps a local voice for a hosted one. */}
			<div
				data-setting-id="encore-a-cappella-voice-audio-destination"
				className="p-3 rounded border text-xs"
				style={{
					borderColor: egress.audioLeaves ? theme.colors.warning : theme.colors.success,
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
				}}
			>
				{egress.statement}
			</div>

			{/* -- Voice ------------------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-voice-selection">
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Voice
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">
							Preview speaks one fixed line, so two voices can be compared on the same words. You
							can hear a voice before you pick it.
						</p>
					</div>

					{voices.length === 0 ? (
						<p className="text-xs opacity-70">
							This engine has one voice. Nothing to choose between.
						</p>
					) : (
						<div
							className="max-h-52 overflow-y-auto scrollbar-thin rounded border"
							style={{ borderColor: theme.colors.border }}
							role="radiogroup"
							aria-label="Voice"
						>
							{voices.map((voice) => {
								const selected = selection.voiceId === voice.id;
								return (
									<div
										key={voice.id}
										className="flex items-center gap-2 px-2 py-1.5 border-b last:border-b-0"
										style={{ borderColor: theme.colors.border }}
									>
										<input
											type="radio"
											id={`acappella-voice-${voice.id}`}
											name="acappella-voice"
											checked={selected}
											disabled={!enabled}
											onChange={() => void selection.setVoiceId(voice.id)}
										/>
										<label
											htmlFor={`acappella-voice-${voice.id}`}
											className="flex-1 text-xs truncate cursor-pointer"
											style={{ color: theme.colors.textMain }}
										>
											{voice.name}
										</label>
										<button
											type="button"
											data-testid={`voice-preview-${voice.id}`}
											aria-label={`Preview ${voice.name}`}
											title={`Preview ${voice.name}`}
											disabled={!enabled}
											onClick={() => void preview(voice.id)}
											className="p-1 rounded border disabled:opacity-50 hover:opacity-80 focus:outline-none focus-visible:ring-2"
											style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
										>
											<Play className="w-3 h-3" />
										</button>
									</div>
								);
							})}
						</div>
					)}

					<div className="flex items-center gap-2">
						<button
							type="button"
							data-testid="voice-preview-current"
							disabled={!enabled}
							onClick={() => void preview()}
							className="px-2 py-1 rounded border text-xs disabled:opacity-50 focus:outline-none focus-visible:ring-2"
							style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
						>
							Preview current voice
						</button>
						{previewNote && <span className="text-xs opacity-70">{previewNote}</span>}
					</div>
				</SectionCard>
			</div>

			{/* -- Speed and volume -------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-speed-volume">
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Speed and volume
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">
							Both take effect on the next sentence spoken, not the next session, so you can tune
							them mid-conversation.
						</p>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs opacity-70 w-16" htmlFor="acappella-rate">
							Speed
						</label>
						<input
							id="acappella-rate"
							type="range"
							min={MIN_TTS_RATE}
							max={MAX_TTS_RATE}
							step={TTS_RATE_STEP}
							disabled={!enabled}
							value={selection.rate}
							onChange={(event) => void selection.setRate(Number(event.target.value))}
							className="flex-1"
						/>
						<span className="text-xs tabular-nums opacity-70 w-12 text-right">
							{selection.rate.toFixed(2)}x
						</span>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs opacity-70 w-16" htmlFor="acappella-volume">
							Volume
						</label>
						<input
							id="acappella-volume"
							type="range"
							min={MIN_TTS_VOLUME}
							max={MAX_TTS_VOLUME}
							step={TTS_VOLUME_STEP}
							disabled={!enabled}
							value={selection.volume}
							onChange={(event) => void selection.setVolume(Number(event.target.value))}
							className="flex-1"
						/>
						<span className="text-xs tabular-nums opacity-70 w-12 text-right">
							{Math.round(selection.volume * 100)}%
						</span>
					</div>
					<p className="text-xs opacity-70">
						The slider stops short of silence on purpose. Muting is the HUD&apos;s speaker button,
						which shows that it is muted; a volume dragged to zero would not.
					</p>
				</SectionCard>
			</div>

			{/* -- Announcements ------------------------------------------------ */}
			<div data-setting-id="encore-a-cappella-background-announcements">
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Background completions
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">
							Whether an agent finishing outside the current turn is spoken about. Auto is on while
							you are talking to the Conductor and off inside one agent&apos;s session, because
							another agent talking over that conversation is an interruption you did not ask for.
						</p>
					</div>
					<ToggleButtonGroup
						theme={theme}
						value={selection.backgroundAnnouncements}
						options={ANNOUNCEMENT_OPTIONS}
						disabled={!enabled}
						onChange={(value) =>
							void selection.setBackgroundAnnouncements(value as BackgroundAnnouncementSetting)
						}
					/>
				</SectionCard>
			</div>

			{/* -- HUD ---------------------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-hud">
				<SectionCard theme={theme}>
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
								Live transcript
							</div>
							<p className="text-xs opacity-70 mt-0.5">
								Show the scrollback inside the HUD, with a chip on each turn saying which agent and
								tab it was sent to. Also toggled from the HUD itself.
							</p>
						</div>
						<ToggleSwitch
							theme={theme}
							checked={ui.transcriptVisible}
							disabled={!enabled}
							ariaLabel="Live transcript"
							onChange={(checked) => void ui.setTranscriptVisible(checked)}
						/>
					</div>

					<div>
						<div className="text-xs opacity-70 mb-1">Minimize the HUD</div>
						<ToggleButtonGroup
							theme={theme}
							value={ui.minimizeBehavior}
							options={MINIMIZE_OPTIONS}
							disabled={!enabled}
							onChange={(value) => void ui.setMinimizeBehavior(value as VoiceHudMinimizeBehavior)}
						/>
						<p className="text-xs opacity-70 mt-1">
							Minimizing collapses the HUD to a small indicator and leaves the session running.
							Closing it ends the session.
						</p>
					</div>

					<div className="flex items-center gap-2">
						<button
							type="button"
							data-testid="voice-hud-reset-position"
							onClick={() => void ui.setHudPosition(null)}
							className="flex items-center gap-1.5 px-2 py-1 rounded border text-xs hover:opacity-80 focus:outline-none focus-visible:ring-2"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							<RotateCcw className="w-3 h-3" />
							Reset HUD position
						</button>
						<span className="text-xs opacity-70">
							{ui.hudPosition
								? `Currently at ${Math.round(ui.hudPosition.left)}, ${Math.round(ui.hudPosition.top)}.`
								: 'Currently at the default, bottom right.'}
						</span>
					</div>
				</SectionCard>
			</div>

			{/* -- Idle timeout -------------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-idle-timeout">
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Idle timeout
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">
							How long a listening microphone stays open with nothing said into it. Long enough to
							think about how to phrase a request, short enough that a mic left open in an empty
							room goes cold before anyone forgets it is there.
						</p>
					</div>
					<div className="flex items-center gap-3">
						<input
							id="acappella-idle-timeout"
							aria-label="Idle timeout"
							type="range"
							min={MIN_IDLE_TIMEOUT_MS / 1000}
							max={MAX_IDLE_TIMEOUT_MS / 1000}
							step={5}
							disabled={!enabled}
							value={controls.idleTimeoutSeconds}
							onChange={(event) =>
								void controls.update({ idleTimeoutSeconds: Number(event.target.value) })
							}
							className="flex-1"
						/>
						<span className="text-xs tabular-nums opacity-70 w-12 text-right">
							{controls.idleTimeoutSeconds}s
						</span>
					</div>
				</SectionCard>
			</div>
		</div>
	);
}

export default VoiceOutputPanel;
