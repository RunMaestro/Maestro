/**
 * Computer History config BODY (extension detail pane, Settings sub-tab).
 *
 * Every control here calls `window.maestro.computerHistory.*`, which reaches
 * the one main-process ComputerHistoryService; each has a matching
 * `maestro-cli computer-history` verb on the same service (CLI-UI-PARITY.md).
 * Settings live in the store's own `config.json`, not in the settings store,
 * so nothing here goes through settingsMetadata / settingsStore.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	AlertTriangle,
	Archive,
	Ban,
	Eye,
	ScrollText,
	Shield,
	Trash2,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';
import { CaptureRulesEditor } from '../../../../ComputerHistory/CaptureRulesEditor';
import { useComputerHistoryStatus } from '../../../../../hooks/computerHistory/useComputerHistoryStatus';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { useModalStore } from '../../../../../stores/modalStore';
import { notifyToast } from '../../../../../stores/notificationStore';
import { formatSize } from '../../../../../../shared/formatters';
import { GIB } from '../../../../../../shared/computer-history/config';
import type { RecorderState } from '../../../../../../shared/computer-history/status';
import type { ComputerHistoryConfig } from '../../../../../../shared/computer-history/types';

interface ComputerHistorySectionProps {
	theme: Theme;
}

const STATE_LABELS: Record<RecorderState, string> = {
	off: 'Off',
	recording: 'Recording',
	paused: 'Paused',
	blocked: 'Waiting for permission',
	starting: 'Starting',
	'binary-missing': 'Recorder not installed',
	restarting: 'Restarting',
	failed: 'Recorder stopped after repeated crashes',
};

const HOUR_MS = 60 * 60_000;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function ActionButton({
	theme,
	icon: Icon,
	label,
	onClick,
	destructive,
	disabled,
}: {
	theme: Theme;
	icon?: LucideIcon;
	label: string;
	onClick: () => void;
	destructive?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border disabled:opacity-50"
			style={{
				borderColor: destructive ? theme.colors.error : theme.colors.border,
				color: destructive ? theme.colors.error : theme.colors.textMain,
				backgroundColor: theme.colors.bgActivity,
			}}
		>
			{Icon && <Icon className="w-3.5 h-3.5" />}
			{label}
		</button>
	);
}

export function ComputerHistorySection({ theme }: ComputerHistorySectionProps) {
	const { enabled, status, refresh } = useComputerHistoryStatus();
	const [config, setConfig] = useState<ComputerHistoryConfig | null>(null);
	const [retentionDraft, setRetentionDraft] = useState('');
	const [maxGbDraft, setMaxGbDraft] = useState('');
	const sessions = useSessionStore((s) => s.sessions);
	const digestAgents = useMemo(
		() =>
			sessions.filter((s) => s.toolType !== 'terminal').map((s) => ({ id: s.id, name: s.name })),
		[sessions]
	);
	const api = window.maestro?.computerHistory;

	const applyConfig = useCallback((next: ComputerHistoryConfig) => {
		setConfig(next);
		setRetentionDraft(String(next.retentionDays));
		setMaxGbDraft(String(Math.round((next.maxBytes / GIB) * 10) / 10));
	}, []);

	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		api
			.getConfig()
			.then((cfg) => {
				if (!cancelled) applyConfig(cfg);
			})
			.catch(() => {
				// Not available (web bridge): the body renders its read-only notice.
			});
		return () => {
			cancelled = true;
		};
	}, [api, applyConfig, enabled]);

	const run = useCallback(
		async <T,>(action: () => Promise<T>, failureTitle: string): Promise<T | null> => {
			try {
				return await action();
			} catch (err) {
				notifyToast({ color: 'red', title: failureTitle, message: errorText(err) });
				return null;
			}
		},
		[]
	);

	if (!api) {
		return (
			<div data-setting-id="encore-computer-history" className="text-xs opacity-70">
				Computer History can only be managed from the Maestro desktop app.
			</div>
		);
	}

	const paused = status?.state === 'paused';
	const helper = status?.helperStatus ?? null;
	const platform = status?.platform;

	const saveConfig = async (patch: Parameters<typeof api.setConfig>[0]) => {
		const next = await run(() => api.setConfig(patch), 'Could not save Computer History settings');
		if (next) applyConfig(next);
	};

	const requestAccessibility = async () => {
		const result = await run(() => api.requestAccessibility(), 'Accessibility request failed');
		if (!result) return;
		if (result.detail) {
			notifyToast({ color: 'theme', title: 'Computer History', message: result.detail });
		}
		refresh();
	};

	const confirmLinuxAccessibility = () => {
		useModalStore.getState().openModal('confirm', {
			title: 'Turn on accessibility',
			message:
				'Computer History reads apps through the desktop accessibility bus, which is off on this session. Turning it on sets the same switch as the accessibility toggle in your desktop settings (org.a11y.Status.IsEnabled). Apps opened afterwards expose their text to accessibility tools, including screen readers and this recorder. Browsers and Electron apps that are already open need a restart. You can turn it off again in your desktop accessibility settings.',
			onConfirm: () => void requestAccessibility(),
		});
	};

	const confirmClear = (all: boolean) => {
		useModalStore.getState().openModal('confirm', {
			title: all ? 'Clear all Computer History' : 'Clear the last hour',
			message: all
				? 'Delete everything Computer History has recorded? Settings and rules stay. This cannot be undone.'
				: 'Delete everything recorded in the last hour? This cannot be undone.',
			destructive: true,
			onConfirm: () => {
				void run(
					() => api.clear(all ? { all: true } : { sinceMs: Date.now() - HOUR_MS }),
					'Could not clear Computer History'
				).then((result) => {
					if (!result) return;
					notifyToast({
						color: 'green',
						title: 'Computer History cleared',
						message: `Deleted ${result.deletedSegments} segment(s), ${formatSize(result.freedBytes)}.`,
					});
					refresh();
				});
			},
		});
	};

	const inputStyle = {
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.bgActivity,
		color: theme.colors.textMain,
	};

	const needsMacPermission = platform === 'macos' && helper?.permission === 'denied';
	const needsLinuxBus =
		platform === 'linux' &&
		(helper?.accessibilityBus === 'disabled' || helper?.state === 'blocked');

	return (
		<div data-setting-id="encore-computer-history" className="space-y-5">
			<div>
				<SettingsSectionHeading
					icon={Eye}
					description="Records the app in front: window titles, visible text, selections, and what you type into fields once you stop typing. Never keystrokes, password fields, or screenshots. Everything stays on this computer."
				>
					Recorder
				</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<div>
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							{enabled ? STATE_LABELS[status?.state ?? 'starting'] : 'Off'}
						</div>
						<p className="text-xs opacity-70 mt-0.5">
							{enabled
								? `${status?.eventsStored ?? 0} events recorded this session. Stored in ${status?.storeDir ?? 'the Maestro data folder'}.`
								: 'Turn Computer History on from the tile header to start recording.'}
						</p>
						{status?.pausedUntil && (
							<p className="text-xs opacity-70 mt-0.5">
								{status.pausedUntil === 'forever'
									? 'Paused until you resume.'
									: `Paused until ${new Date(status.pausedUntil).toLocaleString()}.`}
							</p>
						)}
					</div>
					{status?.state === 'binary-missing' && (
						<div
							className="flex items-start gap-1.5 text-xs"
							style={{ color: theme.colors.warning }}
						>
							<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
							<span>
								The maestro-observer helper is not installed for this platform. Builds from source
								need the Rust toolchain; see the Computer History docs.
							</span>
						</div>
					)}
					{enabled && (
						<div className="flex flex-wrap gap-2">
							{paused ? (
								<ActionButton
									theme={theme}
									label="Resume"
									onClick={() => void run(() => api.resume(), 'Could not resume')}
								/>
							) : (
								<>
									<ActionButton
										theme={theme}
										label="Pause 1 hour"
										onClick={() => void run(() => api.pause(HOUR_MS), 'Could not pause')}
									/>
									<ActionButton
										theme={theme}
										label="Pause until resumed"
										onClick={() => void run(() => api.pause(null), 'Could not pause')}
									/>
								</>
							)}
						</div>
					)}
				</SectionCard>
			</div>

			<div>
				<SettingsSectionHeading icon={Shield}>Permission</SettingsSectionHeading>
				<SectionCard theme={theme}>
					{platform === 'windows' && (
						<p className="text-xs opacity-70">
							Windows needs no permission. Windows of apps running as administrator cannot be read
							and are recorded as app and title only.
						</p>
					)}
					{platform === 'macos' && (
						<div className="space-y-2">
							<p className="text-xs opacity-70">
								{helper?.permission === 'granted'
									? 'Accessibility access is granted.'
									: 'macOS needs Accessibility access for Maestro (System Settings > Privacy & Security > Accessibility). Development and signed builds each need their own grant.'}
							</p>
							{(needsMacPermission || !helper) && enabled && (
								<ActionButton
									theme={theme}
									label="Request Accessibility access"
									onClick={() => void requestAccessibility()}
								/>
							)}
						</div>
					)}
					{platform === 'linux' && (
						<div className="space-y-2">
							<p className="text-xs opacity-70">
								{helper?.accessibilityBus === 'enabled'
									? 'The desktop accessibility bus is on. Apps started before it was turned on may expose only window titles until restarted.'
									: 'Computer History needs the desktop accessibility bus. Chromium and Electron apps also need a restart after it is turned on.'}
							</p>
							{needsLinuxBus && enabled && (
								<ActionButton
									theme={theme}
									label="Turn on accessibility"
									onClick={confirmLinuxAccessibility}
								/>
							)}
						</div>
					)}
					{!platform && (
						<p className="text-xs opacity-70">Turn the feature on to check permission.</p>
					)}
				</SectionCard>
			</div>

			{config && (
				<div>
					<SettingsSectionHeading
						icon={Archive}
						description="The oldest history is deleted first when either limit is reached."
					>
						Storage
					</SettingsSectionHeading>
					<SectionCard theme={theme}>
						<div className="grid grid-cols-2 gap-3">
							<label className="block">
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Keep days
								</div>
								<input
									type="number"
									min={1}
									value={retentionDraft}
									onChange={(e) => setRetentionDraft(e.target.value)}
									onBlur={() => {
										const n = Number(retentionDraft);
										if (Number.isFinite(n) && n >= 1 && n !== config.retentionDays) {
											void saveConfig({ retentionDays: n });
										} else setRetentionDraft(String(config.retentionDays));
									}}
									className="mt-1 w-full px-2 py-1 rounded border text-sm outline-none"
									style={inputStyle}
								/>
							</label>
							<label className="block">
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Max size (GB)
								</div>
								<input
									type="number"
									min={0.1}
									step={0.5}
									value={maxGbDraft}
									onChange={(e) => setMaxGbDraft(e.target.value)}
									onBlur={() => {
										const n = Number(maxGbDraft);
										const bytes = Math.round(n * GIB);
										if (Number.isFinite(n) && n > 0 && bytes !== config.maxBytes) {
											void saveConfig({ maxBytes: bytes });
										} else setMaxGbDraft(String(Math.round((config.maxBytes / GIB) * 10) / 10));
									}}
									className="mt-1 w-full px-2 py-1 rounded border text-sm outline-none"
									style={inputStyle}
								/>
							</label>
						</div>
						<ToggleSettingRow
							theme={theme}
							title="Record visible window text"
							description="Snapshots of the text on screen make recall much better and use the most space."
							checked={config.snapshots}
							onChange={(checked) => void saveConfig({ snapshots: checked })}
							clickableRow
							borderTop
						/>
					</SectionCard>
				</div>
			)}

			{config && (
				<div>
					<SettingsSectionHeading
						icon={Ban}
						description="Record every app except the ones you switch off, or only the apps you switch on. Same rules as maestro-cli computer-history rules."
					>
						Apps and domains
					</SettingsSectionHeading>
					<SectionCard theme={theme}>
						<CaptureRulesEditor theme={theme} onConfigChange={applyConfig} />
					</SectionCard>
				</div>
			)}

			{config && (
				<div>
					<SettingsSectionHeading
						icon={ScrollText}
						description="An agent of your choice summarizes each 15-minute window into a markdown digest next to the history, and can roll each 6-hour block up into one summary. Off by default."
					>
						Digests
					</SettingsSectionHeading>
					<SectionCard theme={theme}>
						<ToggleSettingRow
							theme={theme}
							title="Write digests"
							description={
								config.digests.enabled
									? 'A 15-minute digest is requested from the chosen agent after each window with activity closes.'
									: 'No digests are written.'
							}
							checked={config.digests.enabled}
							onChange={(checked) => void saveConfig({ digests: { enabled: checked } })}
							clickableRow
						/>
						<label className="block">
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Digest agent
							</div>
							<select
								value={config.digests.agentId ?? ''}
								onChange={(e) => void saveConfig({ digests: { agentId: e.target.value || null } })}
								className="mt-1 w-full px-2 py-1 rounded border text-sm outline-none"
								style={inputStyle}
							>
								<option value="">Choose an agent</option>
								{digestAgents.map((a) => (
									<option key={a.id} value={a.id}>
										{a.name}
									</option>
								))}
							</select>
						</label>
						<ToggleSettingRow
							theme={theme}
							title="6-hour roll-up"
							description={
								config.digests.rollup
									? 'At 00:00, 06:00, 12:00, and 18:00 UTC the same agent summarizes the block from its 15-minute digests.'
									: 'Only 15-minute digests are written.'
							}
							checked={config.digests.rollup}
							onChange={(checked) => void saveConfig({ digests: { rollup: checked } })}
							disabled={!config.digests.enabled}
							clickableRow
							borderTop
						/>
						{config.digests.enabled && status?.digests && (
							<p className="text-xs-plus opacity-55">
								{`Last 15-minute digest: ${status.digests.last15mAt ? new Date(status.digests.last15mAt).toLocaleString() : 'none yet'}. Last roll-up: ${status.digests.lastRollupAt ? new Date(status.digests.lastRollupAt).toLocaleString() : 'none yet'}.`}
								{status.digests.lastError ? ` Last error: ${status.digests.lastError}` : ''}
							</p>
						)}
					</SectionCard>
				</div>
			)}

			<div>
				<SettingsSectionHeading icon={Trash2}>Clear history</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<div className="flex flex-wrap gap-2">
						<ActionButton
							theme={theme}
							label="Clear the last hour"
							destructive
							onClick={() => confirmClear(false)}
						/>
						<ActionButton
							theme={theme}
							label="Clear all history"
							destructive
							onClick={() => confirmClear(true)}
						/>
					</div>
				</SectionCard>
			</div>
		</div>
	);
}
