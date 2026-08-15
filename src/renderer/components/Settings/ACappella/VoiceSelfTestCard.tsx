/**
 * "Run voice self-test" - the button that turns "voice does not work" into
 * something actionable.
 *
 * A voice failure has several independent causes that look identical from the
 * outside: a denied microphone, a native runtime that will not load in this
 * build, a model that is not downloaded, or the feature simply being off. This
 * card runs the main-process self-test and shows the per-runtime verdict with
 * timings, so the user pastes a result instead of describing a symptom.
 *
 * It loads no model and opens no device, so pressing it is free and safe at any
 * time, including on a machine where nothing has been downloaded yet.
 */

import { useCallback, useState } from 'react';
import { Stethoscope } from 'lucide-react';

import type { RuntimeSelfTestReport } from '../../../../main/acappella/runtime/runtime-selftest';
import type { Theme } from '../../../types';
import { flashCopiedToClipboard } from '../../../utils/flashCopiedToClipboard';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';

export interface VoiceSelfTestCardProps {
	theme: Theme;
}

/** Plain-language microphone states. `not-determined` is not a refusal. */
const MIC_LABELS: Record<string, string> = {
	granted: 'granted',
	denied: 'denied',
	restricted: 'blocked by a system policy',
	'not-determined': 'not asked yet (you will be asked when a session starts)',
	unknown: 'unknown on this platform until a session starts',
};

export function VoiceSelfTestCard({ theme }: VoiceSelfTestCardProps) {
	const [running, setRunning] = useState(false);
	const [report, setReport] = useState<RuntimeSelfTestReport | null>(null);
	const [error, setError] = useState<string | null>(null);

	const run = useCallback(async () => {
		setRunning(true);
		setError(null);
		try {
			const response = await window.maestro.debug.voiceSelfTest();
			// Two different failures: the self-test could not run, or it ran and
			// found something. Collapsing them would report a broken diagnostic as a
			// broken runtime.
			if (!response.success || !response.report) {
				setError(response.error ?? 'The self-test could not run.');
				setReport(null);
				return;
			}
			setReport(response.report);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRunning(false);
		}
	}, []);

	const copy = useCallback(() => {
		if (!report) return;
		void navigator.clipboard.writeText(JSON.stringify(report, null, 2));
		flashCopiedToClipboard('Voice self-test result');
	}, [report]);

	const statusColor = (status: string): string => {
		if (status === 'pass') return theme.colors.success;
		if (status === 'fail') return theme.colors.error;
		return theme.colors.textMain;
	};

	return (
		<div data-setting-id="encore-a-cappella-self-test">
			<SettingsSectionHeading icon={Stethoscope}>Voice self-test</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<p className="text-xs opacity-70">
					Loads each speech runtime and runs a trivial operation against it. No model is loaded and
					no microphone is opened, so this is safe to run at any time. Include the result when
					reporting a voice problem.
				</p>

				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						data-setting-id="encore-a-cappella-run-self-test"
						disabled={running}
						onClick={() => void run()}
						className="px-2 py-1 rounded border text-xs"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							opacity: running ? 0.6 : 1,
						}}
					>
						{running ? 'Running self-test...' : 'Run voice self-test'}
					</button>
					{report && (
						<button
							type="button"
							onClick={copy}
							className="px-2 py-1 rounded border text-xs"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							Copy result
						</button>
					)}
				</div>

				{error && (
					<p className="text-xs select-text" style={{ color: theme.colors.error }}>
						{error}
					</p>
				)}

				{report && (
					<div className="space-y-1 select-text">
						<div
							className="text-xs"
							style={{ color: statusColor(report.passed ? 'pass' : 'fail') }}
						>
							{report.passed ? 'All runtimes responded' : 'One or more runtimes failed'} on{' '}
							{report.platform}-{report.arch}
						</div>
						{report.entries.map((entry) => (
							<div key={entry.runtimeId} className="text-[11px] flex flex-wrap gap-1">
								<span style={{ color: statusColor(entry.status) }}>
									{entry.status.toUpperCase()}
								</span>
								<span>{entry.label}</span>
								<span className="opacity-55">
									{entry.moduleId} - {entry.durationMs} ms
								</span>
								{entry.detail && <span className="opacity-70">{entry.detail}</span>}
							</div>
						))}
						<div className="text-[11px] opacity-70">
							Microphone: {MIC_LABELS[report.microphone.permission] ?? report.microphone.permission}
						</div>
					</div>
				)}
			</SectionCard>
		</div>
	);
}
