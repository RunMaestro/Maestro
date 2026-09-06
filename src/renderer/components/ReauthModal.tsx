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
import {
	ChevronDown,
	ChevronRight,
	Copy,
	KeyRound,
	Terminal as TerminalIcon,
	Users,
} from 'lucide-react';
import { Modal } from './ui/Modal';
import { XTerminal, type XTerminalHandle } from './XTerminal';
import { EnvVarList } from './ui/EnvVarList';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { resolveAuthOutage, type AuthOutage } from '../stores/authOutageStore';
import {
	classifyCredentialKind,
	credentialKindBlocksLogin,
} from '../../shared/providerAuthIdentity';
import { generateId } from '../utils/ids';
import { findLoginUrl } from '../utils/loginUrl';
import { isWindowsPlatform } from '../utils/platformUtils';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { notifyToast } from '../stores/notificationStore';
import { logger } from '../utils/logger';
import {
	formatAgentLoginCommand,
	getAgentDisplayName,
	getAgentLoginCommand,
	loginShellSyntaxFor,
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

/**
 * How long to wait for the shell's first byte before typing the login command
 * anyway. Generous because it has to cover an SSH handshake to a cold remote;
 * the normal path fires on the prompt long before this.
 */
const SILENT_SHELL_FALLBACK_MS = 8000;

/**
 * How much login output to keep for URL scanning. A login screen is a few KB;
 * this is generous enough to survive a redraw while keeping the buffer from
 * growing for as long as the dialog stays open.
 */
const OUTPUT_SCAN_LIMIT = 64_000;

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
	// Bumped per spawn so a superseded attempt (StrictMode remount, a prop
	// change) cannot type its login command into a shell that is being replaced.
	const spawnGenerationRef = useRef(0);
	// The login command, held until the shell proves it is alive. See below.
	const pendingCommandRef = useRef<{ ptySessionId: string; command: string } | null>(null);
	const commandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const [status, setStatus] = useState<ReauthStatus>('starting');
	const [spawnError, setSpawnError] = useState<string | null>(null);
	const [envExpanded, setEnvExpanded] = useState(false);
	/** Sign-in URL scraped from the login output, once the provider prints one. */
	const [loginUrl, setLoginUrl] = useState<string | null>(null);
	/** Rolling tail of login output, scanned for that URL. */
	const outputRef = useRef('');
	// Provider-level vars come from the agent config store rather than the
	// session, so they need a fetch. Null until it resolves.
	const [providerEnv, setProviderEnv] = useState<Record<string, string> | null>(null);

	const login = useMemo(
		() => getAgentLoginCommand(session.toolType, session.customPath),
		[session.toolType, session.customPath]
	);
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

	/**
	 * Why this agent cannot be signed in from here, or null when it can.
	 *
	 * An API-key, gateway, or Bedrock/Vertex agent rejects its credentials with
	 * the same `auth_expired` output an expired login produces, and it would sit
	 * through the whole login flow without its situation changing - the flow
	 * succeeds, the user believes it is fixed, and the next prompt burns on the
	 * same rejection. So the terminal only opens for a credential a login repairs.
	 *
	 * Held at null until the provider env resolves. Classifying against a partial
	 * environment would miss exactly the override that makes the answer "no", and
	 * this runs once per modal open rather than per keystroke.
	 */
	const loginBlockedReason = useMemo(() => {
		if (providerEnv === null) return null;
		const env = Object.fromEntries(effectiveEnv.map((entry) => [entry.key, entry.value]));
		return credentialKindBlocksLogin(classifyCredentialKind(session.toolType, env), agentName);
	}, [providerEnv, effectiveEnv, session.toolType, agentName]);

	// Same SSH resolution as a terminal tab: an agent that runs on a remote host
	// must re-authenticate on that host, not on this laptop.
	const sshConfig = useMemo(() => {
		// Only paths that are definitely REMOTE are used. A terminal tab falls
		// back to `session.cwd` here, but this shell exists solely to run a login:
		// it gains nothing from the project directory, and main turns the override
		// into a `cd` that the remote shell runs before anything else - so a stale
		// or local-looking path kills the session before the login can start.
		// Landing in the remote home directory is always safe.
		if (session.sessionSshRemoteConfig?.enabled) {
			return {
				...session.sessionSshRemoteConfig,
				workingDirOverride:
					session.sessionSshRemoteConfig.workingDirOverride || session.remoteCwd || undefined,
			};
		}
		if (session.sshRemoteId) {
			return {
				enabled: true,
				remoteId: session.sshRemoteId,
				workingDirOverride: session.remoteCwd || undefined,
			};
		}
		return undefined;
	}, [session.sessionSshRemoteConfig, session.sshRemoteId, session.remoteCwd]);

	/**
	 * Shell the login runs in.
	 *
	 * On Windows the configured default may be WSL, and that is the one shell
	 * this dialog must NOT use: agents are always spawned as native Windows
	 * processes (nothing in the spawn path goes through `wsl.exe`), so a login
	 * inside WSL writes credentials to the WSL home directory that the native
	 * agent never reads. The login would appear to succeed and fix nothing.
	 * A remote agent is unaffected - its shell is the SSH remote's own.
	 */
	const loginShell = useMemo(() => {
		if (sshConfig?.enabled) return defaultShell;
		if (isWindowsPlatform() && defaultShell?.trim().toLowerCase() === 'wsl') return 'powershell';
		return defaultShell;
	}, [defaultShell, sshConfig?.enabled]);

	// Null until the environment has been read, so the spawn effect below waits
	// rather than starting a login the classification is about to rule out.
	const commandLine =
		providerEnv !== null && !loginBlockedReason && login
			? formatAgentLoginCommand(
					login,
					// An SSH remote runs a posix shell regardless of this machine.
					sshConfig?.enabled ? 'posix' : loginShellSyntaxFor(loginShell ?? '', isWindowsPlatform())
				)
			: null;

	// Type the login command in, once the shell is actually there to receive it.
	//
	// Not sent straight after the spawn resolves: over SSH the spawn resolves as
	// soon as the local `ssh` client is running, seconds before the remote shell
	// exists, and anything typed into that gap is dropped - which is exactly how
	// a remote login came up as an empty box. So the command is held until the
	// PTY produces its first byte (the prompt), with a timeout fallback for a
	// shell that prints nothing at all.
	const flushPendingCommand = useCallback(() => {
		const pending = pendingCommandRef.current;
		if (!pending) return;
		pendingCommandRef.current = null;
		if (commandTimerRef.current) {
			clearTimeout(commandTimerRef.current);
			commandTimerRef.current = null;
		}
		// CR, not LF: this is what a real Enter key sends (see the terminal
		// keyboard handler), and it is the only one that submits reliably on
		// Windows - ConPTY passes LF through as Ctrl+J, which PSReadLine does not
		// treat as "run this line", so a PowerShell login would sit there untyped.
		// A Unix PTY maps CR to NL for us, so this is correct on every platform.
		void window.maestro.process.write(pending.ptySessionId, `${pending.command}\r`).catch(() => {
			// A failed write surfaces as the process exiting; nothing to add here.
		});
	}, []);

	useEffect(() => {
		return window.maestro.process.onData((dataSessionId: string, data: string) => {
			if (dataSessionId !== ptySessionId) return;
			flushPendingCommand();

			// Watch the stream for the sign-in URL. A login URL is hundreds of
			// characters, the TUI soft-wraps it across rows, and mouse-tracking
			// TUIs swallow the drag that would select it - so reading it off the
			// screen is not a realistic option for the user.
			outputRef.current = `${outputRef.current}${data}`.slice(-OUTPUT_SCAN_LIMIT);
			const found = findLoginUrl(outputRef.current);
			if (found) setLoginUrl((prev) => (prev === found ? prev : found));
		});
	}, [ptySessionId, flushPendingCommand]);

	// Spawn the login shell, and tear it down when this modal really goes away.
	//
	// Spawn and kill live in ONE effect on purpose. Split across two, React's
	// StrictMode remount (cleanup, then re-run) killed the shell that the first
	// pass had just started while a `spawnStarted` guard blocked the second pass
	// from starting another - leaving a dead or orphaned PTY that nobody ever
	// typed into. The guard is therefore a generation counter that the cleanup
	// resets, so a remount always ends up with exactly one live shell.
	useEffect(() => {
		if (!commandLine) return;

		const generation = ++spawnGenerationRef.current;
		let disposed = false;

		void window.maestro.process
			.spawnTerminalTab({
				sessionId: ptySessionId,
				// The login runs wherever the shell lands (the remote's home dir
				// over SSH). It needs no project directory, and guessing one risks a
				// `cd` that fails and kills the session before the login can run.
				cwd: sshConfig?.enabled ? '' : session.cwd || session.projectRoot || '',
				shell: loginShell || undefined,
				shellArgs,
				shellEnvVars,
				toolType: session.toolType,
				sessionCustomEnvVars: session.customEnvVars,
				sessionSshRemoteConfig: sshConfig,
			})
			.then((result) => {
				// A superseded generation's shell is already being replaced; writing
				// to it would type the login into a PTY nobody is watching.
				if (disposed || spawnGenerationRef.current !== generation) return;
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
				pendingCommandRef.current = { ptySessionId, command: commandLine };
				commandTimerRef.current = setTimeout(flushPendingCommand, SILENT_SHELL_FALLBACK_MS);
			})
			.catch((err: unknown) => {
				if (disposed || spawnGenerationRef.current !== generation) return;
				logger.error('[ReauthModal] Failed to spawn login terminal', undefined, err);
				setStatus('failed');
				setSpawnError(err instanceof Error ? err.message : 'The login terminal failed to start.');
			});

		return () => {
			disposed = true;
			pendingCommandRef.current = null;
			if (commandTimerRef.current) {
				clearTimeout(commandTimerRef.current);
				commandTimerRef.current = null;
			}
			// Never leave a login shell running behind a closed modal. Re-spawning
			// under the same key is safe: ProcessManager kills the predecessor.
			void window.maestro.process.kill(ptySessionId).catch(() => {
				// Already gone - that is the desired end state either way.
			});
		};
	}, [
		commandLine,
		ptySessionId,
		loginShell,
		shellArgs,
		shellEnvVars,
		sshConfig,
		session.cwd,
		session.projectRoot,
		session.toolType,
		session.customEnvVars,
		flushPendingCommand,
	]);

	// The login shell exiting means the flow is over, one way or the other. A
	// shell that dies without printing anything (a dropped SSH transport, a
	// remote with no such binary) would otherwise leave an empty box with no
	// explanation, so say so in the terminal itself.
	useEffect(() => {
		return window.maestro.process.onExit((exitSessionId: string) => {
			if (exitSessionId !== ptySessionId) return;
			pendingCommandRef.current = null;
			terminalRef.current?.write('\r\n\x1b[2m[the login session ended]\x1b[0m\r\n');
			setStatus((prev) => (prev === 'failed' ? prev : 'exited'));
		});
	}, [ptySessionId]);

	const handleFocusTerminal = useCallback(() => {
		terminalRef.current?.focus();
	}, []);

	const handleCopyLoginUrl = useCallback(async () => {
		if (!loginUrl) return;
		const copied = await safeClipboardWrite(loginUrl);
		if (copied) {
			flashCopiedToClipboard(loginUrl, 'Login URL Copied');
		} else {
			notifyToast({
				color: 'red',
				title: 'Could not copy',
				message: 'The login URL could not be written to the clipboard.',
			});
		}
	}, [loginUrl]);

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

	const statusLine = loginBlockedReason
		? 'Fix the credential this agent presents, then resume.'
		: status === 'failed'
			? spawnError
			: status === 'exited'
				? 'The login session ended. Resume to re-run everything that failed.'
				: status === 'running'
					? 'Complete the provider login above, then resume.'
					: 'Starting the login shell...';

	const statusColor = loginBlockedReason
		? theme.colors.warning
		: status === 'failed'
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
						className="px-4 py-1.5 rounded border hover:bg-white/5 transition-colors text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Not Now
					</button>
					<button
						type="button"
						onClick={handleResume}
						className="px-4 py-1.5 rounded transition-colors text-sm"
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
				) : loginBlockedReason ? (
					<p className="text-sm select-text" style={{ color: theme.colors.warning }}>
						{loginBlockedReason}
					</p>
				) : providerEnv === null ? (
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						Reading this agent's environment to work out how it signs in...
					</p>
				) : (
					<p className="text-sm" style={{ color: theme.colors.error }}>
						{agentName} has no login command Maestro can run. Re-authenticate it from a terminal,
						then resume.
					</p>
				)}

				{/* The provider printed a sign-in URL. Surfacing it as a button is the
				    only practical way to get at it: it is far too long to retype, it
				    is soft-wrapped across terminal rows, and a mouse-tracking TUI
				    swallows the drag that would select it. */}
				{loginUrl && (
					<div className="flex items-center gap-2 shrink-0">
						<button
							type="button"
							onClick={handleCopyLoginUrl}
							className="inline-flex items-center gap-1.5 px-2 py-1 rounded border hover:bg-white/5 transition-colors text-xs shrink-0"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							data-testid="reauth-copy-url"
						>
							<Copy className="w-3.5 h-3.5" />
							<span>Copy Login URL</span>
						</button>
						<span
							className="text-xs min-w-0 truncate select-text"
							style={{ color: theme.colors.textDim }}
							title={loginUrl}
						>
							{loginUrl}
						</span>
					</div>
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
