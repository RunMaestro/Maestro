/**
 * Preload API for Symphony operations
 *
 * Provides the window.maestro.symphony namespace for:
 * - Registry and issue fetching
 * - Contribution lifecycle management
 * - Real-time updates
 */

import { ipcRenderer } from 'electron';

// Types for Symphony API
export interface SymphonyRepository {
	slug: string;
	name: string;
	description: string;
	url: string;
	category: string;
	tags?: string[];
	maintainer: { name: string; url?: string };
	isActive: boolean;
	featured?: boolean;
	addedAt: string;
}

export interface SymphonyRegistry {
	schemaVersion: '1.0';
	lastUpdated: string;
	repositories: SymphonyRepository[];
}

export interface DocumentReference {
	name: string;
	path: string;
	isExternal: boolean;
}

export interface ClaimedByPR {
	number: number;
	url: string;
	author: string;
	isDraft: boolean;
}

export interface SymphonyIssue {
	number: number;
	title: string;
	body: string;
	url: string;
	htmlUrl: string;
	author: string;
	createdAt: string;
	updatedAt: string;
	documentPaths: DocumentReference[];
	status: 'available' | 'in_progress' | 'completed';
	claimedByPr?: ClaimedByPR;
}

export interface ContributionProgress {
	totalDocuments: number;
	completedDocuments: number;
	currentDocument?: string;
	totalTasks: number;
	completedTasks: number;
}

export interface ContributionTokenUsage {
	inputTokens: number;
	outputTokens: number;
	estimatedCost: number;
}

export interface ActiveContribution {
	id: string;
	repoSlug: string;
	repoName: string;
	issueNumber: number;
	issueTitle: string;
	localPath: string;
	branchName: string;
	draftPrNumber?: number;
	draftPrUrl?: string;
	startedAt: string;
	status: string;
	progress: ContributionProgress;
	tokenUsage: ContributionTokenUsage;
	timeSpent: number;
	sessionId: string;
	agentType: string;
	error?: string;
}

export interface CompletedTokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
}

export interface CompletedContribution {
	id: string;
	repoSlug: string;
	repoName: string;
	issueNumber: number;
	issueTitle: string;
	startedAt: string;
	completedAt: string;
	prUrl: string;
	prNumber: number;
	tokenUsage: CompletedTokenUsage;
	timeSpent: number;
	documentsProcessed: number;
	tasksCompleted: number;
	outcome?: 'merged' | 'closed' | 'open' | 'unknown';
}

export interface ContributorStats {
	totalContributions: number;
	totalDocumentsProcessed: number;
	totalTasksCompleted: number;
	totalTokensUsed: number;
	totalTimeSpent: number;
	estimatedCostDonated: number;
	repositoriesContributed: string[];
	firstContributionAt?: string;
	lastContributionAt?: string;
	currentStreak: number;
	longestStreak: number;
	lastContributionDate?: string;
}

export interface SymphonyState {
	active: ActiveContribution[];
	history: CompletedContribution[];
	stats: ContributorStats;
}

export interface GetRegistryResponse {
	success: boolean;
	registry?: SymphonyRegistry;
	fromCache?: boolean;
	cacheAge?: number;
	error?: string;
}

export interface GetIssuesResponse {
	success: boolean;
	issues?: SymphonyIssue[];
	fromCache?: boolean;
	cacheAge?: number;
	error?: string;
}

export interface GetStateResponse {
	success: boolean;
	state?: SymphonyState;
	error?: string;
}

export interface StartContributionParams {
	repoSlug: string;
	repoUrl: string;
	repoName: string;
	issueNumber: number;
	issueTitle: string;
	documentPaths: DocumentReference[];
	agentType: string;
	sessionId: string;
	baseBranch?: string;
	autoRunFolderPath?: string;
}

export interface StartContributionResponse {
	success: boolean;
	contributionId?: string;
	localPath?: string;
	branchName?: string;
	error?: string;
}

export interface CreateDraftPRResponse {
	success: boolean;
	prUrl?: string;
	prNumber?: number;
	error?: string;
}

export interface CompleteContributionResponse {
	success: boolean;
	prUrl?: string;
	prNumber?: number;
	error?: string;
}

/**
 * Creates the Symphony API object for preload exposure
 */
