/**
 * Voice diagnostics - what the pipeline did, when it appeared to do nothing.
 *
 * Built for one question, asked in this order, because that is the order the
 * stages fail in and each answer makes the next one meaningful:
 *
 *   1. Is a microphone open, and is it producing signal? (frames, peak level)
 *   2. Does the recogniser hear audio at all, and does it transcribe WORDS?
 *      (a mic check hears but reports a measurement)
 *   3. What did the event stream actually say?
 *
 * The log is recorded continuously by `voiceDiagnosticsStore`, not while this
 * panel is open, because you find the problem by speaking and cannot read a
 * settings panel at the same time.
 */

import { useMemo, useState } from 'react';
import { Stethoscope } from 'lucide-react';
import type { Theme } from '../../../types';
import { flashCopiedToClipboard } from '../../../utils/flashCopiedToClipboard';
import {
	useVoiceDiagnosticsStore,
	type VoiceDiagnosticEntry,
} from '../../../stores/voiceDiagnosticsStore';
import { useVoiceSessionStore } from '../../../stores/voiceSessionStore';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';

export interface VoiceDiagnosticsCardProps {
	theme: Theme;
}

/** `14:22:31.412` - relative order and sub-second gaps are what matter here. */
function clock(ts: number): string {
	const date = new Date(ts);
	const time = date.toTimeString().slice(0, 8);
	return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function line(entry: VoiceDiagnosticEntry): string {
	return `${clock(entry.ts)}  ${entry.type.padEnd(18)} ${entry.detail}`;
}

export function VoiceDiagnosticsCard({ theme }: VoiceDiagnosticsCardProps) {
	const entries = useVoiceDiagnosticsStore((s) => s.entries);
	const audioLevelCount = useVoiceDiagnosticsStore((s) => s.audioLevelCount);
	const audioLevelPeak = useVoiceDiagnosticsStore((s) => s.audioLevelPeak);
	const speechFrames = useVoiceDiagnosticsStore((s) => s.speechFrames);
	const clear = useVoiceDiagnosticsStore((s) => s.clear);

	const state = useVoiceSessionStore((s) => s.state);
	const providerIds = useVoiceSessionStore((s) => s.providerIds);
	const sttHearsAudio = useVoiceSessionStore((s) => s.sttHearsAudio);
	const mic = useVoiceSessionStore((s) => s.mic);

	const [expanded, setExpanded] = useState(false);

	/**
	 * The whole picture as one block of text.
	 *
	 * A copy button rather than a screenshot: the timings and the exact provider
	 * ids are the diagnostic content, and both are what a screenshot loses.
	 */
	const report = useMemo(() => {
		const header = [
			`state: ${state}`,
			`stt: ${providerIds?.stt ?? 'none'}${sttHearsAudio === false ? ' (does not hear audio)' : ''}`,
			`tts: ${providerIds?.tts ?? 'none'}`,
			`brain: ${providerIds?.brain ?? 'none'}`,
			`mic: capturing=${mic?.capturing ?? 'unknown'} issue=${mic?.issue ?? 'none'}`,
			`device: ${mic?.deviceLabel || mic?.deviceId || 'unknown'}`,
			`audio frames: ${audioLevelCount} (peak ${audioLevelPeak.toFixed(3)}, speech ${speechFrames})`,
		].join('\n');
		return `${header}\n\n${entries.map(line).join('\n')}`;
	}, [
		state,
		providerIds,
		sttHearsAudio,
		mic,
		audioLevelCount,
		audioLevelPeak,
		speechFrames,
		entries,
	]);

	const handleCopy = () => {
		void navigator.clipboard.writeText(report);
		flashCopiedToClipboard('Voice diagnostics');
	};

	// Signal but no speech is a real, distinct answer: the device works and the
	// detector is not classifying any of it as voice, which is a threshold or a
	// very quiet input rather than a broken microphone.
	const audioSummary =
		audioLevelCount === 0
			? 'No audio frames yet. Start a session and speak.'
			: `${audioLevelCount} frames, peak ${audioLevelPeak.toFixed(3)}, ${speechFrames} classified as speech`;

	const visible = expanded ? entries : entries.slice(-12);

	return (
		<div data-setting-id="encore-a-cappella-diagnostics">
			<SettingsSectionHeading icon={Stethoscope}>Voice diagnostics</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<p className="text-xs opacity-70">
					A rolling record of the voice pipeline, kept whether or not this panel is open. Speak
					first, then come back and read it.
				</p>

				<dl className="text-xs space-y-1 font-mono">
					<Row theme={theme} label="Session" value={state} />
					<Row
						theme={theme}
						label="Speech-to-Text"
						value={`${providerIds?.stt ?? 'none'}${
							sttHearsAudio === false ? ' - does not listen to the microphone' : ''
						}`}
						warn={sttHearsAudio === false}
					/>
					<Row
						theme={theme}
						label="Microphone"
						value={
							mic
								? `${mic.capturing ? 'capturing' : 'not capturing'}${
										mic.issue ? ` (${mic.issue})` : ''
									}${mic.deviceLabel ? ` - ${mic.deviceLabel}` : ''}`
								: 'no report yet'
						}
						warn={mic ? !mic.capturing || !!mic.issue : false}
					/>
					<Row
						theme={theme}
						label="Audio"
						value={audioSummary}
						warn={audioLevelCount > 0 && speechFrames === 0}
					/>
				</dl>

				{entries.length > 0 && (
					<pre
						data-testid="voice-diagnostics-log"
						className="text-[10px] leading-relaxed overflow-auto max-h-64 rounded border p-2 select-text"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						{visible.map(line).join('\n')}
					</pre>
				)}

				<div className="flex flex-wrap items-center gap-2">
					<button
						type="button"
						data-setting-id="encore-a-cappella-copy-diagnostics"
						onClick={handleCopy}
						disabled={entries.length === 0 && audioLevelCount === 0}
						className="px-3 py-1.5 rounded border text-xs font-medium disabled:opacity-55"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Copy diagnostics
					</button>
					{entries.length > 12 && (
						<button
							type="button"
							onClick={() => setExpanded((prev) => !prev)}
							className="px-3 py-1.5 rounded border text-xs disabled:opacity-55"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						>
							{expanded ? 'Show recent only' : `Show all ${entries.length}`}
						</button>
					)}
					<button
						type="button"
						onClick={clear}
						disabled={entries.length === 0 && audioLevelCount === 0}
						className="px-3 py-1.5 rounded border text-xs disabled:opacity-55"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						Clear
					</button>
				</div>
			</SectionCard>
		</div>
	);
}

/** One labelled fact. `warn` colours the value, never the label. */
function Row({
	theme,
	label,
	value,
	warn = false,
}: {
	theme: Theme;
	label: string;
	value: string;
	warn?: boolean;
}) {
	return (
		<div className="flex gap-2">
			<dt className="opacity-60 shrink-0 w-32">{label}</dt>
			<dd
				className="select-text"
				style={{ color: warn ? theme.colors.warning : theme.colors.textMain }}
			>
				{value}
			</dd>
		</div>
	);
}
