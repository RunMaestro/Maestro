import type { BrowserWindow } from 'electron';
import Store from 'electron-store';
import { logger } from '../../../utils/logger';
import { isWebContentsAvailable } from '../../../utils/safe-send';
import type { ClaudeSpawnContext } from './resolve-claude-spawn-context';
import type { SpawnProcessConfig } from './spawn-types';
import type { SteeringUnavailableReason } from '../../../../shared/chatSteering';

const LOG_CONTEXT = '[ProcessManager]';

/**
 * Persist the resolved Claude headless-mode state back to the session record
 * and notify the renderer.
 */
export function persistClaudeInteractiveMode(
	config: SpawnProcessConfig,
	claudeContext: ClaudeSpawnContext,
	deps: {
		sessionsStore: Store<{ sessions: unknown[] }>;
		safeSend?: (channel: string, ...args: unknown[]) => void;
		getMainWindow: () => BrowserWindow | null;
	}
): void {
	const {
		isClaudeCode,
		tokenSourceSessionId,
		claudeResolvedMode,
		claudeResolvedReason,
		resolvedConfigDirKey,
		remoteMaestroPCanSteer,
	} = claudeContext;
	// A TUI turn on an SSH remote whose maestro-p predates the steering relay has no
	// steering channel. Recorded with the mode so the Steer controls say why before
	// anyone clicks; any other spawn clears it.
	const steeringUnavailable: SteeringUnavailableReason | undefined =
		claudeResolvedMode === 'interactive' && remoteMaestroPCanSteer === false
			? 'maestro-p-outdated'
			: undefined;

	// Persist the resolved Claude headless-mode state back to the session
	// record and notify the renderer. Fires when:
	//   - Adaptive Mode's auto-resolver ran (toggle on), OR
	//   - The user wired `Path` directly at maestro-p (resolved-interactive
	//     without the toggle), OR
	//   - We need to clear stale `mode === 'interactive'` from a prior
	//     turn (both `resolvedConfigDirKey` above branches resolve it,
	//     gate on `!== undefined`).
	// When none of those apply we leave `claudeInteractive` alone - the
	// popover hides itself anyway when `enableMaestroP` is false.
	if (!isClaudeCode || resolvedConfigDirKey === undefined) return;

	try {
		const allSessions = deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
		let mutated = false;
		const nextSessions = allSessions.map((s) => {
			if (s?.id !== tokenSourceSessionId) return s;
			const current = s.claudeInteractive as
				| {
						mode?: string;
						modeReason?: string;
						lastUsageSnapshotKey?: string;
						steeringUnavailable?: string;
				  }
				| undefined;
			if (
				current?.mode === claudeResolvedMode &&
				current?.modeReason === claudeResolvedReason &&
				current?.lastUsageSnapshotKey === resolvedConfigDirKey &&
				current?.steeringUnavailable === steeringUnavailable
			) {
				return s;
			}
			mutated = true;
			return {
				...s,
				claudeInteractive: {
					mode: claudeResolvedMode,
					modeReason: claudeResolvedReason,
					lastUsageSnapshotKey: resolvedConfigDirKey,
					...(steeringUnavailable ? { steeringUnavailable } : {}),
				},
			};
		});
		if (mutated) {
			deps.sessionsStore.set('sessions', nextSessions);
		}
	} catch (err) {
		logger.warn('Failed to persist resolved Claude mode', LOG_CONTEXT, {
			sessionId: config.sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Mirror to the renderer so the popover updates without a refetch.
	const claudeModePayload = {
		mode: claudeResolvedMode,
		reason: claudeResolvedReason,
		configDirKey: resolvedConfigDirKey,
		...(steeringUnavailable ? { steeringUnavailable } : {}),
	};
	if (deps.safeSend) {
		deps.safeSend('process:claude-mode-resolved', config.sessionId, claudeModePayload);
	} else {
		const mainWindow = deps.getMainWindow();
		if (isWebContentsAvailable(mainWindow)) {
			mainWindow.webContents.send(
				'process:claude-mode-resolved',
				config.sessionId,
				claudeModePayload
			);
		}
	}
}
