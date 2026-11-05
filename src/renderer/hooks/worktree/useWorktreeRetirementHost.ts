import { isWebDesktop } from '../../utils/runtimeContext';
import { useEffect } from 'react';
import {
	cancelRendererRetirement,
	completeRendererRetirement,
	isRendererRetirementCurrent,
	prepareRendererRetirement,
} from '../../services/worktreeRetirementPreparation';

/** Primary app lifetime owns the authoritative stores and reply listener. */
export function useWorktreeRetirementHost(): void {
	useEffect(() => {
		if (isWebDesktop()) return;
		const git = window.maestro.git;
		// Web/Lite bridges intentionally omit this desktop-only protocol.
		if (!git.onRetirementRendererRequest || !git.onRetirementRendererRelease) return;
		const tokens = new Map<string, string>();
		let disposed = false;
		let detached = false;
		const finish = () => {
			if (disposed && !tokens.size && !detached) {
				detached = true;
				stopRelease();
			}
		};
		const stopRelease = git.onRetirementRendererRelease((sessionId, token) => {
			cancelRendererRetirement(sessionId, token);
			if (tokens.get(sessionId) === token) tokens.delete(sessionId);
			finish();
		});
		const stopRequest = git.onRetirementRendererRequest((command) => {
			if (command.kind === 'prepare') {
				const result = prepareRendererRetirement(command.request);
				if (result.ok) tokens.set(command.request.sessionId, result.token);
				return result;
			}
			if (
				command.kind === 'complete' &&
				completeRendererRetirement(command.sessionId, command.token, command.revision)
			)
				return { ok: true, token: command.token, revision: command.revision };
			if (
				command.kind === 'check' &&
				isRendererRetirementCurrent(command.sessionId, command.token, command.revision)
			)
				return { ok: true, token: command.token, revision: command.revision };
			return { ok: false, reason: 'renderer preparation is no longer current' };
		});
		return () => {
			stopRequest();
			disposed = true;
			// Main decides whether abort is legal. An unmounted React root must
			// never locally thaw a reservation whose removal is already in flight.
			void Promise.all(
				[...tokens].map(async ([sessionId, token]) => {
					try {
						if (await git.abortWorktreeRetirement(token)) {
							cancelRendererRetirement(sessionId, token);
							if (tokens.get(sessionId) === token) tokens.delete(sessionId);
						}
					} catch {
						/* Main's lease/lifetime invalidation still owns the fence. */
					}
				})
			).finally(finish);
		};
	}, []);
}
