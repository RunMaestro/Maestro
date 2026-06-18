import type React from 'react';
import type { Session } from '../../../types';
import type { NotifyToastInput } from '../../../stores/notificationStore';
import { captureException } from '../../../utils/sentry';
import type { QuickAction } from '../types';

interface BuildDebugCommandsArgs {
	activeSession: Session | undefined;
	activeSessionId: string;
	sessions: Session[];
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setQuickActionOpen: (open: boolean) => void;
	setPlaygroundOpen?: (open: boolean) => void;
	setDebugApplicationStatsOpen?: (open: boolean) => void;
	setDebugAgentProbeOpen?: (open: boolean) => void;
	setDebugWizardModalOpen?: (open: boolean) => void;
	onDebugReleaseQueuedItem?: () => void;
	getInstallationId: () => Promise<string | null | undefined>;
	safeClipboardWrite: (text: string) => Promise<boolean>;
	flashCopiedToClipboard: (value: string, message?: string) => void;
	notifyToast: (args: NotifyToastInput) => void;
	logger: {
		info: (message: string, context?: string, value?: unknown) => void;
		warn: (message: string, context?: string, value?: unknown) => void;
		error: (message: string, context?: string, error?: unknown) => void;
	};
}

function resetSessionBusyState(session: Session): Session {
	return {
		...session,
		state: 'idle' as const,
		busySource: undefined,
		thinkingStartTime: undefined,
		currentCycleTokens: undefined,
		currentCycleBytes: undefined,
		aiTabs: session.aiTabs?.map((tab) => ({
			...tab,
			state: 'idle' as const,
			thinkingStartTime: undefined,
		})),
	};
}

export function buildDebugCommands({
	activeSession,
	activeSessionId,
	sessions,
	setSessions,
	setQuickActionOpen,
	setPlaygroundOpen,
	setDebugApplicationStatsOpen,
	setDebugAgentProbeOpen,
	setDebugWizardModalOpen,
	onDebugReleaseQueuedItem,
	getInstallationId,
	safeClipboardWrite,
	flashCopiedToClipboard,
	notifyToast,
	logger,
}: BuildDebugCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [
		{
			id: 'debugResetBusy',
			label: 'Debug: Reset Busy State',
			subtext: 'Clear stuck thinking/busy state for all sessions',
			action: () => {
				setSessions((prev) => prev.map(resetSessionBusyState));
				logger.info('[Debug] Reset busy state for all sessions');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'debugLogSessions',
			label: 'Debug: Log Session State',
			subtext: 'Print session state to DevTools console',
			action: () => {
				console.log(
					'[Debug] All sessions:',
					sessions.map((session) => ({
						id: session.id,
						name: session.name,
						state: session.state,
						busySource: session.busySource,
						thinkingStartTime: session.thinkingStartTime,
						tabs: session.aiTabs?.map((tab) => ({
							id: tab.id.substring(0, 8),
							name: tab.name,
							state: tab.state,
							thinkingStartTime: tab.thinkingStartTime,
						})),
					}))
				);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'debugCopyInstallGuid',
			label: 'Debug: Copy Install GUID to Clipboard',
			subtext: 'Copy your unique installation identifier',
			action: async () => {
				try {
					const installationId = await getInstallationId();
					if (installationId) {
						const ok = await safeClipboardWrite(installationId);
						if (ok) {
							flashCopiedToClipboard(installationId, 'Install GUID Copied');
							logger.info(
								'[Debug] Installation GUID copied to clipboard:',
								undefined,
								installationId
							);
						} else {
							notifyToast({
								type: 'error',
								title: 'Error',
								message: 'Failed to copy installation GUID',
							});
							logger.error('[Debug] Failed to copy Installation GUID', undefined, installationId);
						}
					} else {
						notifyToast({ type: 'error', title: 'Error', message: 'No installation GUID found' });
						logger.warn('[Debug] No installation GUID found');
					}
				} catch (err) {
					notifyToast({
						type: 'error',
						title: 'Error',
						message: 'Failed to copy installation GUID',
					});
					logger.error('[Debug] Failed to copy installation GUID:', undefined, err);
					captureException(err);
				}
				setQuickActionOpen(false);
			},
		},
	];

	if (activeSession) {
		commands.push({
			id: 'debugResetSession',
			label: 'Debug: Reset Current Session',
			subtext: `Clear busy state for ${activeSession.name}`,
			action: () => {
				setSessions((prev) =>
					prev.map((session) =>
						session.id === activeSessionId ? resetSessionBusyState(session) : session
					)
				);
				logger.info('[Debug] Reset busy state for session:', undefined, activeSessionId);
				setQuickActionOpen(false);
			},
		});
	}

	if (setPlaygroundOpen) {
		commands.push({
			id: 'debugPlayground',
			label: 'Debug: Playground',
			subtext: 'Open the developer playground',
			action: () => {
				setPlaygroundOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (setDebugApplicationStatsOpen) {
		commands.push({
			id: 'debugApplicationStats',
			label: 'Debug: View Application Stats',
			subtext: 'Memory and data footprint per loaded agent',
			action: () => {
				setDebugApplicationStatsOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (setDebugAgentProbeOpen) {
		commands.push({
			id: 'debugAgentProbe',
			label: 'Debug: Re-Probe Agents',
			subtext: 'Re-detect each agent binary and refresh readiness',
			action: () => {
				setDebugAgentProbeOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession && activeSession.executionQueue?.length > 0 && onDebugReleaseQueuedItem) {
		commands.push({
			id: 'debugReleaseQueued',
			label: 'Debug: Release Next Queued Item',
			subtext: `Process next item from queue (${activeSession.executionQueue.length} queued)`,
			action: () => {
				onDebugReleaseQueuedItem();
				setQuickActionOpen(false);
			},
		});
	}

	if (setDebugWizardModalOpen) {
		commands.push({
			id: 'debugWizardPhaseReview',
			label: 'Debug: Wizard → Review Playbooks',
			subtext: 'Jump directly to Phase Review step (requires existing Auto Run docs)',
			action: () => {
				setDebugWizardModalOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
