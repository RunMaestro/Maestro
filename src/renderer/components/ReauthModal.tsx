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
 * The PTY itself (spawn, typing the command, the sign-in URL, the exit) is
 * `LoginTerminal`, shared with the GitHub CLI login behind Send Feedback.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Terminal as TerminalIcon, Users } from 'lucide-react';
import { Modal } from './ui/Modal';
import {
	LoginTerminal,
	loginPtySessionId,
	resolveLoginShell,
	type LoginTerminalStatus,
} from './LoginTerminal';
import { EnvVarList } from './ui/EnvVarList';
import { AccountPill } from './ui/AccountPill';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore } from '../stores/sessionStore';
import { resolveAuthOutage, type AuthOutage } from '../stores/authOutageStore';
import {
	classifyCredentialKind,
	credentialKindBlocksLogin,
} from '../../shared/providerAuthIdentity';
import { isWindowsPlatform } from '../utils/platformUtils';
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

export function ReauthModal({ theme, outage, session, onClose }: ReauthModalProps) {
	const defaultShell = useSettingsStore((s) => s.defaultShell);
	const shellArgs = useSettingsStore((s) => s.shellArgs);
	const shellEnvVars = useSettingsStore((s) => s.shellEnvVars);
	const sessions = useSessionStore((s) => s.sessions);

	// One login shell per modal open. The `reauth-` prefix keeps the routing
	// key from colliding with an agent's own terminal tabs (see LoginTerminal).
	const ptySessionId = useMemo(() => loginPtySessionId(`reauth-${session.id}`), [session.id]);

	const [status, setStatus] = useState<LoginTerminalStatus>('starting');
	const [spawnError, setSpawnError] = useState<string | null>(null);
	const [envExpanded, setEnvExpanded] = useState(false);
	// Provider-level vars come from the agent config store rather than the
	// session, so they need a fetch. Null until it resolves.
	const [providerEnv, setProviderEnv] = useState<Record<string, string> | null>(null);

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

	// A remote login cannot use a browser callback on the remote's localhost,
	// so providers with a device-code flow switch to it over SSH.
	const login = useMemo(
		() =>
			getAgentLoginCommand(session.toolType, session.customPath, {
				remote: Boolean(sshConfig?.enabled),
			}),
		[session.toolType, session.customPath, sshConfig?.enabled]
	);

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

	/** Shell the login runs in (never WSL locally - see resolveLoginShell). */
	const loginShell = useMemo(
		() => resolveLoginShell(defaultShell, Boolean(sshConfig?.enabled)),
		[defaultShell, sshConfig?.enabled]
	);

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
	const handleStatusChange = useCallback((next: LoginTerminalStatus, error: string | null) => {
		setStatus(next);
		if (next === 'failed') setSpawnError(error);
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
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						{userInitiated ? 'Cancel' : 'Not Now'}
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
						<AccountPill theme={theme} label={profile.shortLabel} testId="reauth-profile-pill" />
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

				{commandLine && (
					<LoginTerminal
						theme={theme}
						ptySessionId={ptySessionId}
						commandLine={commandLine}
						spawn={{
							shell: loginShell,
							shellArgs,
							shellEnvVars,
							sshConfig,
							cwd: session.cwd || session.projectRoot,
							toolType: session.toolType,
							customEnvVars: session.customEnvVars,
						}}
						onStatusChange={handleStatusChange}
						testIdPrefix="reauth"
					/>
				)}
			</div>
		</Modal>
	);
}

export default ReauthModal;
