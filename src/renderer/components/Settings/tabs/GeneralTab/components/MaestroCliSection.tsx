import { Terminal } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import type { MaestroCliState } from '../types';

interface MaestroCliSectionProps {
	theme: Theme;
	appVersion: string;
	maestroCli: MaestroCliState;
}

export function MaestroCliSection({ theme, appVersion, maestroCli }: MaestroCliSectionProps) {
	const {
		status,
		statusError,
		checking,
		installing,
		installMessage,
		checkStatus,
		installOrUpdate,
	} = maestroCli;

	return (
		<div data-setting-id="general-maestro-cli">
			<SettingsSectionHeading icon={Terminal}>Maestro CLI</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-2"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="text-xs opacity-70">
					Check whether <code>maestro-cli</code> is available in your PATH and whether its version
					matches Maestro v{status?.expectedVersion || appVersion}.
				</div>

				{status && !checking && (
					<div className="text-xs space-y-1">
						<div>
							<span style={{ color: theme.colors.textDim }}>PATH:</span>{' '}
							<span
								style={{
									color:
										status.inPath || status.inShellPath
											? theme.colors.success
											: theme.colors.warning,
								}}
							>
								{status.inPath
									? 'Detected'
									: status.inShellPath
										? 'Detected (shell PATH)'
										: 'Not detected'}
							</span>
						</div>
						<div>
							<span style={{ color: theme.colors.textDim }}>Installed version:</span>{' '}
							<span style={{ color: theme.colors.textMain }}>
								{status.installedVersion || 'Not installed'}
							</span>
						</div>
						<div>
							<span style={{ color: theme.colors.textDim }}>Expected version:</span>{' '}
							<span style={{ color: theme.colors.textMain }}>{status.expectedVersion}</span>
						</div>
						{status.commandPath && (
							<div className="break-all">
								<span style={{ color: theme.colors.textDim }}>Command path:</span>{' '}
								<code>{status.commandPath}</code>
							</div>
						)}
						{status.needsInstallOrUpdate && (
							<div style={{ color: theme.colors.warning }}>
								Mismatch or missing CLI detected. Install/update to sync versions.
							</div>
						)}
					</div>
				)}

				<div
					role={statusError ? 'alert' : 'status'}
					aria-live={statusError ? 'assertive' : 'polite'}
					aria-atomic="true"
					className="text-xs space-y-1"
				>
					{checking && <div className="opacity-60">Checking Maestro CLI status...</div>}
					{statusError && <div style={{ color: theme.colors.warning }}>{statusError}</div>}
					{installMessage && <div style={{ color: theme.colors.success }}>{installMessage}</div>}
				</div>

				<div className="flex gap-2">
					<button
						onClick={() => void checkStatus()}
						disabled={checking || installing}
						className="px-2 py-1 rounded text-xs"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							opacity: checking || installing ? 0.6 : 1,
						}}
					>
						{checking ? 'Checking...' : 'Check now'}
					</button>
					<button
						onClick={() => void installOrUpdate()}
						disabled={checking || installing}
						className="px-2 py-1 rounded text-xs"
						style={{
							backgroundColor: theme.colors.accentDim,
							color: theme.colors.textMain,
							opacity: checking || installing ? 0.6 : 1,
						}}
					>
						{installing
							? 'Installing...'
							: status?.needsInstallOrUpdate
								? 'Install / Update CLI'
								: 'Reinstall CLI'}
					</button>
				</div>
				<div className="text-[11px] opacity-50">
					Install target: <code>{status?.installDir || '~/.local/bin'}</code>
				</div>
			</div>
		</div>
	);
}
