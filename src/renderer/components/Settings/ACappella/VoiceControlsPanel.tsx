/**
 * Voice Controls: the three ways to open the floor and the one way to shut it.
 *
 * Everything a user has to be able to see without guessing:
 *
 *   - the wake word, its phrase, its sensitivity, and a Test button that says
 *     whether the phrase actually fires, because tuning a threshold by trial and
 *     restart is not tuning;
 *   - the stop word, kept in its own card and its own words, because a user who
 *     cannot tell the stop word from barge-in will reach for the wrong one at the
 *     moment they most need the right one;
 *   - both hotkeys with their REAL registration state, because a combo the OS
 *     already owns is the commonest way a global shortcut silently does nothing;
 *   - what a press can do on this platform, stated rather than assumed.
 *
 * The hotkeys are stored in the ordinary `shortcuts` map, so this panel and the
 * Shortcuts tab are two views of one binding.
 */

import { useCallback, useEffect, useState } from 'react';
import { Keyboard, Mic, Radio, RotateCcw, Square, X } from 'lucide-react';

import type { RosterAgent } from '../../../../shared/acappella/protocol';
import {
	DEFAULT_SEND_PHRASES,
	DEFAULT_WAKE_PHRASE,
	FALLBACK_STOP_PHRASE,
	MAX_HOLD_THRESHOLD_MS,
	MAX_SEND_HOLD_MS,
	MAX_TURN_SETTLE_MS,
	MIN_SEND_HOLD_MS,
	MIN_TURN_SETTLE_MS,
	MIN_HOLD_THRESHOLD_MS,
	formatSendPhrases,
	type WakeEngine,
} from '../../../../shared/acappella/voice-controls';
import {
	VOICE_AGENT_HOTKEY_ID,
	VOICE_CONDUCTOR_HOTKEY_ID,
	defaultGlobalHotkeyKeys,
	describeGlobalHotkeyStatus,
	getGlobalHotkeyDefinition,
	type GlobalHotkeyStatus,
} from '../../../../shared/global-hotkeys';
import { useSettings } from '../../../hooks';
import type { Theme } from '../../../types';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { KeyCaptureButton } from '../../ui/KeyCaptureButton';
import { GhostIconButton } from '../../ui/GhostIconButton';
import { ThemedSelect } from '../../shared/ThemedSelect';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { findPretrainedWakePhrase } from '../../../../shared/acappella/voice-models';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { useVoiceControls } from './useVoiceControls';
import { useWakeEnrollment } from './useWakeEnrollment';
import { WakePhraseTrainingRow } from './WakePhraseTraining';

export interface VoiceControlsPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

const HOTKEY_IDS = [VOICE_CONDUCTOR_HOTKEY_ID, VOICE_AGENT_HOTKEY_ID] as const;

/** How long a Test run listens before closing the microphone on its own. */
const WAKE_TEST_TIMEOUT_MS = 15_000;

const WAKE_HIT_FLASH_MS = 900;

/** The shipped phrases, shown in an emptied field so the format is never a guess. */
const SEND_PHRASES_PLACEHOLDER = formatSendPhrases(DEFAULT_SEND_PHRASES);

const WAKE_ENGINE_OPTIONS: Array<{ value: WakeEngine; label: string }> = [
	{ value: 'classifier', label: 'Trained model' },
	{ value: 'transcription', label: 'Transcription' },
];