export function createSymphonyApi() {
	return {
		// Registry operations
		getRegistry: (forceRefresh?: boolean): Promise<GetRegistryResponse> =>
			ipcRenderer.invoke('symphony:getRegistry', forceRefresh),

		getIssues: (repoSlug: string, forceRefresh?: boolean): Promise<GetIssuesResponse> =>
			ipcRenderer.invoke('symphony:getIssues', repoSlug, forceRefresh),

		// State operations
		getState: (): Promise<GetStateResponse> => ipcRenderer.invoke('symphony:getState'),

		getActive: (): Promise<{
			success: boolean;
			contributions?: ActiveContribution[];
			error?: string;
		}> => ipcRenderer.invoke('symphony:getActive'),

		getCompleted: (
			limit?: number
		): Promise<{ success: boolean; contributions?: CompletedContribution[]; error?: string }> =>
			ipcRenderer.invoke('symphony:getCompleted', limit),

		getStats: (): Promise<{ success: boolean; stats?: ContributorStats; error?: string }> =>
			ipcRenderer.invoke('symphony:getStats'),

		// Contribution lifecycle
		start: (params: StartContributionParams): Promise<StartContributionResponse> =>
			ipcRenderer.invoke('symphony:start', params),

		registerActive: (params: {
			contributionId: string;
			repoSlug: string;
			repoName: string;
			issueNumber: number;
			issueTitle: string;
			localPath: string;
			branchName: string;
			sessionId: string;
			agentType: string;
			totalDocuments: number;
		}): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('symphony:registerActive', params),

		updateStatus: (params: {
			contributionId: string;
			status?: string;
			progress?: Partial<ContributionProgress>;
			tokenUsage?: Partial<ContributionTokenUsage>;
			timeSpent?: number;
			error?: string;
			draftPrNumber?: number;
			draftPrUrl?: string;
		}): Promise<{ success: boolean; updated?: boolean; error?: string }> =>
			ipcRenderer.invoke('symphony:updateStatus', params),

		complete: (params: {
			contributionId: string;
			prBody?: string;
		}): Promise<CompleteContributionResponse> => ipcRenderer.invoke('symphony:complete', params),

		cancel: (
			contributionId: string,
			cleanup?: boolean
		): Promise<{ success: boolean; cancelled?: boolean; error?: string }> =>
			ipcRenderer.invoke('symphony:cancel', contributionId, cleanup),

		checkPRStatuses: (): Promise<{
			success: boolean;
			checked?: number;
			merged?: number;
			closed?: number;
			errors?: string[];
			error?: string;
		}> => ipcRenderer.invoke('symphony:checkPRStatuses'),

		syncContribution: (
			contributionId: string
		): Promise<{
			success: boolean;
			message?: string;
			prCreated?: boolean;
			prMerged?: boolean;
			prClosed?: boolean;
			error?: string;
		}> => ipcRenderer.invoke('symphony:syncContribution', contributionId),

		// Cache operations
		clearCache: (): Promise<{ success: boolean; cleared?: boolean; error?: string }> =>
			ipcRenderer.invoke('symphony:clearCache'),

		// Clone and contribution start helpers
		cloneRepo: (params: {
			repoUrl: string;
			localPath: string;
		}): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('symphony:cloneRepo', params),

		startContribution: (params: {
			contributionId: string;
			sessionId: string;
			repoSlug: string;
			issueNumber: number;
			issueTitle: string;
			localPath: string;
			documentPaths: DocumentReference[];
		}): Promise<{
			success: boolean;
			branchName?: string;
			draftPrNumber?: number;
			draftPrUrl?: string;
			autoRunPath?: string;
			error?: string;
		}> => ipcRenderer.invoke('symphony:startContribution', params),

		createDraftPR: (params: {
			contributionId: string;
			title: string;
			body: string;
		}): Promise<CreateDraftPRResponse> => ipcRenderer.invoke('symphony:createDraftPR', params),

		fetchDocumentContent: (
			url: string
		): Promise<{ success: boolean; content?: string; error?: string }> =>
			ipcRenderer.invoke('symphony:fetchDocumentContent', { url }),

		// Real-time updates
		onUpdated: (callback: () => void) => {
			const handler = () => callback();
			ipcRenderer.on('symphony:updated', handler);
			return () => ipcRenderer.removeListener('symphony:updated', handler);
		},

		onContributionStarted: (
			callback: (data: {
				contributionId: string;
				sessionId: string;
				localPath: string;
				branchName: string;
			}) => void
		) => {
			const handler = (
				_event: Electron.IpcRendererEvent,
				data: {
					contributionId: string;
					sessionId: string;
					localPath: string;
					branchName: string;
				}
			) => callback(data);
			ipcRenderer.on('symphony:contributionStarted', handler);
			return () => ipcRenderer.removeListener('symphony:contributionStarted', handler);
		},

		onPRCreated: (
			callback: (data: { contributionId: string; prNumber: number; prUrl: string }) => void
		) => {
			const handler = (
				_event: Electron.IpcRendererEvent,
				data: {
					contributionId: string;
					prNumber: number;
					prUrl: string;
				}
			) => callback(data);
			ipcRenderer.on('symphony:prCreated', handler);
			return () => ipcRenderer.removeListener('symphony:prCreated', handler);
		},
	};
}

export type SymphonyApi = ReturnType<typeof createSymphonyApi>;
