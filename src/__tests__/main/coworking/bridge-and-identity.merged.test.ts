// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/coworking/coworking-audit.test.ts
// Source: src/__tests__/main/coworking/coworking-session-id.test.ts
// Source: src/__tests__/main/coworking/coworking-types.test.ts
// Source: src/__tests__/main/coworking/pid-resolution.test.ts
import { describe, it, expect, vi } from 'vitest';
import { redactBrowserOpDetail } from '../../../main/coworking/coworking-audit';
import { resolveOwningMaestroSessionId } from '../../../main/coworking/coworking-session-id';
import {
	COWORKING_MCP_SERVER_NAME,
	COWORKING_SOCKET_ENV_VAR,
	formatCoworkingId,
	parseCoworkingId,
} from '../../../main/coworking/coworking-types';
import {
	resolveSessionFromPidWalk,
	MAX_PID_WALK_HOPS,
} from '../../../main/coworking/pid-resolution';
vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/coworking-test-userdata' },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Source: src/__tests__/main/coworking/coworking-audit.test.ts
describe('', () => {
	describe('redactBrowserOpDetail', () => {
		it('strips navigate URLs to origin+path with query/hash character counts', () => {
			const detail = redactBrowserOpDetail({
				kind: 'navigate',
				url: 'https://app.example.com/login?token=SECRET123#access=SECRET456',
			});
			// '?token=SECRET123' -> 15 query chars; '#access=SECRET456' -> 16 hash chars.
			expect(detail).toBe('url=https://app.example.com/login queryChars=15 hashChars=16');
			expect(detail).not.toContain('SECRET');
		});
		it('omits query/hash counts when the URL has neither', () => {
			expect(redactBrowserOpDetail({ kind: 'navigate', url: 'https://x.com/docs' })).toBe(
				'url=https://x.com/docs'
			);
		});
		it('reduces non-URL navigate targets to a character count, never verbatim', () => {
			const detail = redactBrowserOpDetail({ kind: 'navigate', url: 'my secret query' });
			expect(detail).toBe('url=<non-url textChars=15>');
			expect(detail).not.toContain('secret');
		});
		it('newTab redacts the URL the same way and appends the ephemeral flag', () => {
			expect(
				redactBrowserOpDetail({ kind: 'newTab', url: 'https://x.com/p?t=abc', ephemeral: true })
			).toBe('url=https://x.com/p queryChars=5 ephemeral');
			expect(redactBrowserOpDetail({ kind: 'newTab', url: 'https://x.com/p' })).toBe(
				'url=https://x.com/p'
			);
			expect(redactBrowserOpDetail({ kind: 'newTab', ephemeral: true })).toBe(
				'url=<default> ephemeral'
			);
			expect(redactBrowserOpDetail({ kind: 'newTab' })).toBe('url=<default>');
		});
		it('waitFor records the selector and timeout only when present', () => {
			expect(redactBrowserOpDetail({ kind: 'waitFor', selector: '#login', timeoutMs: 5000 })).toBe(
				'selector=#login timeoutMs=5000'
			);
			expect(redactBrowserOpDetail({ kind: 'waitFor', selector: '#login' })).toBe(
				'selector=#login'
			);
		});
		it('eval and type reduce free-form content to lengths, never verbatim', () => {
			const evalDetail = redactBrowserOpDetail({
				kind: 'eval',
				code: 'document.cookie = "leak"',
			});
			expect(evalDetail).toBe('codeLen=24');
			expect(evalDetail).not.toContain('cookie');
			const typeDetail = redactBrowserOpDetail({
				kind: 'type',
				selector: '#password',
				text: 'hunter2!',
			});
			expect(typeDetail).toBe('selector=#password textLen=8');
			expect(typeDetail).not.toContain('hunter2');
		});
	});
});
// Source: src/__tests__/main/coworking/coworking-session-id.test.ts
describe('', () => {
	describe('resolveOwningMaestroSessionId', () => {
		it('extracts the bare session id from an AI-tab composite', () => {
			expect(resolveOwningMaestroSessionId('session-123-ai-tab1')).toBe('session-123');
		});
		it('strips the forced-parallel suffix', () => {
			expect(resolveOwningMaestroSessionId('session-123-ai-tab1-fp-1712611230000')).toBe(
				'session-123'
			);
		});
		it('handles UUID-shaped session ids with embedded hyphens correctly', () => {
			const sid = '6e58a6c2-2b3f-4f81-9a1e-7b1f3a3a4444';
			expect(resolveOwningMaestroSessionId(`${sid}-ai-default`)).toBe(sid);
			expect(resolveOwningMaestroSessionId(`${sid}-ai-tab-with-dashes`)).toBe(sid);
		});
		it('handles the legacy `-ai` suffix', () => {
			expect(resolveOwningMaestroSessionId('session-123-ai')).toBe('session-123');
		});
		it('passes through non-composite ids unchanged', () => {
			expect(resolveOwningMaestroSessionId('session-123')).toBe('session-123');
			expect(resolveOwningMaestroSessionId('group-chat-abc-moderator-1')).toBe(
				'group-chat-abc-moderator-1'
			);
			expect(resolveOwningMaestroSessionId('session-123-synopsis-1234567890')).toBe(
				'session-123-synopsis-1234567890'
			);
			expect(resolveOwningMaestroSessionId('session-123-batch-1234567890')).toBe(
				'session-123-batch-1234567890'
			);
		});
		it('does NOT misinterpret `-ai` inside the project name as a tab marker', () => {
			// e.g. project named "openai-tools" used as part of a session id
			expect(resolveOwningMaestroSessionId('openai-tools-session')).toBe('openai-tools-session');
		});
	});
});
// Source: src/__tests__/main/coworking/coworking-types.test.ts
describe('', () => {
	describe('coworking-types', () => {
		it('exports stable string constants', () => {
			expect(COWORKING_MCP_SERVER_NAME).toBe('maestro-coworking');
			expect(COWORKING_SOCKET_ENV_VAR).toBe('MAESTRO_COWORKING_SOCKET');
		});
		describe('formatCoworkingId', () => {
			it('returns "term:N" for a positive integer', () => {
				expect(formatCoworkingId(1)).toBe('term:1');
				expect(formatCoworkingId(42)).toBe('term:42');
			});
		});
		describe('parseCoworkingId', () => {
			it('returns the numeric id for valid input', () => {
				expect(parseCoworkingId('term:1')).toBe(1);
				expect(parseCoworkingId('term:99')).toBe(99);
			});
			it('returns null for invalid input', () => {
				expect(parseCoworkingId('bogus')).toBeNull();
				expect(parseCoworkingId('term:')).toBeNull();
				expect(parseCoworkingId('term:abc')).toBeNull();
				expect(parseCoworkingId('term:0')).toBeNull();
				expect(parseCoworkingId('term:-1')).toBeNull();
				expect(parseCoworkingId('term:1.5')).toBeNull();
			});
		});
	});
});
// Source: src/__tests__/main/coworking/pid-resolution.test.ts
describe('', () => {
	describe('resolveSessionFromPidWalk', () => {
		it('returns the session id when the start pid is directly known', async () => {
			const lookup = vi.fn((pid: number) => (pid === 100 ? 'sess-A' : null));
			const getParent = vi.fn(async () => null);
			expect(await resolveSessionFromPidWalk(100, lookup, getParent)).toBe('sess-A');
			expect(lookup).toHaveBeenCalledTimes(1);
			// We hit on first try, so the walk does not consult getParent.
			expect(getParent).not.toHaveBeenCalled();
		});
		it('walks up the parent chain until it finds a known ancestor', async () => {
			// PID tree: 500 (mcp) -> 400 (shell) -> 300 (agent CLI, known)
			const lookup = (pid: number) => (pid === 300 ? 'sess-B' : null);
			const parents: Record<number, number> = { 500: 400, 400: 300, 300: 1 };
			const getParent = vi.fn(async (pid: number) => parents[pid] ?? null);
			expect(await resolveSessionFromPidWalk(500, lookup, getParent)).toBe('sess-B');
			// 500 (miss) -> getParent -> 400 (miss) -> getParent -> 300 (hit).
			expect(getParent).toHaveBeenCalledTimes(2);
		});
		it('gives up after MAX_PID_WALK_HOPS hops', async () => {
			const lookup = () => null;
			// An endlessly-deep chain that never resolves: 10 -> 9 -> 8 -> ...
			const getParent = vi.fn(async (pid: number) => (pid > 2 ? pid - 1 : null));
			expect(await resolveSessionFromPidWalk(100, lookup, getParent)).toBeNull();
			// The walk inspects start + up to MAX_PID_WALK_HOPS ancestors. Once an
			// iteration finds no match it calls getParent, so the call count is
			// bounded by MAX_PID_WALK_HOPS + 1 (the final hop's parent lookup).
			expect(getParent.mock.calls.length).toBeLessThanOrEqual(MAX_PID_WALK_HOPS + 1);
		});
		it('returns null when start pid is invalid', async () => {
			const lookup = vi.fn(() => 'sess-X');
			const getParent = vi.fn(async () => 200);
			expect(await resolveSessionFromPidWalk(0, lookup, getParent)).toBeNull();
			expect(await resolveSessionFromPidWalk(-1, lookup, getParent)).toBeNull();
			expect(await resolveSessionFromPidWalk(1, lookup, getParent)).toBeNull();
			expect(lookup).not.toHaveBeenCalled();
		});
		it('stops walking when getParent reports a self-cycle or pid<=1', async () => {
			const lookup = () => null;
			// Self-cycle: 50's parent is 50. Walk must terminate, not loop.
			const getParent = vi.fn(async (pid: number) => (pid === 50 ? 50 : null));
			expect(await resolveSessionFromPidWalk(50, lookup, getParent)).toBeNull();
			expect(getParent).toHaveBeenCalledTimes(1);
		});
		it('stops walking when getParent returns pid 1 (init/launchd)', async () => {
			const lookup = () => null;
			const getParent = vi.fn(async (pid: number) => (pid === 200 ? 1 : null));
			expect(await resolveSessionFromPidWalk(200, lookup, getParent)).toBeNull();
			expect(getParent).toHaveBeenCalledTimes(1);
		});
	});
});