export function VoiceControlsPanel({ theme, enabled }: VoiceControlsPanelProps) {
	const controls = useVoiceControls(enabled);
	const enrollment = useWakeEnrollment(controls.wakePhrase, enabled);
	/** Whether the phrase has a model trained from the user's own recordings. */
	const enrolled = enrollment.status?.model != null;
	const { shortcuts, setShortcuts } = useSettings();
	const [statuses, setStatuses] = useState<GlobalHotkeyStatus[]>([]);
	const [capabilityNote, setCapabilityNote] = useState<string>('');
	const [agents, setAgents] = useState<RosterAgent[]>([]);
	const [addedAgentIds, setAddedAgentIds] = useState<string[]>([]);
	const phraseAgents = agents.filter(
		(agent) =>
			addedAgentIds.includes(agent.sessionId) ||
			controls.agentPhrases.some((entry) => entry.agentSessionId === agent.sessionId)
	);
	const availableAgents = agents.filter((agent) => !phraseAgents.includes(agent));
	const [testing, setTesting] = useState(false);
	const [testHit, setTestHit] = useState<string | null>(null);
	const [wakeHits, setWakeHits] = useState(0);
	const [wakeLit, setWakeLit] = useState(false);

	const refreshStatuses = useCallback(async () => {
		const result = await window.maestro.voice.hotkeyStatus().catch(() => null);
		if (!result) return;
		setStatuses(result.statuses);
		setCapabilityNote(result.note);
	}, []);

	useEffect(() => {
		void refreshStatuses();
	}, [refreshStatuses, shortcuts]);

	useEffect(() => {
		if (!enabled) return;
		void window.maestro.voice
			.getRoster()
			.then(setAgents)
			.catch(() => setAgents([]));
	}, [enabled]);

	// A tuning run holds a real microphone, so it is torn down when the panel
	// goes away rather than left running behind a closed Settings modal.
	useEffect(() => {
		return () => {
			void window.maestro.voice.wakeTestStop().catch(() => undefined);
		};
	}, []);

	useEffect(() => {
		if (!enabled) return;
		const cleanupTest = window.maestro.voice.onWakeTest((hit) => {
			setTestHit(`Heard "${hit.phrase}" (${hit.score.toFixed(2)})`);
			setWakeHits((count) => count + 1);
		});
		const cleanupEvents = window.maestro.voice.onEvent((event) => {
			if (event.type !== 'wake' || event.source !== 'wake-word') return;
			setTestHit('Wake phrase detected');
			setWakeHits((count) => count + 1);
		});
		return () => {
			cleanupTest();
			cleanupEvents();
		};
	}, [enabled]);

	useEffect(() => {
		if (wakeHits === 0) return;
		setWakeLit(true);
		const timer = setTimeout(() => setWakeLit(false), WAKE_HIT_FLASH_MS);
		return () => clearTimeout(timer);
	}, [wakeHits]);

	useEffect(() => {
		if (!testing) return;
		const timer = setTimeout(() => {
			setTesting(false);
			void window.maestro.voice.wakeTestStop().catch(() => undefined);
		}, WAKE_TEST_TIMEOUT_MS);
		return () => {
			clearTimeout(timer);
		};
	}, [testing]);

	const setHotkeyKeys = useCallback(
		(id: string, keys: string[]) => {
			const existing = shortcuts[id];
			setShortcuts({
				...shortcuts,
				[id]: { ...existing, id, label: existing?.label ?? id, keys },
			});
		},
		[setShortcuts, shortcuts]
	);

	const startTest = useCallback(async () => {
		setTestHit(null);
		const result = await window.maestro.voice
			.wakeTest({ phrase: controls.wakePhrase, sensitivity: controls.wakeSensitivity })
			.catch((error: Error) => ({ started: false as const, reason: error.message }));
		if (!result.started) {
			// The main process says WHY, so a phrase that cannot fire is never
			// mistaken for one that was said too quietly.
			setTestHit(result.reason);
			return;
		}
		setTesting(true);
	}, [controls.wakePhrase, controls.wakeSensitivity]);

	const stopTest = useCallback(async () => {
		setTesting(false);
		await window.maestro.voice.wakeTestStop().catch(() => undefined);
	}, []);

	return (
		<>
			<SettingsSectionHeading icon={Mic}>Voice Controls</SettingsSectionHeading>

			{/* -- Wake word -------------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-wake-word">
				<SectionCard theme={theme}>
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
								Wake word
							</div>
							<p className="text-xs opacity-70 mt-0.5">
								Always runs on this machine, even when speech-to-text is hosted. No audio leaves
								your computer until the phrase actually fires.
							</p>
						</div>
						<ToggleSwitch
							theme={theme}
							checked={controls.wakeWordEnabled}
							disabled={!enabled}
							ariaLabel="Wake word"
							onChange={(checked) => void controls.update({ wakeWordEnabled: checked })}
						/>
					</div>

					<div className="flex items-center justify-between gap-2">
						<label className="text-xs opacity-70" htmlFor="acappella-wake-phrase">
							Phrase
						</label>
						<GhostIconButton
							ariaLabel="Reset wake phrase to default"
							title={`Reset to ${DEFAULT_WAKE_PHRASE}`}
							color={theme.colors.textMain}
							className="gap-1 text-xs"
							disabled={!enabled || controls.wakePhrase === DEFAULT_WAKE_PHRASE}
							onClick={() => void controls.update({ wakePhrase: DEFAULT_WAKE_PHRASE })}
						>
							<RotateCcw className="w-3 h-3" />
							Reset
						</GhostIconButton>
					</div>
					<input
						id="acappella-wake-phrase"
						type="text"
						value={controls.wakePhrase}
						disabled={!enabled}
						onChange={(event) => void controls.update({ wakePhrase: event.target.value })}
						className="w-full px-2 py-1.5 rounded border text-sm disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
						}}
					/>

					<div className="space-y-1">
						<div className="text-xs opacity-70">Detection</div>
						<ToggleButtonGroup
							options={WAKE_ENGINE_OPTIONS}
							value={controls.wakeEngine}
							onChange={(next) => void controls.update({ wakeEngine: next })}
							theme={theme}
						/>
						<p className="text-xs-plus opacity-55">
							{controls.wakeEngine === 'classifier'
								? 'A small model trained for the phrase. Near-zero CPU, but it only knows the phrases it was trained on.'
								: 'Transcribes each burst of speech locally and matches the phrase in the text. Any phrase works; keeps the speech model loaded (about 1 GB).'}
						</p>
						{/* The classifier engine fires on trained phrases only. Saying so here
						    beats a Test button that listens and never lights up. */}
						{controls.wakeEngine === 'classifier' &&
							!enrolled &&
							!findPretrainedWakePhrase(controls.wakePhrase) && (
								<p className="text-xs-plus" style={{ color: theme.colors.warning }}>
									No trained model exists for &ldquo;{controls.wakePhrase}&rdquo;. Train it from
									your own voice below, use &ldquo;{DEFAULT_WAKE_PHRASE}&rdquo;, or switch Detection
									to Transcription.
								</p>
							)}
					</div>

					<div data-setting-id="encore-a-cappella-wake-phrase-training">
						<WakePhraseTrainingRow
							theme={theme}
							enabled={enabled}
							phrase={controls.wakePhrase}
							engine={controls.wakeEngine}
							enrollment={enrollment}
							test={{
								running: testing,
								message: testHit,
								toggle: () => void (testing ? stopTest() : startTest()),
							}}
						/>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs opacity-70" htmlFor="acappella-wake-sensitivity">
							Sensitivity
						</label>
						<input
							id="acappella-wake-sensitivity"
							type="range"
							min={0}
							max={1}
							step={0.05}
							disabled={!enabled}
							value={controls.wakeSensitivity}
							onChange={(event) =>
								void controls.update({ wakeSensitivity: Number(event.target.value) })
							}
							className="flex-1"
						/>
						<span className="text-xs tabular-nums opacity-70">
							{controls.wakeSensitivity.toFixed(2)}
						</span>
					</div>

					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={!enabled}
							onClick={() => void (testing ? stopTest() : startTest())}
							className="px-2 py-1 rounded border text-xs disabled:opacity-50"
							style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
						>
							{testing ? 'Stop test' : 'Test'}
						</button>
						<span
							aria-hidden="true"
							data-testid="wake-detection-light"
							data-active={wakeLit}
							className="h-3 w-3 shrink-0 rounded-full border"
							style={{
								borderColor: wakeLit ? theme.colors.success : theme.colors.border,
								backgroundColor: wakeLit ? theme.colors.success : theme.colors.bgActivity,
								boxShadow: wakeLit ? `0 0 8px ${theme.colors.success}` : undefined,
							}}
						/>
						<span className="text-xs opacity-70" role="status" aria-live="polite">
							{testHit ??
								(testing
									? 'Listening. Say the phrase.'
									: controls.wakeWordEnabled
										? `Say "${controls.wakePhrase}" and watch for a detection.`
										: 'Enable Wake word for hands-free use, or press Test to try the phrase.')}
							{wakeHits > 0 && ` · ${wakeHits} detection${wakeHits === 1 ? '' : 's'}`}
						</span>
					</div>
				</SectionCard>
			</div>

			{/* -- Per-agent phrases ------------------------------------------ */}
			<div data-setting-id="encore-a-cappella-agent-wake-phrases">
				<SectionCard theme={theme}>
					<div>
						<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
							Per-agent phrases
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">
							Give an agent its own phrase and saying it opens a session bound straight to that
							agent, with no routing step in between. Also editable in the agent&apos;s own
							settings.
						</p>
					</div>
					{phraseAgents.length === 0 && (
						<p className="text-xs opacity-70">No per-agent phrases configured.</p>
					)}
					{phraseAgents.map((agent) => {
						const assigned =
							controls.agentPhrases.find((entry) => entry.agentSessionId === agent.sessionId)
								?.phrase ?? '';
						return (
							<div key={agent.sessionId} className="flex items-center gap-2">
								<span
									className="text-xs w-32 truncate"
									style={{ color: theme.colors.textMain }}
									title={agent.name}
								>
									{agent.name}
								</span>
								<input
									type="text"
									aria-label={`Wake phrase for ${agent.name}`}
									value={assigned}
									disabled={!enabled}
									placeholder="No phrase"
									onChange={(event) => {
										setAddedAgentIds((ids) =>
											ids.includes(agent.sessionId) ? ids : [...ids, agent.sessionId]
										);
										void controls.setAgentPhrase(agent.sessionId, event.target.value);
									}}
									className="flex-1 px-2 py-1 rounded border text-xs disabled:opacity-50"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textMain,
									}}
								/>
								<GhostIconButton
									ariaLabel={`Remove wake phrase for ${agent.name}`}
									title="Remove phrase"
									color={theme.colors.textDim}
									disabled={!enabled}
									onClick={() => {
										setAddedAgentIds((ids) => ids.filter((id) => id !== agent.sessionId));
										void controls.setAgentPhrase(agent.sessionId, '');
									}}
								>
									<X size={14} />
								</GhostIconButton>
							</div>
						);
					})}
					<ThemedSelect
						theme={theme}
						value=""
						placeholder="Add agent"
						aria-label="Add agent wake phrase"
						options={availableAgents.map((agent) => ({
							value: agent.sessionId,
							label: agent.name,
						}))}
						onChange={(id) => setAddedAgentIds((ids) => [...ids, id])}
						disabled={!enabled || !controls.loaded || availableAgents.length === 0}
						filterable
						filterPlaceholder="Filter agents..."
					/>
				</SectionCard>
			</div>

			{/* -- Stop word --------------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-stop-word">
				<SectionCard theme={theme}>
					<div className="flex items-start justify-between gap-3">
						<div>
							<div
								className="font-medium text-sm flex items-center gap-1.5"
								style={{ color: theme.colors.textMain }}
							>
								<Square size={13} /> Stop word
							</div>
							<p className="text-xs opacity-70 mt-0.5">
								Ends the session: speech stops, the microphone closes, and Maestro goes back to
								waiting for the wake word. This is NOT interrupting - talking over a reply just
								stops the speech and keeps the floor.
							</p>
						</div>
						<ToggleSwitch
							theme={theme}
							checked={controls.stopWordEnabled}
							disabled={!enabled}
							ariaLabel="Stop word"
							onChange={(checked) => void controls.update({ stopWordEnabled: checked })}
						/>
					</div>

					<label className="block text-xs opacity-70" htmlFor="acappella-stop-phrase">
						Stop phrase
					</label>
					<input
						id="acappella-stop-phrase"
						type="text"
						value={controls.stopPhrase}
						disabled={!enabled}
						onChange={(event) => void controls.update({ stopPhrase: event.target.value })}
						className="w-full px-2 py-1.5 rounded border text-sm disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
						}}
					/>
					<p className="text-xs opacity-70">
						&ldquo;{FALLBACK_STOP_PHRASE}&rdquo; always works too, so there is an answer even when
						you cannot remember what you set.
					</p>
				</SectionCard>
			</div>

			{/* -- Hotkeys ----------------------------------------------------- */}
			<div data-setting-id="encore-a-cappella-voice-hotkeys">
				<SectionCard theme={theme}>
					<div>
						<div
							className="font-medium text-sm flex items-center gap-1.5"
							style={{ color: theme.colors.textMain }}
						>
							<Keyboard size={13} /> Hotkeys
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">{capabilityNote}</p>
					</div>

					{HOTKEY_IDS.map((id) => {
						const definition = getGlobalHotkeyDefinition(id);
						const status = statuses.find((entry) => entry.id === id);
						// The stored map has no entry on a profile that predates these
						// hotkeys, while main registers the shipped default regardless
						// (`keysById[id] ?? defaultGlobalHotkeyKeys(id)`). Reading only the
						// map made the row say "Click to set" for a combo that was live and
						// working. The registry's own keys are the truth; the definition
						// default is the last resort. An explicitly CLEARED binding is an
						// entry with an empty array, which is not nullish, so it still
						// reads "(none)".
						const keys = shortcuts[id]?.keys ?? status?.keys ?? defaultGlobalHotkeyKeys(id);
						const combo = keys.length ? formatShortcutKeys(keys) : '(none)';
						return (
							<div key={id} className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="text-sm" style={{ color: theme.colors.textMain }}>
										{definition?.label ?? id}
									</div>
									<p className="text-xs opacity-70">{definition?.description}</p>
									<p
										className="text-xs mt-0.5"
										style={{
											color: status?.registered ? theme.colors.textDim : theme.colors.error,
										}}
									>
										{status ? describeGlobalHotkeyStatus(status, combo) : 'Not registered yet'}
									</p>
								</div>
								<KeyCaptureButton
									theme={theme}
									keys={keys}
									onKeysChange={(next) => setHotkeyKeys(id, next)}
									emptyLabel="Click to set"
								/>
							</div>
						);
					})}
				</SectionCard>
			</div>

			{/* -- Timing ------------------------------------------------------ */}
			<div data-setting-id="encore-a-cappella-floor-timing">
				<SectionCard theme={theme}>
					<div>
						<div
							className="font-medium text-sm flex items-center gap-1.5"
							style={{ color: theme.colors.textMain }}
						>
							<Radio size={13} /> Timing
						</div>
						<p className="text-xs opacity-70 mt-0.5 mb-2">
							How long a press has to be before it counts as holding the key rather than tapping it.
							The same number classifies a press on the HUD&apos;s talk button. How long an
							untouched microphone stays open is in Voice and Speed.
						</p>
					</div>

					<div className="flex items-center gap-3">
						<label className="text-xs opacity-70 w-28" htmlFor="acappella-hold-threshold">
							Tap vs hold
						</label>
						<input
							id="acappella-hold-threshold"
							type="range"
							min={MIN_HOLD_THRESHOLD_MS}
							max={MAX_HOLD_THRESHOLD_MS}
							step={25}
							disabled={!enabled}
							value={controls.holdThresholdMs}
							onChange={(event) =>
								void controls.update({ holdThresholdMs: Number(event.target.value) })
							}
							className="flex-1"
						/>
						<span className="text-xs tabular-nums opacity-70">{controls.holdThresholdMs} ms</span>
					</div>

					<div
						className="flex items-start justify-between gap-3"
						data-setting-id="encore-a-cappella-conversational-mode"
					>
						<div className="min-w-0">
							<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
								Talk it through first
							</div>
							<p className="text-xs opacity-70 mt-0.5">
								The Conductor answers you instead of sending every sentence to an agent, and only
								hands work over once you have described something doable. Off, each sentence is a
								command.
							</p>
						</div>
						<ToggleSwitch
							theme={theme}
							checked={controls.conversationalMode}
							disabled={!enabled}
							ariaLabel="Talk it through first"
							onChange={(checked) => void controls.update({ conversationalMode: checked })}
						/>
					</div>

					<div
						className="flex items-start justify-between gap-3"
						data-setting-id="encore-a-cappella-hold-until-send"
					>
						<div className="min-w-0">
							<div className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
								Wait for me to say send
							</div>
							<p className="text-xs opacity-70 mt-0.5">
								Speak for as long as you like. Nothing goes to an agent until you say a send phrase,
								or you stop talking for the pause below.
							</p>
						</div>
						<ToggleSwitch
							theme={theme}
							checked={controls.holdUntilSend}
							disabled={!enabled}
							ariaLabel="Wait for me to say send"
							onChange={(checked) => void controls.update({ holdUntilSend: checked })}
						/>
					</div>

					{controls.holdUntilSend && (
						<div className="flex items-center gap-3" data-setting-id="encore-a-cappella-send-hold">
							<label className="text-xs opacity-70 w-28" htmlFor="acappella-send-hold">
								Send after
							</label>
							<input
								id="acappella-send-hold"
								type="range"
								min={MIN_SEND_HOLD_MS}
								max={MAX_SEND_HOLD_MS}
								step={5_000}
								disabled={!enabled}
								value={controls.sendHoldMs}
								onChange={(event) =>
									void controls.update({ sendHoldMs: Number(event.target.value) })
								}
								className="flex-1"
							/>
							<span className="text-xs tabular-nums opacity-70">
								{Math.round(controls.sendHoldMs / 1000)}s
							</span>
						</div>
					)}

					{/* Outside the toggle above on purpose. A send phrase ends a request in
					    BOTH modes: with the toggle off it beats the short settle window,
					    with it on it is how a held request finishes. Hidden behind the
					    toggle, the phrase worked for everyone and could be changed by
					    almost no one. */}
					<label className="block text-xs opacity-70" htmlFor="acappella-send-phrases">
						Send phrases
					</label>
					<input
						id="acappella-send-phrases"
						data-setting-id="encore-a-cappella-send-phrases"
						type="text"
						disabled={!enabled}
						value={controls.sendPhrases}
						onChange={(event) => void controls.update({ sendPhrases: event.target.value })}
						placeholder={SEND_PHRASES_PLACEHOLDER}
						className="w-full rounded border bg-transparent px-2 py-1 text-xs outline-none disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					<p className="text-xs-plus opacity-55">
						Say one to send a request right away instead of waiting out the pause. Comma separated,
						and only heard at the END of a sentence - so &quot;go maestro, then fix the tests&quot;
						keeps listening. The phrase is removed before the request is sent, and the first one is
						the phrase the HUD reminds you of. Leave this empty to send only on the pause.
					</p>

					<div className="flex items-center gap-3" data-setting-id="encore-a-cappella-turn-settle">
						<label className="text-xs opacity-70 w-28" htmlFor="acappella-turn-settle">
							Finish my thought
						</label>
						<input
							id="acappella-turn-settle"
							type="range"
							min={MIN_TURN_SETTLE_MS}
							max={MAX_TURN_SETTLE_MS}
							step={50}
							disabled={!enabled}
							value={controls.turnSettleMs}
							onChange={(event) =>
								void controls.update({ turnSettleMs: Number(event.target.value) })
							}
							className="flex-1"
						/>
						<span className="text-xs tabular-nums opacity-70">
							{controls.turnSettleMs === 0 ? 'off' : `${controls.turnSettleMs} ms`}
						</span>
					</div>

					<p className="text-xs-plus opacity-55">
						Extra silence to wait before sending, so a pause in the middle of a request does not
						become two. It is added to the recogniser&apos;s own endpointing, so the default sends
						about 1.6 seconds after you stop talking. Set it to off to send each sentence the moment
						it lands.
					</p>
				</SectionCard>
			</div>
		</>
	);
}
