/**
 * The last turn's latency, hop by hop.
 *
 * "Voice feels slow" is unanswerable without this. The same sentence covers a
 * cold whisper decode, a hosted Brain retrying a 429, a local model reloading
 * after an idle unload, and a TTS provider that will not start speaking until it
 * has synthesised the whole reply - four different problems with four different
 * fixes and one symptom. This card names the hop.
 *
 * It is a developer-visible panel rather than a user-facing one: it appears on
 * the Models page beside the self-test, which is where somebody already goes to
 * gather evidence for a bug report.
 */

import { useCallback, useState } from 'react';
import { Timer } from 'lucide-react';

import type { TurnBreakdown } from '../../../../main/acappella/telemetry/turn-metrics';
import type { Theme } from '../../../types';
import { flashCopiedToClipboard } from '../../../utils/flashCopiedToClipboard';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';

export interface VoiceLatencyCardProps {
	theme: Theme;
}

export function VoiceLatencyCard({ theme }: VoiceLatencyCardProps) {
	const [breakdown, setBreakdown] = useState<TurnBreakdown | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(async () => {
		setMessage(null);
		try {
			const result = await window.maestro.voice.lastTurn();
			setBreakdown(result);
			// Null is the ordinary answer before anything has been said, so it is
			// stated rather than rendered as an empty panel that looks broken.
			if (!result) setMessage('No turn has completed yet. Speak once, then read this again.');
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	}, []);

	const copy = useCallback(() => {
		if (!breakdown) return;
		void navigator.clipboard.writeText(JSON.stringify(breakdown, null, 2));
		flashCopiedToClipboard('Voice turn timings');
	}, [breakdown]);

	return (
		<div data-setting-id="encore-a-cappella-turn-latency">
			<SettingsSectionHeading icon={Timer}>Turn latency</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<p className="text-xs opacity-70">
					Where the last spoken turn spent its time, measured from the moment the detector heard you
					stop talking. Include this when reporting that voice feels slow.
				</p>

				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						data-setting-id="encore-a-cappella-read-turn-latency"
						onClick={() => void load()}
						className="px-2 py-1 rounded border text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Read last turn
					</button>
					{breakdown && (
						<button
							type="button"
							onClick={copy}
							className="px-2 py-1 rounded border text-xs"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							Copy timings
						</button>
					)}
				</div>

				{message && <p className="text-xs opacity-70 select-text">{message}</p>}

				{breakdown && (
					<div className="space-y-1 select-text">
						<div className="text-[11px] opacity-70">
							{breakdown.configuration.pipeline}: {breakdown.configuration.providerIds.stt} /{' '}
							{breakdown.configuration.providerIds.brain} /{' '}
							{breakdown.configuration.providerIds.tts}
						</div>
						{breakdown.deltas.map((delta) => (
							<div key={delta.span} className="text-[11px] flex justify-between gap-3">
								<span>{delta.label}</span>
								<span className="tabular-nums opacity-70">{delta.formatted}</span>
							</div>
						))}
					</div>
				)}
			</SectionCard>
		</div>
	);
}
