/**
 * MaestroRun config BODY (extension detail pane, Settings sub-tab).
 *
 * A three-step setup: install the launcher, grant it Full Disk Access, and
 * only then are agents told about it. Every control calls
 * `window.maestro.maestroRun.*`, which reaches the one main-process
 * MaestroRunService; each has a matching `maestro-cli maestro-run` verb on the
 * same service (CLI-UI-PARITY.md). There are no settings of its own, so
 * nothing here goes through settingsMetadata / settingsStore.
 */

import { useCallback, useState } from 'react';
import {
	AlertTriangle,
	CheckCircle2,
	Circle,
	Download,
	FolderOpen,
	HardDrive,
	Loader2,
	RefreshCw,
	ShieldCheck,
} from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ActionButton } from './ActionButton';
import { useMaestroRunStatus } from '../../../../../hooks/maestroRun/useMaestroRunStatus';
import { notifyToast } from '../../../../../stores/notificationStore';
import { fileManagerName } from '../../../../../utils/platformUtils';
import type { MaestroRunStatus } from '../../../../../../shared/maestro-run/status';

interface MaestroRunSectionProps {
	theme: Theme;
}

/** The message a rejected IPC call should show, without Electron's wrapper. */
function errorText(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	// A main-process throw arrives as
	// "Error invoking remote method 'maestroRun:install': Error: <message>".
	return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function StepHeader({
	theme,
	done,
	title,
	summary,
}: {
	theme: Theme;
	done: boolean;
	title: string;
	summary: string;
}) {
	const Icon = done ? CheckCircle2 : Circle;
	return (
		<div className="flex items-start gap-2">
			<Icon
				className="w-4 h-4 flex-shrink-0 mt-0.5"
				style={{ color: done ? theme.colors.success : theme.colors.textDim }}
			/>
			<div className="min-w-0">
				<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{title}
				</div>
				<p className="text-xs opacity-70 mt-0.5">{summary}</p>
			</div>
		</div>
	);
}

function installSummary(status: MaestroRunStatus | null): string {
	if (!status) return 'Checking this Mac for MaestroRun.';
	if (status.phase === 'not-installed') {
		return 'Maestro downloads the build for this Mac from GitHub, then verifies its checksum, signature, and notarization before anything from it runs.';
	}
	if (status.phase === 'invalid') {
		return 'A MaestroRun.app is here, but it is not signed by MaestroRun. Maestro will not run it.';
	}
	const version = status.installedVersion ? ` ${status.installedVersion}` : '';
	return status.updateAvailable
		? `MaestroRun${version} is installed. Version ${status.latestVersion} is available.`
		: `MaestroRun${version} is installed and its signature is verified.`;
}

export function MaestroRunSection({ theme }: MaestroRunSectionProps) {
	const { enabled, status } = useMaestroRunStatus();
	const [busy, setBusy] = useState<'install' | 'access' | 'check' | null>(null);
	const api = window.maestro?.maestroRun;

	const run = useCallback(
		async (kind: 'install' | 'access' | 'check', action: () => Promise<unknown>, title: string) => {
			setBusy(kind);
			try {
				await action();
			} catch (err) {
				notifyToast({ color: 'red', title, message: errorText(err) });
			} finally {
				setBusy(null);
			}
		},
		[]
	);

	if (!api) {
		return (
			<div data-setting-id="encore-maestro-run" className="text-xs opacity-70">
				MaestroRun can only be set up from the Maestro desktop app.
			</div>
		);
	}

	const phase = status?.phase;
	const installed = phase === 'needs-access' || phase === 'ready';
	const ready = phase === 'ready';
	const installing = busy === 'install' || status?.installing === true;

	return (
		<div data-setting-id="encore-maestro-run" className="space-y-5">
			<div>
				<SettingsSectionHeading
					icon={ShieldCheck}
					description="One Full Disk Access grant for your scheduled scripts, held by a signed launcher instead of an interpreter that changes on every upgrade."
				>
					Setup
				</SettingsSectionHeading>
				{!enabled && (
					<p className="text-xs opacity-70 mb-2">
						Turn MaestroRun on from the tile header to install it.
					</p>
				)}
				<div className="space-y-3">
					<SectionCard theme={theme}>
						<StepHeader
							theme={theme}
							done={installed}
							title="1. Install the launcher"
							summary={installSummary(status)}
						/>
						{status && status.phase !== 'not-installed' && (
							<p className="text-xs opacity-70 font-mono break-all select-text">{status.appPath}</p>
						)}
						{phase === 'invalid' && status?.detail && (
							<div
								className="flex items-start gap-1.5 text-xs select-text"
								style={{ color: theme.colors.warning }}
							>
								<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
								<span>{status.detail}</span>
							</div>
						)}
						{enabled && (
							<div className="flex flex-wrap gap-2">
								{(!installed || status?.updateAvailable) && (
									<ActionButton
										theme={theme}
										icon={installing ? Loader2 : Download}
										label={
											installing
												? 'Installing'
												: status?.updateAvailable
													? `Update to ${status.latestVersion}`
													: 'Install MaestroRun'
										}
										disabled={installing}
										onClick={() =>
											void run('install', () => api.install(), 'MaestroRun install failed')
										}
									/>
								)}
								<ActionButton
									theme={theme}
									icon={RefreshCw}
									label="Check again"
									disabled={busy !== null}
									onClick={() =>
										void run(
											'check',
											() => api.refresh({ checkLatest: true }),
											'Could not check MaestroRun'
										)
									}
								/>
							</div>
						)}
					</SectionCard>

					<SectionCard theme={theme}>
						<StepHeader
							theme={theme}
							done={ready}
							title="2. Grant Full Disk Access"
							summary={
								ready
									? 'MaestroRun holds Full Disk Access.'
									: 'macOS has no prompt for this permission. Open the Full Disk Access list and switch MaestroRun on. This tile updates by itself when you do.'
							}
						/>
						{installed && !ready && status?.detail && (
							<div
								className="flex items-start gap-1.5 text-xs select-text"
								style={{ color: theme.colors.warning }}
							>
								<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
								<span>{status.detail}</span>
							</div>
						)}
						{status?.watchingForAccess && !ready && (
							<p className="text-xs opacity-70 flex items-center gap-1.5">
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
								Watching for the switch.
							</p>
						)}
						{enabled && installed && !ready && (
							<div className="flex flex-wrap gap-2">
								<ActionButton
									theme={theme}
									icon={HardDrive}
									label="Open Full Disk Access"
									disabled={busy !== null}
									onClick={() =>
										void run('access', () => api.requestAccess(), 'Could not open System Settings')
									}
								/>
								<ActionButton
									theme={theme}
									icon={FolderOpen}
									label={`Not in the list? Reveal in ${fileManagerName()}`}
									disabled={busy !== null}
									onClick={() =>
										void run(
											'access',
											() => api.requestAccess({ reveal: true }),
											'Could not reveal MaestroRun'
										)
									}
								/>
							</div>
						)}
					</SectionCard>

					<SectionCard theme={theme}>
						<StepHeader
							theme={theme}
							done={ready && enabled}
							title="3. Agents learn about MaestroRun"
							summary={
								ready && enabled
									? 'Every local agent Maestro starts is now told what MaestroRun is for, where it lives, and that it must ask you before approving a script.'
									: 'Agents are told nothing about MaestroRun until it is installed and holds Full Disk Access.'
							}
						/>
						{ready && status && (
							<p className="text-xs opacity-70 font-mono break-all select-text">
								{status.binaryPath}
							</p>
						)}
					</SectionCard>
				</div>
			</div>
		</div>
	);
}
