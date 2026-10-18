/**
 * SshRemediationNotice - actionable panel for a recognized, fixable SSH failure.
 *
 * A failed connection test normally has one line to say what went wrong, which
 * is enough for "wrong password" and useless for "your remote runs PowerShell,
 * so nothing Maestro sends it can ever execute". When the main process returns
 * an {@link SshRemoteRemediation}, this renders the headline, the reason, the
 * exact command that fixes it (copyable), and the doc that explains the rest.
 *
 * Deliberately inline rather than a modal: the user clicked Test inside a
 * settings modal, so stacking a second modal on top buries the control they
 * were about to use again.
 *
 * Usage:
 * ```tsx
 * {testResult.remediation && (
 *   <SshRemediationNotice remediation={testResult.remediation} theme={theme} />
 * )}
 * ```
 */

import { AlertTriangle, ExternalLink } from 'lucide-react';
import type { Theme } from '../../types';
import type { SshRemoteRemediation } from '../../../shared/sshRemoteShell';
import { CopyIconButton } from '../ui/CopyIconButton';
import { openUrl } from '../../utils/openUrl';

export interface SshRemediationNoticeProps {
	/** The structured failure returned by the connection test */
	remediation: SshRemoteRemediation;
	theme: Theme;
	/** Extra class names on the panel */
	className?: string;
}

export function SshRemediationNotice({ remediation, theme, className }: SshRemediationNoticeProps) {
	const { title, detail, command, commandLabel, docsUrl } = remediation;

	return (
		<div
			className={`p-3 rounded border text-sm ${className ?? ''}`}
			style={{
				borderColor: theme.colors.warning + '60',
				backgroundColor: theme.colors.warning + '15',
			}}
			data-testid="ssh-remediation-notice"
		>
			<div className="flex items-start gap-2">
				<AlertTriangle
					className="w-4 h-4 flex-shrink-0 mt-0.5"
					style={{ color: theme.colors.warning }}
				/>
				<div className="min-w-0 flex-1">
					<div className="font-medium" style={{ color: theme.colors.warning }}>
						{title}
					</div>
					<div className="mt-1 break-words" style={{ color: theme.colors.textMain }}>
						{detail}
					</div>

					{command && (
						<div className="mt-2">
							{commandLabel && (
								<div className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
									{commandLabel}
								</div>
							)}
							<div
								className="flex items-start gap-2 p-2 rounded"
								style={{ backgroundColor: theme.colors.bgMain }}
							>
								<code
									className="text-xs font-mono whitespace-pre-wrap break-all min-w-0 flex-1 select-text"
									style={{ color: theme.colors.textMain }}
								>
									{command}
								</code>
								<CopyIconButton
									value={command}
									theme={theme}
									title="Copy fix command"
									iconClassName="w-3.5 h-3.5"
								/>
							</div>
						</div>
					)}

					{docsUrl && (
						<button
							type="button"
							onClick={(e) => openUrl(docsUrl, { ctrlKey: e.ctrlKey || e.metaKey })}
							className="mt-2 inline-flex items-center gap-1 text-xs hover:underline"
							style={{ color: theme.colors.accent }}
						>
							<ExternalLink className="w-3 h-3" />
							Setting up a Windows remote host
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
