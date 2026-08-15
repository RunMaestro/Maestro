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
import { Keyboard, Mic, Radio, Square } from 'lucide-react';

import type { RosterAgent } from '../../../../shared/acappella/protocol';
import {
	FALLBACK_STOP_PHRASE,
	MAX_HOLD_THRESHOLD_MS,
	MAX_IDLE_TIMEOUT_MS,
	MIN_HOLD_THRESHOLD_MS,
	MIN_IDLE_TIMEOUT_MS,
} from '../../../../shared/acappella/voice-controls';
import {
	VOICE_AGENT_HOTKEY_ID,
	VOICE_CONDUCTOR_HOTKEY_ID,
	describeGlobalHotkeyStatus,
	getGlobalHotkeyDefinition,
	type GlobalHotkeyStatus,
} from '../../../../shared/global-hotkeys';
import { useSettings } from '../../../hooks';
import type { Theme } from '../../../types';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { KeyCaptureButton } from '../../ui/KeyCaptureButton';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { useVoiceControls } from './useVoiceControls';

export interface VoiceControlsPanelProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. */
	enabled: boolean;
}

const HOTKEY_IDS = [VOICE_CONDUCTOR_HOTKEY_ID, VOICE_AGENT_HOTKEY_ID] as const;

/** How long a Test run listens before closing the microphone on its own. */
const WAKE_TEST_TIMEOUT_MS = 15_000;

export function VoiceControlsPanel({ theme, enabled }: VoiceControlsPanelProps) {
	const controls = useVoiceControls(enabled);
	const { shortcuts, setShortcuts } = useSettings();
	const [statuses, setStatuses] = useState<GlobalHotkeyStatus[]>([]);
	const [capabilityNote, setCapabilityNote] = useState<string>('');
	const [agents, setAgents] = useState<RosterAgent[]>([]);
	const [testing, setTesting] = useState(false);
	const [testHit, setTestHit] = useState<string | null>(null);

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
		if (!testing) return;
		const cleanup = window.maestro.voice.onWakeTest((hit) => {
			setTestHit(`Heard "${hit.phrase}" (${hit.score.toFixed(2)})`);
		});
		const timer = setTimeout(() => {
			setTesting(false);
			void window.maestro.voice.wakeTestStop().catch(() => undefined);
		}, WAKE_TEST_TIMEOUT_MS);
		return () => {
			cleanup();
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
		const started = await window.maestro.voice
			.wakeTest({ phrase: controls.wakePhrase, sensitivity: controls.wakeSensitivity })
			.catch(() => false);
		if (!started) {
			setTestHit('Test needs an idle session and the wake model installed.');
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

					<label className="block text-xs opacity-70" htmlFor="acappella-wake-phrase">
						Phrase
					</label>
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
						<span className="text-xs opacity-70">
							{testHit ??
								(testing ? 'Listening. Say the phrase.' : 'Say the phrase and watch it light up.')}
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
					{agents.length === 0 && <p className="text-xs opacity-70">No agents yet.</p>}
					{agents.map((agent) => {
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
									onChange={(event) =>
										void controls.setAgentPhrase(agent.sessionId, event.target.value)
									}
									className="flex-1 px-2 py-1 rounded border text-xs disabled:opacity-50"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textMain,
									}}
								/>
							</div>
						);
					})}
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
						const keys = shortcuts[id]?.keys ?? [];
						const status = statuses.find((entry) => entry.id === id);
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
							How long a press has to be before it counts as holding the key, and how long an
							untouched microphone stays open.
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

					<div className="flex items-center gap-3">
						<label className="text-xs opacity-70 w-28" htmlFor="acappella-idle-timeout">
							Idle timeout
						</label>
						<input
							id="acappella-idle-timeout"
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
						<span className="text-xs tabular-nums opacity-70">{controls.idleTimeoutSeconds}s</span>
					</div>
				</SectionCard>
			</div>
		</>
	);
}
