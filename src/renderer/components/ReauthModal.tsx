/**
 * ReauthModal - re-authenticate a PROVIDER, and put its agents back to work.
 *
 * Scoped to the provider, not to the agent that happened to fail first. One
 * expired token blocks every agent sharing that credential store plus any Cue
 * pipeline they own, and one login fixes all of them - so this is one dialog
 * naming the whole blast radius, never one dialog per agent.
 *
 * It is deliberately loud and self-contained: the old recovery path only
 * dropped the user into terminal mode with the command still to type, which is
 * easy to miss when the failure happened overnight in a pipeline. Here the
 * login runs in an embedded PTY and finishes without leaving the dialog.
 *
 * Closing with "Resume agents" replays the turn each blocked agent died on
 * (see `resolveAuthOutage`), so the queued messages that piled up behind the
 * failure run in order without the user hunting for them.
 *
 * The PTY is a real terminal tab process (`process:spawnTerminalTab`), so the
 * provider's TUI, its device-code prompts, and SSH remotes all behave exactly
 * as they do in a terminal tab. The routing key carries `-terminal-` because
 * that is what makes PtySpawner forward raw output for xterm.js.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Terminal as TerminalIcon, Users } from 'lucide-react';
import { Modal } from './ui/Modal';
import { XTerminal, type XTerminalHandle } from './XTerminal';
import { EnvVarList } from './ui/EnvVarList';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { resolveAuthOutage, type AuthOutage } from '../stores/authOutageStore';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import {
	formatAgentLoginCommand,
	getAgentDisplayName,
	getAgentLoginCommand,
} from '../../shared/agentMetadata';
import { resolveAgentEnvironment, type ResolvedEnvVar } from '../../shared/agentEnvironment';
import type { Session, Theme } from '../types';

export interface ReauthModalProps {
	theme: Theme;
	/** The provider outage this dialog is resolving. */
	outage: AuthOutage;
	/**
	 * An agent backed by the failed provider, used to run the login in the right
	 * place (its cwd, its custom binary path, its SSH remote). Any blocked agent
	 * will do - they share the credential store, which is the whole point.
	 */
	session: Session;
	onClose: () => void;
}

type ReauthStatus = 'starting' | 'running' | 'failed' | 'exited';

