/**
 * ReauthModal - run a provider's login flow without leaving the app.
 *
 * An expired token takes every agent AND every Cue pipeline down at once, and
 * the old recovery path ("Use Terminal") only dropped the user into terminal
 * mode with the command still to be typed. That is easy to miss when the
 * failure happened overnight in a pipeline, so this modal is deliberately loud:
 * it owns the screen, states what is wrong, and runs the login command in an
 * embedded PTY so the whole flow finishes here.
 *
 * The PTY is a real terminal tab process (`process:spawnTerminalTab`), so the
 * provider's TUI, its device-code prompts, and SSH remotes all behave exactly
 * as they do in a terminal tab. The routing key carries `-terminal-` because
 * that is what makes PtySpawner forward raw output for xterm.js.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Terminal as TerminalIcon } from 'lucide-react';
import { Modal } from './ui/Modal';
import { XTerminal, type XTerminalHandle } from './XTerminal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSettingsStore } from '../stores/settingsStore';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import {
	formatAgentLoginCommand,
	getAgentDisplayName,
	getAgentLoginCommand,
} from '../../shared/agentMetadata';
import type { Session, Theme } from '../types';

export interface ReauthModalProps {
	theme: Theme;
	/** The agent whose provider needs re-authentication. */
	session: Session;
	/** The provider's own error text, shown so the user sees what actually failed. */
	message?: string;
	/** True when a Cue pipeline hit this, not a chat turn - changes the lede. */
	fromPipeline?: boolean;
	onClose: () => void;
}

type ReauthStatus = 'starting' | 'running' | 'failed' | 'exited';

