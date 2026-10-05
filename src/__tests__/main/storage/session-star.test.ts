import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Store from 'electron-store';

const mirror = vi.hoisted(() => ({
	snapshotStarredTranscript: vi.fn(async () => undefined),
	releaseTranscriptMirror: vi.fn(async () => undefined),
}));
vi.mock('../../../main/storage/starred-transcript-mirror', () => mirror);

import { setAgentSessionStar, setClaudeSessionStar } from '../../../main/storage/session-star';
import type { AgentSessionOriginsData, ClaudeSessionOriginsData } from '../../../main/stores/types';

/** Minimal in-memory electron-store double backed by a plain record. */
function makeStore<T>(origins: unknown = {}) {
	const data: Record<string, unknown> = { origins };
	const store = {
		data,
		get: vi.fn((key: string, fallback?: unknown) => (key in data ? data[key] : fallback)),
		set: vi.fn((key: string, value: unknown) => {
			data[key] = value;
		}),
	};
	return store as typeof store & Store<T>;
}

beforeEach(() => {
	mirror.snapshotStarredTranscript.mockClear();
	mirror.releaseTranscriptMirror.mockClear();
});

describe('setClaudeSessionStar', () => {
	it('stars the origin record and snapshots the transcript under the name the record holds', () => {
		const store = makeStore<ClaudeSessionOriginsData>({
			'/p': { s1: { origin: 'user', sessionName: 'Named' } },
		});
		setClaudeSessionStar(store, '/p', 's1', true);
		expect(store.data.origins).toEqual({
			'/p': { s1: { origin: 'user', sessionName: 'Named', starred: true } },
		});
		expect(mirror.snapshotStarredTranscript).toHaveBeenCalledWith({
			agentId: 'claude-code',
			projectPath: '/p',
			sessionId: 's1',
			sessionName: 'Named',
		});
		expect(mirror.releaseTranscriptMirror).not.toHaveBeenCalled();
	});

	it('snapshots with no name for a session that has none', () => {
		const store = makeStore<ClaudeSessionOriginsData>({});
		setClaudeSessionStar(store, '/p', 's1', true);
		expect(mirror.snapshotStarredTranscript).toHaveBeenCalledWith(
			expect.objectContaining({ sessionName: undefined })
		);
	});

	it('unstars the record and releases the mirror', () => {
		const store = makeStore<ClaudeSessionOriginsData>({
			'/p': { s1: { origin: 'user', starred: true } },
		});
		setClaudeSessionStar(store, '/p', 's1', false);
		expect(mirror.releaseTranscriptMirror).toHaveBeenCalledWith({
			agentId: 'claude-code',
			sessionId: 's1',
		});
		expect(mirror.snapshotStarredTranscript).not.toHaveBeenCalled();
	});
});

describe('setAgentSessionStar', () => {
	it('stars the generic origin record, keeping the name, and snapshots under that name', () => {
		const store = makeStore<AgentSessionOriginsData>({
			codex: { '/p': { s1: { sessionName: 'Named' } } },
		});
		setAgentSessionStar(store, 'codex', '/p', 's1', true);
		expect(store.data.origins).toEqual({
			codex: { '/p': { s1: { sessionName: 'Named', starred: true } } },
		});
		expect(mirror.snapshotStarredTranscript).toHaveBeenCalledWith({
			agentId: 'codex',
			projectPath: '/p',
			sessionId: 's1',
			sessionName: 'Named',
		});
	});

	it('creates the path to a session it has never seen', () => {
		const store = makeStore<AgentSessionOriginsData>({});
		setAgentSessionStar(store, 'codex', '/p', 's1', true);
		expect(store.data.origins).toEqual({ codex: { '/p': { s1: { starred: true } } } });
	});

	it('removes the star, and the record too when nothing else is left in it', () => {
		const store = makeStore<AgentSessionOriginsData>({
			codex: { '/p': { s1: { starred: true }, s2: { starred: true, sessionName: 'Keep' } } },
		});
		setAgentSessionStar(store, 'codex', '/p', 's1', false);
		setAgentSessionStar(store, 'codex', '/p', 's2', false);
		expect(store.data.origins).toEqual({ codex: { '/p': { s2: { sessionName: 'Keep' } } } });
		expect(mirror.releaseTranscriptMirror).toHaveBeenCalledTimes(2);
		expect(mirror.releaseTranscriptMirror).toHaveBeenCalledWith({
			agentId: 'codex',
			sessionId: 's1',
		});
	});

	it('unstarring a session the store never held is a quiet no-op for the record, and still releases', () => {
		const store = makeStore<AgentSessionOriginsData>({});
		setAgentSessionStar(store, 'codex', '/p', 'ghost', false);
		expect(store.data.origins).toEqual({ codex: { '/p': {} } });
		expect(mirror.releaseTranscriptMirror).toHaveBeenCalledWith({
			agentId: 'codex',
			sessionId: 'ghost',
		});
	});
});
