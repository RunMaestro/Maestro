import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
	useFilteredAndSortedSessions,
	type SearchMode,
	type SearchResult,
} from '../../renderer/hooks/agent/useFilteredAndSortedSessions';
import type { ClaudeSession } from '../../renderer/hooks/agent/useSessionViewer';

const makeSession = (overrides: Partial<ClaudeSession> = {}): ClaudeSession => ({
	sessionId: '11111111-aaaa-bbbb-cccc-111111111111',
	projectPath: '/repo',
	timestamp: '2026-01-01T00:00:00.000Z',
	modifiedAt: '2026-01-01T00:00:00.000Z',
	firstMessage: 'Start implementation',
	messageCount: 1,
	sizeBytes: 100,
	inputTokens: 10,
	outputTokens: 20,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	durationSeconds: 5,
	...overrides,
});

const renderFilteredSessions = ({
	sessions,
	search = '',
	searchMode = 'title',
	searchResults = [],
	isSearching = false,
	starredSessions = new Set<string>(),
	showAllSessions = true,
	namedOnly = false,
}: {
	sessions: ClaudeSession[];
	search?: string;
	searchMode?: SearchMode;
	searchResults?: SearchResult[];
	isSearching?: boolean;
	starredSessions?: Set<string>;
	showAllSessions?: boolean;
	namedOnly?: boolean;
}) =>
	renderHook(() =>
		useFilteredAndSortedSessions({
			sessions,
			search,
			searchMode,
			searchResults,
			isSearching,
			starredSessions,
			showAllSessions,
			namedOnly,
		})
	);

