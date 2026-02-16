/**
 * useProcessReconciliation - Reconcile renderer session state with running processes after reload.
 *
 * When the Electron renderer reloads (F5, HMR, dev restart), main process child processes
 * survive but the renderer loses all in-memory session state. This hook queries the main
 * process for running processes on mount and restores session states to match reality.
 *
 * Key detail: the main process stores composite session IDs (e.g. `{uuid}-ai-{tabId}`,
 * `{uuid}-terminal`, `{uuid}-batch-{ts}`) while the renderer's Session.id is the bare UUID.
 * We use parseSessionId() to extract the base session ID for matching.
 */

import { useEffect } from 'react';
import type { SessionState, Session } from '../../types';
import type { Toast } from '../../contexts/ToastContext';
import { useSessionStore } from '../../stores/sessionStore';
import { parseSessionId } from '../../utils/sessionIdParser';
import type { BatchedUpdater } from './useAgentListeners';

/** Suffix used for terminal process session IDs */
const TERMINAL_SUFFIX = '-terminal';

export interface UseProcessReconciliationDeps {
	/** Batched updater for replaying output into terminal views */
	batchedUpdater: BatchedUpdater;
	/** Toast notification callback ref */
	addToastRef: React.RefObject<((toast: Omit<Toast, 'id' | 'timestamp'>) => void) | null>;
}

/**
 * Extract the base session UUID and tab ID from a composite process session ID.
 *
 * Handles all formats:
 * - `{uuid}-ai-{tabId}` → { baseId: uuid, tabId }
 * - `{uuid}-terminal` → { baseId: uuid, tabId: null }
 * - `{uuid}-batch-{ts}` → { baseId: uuid, tabId: null }
 * - `{uuid}-synopsis-{ts}` → { baseId: uuid, tabId: null }
 * - `{uuid}` → { baseId: uuid, tabId: null }
 */
function extractIds(processSessionId: string): { baseId: string; tabId: string | null } {
	// Handle terminal suffix (not covered by parseSessionId)
	if (processSessionId.endsWith(TERMINAL_SUFFIX)) {
		return {
			baseId: processSessionId.slice(0, -TERMINAL_SUFFIX.length),
			tabId: null,
		};
	}

	const parsed = parseSessionId(processSessionId);
	return {
		baseId: parsed.baseSessionId,
		tabId: parsed.tabId,
	};
}

/**
 * On mount, queries the main process for still-running processes and reconciles
 * session states (busy/idle) and tab states to match reality.
 */
export function useProcessReconciliation(deps: UseProcessReconciliationDeps): void {
	useEffect(() => {
		let cancelled = false;

		async function reconcileProcesses() {
			try {
				const runningProcesses = await window.maestro.process.reconcileAfterReload();
				if (cancelled || runningProcesses.length === 0) return;

				// Pre-parse all process session IDs to extract base session UUID and tab ID
				const parsedProcesses = runningProcesses.map((p) => {
					const { baseId, tabId } = extractIds(p.sessionId);
					return { ...p, baseId, extractedTabId: tabId };
				});

				const { setSessions } = useSessionStore.getState();

				setSessions((prev: Session[]) =>
					prev.map((session) => {
						// Match processes by base session UUID
						const procs = parsedProcesses.filter((p) => p.baseId === session.id);
						if (procs.length === 0) return session;

						// Already busy — don't double-update
						const isAlreadyBusy = session.state === 'busy';
						if (isAlreadyBusy) return session;

						const proc = procs[0]; // Primary process for this session

						// Update tab-level state using extracted tab IDs
						let updatedAiTabs = session.aiTabs;
						const aiProcs = procs.filter((p) => p.extractedTabId);
						if (aiProcs.length > 0) {
							updatedAiTabs = session.aiTabs.map((tab) => {
								const tabProc = aiProcs.find((p) => p.extractedTabId === tab.id);
								if (!tabProc) return tab;
								if (tab.state === 'busy') return tab;
								return {
									...tab,
									state: 'busy' as const,
									thinkingStartTime: tabProc.startTime,
								};
							});
						}

						return {
							...session,
							state: 'busy' as SessionState,
							busySource: proc.isTerminal ? 'terminal' : 'ai',
							thinkingStartTime: proc.startTime,
							aiTabs: updatedAiTabs,
						};
					})
				);

				// Replay recent output for each running process.
				// appendLog expects the base session UUID, not the composite process ID.
				for (const proc of parsedProcesses) {
					if (proc.recentOutput) {
						deps.batchedUpdater.appendLog(
							proc.baseId,
							proc.extractedTabId,
							!proc.isTerminal,
							proc.recentOutput,
						);
					}
				}

				// Show reconnection toast
				const agentCount = parsedProcesses.filter((p) => !p.isTerminal).length;
				const terminalCount = parsedProcesses.filter((p) => p.isTerminal).length;

				const parts: string[] = [];
				if (agentCount > 0) parts.push(`${agentCount} agent${agentCount > 1 ? 's' : ''}`);
				if (terminalCount > 0) parts.push(`${terminalCount} terminal${terminalCount > 1 ? 's' : ''}`);

				if (parts.length > 0) {
					deps.addToastRef.current?.({
						type: 'success',
						title: 'Reconnected',
						message: `Reconnected to ${parts.join(' and ')}`,
					});
				}
			} catch (err) {
				console.error('Process reconciliation failed:', err);
			}
		}

		reconcileProcesses();

		return () => {
			cancelled = true;
		};
	}, []);
}
