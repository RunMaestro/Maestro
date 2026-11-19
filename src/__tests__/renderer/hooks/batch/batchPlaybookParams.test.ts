/**
 * The desktop Auto Run's missing-required precondition: resolving a run's
 * playbook parameters, re-reading them on Resume, and the pause it raises.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	missingParamsPauseError,
	reloadRunPlaybookParams,
	resolveRunPlaybookParams,
} from '../../../../renderer/hooks/batch/internal/batchPlaybookParams';

const playbook = { id: 'pb-1', parameterOverlay: [{ name: 'REPO_URL' }] };
const context = { agentId: 'claude-code', sessionId: 'session-1' };

const listPlaybooks = vi.fn();

beforeEach(() => {
	listPlaybooks.mockReset();
	(window as unknown as { maestro: unknown }).maestro = {
		playbooks: { list: listPlaybooks },
	};
});

describe('resolveRunPlaybookParams', () => {
	it('has nothing to resolve for an ad-hoc run', () => {
		expect(resolveRunPlaybookParams(undefined, 'Work on [REPO_URL]')).toBeUndefined();
	});

	it('resolves specs from the prompt and overlay, with the stored answers', () => {
		const set = resolveRunPlaybookParams(
			{ ...playbook, parameterValues: { REPO_URL: 'https://example.com' } },
			'prompt'
		);
		expect(set?.specs.map((spec) => spec.name)).toEqual(['REPO_URL']);
		expect(set?.values).toEqual({ REPO_URL: 'https://example.com' });
	});
});

describe('missingParamsPauseError', () => {
	it('returns a recoverable missing_parameters error naming the missing answers', () => {
		const set = resolveRunPlaybookParams(playbook, 'prompt')!;
		expect(missingParamsPauseError(set, context)).toMatchObject({
			type: 'missing_parameters',
			message: 'Missing required parameters: REPO_URL',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: 'session-1',
		});
	});

	it('returns null when every required parameter resolves', () => {
		const set = resolveRunPlaybookParams(
			{ ...playbook, parameterValues: { REPO_URL: 'https://example.com' } },
			'prompt'
		)!;
		expect(missingParamsPauseError(set, context)).toBeNull();
	});
});

describe('reloadRunPlaybookParams', () => {
	const current = resolveRunPlaybookParams(playbook, 'prompt')!;

	it('reads the answers the user saved during the pause from the owner agent', async () => {
		listPlaybooks.mockResolvedValue({
			success: true,
			playbooks: [{ ...playbook, parameterValues: { REPO_URL: 'https://example.com' } }],
		});

		const reloaded = await reloadRunPlaybookParams(playbook, 'owner-1', 'prompt', current);

		expect(listPlaybooks).toHaveBeenCalledWith('owner-1');
		expect(reloaded.values).toEqual({ REPO_URL: 'https://example.com' });
		expect(missingParamsPauseError(reloaded, context)).toBeNull();
	});

	it('keeps the current set when the playbook is gone', async () => {
		listPlaybooks.mockResolvedValue({ success: true, playbooks: [] });
		expect(await reloadRunPlaybookParams(playbook, 'owner-1', 'prompt', current)).toBe(current);
	});

	it('keeps the current set when the store cannot be read', async () => {
		listPlaybooks.mockRejectedValue(new Error('IPC down'));
		expect(await reloadRunPlaybookParams(playbook, 'owner-1', 'prompt', current)).toBe(current);
	});
});