describe('useFilteredAndSortedSessions', () => {
	it('exposes visibility and search-result helpers for session rows', () => {
		const named = makeSession({
			sessionId: 'named-session',
			sessionName: 'Named Session',
		});
		const unnamed = makeSession({
			sessionId: 'unnamed-session',
			sessionName: undefined,
		});
		const searchResult: SearchResult = {
			sessionId: named.sessionId,
			matchType: 'assistant',
			matchPreview: 'Matched assistant text',
			matchCount: 2,
		};

		const { result } = renderFilteredSessions({
			sessions: [named, unnamed],
			searchResults: [searchResult],
			namedOnly: true,
		});

		expect(result.current.isSessionVisible(named)).toBe(true);
		expect(result.current.isSessionVisible(unnamed)).toBe(false);
		expect(result.current.filteredSessions).toEqual([named]);
		expect(result.current.getSearchResultInfo(named.sessionId)).toBe(searchResult);
		expect(result.current.getSearchResultInfo(unnamed.sessionId)).toBeUndefined();
	});

	it('keeps starred sessions above newer unstarred sessions', () => {
		const starred = makeSession({
			sessionId: 'starred-session',
			modifiedAt: '2026-01-01T00:00:00.000Z',
		});
		const newest = makeSession({
			sessionId: 'newest-session',
			modifiedAt: '2026-01-03T00:00:00.000Z',
		});
		const older = makeSession({
			sessionId: 'older-session',
			modifiedAt: '2026-01-02T00:00:00.000Z',
		});

		const { result } = renderFilteredSessions({
			sessions: [newest, starred, older],
			starredSessions: new Set([starred.sessionId]),
		});

		expect(result.current.filteredSessions.map((session) => session.sessionId)).toEqual([
			starred.sessionId,
			newest.sessionId,
			older.sessionId,
		]);
	});

	it('keeps a later starred session above an earlier unstarred session', () => {
		const unstarred = makeSession({
			sessionId: 'unstarred-session',
			modifiedAt: '2026-01-03T00:00:00.000Z',
		});
		const starred = makeSession({
			sessionId: 'starred-session',
			modifiedAt: '2026-01-01T00:00:00.000Z',
		});

		const { result } = renderFilteredSessions({
			sessions: [starred, unstarred],
			starredSessions: new Set([starred.sessionId]),
		});

		expect(result.current.filteredSessions.map((session) => session.sessionId)).toEqual([
			starred.sessionId,
			unstarred.sessionId,
		]);
	});

	it('matches title search against the first message and session name', () => {
		const firstMessageMatch = makeSession({
			sessionId: 'aaaaaaaa-aaaa-bbbb-cccc-111111111111',
			firstMessage: 'Implement billing workflow',
		});
		const sessionNameMatch = makeSession({
			sessionId: 'bbbbbbbb-aaaa-bbbb-cccc-222222222222',
			firstMessage: 'Unrelated title',
			sessionName: 'Release Notes Draft',
		});
		const miss = makeSession({
			sessionId: 'cccccccc-aaaa-bbbb-cccc-333333333333',
			firstMessage: 'Another unrelated title',
			sessionName: 'Archived conversation',
		});

		const byFirstMessage = renderFilteredSessions({
			sessions: [miss, firstMessageMatch],
			search: 'billing',
			searchMode: 'title',
		});
		expect(byFirstMessage.result.current.filteredSessions).toEqual([firstMessageMatch]);

		const bySessionName = renderFilteredSessions({
			sessions: [miss, sessionNameMatch],
			search: 'release notes',
			searchMode: 'title',
		});
		expect(bySessionName.result.current.filteredSessions).toEqual([sessionNameMatch]);
	});

	it('matches title search against the displayed first session-id octet', () => {
		const octetMatch = makeSession({
			sessionId: 'd02d0bd6-aaaa-bbbb-cccc-111111111111',
			firstMessage: 'Unrelated title',
			sessionName: undefined,
		});
		const miss = makeSession({
			sessionId: 'aaaaaaaa-aaaa-bbbb-cccc-222222222222',
			firstMessage: 'Another unrelated title',
			sessionName: undefined,
		});

		const { result } = renderFilteredSessions({
			sessions: [miss, octetMatch],
			search: 'D02D',
			searchMode: 'title',
		});

		expect(result.current.filteredSessions).toEqual([octetMatch]);
	});

	it('matches content searches by backend result and metadata fallbacks', () => {
		const backendMatch = makeSession({
			sessionId: 'backend-session',
			firstMessage: 'No title hit',
		});
		const matchingName = makeSession({
			sessionId: 'named-session',
			sessionName: 'Release Notes Draft',
			firstMessage: 'No title hit',
		});
		const matchingFullId = makeSession({
			sessionId: 'feedface-aaaa-bbbb-cccc-333333333333',
			firstMessage: 'No title hit',
		});
		const matchingOctet = makeSession({
			sessionId: 'cafebabe-aaaa-bbbb-cccc-444444444444',
			firstMessage: 'No title hit',
		});

		const byBackendResult = renderFilteredSessions({
			sessions: [matchingName, backendMatch],
			search: 'assistant response',
			searchMode: 'assistant',
			searchResults: [
				{
					sessionId: backendMatch.sessionId,
					matchType: 'assistant',
					matchPreview: 'assistant response',
					matchCount: 1,
				},
			],
		});
		expect(byBackendResult.result.current.filteredSessions).toEqual([backendMatch]);

		const byName = renderFilteredSessions({
			sessions: [matchingFullId, matchingName],
			search: 'release notes',
			searchMode: 'all',
		});
		expect(byName.result.current.filteredSessions).toEqual([matchingName]);

		const byFullId = renderFilteredSessions({
			sessions: [matchingName, matchingFullId],
			search: '333333333333',
			searchMode: 'assistant',
		});
		expect(byFullId.result.current.filteredSessions).toEqual([matchingFullId]);

		const byOctet = renderFilteredSessions({
			sessions: [matchingName, matchingOctet],
			search: 'CAFE',
			searchMode: 'user',
		});
		expect(byOctet.result.current.filteredSessions).toEqual([matchingOctet]);
	});

	it('returns visible sessions while a backend content search is in flight', () => {
		const visible = makeSession({ sessionId: 'visible-session' });
		const hiddenAgent = makeSession({ sessionId: 'agent-hidden-session' });

		const { result } = renderFilteredSessions({
			sessions: [hiddenAgent, visible],
			search: 'missing',
			searchMode: 'assistant',
			isSearching: true,
			showAllSessions: false,
		});

		expect(result.current.filteredSessions).toEqual([visible]);
	});

	it('returns no sessions when a completed content search has no matching rows', () => {
		const visible = makeSession({ sessionId: 'visible-session' });

		const { result } = renderFilteredSessions({
			sessions: [visible],
			search: 'not present',
			searchMode: 'all',
			isSearching: false,
		});

		expect(result.current.filteredSessions).toEqual([]);
	});
});
