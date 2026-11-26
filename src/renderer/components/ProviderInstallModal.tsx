/**
 * ProviderInstallModal - install a missing provider CLI, then retry the turn.
 *
 * Opened from the agent error dialog when a turn failed with
 * `agent_not_installed`: the CLI was not on PATH, or the runtime its shebang
 * names (Node.js) was not. The fix lives entirely outside Maestro, so instead of
 * telling the user to go find a terminal, this runs the install command for
 * their platform in an embedded PTY they can watch and answer prompts in.
 *
 * The command is typed with an exit suffix, so the shell ends when the install
 * does and carries its exit code. On a zero exit code, the primary Retry button
 * appears and resends the turn that failed. The PTY is the same `LoginTerminal`
 * the provider re-auth and GitHub login dialogs use.
 *
 * The install runs where the agent's turns run: for an agent on an SSH remote
 * (a hosted agent's host is that remote too) the shell starts on the remote,
 * as the re-auth dialog's does, and types that remote's POSIX command. The
 * dialog itself is the same in every mode.
 */

import { useCallback, useMemo, useState } from 'react';
import { Download, ExternalLink, Terminal as TerminalIcon } from 'lucide-react';
import { Modal } from './ui/Modal';
import {
	LoginTerminal,
	loginPtySessionId,
	loginTerminalSshConfig,
	resolveLoginShell,
	type LoginTerminalStatus,
} from './LoginTerminal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSettingsStore } from '../stores/settingsStore';
import { getPlatform, isWindowsPlatform } from '../utils/platformUtils';
import {
	exitWithCommandStatus,
	getAgentDisplayName,
	loginShellSyntaxFor,
} from '../../shared/agentMetadata';
import {
	agentCliLabel,
	agentInstallPlatform,
	getAgentInstallInfo,
} from '../../shared/agentInstall';
import type { Session, Theme } from '../types';

export interface ProviderInstallModalProps {
	theme: Theme;
	/** The agent whose provider CLI is missing. */
	session: Session;
	/** Why the dialog opened (the classified error message), shown above the terminal. */
	reason?: string;
	onClose: () => void;
	/** The install finished with exit code 0. Resend the failed turn. */
	onRetry: () => void;
}

type Phase =
	| { kind: 'running' }
	| { kind: 'installed' }
	| { kind: 'failed'; message: string }
	| { kind: 'unavailable' };

