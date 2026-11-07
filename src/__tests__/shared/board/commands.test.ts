import { requestBoardCommand } from '../../../shared/maestro-lib/client/board';
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
	answerBoardCommand,
	parseBoardCommand,
	BOARD_DELETE_CARDS_LIMIT,
} from '../../../shared/board/commands';
import { createRequestHandler } from '../../../shared/maestro-lib/runtime/server-requests';
import type { MaestroClient } from '../../../shared/maestro-lib/client/types';

const projectRoot = path.join(os.tmpdir(), 'board-repo');
const otherProjectRoot = path.join(os.tmpdir(), 'board-other');
const target = {
	projectRoot: projectRoot,
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
		{ action: 'create', projectRoot: projectRoot, sourceKey: 's', name: 'B', maxInProgress: 0 },
		{ action: 'create', projectRoot: projectRoot, sourceKey: 's', name: 'B', autoDecompose: 'yes' },
		{ action: 'card-pr', target, cardId: '' },
		{ action: 'card-pr', target, cardId: 'c', actorAuthority: 'human' },
		{ action: 'catalog', command: {} },
		{ action: 'list-workers', extra: true },
		{
			action: 'set-worker-options',
			command: { agentId: 'a', expectedPayload: '{}', patch: { customModel: '' } },
		},
		{
			action: 'set-worker-options',
			command: { agentId: 'a', expectedPayload: '{}', patch: { unknown: 'x' } },
		},
		{
			action: 'set-worker-options',
			command: { agentId: 'a', expectedPayload: '{}', patch: { customArgs: 'x\0y' } },
		},
		{ action: 'create-role', name: ' ' },
		{ action: 'create-role', name: 'Role', namespace: 'caller-chosen' },
		{ action: 'create-role', name: 'Role', profile: { model: 'bypass' } },
		{
			action: 'set-worker-role',
			agentId: 'a',
			role: { namespace: 's', profileId: 'p', human: true },
			enabled: true,
		},
		{
			action: 'set-worker-role',
			agentId: 'a',
			role: { namespace: '', profileId: 'p' },
			enabled: true,
		},
		{
			action: 'set-worker-role',
			agentId: 'a',
			role: { namespace: 's', profileId: 'p' },
			enabled: 'true',
		},
		{
			action: 'set-worker-role',
			agentId: 'a',
			role: { namespace: 's', profileId: 'p' },
			enabled: true,
			expectedRevision: 0,
		},
		{ action: 'initialize', sourceKey: 'caller-chosen' },
		{ action: 'initialize', actorAuthority: 'human' },
		{ action: 'delete', target, force: 'true' },
		{ action: 'delete-cards', target, cards: [] },
		{ action: 'delete-cards', target, cards: [{ cardId: 'c' }] },
		{ action: 'delete-cards', target, cards: [{ cardId: 'c', cardRevision: -1 }] },
		{ action: 'delete-cards', target, cards: [{ cardId: 'c', cardRevision: 1.5 }] },
		{ action: 'delete-cards', target, cards: [{ cardId: ' ', cardRevision: 1 }] },
		{ action: 'delete-cards', target, cards: [{ cardId: 'c', cardRevision: 1, human: true }] },
		{
			action: 'delete-cards',
			target,
			cards: [
				{ cardId: 'c', cardRevision: 1 },
				{ cardId: 'c', cardRevision: 2 },
			],
		},
		{
			action: 'delete-cards',
			target,
			cards: Array.from({ length: BOARD_DELETE_CARDS_LIMIT + 1 }, () => ({
				cardId: 'c',
				cardRevision: 1,
			})),
		},
		{ action: 'delete-cards', cards: [{ cardId: 'c', cardRevision: 1 }] },
		{ action: 'rename', target, name: '  ' },
		{
			action: 'capture',
			target,
			capture: { projectRoot: otherProjectRoot, boardId: 'b', expectedRevision: 1, card: {} },
		},
		{
			action: 'capture',
			target,
			capture: {
				projectRoot: projectRoot,
				boardId: 'b',
				expectedRevision: 1,
				card: {},
				replaceRole: 'true',
			},
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

	it('accepts a worker patch with an explicit clear and an expected payload', () => {
		const command = {
			agentId: 'a',
			expectedPayload: '{}',
			patch: { customModel: 'model', customEffort: null },
		};
		expect(parseBoardCommand({ action: 'set-worker-options', command })).toEqual({
			action: 'set-worker-options',
			command,
		});
	});

	it('deduplicates identical batch fences and dispatches one exact collection target', async () => {
		const host = vi.fn(async () => ({ ok: true as const, value: null }));
		const cards = [
			{ cardId: 'c', cardRevision: 1 },
			{ cardId: 'd', cardRevision: 2 },
		];
		await answerBoardCommand({ action: 'delete-cards', target, cards: [...cards, cards[0]] }, host);
		expect(host).toHaveBeenCalledExactlyOnceWith({ action: 'delete-cards', target, cards });
	});

	it('returns typed unavailability without inventing an empty host register', async () => {
		expect(await answerBoardCommand({ action: 'query', query: {} })).toMatchObject({
			ok: false,
			error: { code: 'runtime-unavailable' },
		});
	});

	it('initializes only the host-owned global destination and preserves the request ID', async () => {
		const host = vi.fn(async () => ({ ok: true as const, value: null }));
		expect(
			await answerBoardCommand({ action: 'initialize', requestId: 'bootstrap' }, host)
		).toEqual({ type: 'board_command_result', requestId: 'bootstrap', ok: true, value: null });
		expect(host).toHaveBeenCalledWith({ action: 'initialize' });
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

it.each([
	{ command: { action: 'query', query: {} }, timeout: undefined },
	{
		command: { action: 'card-pr', projectRoot: '/repo', boardId: 'b', cardId: 'c' },
		timeout: 240000,
	},
	{ command: { action: 'source-preview', sourceKey: 's' }, timeout: 60000 },
])(
	'gives long Board operations an explicit transport budget: $command.action',
	async ({ command, timeout }) => {
		const sendCommand = vi.fn().mockResolvedValue({ ok: true });
		await requestBoardCommand({ sendCommand } as never, command as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'board_command', ...command },
			'board_command_result',
			timeout
		);
	}
);