export function ReauthModal({ theme, outage, session, onClose }: ReauthModalProps) {
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const defaultShell = useSettingsStore((s) => s.defaultShell);
	const shellArgs = useSettingsStore((s) => s.shellArgs);
	const shellEnvVars = useSettingsStore((s) => s.shellEnvVars);
	const sessions = useSessionStore((s) => s.sessions);

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
	const [envExpanded, setEnvExpanded] = useState(false);
	// Provider-level vars come from the agent config store rather than the
	// session, so they need a fetch. Null until it resolves.
	const [providerEnv, setProviderEnv] = useState<Record<string, string> | null>(null);

	const login = useMemo(
		() => getAgentLoginCommand(session.toolType, session.customPath),
		[session.toolType, session.customPath]
	);
	const commandLine = login ? formatAgentLoginCommand(login) : null;
	const agentName = getAgentDisplayName(outage.toolType);

	// Names of the blocked agents, resolved live: more of them can fail while
	// this dialog is open, and each one joins the outage rather than raising a
	// second prompt, so the count here has to keep up.
	const blockedNames = useMemo(() => {
		const byId = new Map(sessions.map((s) => [s.id, s.name]));
		return outage.blocked
			.map((b) => byId.get(b.sessionId))
			.filter((name): name is string => !!name);
	}, [sessions, outage.blocked]);
	const blockedCount = outage.blocked.length;

	// The environment decides WHICH credentials the login writes and the agent
	// reads - a base URL override, an API-key var, a profile selector - so an
	// auth failure is exactly when it needs to be visible. Merged the same way
	// the spawner merges it, so this is what the login shell below actually got.
	useEffect(() => {
		let cancelled = false;
		void window.maestro.agents
			.getCustomEnvVars(session.toolType)
			.then((vars) => {
				if (!cancelled) setProviderEnv(vars ?? {});
			})
			.catch((err: unknown) => {
				// Non-fatal: the login still works, we just cannot show one layer.
				logger.warn('[ReauthModal] Could not read provider env vars', undefined, err);
				if (!cancelled) setProviderEnv({});
			});
		return () => {
			cancelled = true;
		};
	}, [session.toolType]);

	const effectiveEnv: ResolvedEnvVar[] = useMemo(
		() =>
			resolveAgentEnvironment({
				global: shellEnvVars,
				agent: providerEnv ?? undefined,
				session: session.customEnvVars,
			}),
		[shellEnvVars, providerEnv, session.customEnvVars]
	);

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

	/** Login done: close the outage and replay what every blocked agent lost. */
	const handleResume = useCallback(() => {
		resolveAuthOutage(outage.providerKey, true);
		onClose();
	}, [outage.providerKey, onClose]);

	/**
	 * Dismiss without resuming. The agents keep their error state and their held
	 * queues, so nothing is lost - but we do NOT restart them, because the user
	 * closing this dialog is not evidence that the login succeeded.
	 */
	const handleDismiss = useCallback(() => {
		resolveAuthOutage(outage.providerKey, false);
		onClose();
	}, [outage.providerKey, onClose]);

	const statusLine =
		status === 'failed'
			? spawnError
			: status === 'exited'
				? 'The login session ended. Resume to re-run everything that failed.'
				: status === 'running'
					? 'Complete the provider login above, then resume.'
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
			onClose={handleDismiss}
			width={1100}
			maxHeight="92vh"
			// Resizable and persisted: this is a working surface, not a notice. The
			// user drives a real TUI login inside it, so the default is deliberately
			// large - a login flow squeezed into a notification-sized box is
			// unreadable, and the provider's own menus need the room.
			resizeKey="modal-reauth"
			defaultSize={{ width: 1100, height: 800 }}
			minSize={{ width: 560, height: 420 }}
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
						onClick={handleDismiss}
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Not Now
					</button>
					<button
						type="button"
						onClick={handleResume}
						className="px-4 py-2 rounded transition-colors"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						data-testid="reauth-resume"
					>
						{blockedCount > 1 ? `Resume ${blockedCount} Agents` : 'Resume Agent'}
					</button>
				</div>
			}
		>
			<div className="flex flex-col gap-3 flex-1 min-h-0 p-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					<span style={{ color: theme.colors.textDim }}>{agentName}</span> rejected its stored
					credentials
					{outage.fromPipeline ? ', taking Cue pipelines down with it' : ''}.{' '}
					{blockedCount > 1
						? `All ${blockedCount} agents on this provider are stopped until you log in again.`
						: 'This agent is stopped until you log in again.'}{' '}
					Their queued messages are held, not lost.
				</p>

				{blockedNames.length > 0 && (
					<div
						className="flex items-start gap-2 text-xs select-text"
						style={{ color: theme.colors.textDim }}
					>
						<Users className="w-3.5 h-3.5 shrink-0 mt-0.5" />
						<span className="min-w-0">{blockedNames.join(', ')}</span>
					</div>
				)}

				{outage.message && (
					<p className="text-xs select-text" style={{ color: theme.colors.textDim }}>
						{outage.message}
					</p>
				)}

				{/* Which profile this agent runs as. Collapsed by default so the
				    login stays the focus, but one click away because a base-URL or
				    API-key override is a common reason a login "succeeds" and the
				    agent still fails. */}
				<div className="shrink-0">
					<button
						type="button"
						onClick={() => setEnvExpanded((v) => !v)}
						className="flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						aria-expanded={envExpanded}
						data-testid="reauth-env-toggle"
					>
						{envExpanded ? (
							<ChevronDown className="w-3.5 h-3.5" />
						) : (
							<ChevronRight className="w-3.5 h-3.5" />
						)}
						<span>
							Environment for {session.name}
							{providerEnv === null ? '' : ` (${effectiveEnv.length})`}
						</span>
					</button>

					{envExpanded && (
						<div
							className="mt-2 max-h-40 overflow-y-auto scrollbar-thin rounded border p-2"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							{providerEnv === null ? (
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									Reading environment...
								</p>
							) : (
								<EnvVarList
									theme={theme}
									vars={effectiveEnv}
									emptyMessage={`No environment variables are set for ${session.name}.`}
									testId="reauth-env"
								/>
							)}
						</div>
					)}
				</div>

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
						then resume.
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