export function ReauthModal({ theme, session, message, fromPipeline, onClose }: ReauthModalProps) {
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const defaultShell = useSettingsStore((s) => s.defaultShell);
	const shellArgs = useSettingsStore((s) => s.shellArgs);
	const shellEnvVars = useSettingsStore((s) => s.shellEnvVars);

	const terminalRef = useRef<XTerminalHandle | null>(null);
	// One PTY per modal open. Two parts of this key are load-bearing:
	//   - `-terminal-` makes PtySpawner forward raw (unstripped) output for
	//     xterm.js, and makes useAgentExitListener ignore the process.
	//   - the `reauth-` PREFIX keeps the part before `-terminal-` from equalling
	//     any agent id, so TerminalView (which claims every
	//     `{sessionId}-terminal-*` exit for its own tabs) never mistakes this
	//     login shell for a terminal tab that was closed.
	const ptySessionId = useMemo(() => `reauth-${session.id}-terminal-${generateId()}`, [session.id]);
	const spawnStartedRef = useRef(false);

	const [status, setStatus] = useState<ReauthStatus>('starting');
	const [spawnError, setSpawnError] = useState<string | null>(null);

	const login = useMemo(
		() => getAgentLoginCommand(session.toolType, session.customPath),
		[session.toolType, session.customPath]
	);
	const commandLine = login ? formatAgentLoginCommand(login) : null;
	const agentName = getAgentDisplayName(session.toolType);

	// Same SSH resolution as a terminal tab: an agent that runs on a remote host
	// must re-authenticate on that host, not on this laptop.
	const sshConfig = useMemo(() => {
		if (session.sessionSshRemoteConfig?.enabled) {
			return {
				...session.sessionSshRemoteConfig,
				workingDirOverride:
					session.sessionSshRemoteConfig.workingDirOverride ||
					session.remoteCwd ||
					session.cwd ||
					undefined,
			};
		}
		if (session.sshRemoteId) {
			return {
				enabled: true,
				remoteId: session.sshRemoteId,
				workingDirOverride: session.remoteCwd || session.cwd || undefined,
			};
		}
		return undefined;
	}, [session.sessionSshRemoteConfig, session.sshRemoteId, session.remoteCwd, session.cwd]);

	// Spawn the PTY exactly once and type the login command into it. The guard
	// is what keeps StrictMode's double effect from starting two logins.
	useEffect(() => {
		if (!commandLine || spawnStartedRef.current) return;
		spawnStartedRef.current = true;

		let cancelled = false;
		void window.maestro.process
			.spawnTerminalTab({
				sessionId: ptySessionId,
				cwd: session.cwd || session.projectRoot || '',
				shell: defaultShell || undefined,
				shellArgs,
				shellEnvVars,
				toolType: session.toolType,
				sessionCustomEnvVars: session.customEnvVars,
				sessionSshRemoteConfig: sshConfig,
			})
			.then((result) => {
				if (cancelled) return;
				if (!result.success) {
					setStatus('failed');
					setSpawnError(
						sshConfig?.enabled
							? 'The SSH remote could not be reached. Check that the remote is enabled and online.'
							: 'A shell could not be started for the login flow.'
					);
					return;
				}
				setStatus('running');
				// The PTY buffers stdin, so this lands once the shell has finished
				// sourcing its rc files.
				void window.maestro.process.write(ptySessionId, `${commandLine}\n`).catch(() => {
					// A failed write surfaces as the process exiting; nothing to add here.
				});
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				logger.error('[ReauthModal] Failed to spawn login terminal', undefined, err);
				setStatus('failed');
				setSpawnError(err instanceof Error ? err.message : 'The login terminal failed to start.');
			});

		return () => {
			cancelled = true;
		};
	}, [
		commandLine,
		ptySessionId,
		defaultShell,
		shellArgs,
		shellEnvVars,
		sshConfig,
		session.cwd,
		session.projectRoot,
		session.toolType,
		session.customEnvVars,
	]);

	// The login shell exiting means the flow is over, one way or the other.
	useEffect(() => {
		return window.maestro.process.onExit((exitSessionId: string) => {
			if (exitSessionId !== ptySessionId) return;
			setStatus((prev) => (prev === 'failed' ? prev : 'exited'));
		});
	}, [ptySessionId]);

	// Never leave a login shell running behind a closed modal.
	useEffect(() => {
		return () => {
			void window.maestro.process.kill(ptySessionId).catch(() => {
				// Already gone - that is the desired end state either way.
			});
		};
	}, [ptySessionId]);

	const handleFocusTerminal = useCallback(() => {
		terminalRef.current?.focus();
	}, []);

	const statusLine =
		status === 'failed'
			? spawnError
			: status === 'exited'
				? 'The login session ended. Click Done to resume, or reopen this dialog to try again.'
				: status === 'running'
					? 'Complete the provider login above. This dialog stays open until you are done.'
					: 'Starting the login shell...';

	const statusColor =
		status === 'failed'
			? theme.colors.error
			: status === 'exited'
				? theme.colors.success
				: theme.colors.textDim;

	return (
		<Modal
			theme={theme}
			title="Please reauthenticate the provider."
			priority={MODAL_PRIORITIES.REAUTH}
			onClose={onClose}
			width={760}
			maxHeight="80vh"
			resizeKey="modal-reauth"
			defaultSize={{ width: 760, height: 520 }}
			minSize={{ width: 480, height: 320 }}
			zIndex={10002}
			headerIcon={<KeyRound className="w-5 h-5" style={{ color: theme.colors.warning }} />}
			contentClassName="flex-1 min-h-0 flex flex-col"
			testId="reauth-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					<div
						className="mr-auto text-xs min-w-0 truncate select-text"
						style={{ color: statusColor }}
						title={statusLine ?? undefined}
					>
						{statusLine}
					</div>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded transition-colors"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Done
					</button>
				</div>
			}
		>
			<div className="flex flex-col gap-3 flex-1 min-h-0 p-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					<span style={{ color: theme.colors.textDim }}>{agentName}</span> rejected the stored
					credentials for <span className="font-medium">{session.name}</span>
					{fromPipeline ? ' while running a Cue pipeline' : ''}. Every agent and Cue pipeline on
					this provider stays down until you log in again.
				</p>

				{message && (
					<p className="text-xs select-text" style={{ color: theme.colors.textDim }}>
						{message}
					</p>
				)}

				{commandLine ? (
					<div
						className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded border select-text"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<TerminalIcon className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
						<span className="truncate">{commandLine}</span>
						{login?.followUp && (
							<span className="shrink-0" style={{ color: theme.colors.textDim }}>
								then type {login.followUp}
							</span>
						)}
					</div>
				) : (
					<p className="text-sm" style={{ color: theme.colors.error }}>
						{agentName} has no login command Maestro can run. Re-authenticate it from a terminal,
						then reopen this agent.
					</p>
				)}

				{commandLine && (
					<div
						className="flex-1 min-h-0 rounded border overflow-hidden"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						onClick={handleFocusTerminal}
					>
						<XTerminal
							ref={(handle) => {
								terminalRef.current = handle;
							}}
							sessionId={ptySessionId}
							theme={theme}
							fontFamily={fontFamily}
							fontSize={Math.round(fontSize * 0.85)}
						/>
					</div>
				)}
			</div>
		</Modal>
	);
}

export default ReauthModal;
