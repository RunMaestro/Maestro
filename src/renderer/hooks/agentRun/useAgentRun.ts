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

	const clearSelection = useCallback(() => {
		setSelectedRun(null);
		setSelectedRunEvents([]);
		setSelectedCampaign(null);
	}, []);

	useEffect(() => {
		if (options.loadOnMount === false) return;

		void Promise.all([refreshRuns(), refreshCampaigns()]);
	}, [options.loadOnMount, refreshRuns, refreshCampaigns]);

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
		clearSelection,
	};
}
