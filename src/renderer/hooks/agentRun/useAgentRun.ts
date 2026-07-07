import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentRun, AgentRunEvent } from '../../../shared/agent-run';
import type { Campaign } from '../../../shared/campaign';
import {
	agentRunService,
	type AgentRunListOptions,
	type CampaignListOptions,
} from '../../services/agentRun';

export interface UseAgentRunOptions {
	runs?: AgentRunListOptions;
	campaigns?: CampaignListOptions;
	loadOnMount?: boolean;
}

export interface UseAgentRunResult {
	runs: AgentRun[];
	campaigns: Campaign[];
	selectedRun: AgentRun | null;
	selectedRunEvents: AgentRunEvent[];
	selectedCampaign: Campaign | null;
	loading: boolean;
	error: string | null;
	refreshRuns: (options?: AgentRunListOptions) => Promise<AgentRun[]>;
	refreshCampaigns: (options?: CampaignListOptions) => Promise<Campaign[]>;
	showRun: (runId: string) => Promise<AgentRun | null>;
	loadRunEvents: (runId: string) => Promise<AgentRunEvent[]>;
	showCampaign: (campaignId: string) => Promise<Campaign | null>;
	cancelRun: (runId: string) => Promise<boolean>;
	retryRun: (runId: string) => Promise<boolean>;
	resolveFinding: (
		runId: string,
		findingIndex: number,
		status: 'fixed' | 'dismissed'
	) => Promise<boolean>;
	mergeRun: (runId: string) => Promise<boolean>;
	clearSelection: () => void;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useAgentRun(options: UseAgentRunOptions = {}): UseAgentRunResult {
	const [runs, setRuns] = useState<AgentRun[]>([]);
	const [campaigns, setCampaigns] = useState<Campaign[]>([]);
	const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null);
	const [selectedRunEvents, setSelectedRunEvents] = useState<AgentRunEvent[]>([]);
	const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const runsOptionsRef = useRef(options.runs);
	const campaignsOptionsRef = useRef(options.campaigns);
	const mountedRef = useRef(true);
	const pendingCountRef = useRef(0);
	const runsRequestIdRef = useRef(0);
	const campaignsRequestIdRef = useRef(0);
	const runRequestIdRef = useRef(0);
	const eventsRequestIdRef = useRef(0);
	const campaignRequestIdRef = useRef(0);
	runsOptionsRef.current = options.runs;
	campaignsOptionsRef.current = options.campaigns;
	const selectedRunIdRef = useRef<string | null>(null);
	selectedRunIdRef.current = selectedRun?.id ?? null;

	const startRequest = useCallback(() => {
		pendingCountRef.current += 1;
		setLoading(true);
		setError(null);
	}, []);

