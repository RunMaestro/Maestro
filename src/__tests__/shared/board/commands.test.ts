import { describe, expect, it, vi } from 'vitest';
import { answerBoardCommand, parseBoardCommand } from '../../../shared/board/commands';
import { createRequestHandler } from '../../../shared/maestro-lib/runtime/server-requests';
import type { MaestroClient } from '../../../shared/maestro-lib/client/types';

const target = {
	projectRoot: '/repo',
	sourceKey: 'source',
	collectionKey: 'collection',
	expectedRevision: 1,
};
const status = { action: 'status', target, cardId: 'c', cardRevision: 1, status: 'done' };

describe('Board wire parser and native runtime dispatch', () => {
	it.each([
		{ action: 'tick', target, operationId: '' },
		{ action: 'tick', target, operationId: 'r', actorAuthority: 'human' },
		{ action: 'control', target, operation: 'kill', cardId: 'c', cardRevision: 1 },
		{
			action: 'control',
			target,
			operation: 'hold',
			cardId: 'c',
			cardRevision: 1,
			runToken: { runId: 'r', ownerEpoch: 0, generation: 1 },
		},
		{
			action: 'control',
			target,
			operation: 'resume',
			cardId: 'c',
			cardRevision: 1,
			runToken: { runId: 'r', ownerEpoch: 1, generation: 1, human: true },
		},
		{ action: 'control', target, operation: 'approve', cardId: 'c', cardRevision: 1, human: true },
		{ ...status, human: true },
		{ ...status, actorAuthority: 'human' },
		{ ...status, target: { ...target, human: true } },
		{ ...status, target: { ...target, expectedRevision: null } },
		{ ...status, target: { ...target, expectedRevision: -1 } },
		{ ...status, cardRevision: 1.5 },
		{ ...status, status: 'ready' },
		{ ...status, status: 'running' },
		{ ...status, status: ['done'] },
		{ action: '__proto__' },
		{ action: 'create', projectRoot: '/repo', sourceKey: 's', name: 'B', maxInProgress: 0 },
		{ action: 'create', projectRoot: '/repo', sourceKey: 's', name: 'B', autoDecompose: 'yes' },
		{ action: 'card-pr', target, cardId: '' },
		{ action: 'card-pr', target, cardId: 'c', actorAuthority: 'human' },
		{ action: 'catalog', command: {} },
		{ action: 'delete', target, force: 'true' },
		{ action: 'rename', target, name: '  ' },
		{
			action: 'capture',
			target,
			capture: { projectRoot: '/different', boardId: 'b', expectedRevision: 1, card: {} },
		},
	])('rejects malformed command %# before invoking the host', async (message) => {
		const host = vi.fn();
		expect(
			await answerBoardCommand({ type: 'board_command', requestId: 'test', ...message }, host)
		).toMatchObject({
			type: 'board_command_result',
			requestId: 'test',
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(host).not.toHaveBeenCalled();
	});

	it('returns typed unavailability without inventing an empty host register', async () => {
		expect(await answerBoardCommand({ action: 'query', query: {} })).toMatchObject({
			ok: false,
			error: { code: 'runtime-unavailable' },
		});
	});

	it('routes the native board message with its exact query through the configured host', async () => {
		const host = vi.fn(async () => ({
			ok: false as const,
			error: { code: 'stale-revision' as const, message: 'Changed' },
		}));
		const handle = createRequestHandler({} as MaestroClient, host);
		expect(await handle({ type: 'board_command', requestId: 'q', ...status })).toEqual({
			type: 'board_command_result',
			requestId: 'q',
			ok: false,
			error: { code: 'stale-revision', message: 'Changed' },
		});
		expect(host).toHaveBeenCalledWith(expect.objectContaining(status));
		expect(parseBoardCommand({ action: 'query', query: { sourceKey: 'source' } })).toEqual({
			action: 'query',
			query: { sourceKey: 'source' },
		});
	});
});
