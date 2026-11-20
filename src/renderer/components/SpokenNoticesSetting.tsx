/**
 * The "Speak when an agent finishes" setting, in Settings > Notifications.
 *
 * Self-sourced: it reads and writes the `spokenNotices` setting itself, so the
 * Notifications panel does not thread it through as two more props.
 *
 * Three things on screen: the mode (off by default), a Test button that speaks
 * a sample line through the same path a real notice takes, and one line saying
 * what a notice will SAY, which depends on the Spoken notices task in
 * Settings > Models: a summary when a model is assigned and ready, the
 * plain "<agent name> finished" otherwise.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Megaphone } from 'lucide-react';

import {
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
} from '../../shared/local-models/tasks';
import {
	SPOKEN_NOTICE_MODES,
	SPOKEN_NOTICE_MODE_LABELS,
	fallbackNoticeLine,
} from '../../shared/spokenNotices';
import { useLocalModelTaskReadiness } from '../hooks/localModels';
import { speakTestNotice } from '../services/spokenNotices';
import { useSettingsStore } from '../stores/settingsStore';
import type { Theme } from '../types';
import { ToggleButtonGroup } from './ToggleButtonGroup';
import { Spinner } from './ui/Spinner';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';

const TASK_ID = 'spoken-notices';

/**
 * What a notice says when no model writes a summary. Built from the real line
 * so the two cannot drift; the placeholder is swapped in afterwards because the
 * line strips markup, angle brackets included.
 */
const PLAIN_LINE = `"${fallbackNoticeLine('AGENT').replace('AGENT', '<agent name>')}"`;

const MODE_OPTIONS = SPOKEN_NOTICE_MODES.map((mode) => ({
	value: mode,
	label: SPOKEN_NOTICE_MODE_LABELS[mode],
}));

interface SpokenNoticesSettingProps {
	theme: Theme;
}

export function SpokenNoticesSetting({ theme }: SpokenNoticesSettingProps) {
	const mode = useSettingsStore((s) => s.spokenNotices);
	const setMode = useSettingsStore((s) => s.setSpokenNotices);
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);

	// Everything the verdict depends on that the renderer can see, so a model
	// assigned while Settings is open is picked up without reopening it.
	const revision = useMemo(
		() => JSON.stringify([resolveLocalModelAssignment(assignments, TASK_ID), endpoints]),
		[assignments, endpoints]
	);
	const { readiness } = useLocalModelTaskReadiness(revision, TASK_ID);
	const verdict = readiness[TASK_ID];

	const [testing, setTesting] = useState(false);
	const [testError, setTestError] = useState<string | null>(null);

	const runTest = async () => {
		setTesting(true);
		setTestError(null);
		try {
			const result = await speakTestNotice();
			if (!result.spoken) setTestError(result.message);
		} catch (error) {
			setTestError(error instanceof Error ? error.message : String(error));
		} finally {
			setTesting(false);
		}
	};

	return (
		<div data-setting-id="notifications-spoken">
			<label className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<Megaphone className="w-3 h-3" />
				Speak When an Agent Finishes
			</label>
			<div className="flex gap-2">
				<div className="flex-1 min-w-0">
					<ToggleButtonGroup options={MODE_OPTIONS} value={mode} onChange={setMode} theme={theme} />
				</div>
				<button
					onClick={() => void runTest()}
					disabled={testing}
					className="px-3 py-2 rounded text-xs font-medium transition-all flex items-center gap-1.5 min-w-[70px] justify-center"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
						opacity: testing ? 0.7 : 1,
					}}
					data-testid="spoken-notices-test"
				>
					{testing ? (
						<>
							<Spinner size={12} />
							Speaking
						</>
					) : (
						'Test'
					)}
				</button>
			</div>
			{testError && (
				<p
					className="text-xs mt-2 px-2 py-1 rounded select-text"
					style={{ color: theme.colors.error, backgroundColor: theme.colors.error + '10' }}
					data-testid="spoken-notices-test-error"
				>
					{testError}
				</p>
			)}
			<p className="text-xs opacity-50 mt-2">
				Says one line aloud when an agent finishes a turn, on the computer running Maestro, with a
				local voice. Notices never overlap, and nothing is spoken while a voice session is live.
			</p>

			{mode !== 'off' && verdict && verdict.state === 'ready' && (
				<div
					className="flex items-start gap-1.5 text-xs mt-2"
					style={{ color: theme.colors.textDim }}
					data-testid="spoken-notices-ready"
				>
					<Check className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
					<span>
						The line adds a short summary written by{' '}
						{localModelAssignmentSourceLabel(verdict.assignment, endpoints) ??
							'the assigned source'}
						.
					</span>
				</div>
			)}

			{mode !== 'off' && verdict && verdict.state === 'off' && (
				<p
					className="text-xs mt-2"
					style={{ color: theme.colors.textDim }}
					data-testid="spoken-notices-plain"
				>
					The line is {PLAIN_LINE}. To add a short summary of what the agent did, assign a model to
					Spoken notices in {taskAssignmentLocation('spoken-notices')}.
				</p>
			)}

			{mode !== 'off' && verdict && verdict.state === 'unavailable' && (
				<div
					className="flex items-start gap-1.5 text-xs mt-2 select-text"
					style={{ color: theme.colors.warning }}
					data-testid="spoken-notices-not-ready"
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
					<span>
						{[verdict.detail, verdict.suggestedAction].filter(Boolean).join(' ')} Until then the
						line is {PLAIN_LINE}.
					</span>
				</div>
			)}
		</div>
	);
}