	const finishRequest = useCallback(() => {
		pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
		if (mountedRef.current && pendingCountRef.current === 0) {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const refreshRuns = useCallback(
		async (overrideOptions?: AgentRunListOptions) => {
			const requestId = ++runsRequestIdRef.current;
			startRequest();
			try {
				const nextRuns = await agentRunService.list(overrideOptions ?? runsOptionsRef.current);
				if (mountedRef.current && requestId === runsRequestIdRef.current) {
					setRuns(nextRuns);
				}
				return nextRuns;
			} catch (err) {
				const message = toErrorMessage(err);
				if (mountedRef.current && requestId === runsRequestIdRef.current) {
					setError(message);
				}
				return [];
			} finally {
				finishRequest();
			}
		},
		[finishRequest, startRequest]
	);

	const refreshCampaigns = useCallback(
		async (overrideOptions?: CampaignListOptions) => {
			const requestId = ++campaignsRequestIdRef.current;
			startRequest();
			try {
				const nextCampaigns = await agentRunService.campaigns.list(
					overrideOptions ?? campaignsOptionsRef.current
				);
				if (mountedRef.current && requestId === campaignsRequestIdRef.current) {
					setCampaigns(nextCampaigns);
				}
				return nextCampaigns;
			} catch (err) {
				const message = toErrorMessage(err);
				if (mountedRef.current && requestId === campaignsRequestIdRef.current) {
					setError(message);
				}
				return [];
			} finally {
				finishRequest();
			}
		},
		[finishRequest, startRequest]
	);

	const showRun = useCallback(
		async (runId: string) => {
			const requestId = ++runRequestIdRef.current;
			startRequest();
			try {
				const run = await agentRunService.show(runId);
				if (mountedRef.current && requestId === runRequestIdRef.current) {
					setSelectedRun(run);
				}
				return run;
			} catch (err) {
				const message = toErrorMessage(err);
				if (mountedRef.current && requestId === runRequestIdRef.current) {
					setError(message);
					setSelectedRun(null);
				}
				return null;
			} finally {
				finishRequest();
			}
		},
		[finishRequest, startRequest]
	);

	const loadRunEvents = useCallback(
		async (runId: string) => {
			const requestId = ++eventsRequestIdRef.current;
			startRequest();
			try {
				const events = await agentRunService.events(runId);
				if (mountedRef.current && requestId === eventsRequestIdRef.current) {
					setSelectedRunEvents(events);
				}
				return events;
			} catch (err) {
				const message = toErrorMessage(err);
				if (mountedRef.current && requestId === eventsRequestIdRef.current) {
					setError(message);
					setSelectedRunEvents([]);
				}
				return [];
			} finally {
				finishRequest();
			}
		},
		[finishRequest, startRequest]
	);

	const showCampaign = useCallback(
		async (campaignId: string) => {
			const requestId = ++campaignRequestIdRef.current;
			startRequest();
			try {
				const campaign = await agentRunService.campaigns.show(campaignId);
				if (mountedRef.current && requestId === campaignRequestIdRef.current) {
					setSelectedCampaign(campaign);
				}
				return campaign;
			} catch (err) {
				const message = toErrorMessage(err);
				if (mountedRef.current && requestId === campaignRequestIdRef.current) {
					setError(message);
					setSelectedCampaign(null);
				}
				return null;
			} finally {
				finishRequest();
			}
		},
		[finishRequest, startRequest]
	);

	// Shared mutation runner for the F4 control actions. Runs the action, then
	// refreshes the run list and re-shows the currently selected run so the UI
	// reflects the new status/findings/merge outcome. On failure (including a
	// gated destructive action) the error is surfaced and the call returns false.
	const runAction = useCallback(
		async (action: () => Promise<AgentRun>): Promise<boolean> => {
			startRequest();
			try {
				await action();
				return true;
			} catch (err) {
				if (mountedRef.current) setError(toErrorMessage(err));
				return false;
			} finally {
				finishRequest();
				await refreshRuns();
				const selectedId = selectedRunIdRef.current;
				if (selectedId) await showRun(selectedId);
			}
		},
		[finishRequest, refreshRuns, showRun, startRequest]
	);

	const cancelRun = useCallback(
		(runId: string) => runAction(() => agentRunService.cancel(runId)),
		[runAction]
	);

	const retryRun = useCallback(
		(runId: string) => runAction(() => agentRunService.retry(runId)),
		[runAction]
	);

	const resolveFinding = useCallback(
		(runId: string, findingIndex: number, status: 'fixed' | 'dismissed') =>
			runAction(() => agentRunService.resolveFinding(runId, findingIndex, status)),
		[runAction]
	);

	const mergeRun = useCallback(
		(runId: string) => runAction(() => agentRunService.merge(runId)),
		[runAction]
	);

	const clearSelection = useCallback(() => {
		setSelectedRun(null);
		setSelectedRunEvents([]);
		setSelectedCampaign(null);
	}, []);

	useEffect(() => {
		if (options.loadOnMount === false) return;

		void Promise.all([refreshRuns(), refreshCampaigns()]);
	}, [options.loadOnMount, refreshRuns, refreshCampaigns]);

	// Live push (F3): coalesce rapid updates into a single refresh so a burst of
	// events is one re-render, not one per event (ISC-3.7). Unsubscribe on unmount
	// leaves no dangling IPC listener (ISC-3.6).
	useEffect(() => {
		const api = window.maestro?.agentRun;
		if (!api?.onUpdated || !api?.onEventAppended) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const scheduleRefresh = (): void => {
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				void refreshRuns();
			}, 120);
		};
		const unsubUpdated = api.onUpdated(scheduleRefresh);
		const unsubEvent = api.onEventAppended((event) => {
			if (event.runId === selectedRunIdRef.current) void loadRunEvents(event.runId);
			scheduleRefresh();
		});
		return () => {
			clearTimeout(timer ?? undefined);
			unsubUpdated();
			unsubEvent();
		};
	}, [refreshRuns, loadRunEvents]);

	return {
		runs,
		campaigns,
		selectedRun,
		selectedRunEvents,
		selectedCampaign,
		loading,
		error,
		refreshRuns,
		refreshCampaigns,
		showRun,
		loadRunEvents,
		showCampaign,
		cancelRun,
		retryRun,
		resolveFinding,
		mergeRun,
		clearSelection,
	};
}