export function ProviderInstallModal({
	theme,
	session,
	reason,
	onClose,
	onRetry,
}: ProviderInstallModalProps) {
	const defaultShell = useSettingsStore((s) => s.defaultShell);
	const shellArgs = useSettingsStore((s) => s.shellArgs);
	const shellEnvVars = useSettingsStore((s) => s.shellEnvVars);

	const agentName = getAgentDisplayName(session.toolType);
	const info = getAgentInstallInfo(session.toolType);
	const sshConfig = useMemo(
		() =>
			loginTerminalSshConfig({
				sessionSshRemoteConfig: session.sessionSshRemoteConfig,
				sshRemoteId: session.sshRemoteId,
				remoteCwd: session.remoteCwd,
			}),
		[session.sessionSshRemoteConfig, session.sshRemoteId, session.remoteCwd]
	);
	const remote = Boolean(sshConfig?.enabled);
	const platform = agentInstallPlatform(remote, getPlatform());
	const installCommand = info && platform ? (info.commands[platform] ?? null) : null;

	const [phase, setPhase] = useState<Phase>(() =>
		installCommand ? { kind: 'running' } : { kind: 'unavailable' }
	);
	// A new key starts a new shell, which is all "Run Again" needs.
	const [ptySessionId, setPtySessionId] = useState(() =>
		loginPtySessionId(`install-${session.id}`)
	);

	// The CLI is spawned as a native process, so a local install must not land in WSL.
	const installShell = useMemo(
		() => resolveLoginShell(defaultShell, remote),
		[defaultShell, remote]
	);

	const commandLine = useMemo(() => {
		if (!installCommand) return null;
		// An SSH remote runs a posix shell regardless of this machine.
		const syntax = remote ? 'posix' : loginShellSyntaxFor(installShell ?? '', isWindowsPlatform());
		return exitWithCommandStatus(installCommand, syntax);
	}, [installCommand, installShell, remote]);

	const handleExit = useCallback(
		(code: number) => {
			if (code === 0) {
				// Start refreshing cached agent detection right away so Retry sees the new binary.
				void window.maestro?.agents?.reprobe?.(session.toolType)?.catch(() => undefined);
				setPhase({ kind: 'installed' });
			} else {
				setPhase({ kind: 'failed', message: `The install ended with exit code ${code}.` });
			}
		},
		[session.toolType]
	);

	const handleStatusChange = useCallback((status: LoginTerminalStatus, error: string | null) => {
		if (status === 'failed') {
			setPhase({ kind: 'failed', message: error ?? 'The install terminal failed to start.' });
		}
	}, []);

	const handleRunAgain = useCallback(() => {
		setPtySessionId(loginPtySessionId(`install-${session.id}`));
		setPhase({ kind: 'running' });
	}, [session.id]);

	const handleOpenDocs = useCallback(() => {
		if (info) void window.maestro.shell.openExternal(info.docsUrl);
	}, [info]);

	const statusLine =
		phase.kind === 'running'
			? `Installing ${agentName}. Answer any prompts above.`
			: phase.kind === 'installed'
				? `${agentCliLabel(session.toolType)} installed. Retry to resend the message that failed.`
				: phase.kind === 'failed'
					? phase.message
					: `Maestro has no one-line install for ${agentName} on this platform. Follow the install guide, then close and resend.`;
	const statusColor =
		phase.kind === 'installed'
			? theme.colors.success
			: phase.kind === 'failed'
				? theme.colors.error
				: phase.kind === 'unavailable'
					? theme.colors.warning
					: theme.colors.textDim;

	return (
		<Modal
			theme={theme}
			title={`Install ${agentCliLabel(session.toolType)}`}
			priority={MODAL_PRIORITIES.PROVIDER_INSTALL}
			onClose={onClose}
			width={900}
			maxHeight="90vh"
			resizeKey="modal-provider-install"
			defaultSize={{ width: 900, height: 640 }}
			minSize={{ width: 520, height: 400 }}
			zIndex={10002}
			headerIcon={<Download className="w-5 h-5" style={{ color: theme.colors.accent }} />}
			contentClassName="flex-1 min-h-0 flex flex-col"
			testId="provider-install-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					<div
						className="mr-auto text-xs min-w-0 truncate select-text"
						style={{ color: statusColor }}
						title={statusLine}
						data-testid="provider-install-status"
					>
						{statusLine}
					</div>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Cancel
					</button>
					{phase.kind === 'failed' && commandLine && (
						<button
							type="button"
							onClick={handleRunAgain}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							data-testid="provider-install-run-again"
						>
							Run Again
						</button>
					)}
					{phase.kind === 'installed' && (
						<button
							type="button"
							onClick={onRetry}
							className="px-4 py-2 rounded transition-colors"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
							data-testid="provider-install-retry"
						>
							Retry
						</button>
					)}
				</div>
			}
		>
			<div className="flex flex-col gap-3 flex-1 min-h-0 p-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					<span style={{ color: theme.colors.textDim }}>{session.name}</span> could not start its
					provider CLI, so every message to it fails before {agentName} sees it. Install it below,
					then retry. Every agent on {agentName} uses the same install.
				</p>
				{reason && (
					<p className="text-xs select-text" style={{ color: theme.colors.textDim }}>
						{reason}
					</p>
				)}

				<div className="flex items-center gap-2 shrink-0">
					{installCommand && (
						<div
							className="flex-1 min-w-0 flex items-center gap-2 text-xs font-mono px-3 py-2 rounded border select-text"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgMain,
							}}
							data-testid="provider-install-command"
						>
							<TerminalIcon
								className="w-3.5 h-3.5 shrink-0"
								style={{ color: theme.colors.accent }}
							/>
							<span className="truncate" title={installCommand}>
								{installCommand}
							</span>
						</div>
					)}
					{info && (
						<button
							type="button"
							onClick={handleOpenDocs}
							className="inline-flex items-center gap-1.5 shrink-0 text-xs px-3 py-2 rounded border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							data-testid="provider-install-docs"
						>
							<ExternalLink className="w-3.5 h-3.5" />
							Install guide
						</button>
					)}
				</div>

				{commandLine && (
					<LoginTerminal
						theme={theme}
						ptySessionId={ptySessionId}
						commandLine={commandLine}
						spawn={{
							shell: installShell,
							shellArgs,
							shellEnvVars,
							sshConfig,
							cwd: session.cwd || session.projectRoot,
							toolType: session.toolType,
							customEnvVars: session.customEnvVars,
						}}
						onStatusChange={handleStatusChange}
						onExit={handleExit}
						testIdPrefix="provider-install"
					/>
				)}
			</div>
		</Modal>
	);
}

export default ProviderInstallModal;
