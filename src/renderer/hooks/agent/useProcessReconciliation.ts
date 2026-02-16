/**
 * useProcessReconciliation - Reconcile renderer session state with running processes after reload.
 *
 * When the Electron renderer reloads (F5, HMR, dev restart), main process child processes
 * survive but the renderer loses all in-memory session state. This hook queries the main
 * process for running processes on mount and restores session states to match reality.
 */

import { useEffect } from 'react';
import type { SessionState, Session } from '../../types';
import type { Toast } from '../../contexts/ToastContext';
import { useSessionStore } from '../../stores/sessionStore';
import type { BatchedUpdater } from './useAgentListeners';

export interface UseProcessReconciliationDeps {
	/** Batched updater for replaying output into terminal views */
	batchedUpdater: BatchedUpdater;
	/** Toast notification callback ref */
	addToastRef: React.RefObject<((toast: Omit<Toast, 'id' | 'timestamp'>) => void) | null>;
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

				const { setSessions } = useSessionStore.getState();

				setSessions((prev: Session[]) =>
					prev.map((session) => {
						// Find all processes belonging to this session
						const procs = runningProcesses.filter((p) => p.sessionId === session.id);
						if (procs.length === 0) return session;

						// Determine if the session should be marked busy
						const isAlreadyBusy = session.state === 'busy';
						if (isAlreadyBusy) return session;

						const proc = procs[0]; // Primary process for this session

						// Update tab-level state if tabId is present
						let updatedAiTabs = session.aiTabs;
						if (proc.tabId) {
							updatedAiTabs = session.aiTabs.map((tab) => {
								const tabProc = procs.find((p) => p.tabId === tab.id);
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

				// Replay recent output for each running process
				for (const proc of runningProcesses) {
					if (proc.recentOutput) {
						deps.batchedUpdater.appendLog(
							proc.sessionId,
							proc.tabId || null,
							!proc.isTerminal,
							proc.recentOutput,
						);
					}
				}

				// Show reconnection toast
				const agentCount = runningProcesses.filter((p) => !p.isTerminal).length;
				const terminalCount = runningProcesses.filter((p) => p.isTerminal).length;

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
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
}
