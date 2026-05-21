/**
 * Shared fixtures for SymphonyModal/components tests.
 */
import type { Theme } from '../../../../renderer/types';
import type {
	RegisteredRepository,
	SymphonyIssue,
	ActiveContribution,
	CompletedContribution,
} from '../../../../shared/symphony-types';
import type { Achievement } from '../../../../renderer/hooks/symphony/useContributorStats';

export const mockTheme: Theme = {
	id: 'dracula',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#111',
		bgSidebar: '#222',
		bgActivity: '#333',
		border: '#444',
		textMain: '#fff',
		textDim: '#aaa',
		accent: '#5af',
		accentDim: '#5af80',
		accentText: '#5af',
		accentForeground: '#000',
		success: '#0f0',
		warning: '#ff0',
		error: '#f00',
	},
};

export function makeRepo(overrides: Partial<RegisteredRepository> = {}): RegisteredRepository {
	return {
		slug: 'maestro/example',
		name: 'example',
		category: 'developer-tools',
		description: 'A test repository',
		url: 'https://github.com/maestro/example',
		stars: 1234,
		maintainer: { name: 'Maestro Team' },
		tags: ['tag-a', 'tag-b'],
		...overrides,
	} as RegisteredRepository;
}

export function makeIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
	return {
		number: 42,
		title: 'Improve error handling',
		body: 'Body text',
		htmlUrl: 'https://github.com/maestro/example/issues/42',
		status: 'available',
		labels: [],
		documentPaths: [{ name: 'spec.md', path: 'docs/spec.md', isExternal: false }],
		...overrides,
	} as SymphonyIssue;
}

export function makeActiveContribution(
	overrides: Partial<ActiveContribution> = {}
): ActiveContribution {
	return {
		id: 'contrib-1',
		sessionId: 'session-1',
		repoSlug: 'maestro/example',
		issueNumber: 42,
		issueTitle: 'Improve error handling',
		status: 'running',
		progress: {
			completedDocuments: 1,
			totalDocuments: 4,
			currentDocument: 'docs/spec.md',
			currentTask: null,
		},
		timeSpent: 75_000,
		tokenUsage: { inputTokens: 12_000, outputTokens: 4_000, estimatedCost: 0.123 },
		...overrides,
	} as ActiveContribution;
}

export function makeCompletedContribution(
	overrides: Partial<CompletedContribution> = {}
): CompletedContribution {
	return {
		id: 'completed-1',
		repoSlug: 'maestro/example',
		issueNumber: 7,
		issueTitle: 'A finished thing',
		prNumber: 11,
		prUrl: 'https://github.com/maestro/example/pull/11',
		completedAt: '2025-03-15T12:00:00Z',
		documentsProcessed: 3,
		tasksCompleted: 12,
		tokenUsage: { inputTokens: 30_000, outputTokens: 5_000, totalCost: 0.42 },
		...overrides,
	} as CompletedContribution;
}

export function makeAchievement(overrides: Partial<Achievement> = {}): Achievement {
	return {
		id: 'first-pr',
		title: 'First PR',
		description: 'Submit your first contribution',
		icon: '🎉',
		earned: false,
		...overrides,
	} as Achievement;
}
