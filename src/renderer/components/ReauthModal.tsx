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
 * The account the login writes to is named up front in a pill. A provider can
 * hold several accounts at once (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and the
 * wrong one is invisible until the login "succeeds" and the agent fails again,
 * so which account is in play is headline information, not something to go
 * looking for behind a disclosure.
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
	UserRound,
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
import {
	effectiveAgentCustomEnvVars,
	getProviderProfileConfig,
	resolveAgentProfile,
} from '../../shared/providerProfiles';
import { useSshRemoteNames } from '../hooks/stats/useProviderProfiles';
import { getHomeDir, getHomeDirAsync } from '../utils/homeDir';
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
	// Latched the first time the command is actually typed, and never cleared
	// while this dialog is open. Once the user is inside a login the app must
	// not put another keystroke on that PTY: they may be halfway through a
	// device code or a password, and a replayed command line lands in the middle
	// of whatever they were entering.
	const hasTypedCommandRef = useRef(false);
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
	/**
	 * True when the user opened this from the command palette and nothing has
	 * failed. Only the copy changes - a login the user asked for is not a
	 * recovery, so claiming agents are stopped would be a lie they would have to
	 * go and disprove.
	 */
	const userInitiated = outage.initiatedBy === 'user';

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

	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			void getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	const remoteNames = useSshRemoteNames(Boolean(sshConfig?.enabled));

	/**
	 * The env the profile below is read from: the spawner's own layer stack,
	 * with global vars underneath and the ONE winning custom set on top. An
	 * agent's own vars REPLACE the provider's rather than layering over them,
	 * which is why this is not the same merge as `effectiveEnv` above - that one
	 * is the disclosure, this one is the attribution.
	 */
	const profileEnv = useMemo(
		() => ({
			...shellEnvVars,
			...effectiveAgentCustomEnvVars(
				session.customEnvVars as Record<string, string> | undefined,
				providerEnv ?? undefined
			),
		}),
		[shellEnvVars, session.customEnvVars, providerEnv]
	);

	/**
	 * The account this login will actually write to.
	 *
	 * Resolved through `providerProfiles` rather than by reading a config-dir
	 * env var straight off the list, because a set `ANTHROPIC_API_KEY` outranks
	 * the config dir entirely: naming that directory would credit the login to
	 * an account the agent never bills. Going through the shared module also
	 * means this pill and the Usage Dashboard's provider filter cannot disagree
	 * about which account an agent is on.
	 *
	 * Null until the provider env has been read, and null for a config-dir
	 * provider whose $HOME has not resolved yet - there is no account to name,
	 * and guessing one is the exact failure this pill exists to prevent.
	 */
	const profile = useMemo(() => {
		if (providerEnv === null) return null;
		const remoteId = sshConfig?.enabled ? (sshConfig.remoteId ?? 'default') : null;
		return resolveAgentProfile(
			session.toolType,
			profileEnv,
			homeDir,
			remoteId ? { id: remoteId, name: remoteNames[remoteId] } : null
		);
	}, [providerEnv, session.toolType, profileEnv, homeDir, sshConfig, remoteNames]);

	/**
	 * The one env var that decided the profile, spelled out beside the pill.
	 * This is the line the user would otherwise have to expand the whole
	 * environment to find. A config directory is printed because the path IS the
	 * account; a credential is only named, never printed.
	 */
	const profileEnvHint = useMemo(() => {
		if (!profile) return null;
		if (profile.credential) {
			const named = classifyCredentialKind(session.toolType, profileEnv).envVarName;
			return named ? `${named} set` : null;
		}
		const config = getProviderProfileConfig(session.toolType);
		if (!config) return null;
		const configured = profileEnv[config.envVar];
		return configured ? `${config.envVar}=${configured}` : `${config.envVar} unset`;
	}, [profile, session.toolType, profileEnv]);

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
	// The spawn effect keys off this, not off the command text: a command that
	// is re-derived to the same string is not a reason to restart a live login.
	const hasCommandLine = Boolean(commandLine);

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
		if (hasTypedCommandRef.current) return;
		hasTypedCommandRef.current = true;
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

	/**
	 * Everything the spawn below needs, refreshed every render but deliberately
	 * NOT a dependency of it.
	 *
	 * These values are objects and arrays out of the settings and session stores
	 * (`shellEnvVars`, `shellArgs`, the SSH config, the agent's own env), and
	 * their IDENTITY churns whenever either store rehydrates from main, even
	 * when nothing about them changed. As effect dependencies that churn tore
	 * down a live login shell and started a fresh one mid-flow, which is how the
	 * login command came to be typed a second time over whatever the user was
	 * entering. A login shell is started once per open dialog and then left
	 * alone; a settings write is never a reason to restart it.
	 */
	const spawnInputsRef = useRef({
		commandLine,
		loginShell,
		shellArgs,
		shellEnvVars,
		sshConfig,
		cwd: session.cwd,
		projectRoot: session.projectRoot,
		toolType: session.toolType,
		customEnvVars: session.customEnvVars,
	});
	spawnInputsRef.current = {
		commandLine,
		loginShell,
		shellArgs,
		shellEnvVars,
		sshConfig,
		cwd: session.cwd,
		projectRoot: session.projectRoot,
		toolType: session.toolType,
		customEnvVars: session.customEnvVars,
	};

	// Spawn the login shell, and tear it down when this modal really goes away.
	//
	// Spawn and kill live in ONE effect on purpose. Split across two, React's
	// StrictMode remount (cleanup, then re-run) killed the shell that the first
	// pass had just started while a `spawnStarted` guard blocked the second pass
	// from starting another - leaving a dead or orphaned PTY that nobody ever
	// typed into. The guard is therefore a generation counter that the cleanup
	// resets, so a remount always ends up with exactly one live shell.
	//
	// The only thing that starts a shell is the command line existing, which
	// happens once, when the environment finishes resolving. See the ref above
	// for why nothing else belongs in the dependency list.
	useEffect(() => {
		const spawn = spawnInputsRef.current;
		const command = spawn.commandLine;
		if (!command) return;

		const generation = ++spawnGenerationRef.current;
		let disposed = false;

		void window.maestro.process
			.spawnTerminalTab({
				sessionId: ptySessionId,
				// The login runs wherever the shell lands (the remote's home dir
				// over SSH). It needs no project directory, and guessing one risks a
				// `cd` that fails and kills the session before the login can run.
				cwd: spawn.sshConfig?.enabled ? '' : spawn.cwd || spawn.projectRoot || '',
				shell: spawn.loginShell || undefined,
				shellArgs: spawn.shellArgs,
				shellEnvVars: spawn.shellEnvVars,
				toolType: spawn.toolType,
				sessionCustomEnvVars: spawn.customEnvVars,
				sessionSshRemoteConfig: spawn.sshConfig,
			})
			.then((result) => {
				// A superseded generation's shell is already being replaced; writing
				// to it would type the login into a PTY nobody is watching.
				if (disposed || spawnGenerationRef.current !== generation) return;
				if (!result.success) {
					setStatus('failed');
					setSpawnError(
						spawn.sshConfig?.enabled
							? 'The SSH remote could not be reached. Check that the remote is enabled and online.'
							: 'A shell could not be started for the login flow.'
					);
					return;
				}
				setStatus('running');
				pendingCommandRef.current = { ptySessionId, command };
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
	}, [hasCommandLine, ptySessionId, flushPendingCommand]);

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
		? `Fix the credential this agent presents, then ${userInitiated ? 'close' : 'resume'}.`
		: status === 'failed'
			? spawnError
			: status === 'exited'
				? userInitiated
					? 'The login session ended.'
					: 'The login session ended. Resume to re-run everything that failed.'
				: status === 'running'
					? `Complete the provider login above, then ${userInitiated ? 'close this dialog' : 'resume'}.`
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
			title={
				userInitiated ? `Sign in to ${agentName} again.` : 'Please reauthenticate the provider.'
			}
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
						{userInitiated ? 'Cancel' : 'Not Now'}
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
						{userInitiated
							? 'Done'
							: blockedCount > 1
								? `Resume ${blockedCount} Agents`
								: 'Resume Agent'}
					</button>
				</div>
			}
		>
			<div className="flex flex-col gap-3 flex-1 min-h-0 p-4">
				{userInitiated ? (
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
						Run the <span style={{ color: theme.colors.textDim }}>{agentName}</span> login below.
						Every agent on this provider shares the credential store, so signing in once covers all
						of them. Nothing is stopped and no turn is interrupted.
					</p>
				) : (
					<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
						<span style={{ color: theme.colors.textDim }}>{agentName}</span> rejected its stored
						credentials
						{outage.fromPipeline ? ', taking Cue pipelines down with it' : ''}.{' '}
						{blockedCount > 1
							? `All ${blockedCount} agents on this provider are stopped until you log in again.`
							: 'This agent is stopped until you log in again.'}{' '}
						Their queued messages are held, not lost.
					</p>
				)}

				{!userInitiated && blockedNames.length > 0 && (
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

				{/* Which account the login writes to, stated outright. A provider
				    can hold several at once and the wrong one costs a whole round
				    trip to discover, so this does not sit behind the disclosure
				    below - it sits above it, with the single env var that decided
				    it spelled out alongside. */}
				{profile && (
					<div className="flex items-center gap-2 flex-wrap shrink-0">
						<span
							className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium select-text"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}20`,
							}}
							data-testid="reauth-profile-pill"
						>
							<UserRound className="w-3.5 h-3.5 shrink-0" />
							<span className="truncate">{profile.shortLabel}</span>
						</span>
						{profileEnvHint && (
							<span
								className="text-xs font-mono min-w-0 truncate select-text"
								style={{ color: theme.colors.textDim }}
								title={profileEnvHint}
								data-testid="reauth-profile-env"
							>
								{profileEnvHint}
							</span>
						)}
					</div>
				)}

				{/* Every other variable this agent runs with. Collapsed by default so
				    the login stays the focus, but one click away because a base-URL or
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
					<p
						className="text-sm select-text"
						style={{ color: theme.colors.warning }}
						data-testid="reauth-login-blocked"
					>
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
