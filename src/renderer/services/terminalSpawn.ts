/**
 * terminalSpawn.ts - the one place a terminal tab's PTY is started.
 *
 * This used to live inside `TerminalView`, which meant a tab only ever got a
 * shell if that component rendered it. `TerminalView` mounts per agent and only
 * for the agent that is (or has been) on screen, so a terminal opened into the
 * background never spawned at all: the tab appeared in the tab bar, `send-terminal`
 * answered "has no running shell yet", and the only cure was to click the tab -
 * exactly what `open-terminal --background` exists to avoid.
 *
 * The spawn itself never needed the view. It touches no DOM, no xterm instance,
 * and no cols/rows; it is an IPC call plus two store writes. So it lives here and
 * both callers share it:
 *
 *   - `TerminalView`, when a tab it is rendering has no PID yet
 *   - the `open-terminal` remote handler, the moment it creates the tab
 *
 * Callers differ only in how they REPORT failure: the view can write into the
 * live xterm buffer, the handler cannot. That is the `onSpawnFailure` hook.
 */

import { getTerminalSessionId } from '../utils/terminalTabHelpers';
import { useSettingsStore } from '../stores/settingsStore';
import { captureException } from '../utils/sentry';
import type { Session, TerminalTab } from '../types';

/**
 * Tabs with a spawn already in flight, keyed by the PROCESS id
 * (`getTerminalSessionId(sessionId, tabId)`), never by the bare tab id.
 *
 * Module scope rather than a component ref, because the two callers live in
 * different React subtrees and a per-mount guard cannot see the other's spawn -
 * a background spawn racing a user clicking that tab would start two PTYs and
 * orphan one with no error anywhere.
 *
 * The key must be the composed process id: tab ids are only unique within an
 * agent, so guarding on the bare id would make two different agents' terminals
 * dedupe each other and the second one would silently never start.
 *
 * This only covers the window before the PID lands in the store. Once it has,
 * `pid !== 0` is the durable guard and survives remounting.
 */
const spawnInFlight = new Set<string>();

/** Whether a spawn for this tab is already on its way. Exported for tests. */
export function isSpawnInFlight(sessionId: string, tabId: string): boolean {
	return spawnInFlight.has(getTerminalSessionId(sessionId, tabId));
}

export interface SpawnPtyForTabOptions {
	session: Session;
	tab: TerminalTab;
	/** Called with the real PID once the shell is up. */
	onPid: (tabId: string, pid: number) => void;
	/**
	 * Called when the shell could not be started. `isPersistent` means the tab
	 * carries user intent worth keeping (a startup command, or an SSH session
	 * whose transport can drop for unrelated reasons) - those become restartable
	 * exited husks rather than being closed.
	 */
	onSpawnFailure: (tabId: string, isPersistent: boolean, message: string) => void;
}

/**
 * Start the PTY for a terminal tab. Safe to call from anywhere in the renderer;
 * concurrent calls for the same tab collapse to one spawn.
 */
export async function spawnPtyForTab(options: SpawnPtyForTabOptions): Promise<void> {
	const { session, tab, onPid, onSpawnFailure } = options;
	const tabId = tab.id;
	const terminalSessionId = getTerminalSessionId(session.id, tabId);

	if (spawnInFlight.has(terminalSessionId)) return;
	spawnInFlight.add(terminalSessionId);

	// "Persistent" tabs carry user intent to keep running: a configured startup
	// command, or any tab under an SSH/remote session (whose transport can drop
	// for reasons unrelated to the user). We never silently discard these on
	// failure - we keep them as a restartable exited husk instead of closing the
	// tab and losing its config.
	const isPersistent =
		!!tab.startupCommand || !!(session.sessionSshRemoteConfig?.enabled || session.sshRemoteId);

	// Build effective SSH config: prefer explicit sessionSshRemoteConfig, then fall back
	// to sshRemoteId which is set after an AI agent connects. Without this fallback,
	// terminal tabs under running SSH agents spawn locally instead of on the remote host.
	//
	// workingDirOverride must be a REMOTE path. Fallback chain:
	//   1. sessionSshRemoteConfig.workingDirOverride - user-configured remote project root
	//   2. session.remoteCwd - tracked remote cwd (set after agent reports cd)
	//   3. session.cwd - the working directory from session creation; for SSH sessions
	//      this IS a remote path (the user types a remote path when SSH is enabled)
	const effectiveSshConfig = session.sessionSshRemoteConfig?.enabled
		? {
				...session.sessionSshRemoteConfig,
				workingDirOverride:
					session.sessionSshRemoteConfig.workingDirOverride ||
					session.remoteCwd ||
					session.cwd ||
					undefined,
			}
		: session.sshRemoteId
			? {
					enabled: true,
					remoteId: session.sshRemoteId,
					workingDirOverride:
						session.remoteCwd ||
						session.sessionSshRemoteConfig?.workingDirOverride ||
						session.cwd ||
						undefined,
				}
			: undefined;

	// When a startup command is configured, spawn the PTY in its configured cwd
	// (if any) so the command runs in the right directory. Otherwise keep the
	// existing fallback chain.
	const spawnCwd =
		(tab.startupCommand && tab.startupCommandCwd) ||
		tab.cwd ||
		session.cwd ||
		session.projectRoot ||
		'';

	// Read shell settings from the store rather than taking them as props: this
	// runs outside React for the background path, and the settings are global.
	const { defaultShell, shellArgs, shellEnvVars } = useSettingsStore.getState();

	try {
		const result = await window.maestro.process.spawnTerminalTab({
			sessionId: terminalSessionId,
			cwd: spawnCwd,
			shell: defaultShell || undefined,
			shellArgs,
			shellEnvVars,
			toolType: session.toolType,
			sessionCustomEnvVars: session.customEnvVars,
			sessionSshRemoteConfig: effectiveSshConfig,
		});

		if (result.success) {
			onPid(tabId, result.pid);
			// Run the user-configured startup command. The PTY buffers stdin, so the
			// shell will execute it once initialization (rc files, etc.) finishes.
			if (tab.startupCommand) {
				window.maestro.process.write(terminalSessionId, tab.startupCommand + '\n').catch(() => {
					// Write failures are surfaced by the process exit handler
				});
			}
		} else {
			onSpawnFailure(
				tabId,
				isPersistent,
				effectiveSshConfig?.enabled
					? 'SSH terminal could not be started. Check that the SSH remote is enabled and reachable.'
					: 'The shell process could not be started. Check system PTY availability.'
			);
		}
	} catch (err) {
		captureException(err, {
			extra: { tabId, terminalSessionId, operation: 'spawnTerminalTab' },
		});
		// Spawn threw - same persistent-vs-scratch handling as a failed spawn.
		onSpawnFailure(
			tabId,
			isPersistent,
			err instanceof Error ? err.message : 'An unexpected error occurred.'
		);
	} finally {
		spawnInFlight.delete(terminalSessionId);
	}
}
