/**
 * DictationHost - the app-wide half of dictation. Mounted once in `AppShell`.
 *
 * Three jobs, none of which belongs to any one text box:
 *
 *   - **Readiness.** It asks the main process whether the `dictation` Local
 *     Models task would run, and mirrors the answer into `dictationStore`.
 *     Every `<DictationButton>` reads that mirror, so a dozen text boxes cost
 *     one IPC call. A web-desktop client is always `hidden`: the microphone is
 *     on the desktop, and the main process refuses it as `no-microphone`.
 *   - **The shortcut's press.** The keyboard handler reports the `dictate`
 *     chord going down; this classifies it as a tap (toggle) or a hold (record
 *     while held) against the focused text box. The release is ANY key coming
 *     up, or the window losing focus: macOS does not deliver a letter's keyup
 *     while Command is held, so waiting for the exact chord would leave the
 *     microphone open after the user let go.
 *   - **The indicator.** While a dictation is in flight a small pill says so,
 *     with Stop and Discard. A dictation started by the shortcut in a text box
 *     that has no button of its own would otherwise have nothing on screen
 *     showing that a microphone is recording, and no control to end it.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { Mic, X } from 'lucide-react';

import {
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
} from '../../shared/local-models/tasks';
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';
import type { LocalModelTaskReadiness } from '../../shared/local-models/task-readiness';
import { Z_LAYERS } from '../constants/zLayers';
import { useDictationPress } from '../hooks/dictation/useDictationPress';
import { useLocalModelTaskReadiness } from '../hooks/localModels';
import { useEventListener } from '../hooks/utils/useEventListener';
import {
	cancelDictation,
	DICTATION_SHORTCUT_PRESS_EVENT,
	focusedDictationTarget,
	setDictationAvailabilityRefresher,
	stopDictation,
} from '../services/dictation';
import { useDictationStore, type DictationAvailability } from '../stores/dictationStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useVoiceUiStore } from '../stores/voiceUiStore';
import type { Theme } from '../types';
import { isWebDesktop } from '../utils/runtimeContext';
import { Spinner } from './ui/Spinner';

/**
 * What a button may draw, from the main process's verdict. `off` and
 * `utility-agent` both mean nobody assigned dictation a speech model, so
 * nothing is offered.
 */
export function dictationAvailabilityFromReadiness(
	verdict: LocalModelTaskReadiness | undefined,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[],
	webDesktop: boolean
): DictationAvailability {
	if (webDesktop || !verdict) return { state: 'hidden' };
	if (verdict.state === 'ready') {
		return {
			state: 'ready',
			source: localModelAssignmentSourceLabel(verdict.assignment, endpoints),
		};
	}
	if (verdict.state === 'unavailable') {
		return {
			state: 'unavailable',
			reason: [verdict.detail, verdict.suggestedAction].filter(Boolean).join(' '),
		};
	}
	return { state: 'hidden' };
}

export function DictationHost({ theme }: { theme: Theme }) {
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);

	// Everything the verdict depends on that the renderer can see, so assigning
	// a source in Settings shows the microphone without a restart.
	const revision = useMemo(
		() => JSON.stringify([resolveLocalModelAssignment(assignments, 'dictation'), endpoints]),
		[assignments, endpoints]
	);
	const { readiness, refresh } = useLocalModelTaskReadiness(revision, 'dictation');
	const verdict = readiness.dictation;

	useEffect(() => {
		useDictationStore.setState({
			availability: dictationAvailabilityFromReadiness(verdict, endpoints, isWebDesktop()),
		});
	}, [verdict, endpoints]);

	useEffect(() => setDictationAvailabilityRefresher(() => void refresh()), [refresh]);

	// The hold threshold is the user's own number, kept with the voice controls.
	useEffect(() => {
		void useVoiceUiStore.getState().load();
	}, []);

	// The shortcut's press. Released by any keyup or by the window losing focus.
	const { beginPress, endPress } = useDictationPress(focusedDictationTarget);
	useEventListener(DICTATION_SHORTCUT_PRESS_EVENT, beginPress);
	useEventListener('keyup', endPress);
	useEventListener('blur', endPress);

	const phase = useDictationStore((s) => s.phase);
	const handleStop = useCallback(() => void stopDictation(), []);
	const handleDiscard = useCallback(() => void cancelDictation(), []);

	if (phase === 'idle') return null;

	const recording = phase === 'recording';
	const status =
		phase === 'transcribing'
			? 'Transcribing...'
			: phase === 'starting'
				? 'Opening the microphone...'
				: 'Dictating';

	return (
		<div
			data-testid="dictation-indicator"
			data-dictation-phase={phase}
			role="status"
			className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-full border shadow-lg text-xs select-none"
			style={{
				zIndex: Z_LAYERS.DICTATION_INDICATOR,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: recording ? theme.colors.accent : theme.colors.border,
				color: theme.colors.textMain,
			}}
		>
			{phase === 'transcribing' ? (
				<Spinner size={14} ariaLabel="Transcribing" />
			) : (
				<Mic
					className={`w-3.5 h-3.5 ${recording ? 'animate-pulse' : 'opacity-60'}`}
					style={{ color: theme.colors.accent }}
					aria-hidden="true"
				/>
			)}
			<span>{status}</span>
			{recording && (
				<button
					type="button"
					data-testid="dictation-indicator-stop"
					// Keep the caret in the text box the words are about to land in.
					onMouseDown={(event) => event.preventDefault()}
					onClick={handleStop}
					className="px-2 py-0.5 rounded-full text-xs font-medium hover:opacity-90 focus:outline-none focus-visible:ring-2"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					Stop
				</button>
			)}
			<button
				type="button"
				data-testid="dictation-indicator-discard"
				onMouseDown={(event) => event.preventDefault()}
				onClick={handleDiscard}
				title="Discard this dictation"
				aria-label="Discard this dictation"
				className="p-1 rounded-full opacity-60 hover:opacity-100 hover:bg-white/10 focus:outline-none focus-visible:ring-2"
			>
				<X className="w-3.5 h-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}

export default DictationHost;
