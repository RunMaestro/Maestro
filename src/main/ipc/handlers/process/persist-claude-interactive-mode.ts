import type { BrowserWindow } from 'electron';
import Store from 'electron-store';
import { logger } from '../../../utils/logger';
import { isWebContentsAvailable } from '../../../utils/safe-send';
import type { ClaudeSpawnContext } from './resolve-claude-spawn-context';
import type { SpawnProcessConfig } from './spawn-types';

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
		baseSessionId,
		claudeResolvedMode,
		claudeResolvedReason,
		resolvedConfigDirKey,
	} = claudeContext;

	// Persist the resolved Claude headless-mode state back to the session
	// record and notify the renderer. Fires when:
	//   - Adaptive Mode's auto-resolver ran (toggle on), OR
	//   - The user wired `Path` directly at maestro-p (resolved-interactive
	//     without the toggle), OR
	//   - We need to clear stale `mode === 'interactive'` from a prior
	//     turn (both `resolvedConfigDirKey` above branches resolve it,
	//     gate on `!== undefined`).
	// When none of those apply we leave `claudeInteractive` alone — the
	// popover hides itself anyway when `enableMaestroP` is false.
	if (!isClaudeCode || !resolvedConfigDirKey) return;

	try {
		const allSessions = deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
		let mutated = false;
		const nextSessions = allSessions.map((s) => {
			if (s?.id !== baseSessionId) return s;
			const current = s.claudeInteractive as
				| {
						mode?: string;
						modeReason?: string;
						lastUsageSnapshotKey?: string;
				  }
				| undefined;
			if (
				current?.mode === claudeResolvedMode &&
				current?.modeReason === claudeResolvedReason &&
				current?.lastUsageSnapshotKey === resolvedConfigDirKey
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
