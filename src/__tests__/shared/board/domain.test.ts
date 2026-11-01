import { describe, expect, it } from 'vitest';
import {
	evaluateCaptureReadiness,
	persistedCaptureInput,
	validateCapture,
	type BoardCaptureContext,
} from '../../../shared/board/domain';
import type { BoardCaptureOptions } from '../../../shared/board/types';

const context: BoardCaptureContext = {
	agents: [
		{ id: 'a', groupId: 'g' },
		{ id: 'b', groupId: 'other' },
	],
	groups: [{ id: 'g' }],
	profiles: [
		{ namespace: 'project', profile: { id: 'reviewer', name: 'Reviewer', baseAgentId: 'a' } },
	],
	defaultStartMode: 'approval',
	canRelaxStartPolicy: false,
};

describe('global Board capture', () => {
	it('accepts only unchanged persisted unresolved nulls for validation without changing storage or public capture rules', () => {
		const stored = {
			executionScope: null,
			profileNamespace: null,
			repositoryId: null,
			workingDirectory: null,
		};
		const input = stored as unknown as BoardCaptureOptions;
		expect(validateCapture(input, context).ok).toBe(false);
		expect(validateCapture(persistedCaptureInput(input, {}), context).ok).toBe(false);
		expect(validateCapture(persistedCaptureInput(input, stored), context).ok).toBe(true);
		expect(stored).toEqual({
			executionScope: null,
			profileNamespace: null,
			repositoryId: null,
			workingDirectory: null,
		});
	});
	it('accepts a scoped role and snapshots the effective policy', () => {
		expect(
			validateCapture(
				{
					executionScope: { kind: 'group', groupId: 'g' },
					assigneeAgentId: 'a',
					role: { namespace: 'project', profileId: 'reviewer' },
					repositoryId: 'repo',
					workingDirectory: '/repo',
				},
				context
			)
		).toMatchObject({ ok: true, effectiveStartMode: 'approval' });
	});
	it('rejects contradictory scope, pin and role choices', () => {
		expect(
			validateCapture(
				{
					executionScope: { kind: 'group', groupId: 'g' },
					assigneeAgentId: 'b',
					role: { namespace: 'project', profileId: 'reviewer' },
				},
				context
			)
		).toEqual({ ok: false, errors: ['pin-role-conflict', 'pin-outside-scope'] });
		expect(
			validateCapture({ executionScope: { kind: 'agent', agentId: 'a', groupId: 'g' } }, context)
		).toEqual({ ok: false, errors: ['invalid-scope'] });
	});
	it('refuses relative paths and unauthorized relaxation while allowing human direct policy', () => {
		expect(
			validateCapture({ workingDirectory: '../repo', startModeOverride: 'direct' }, context)
		).toEqual({ ok: false, errors: ['invalid-repository-path', 'unauthorized-start-mode'] });
		expect(
			validateCapture({ startModeOverride: 'direct' }, { ...context, canRelaxStartPolicy: true })
		).toMatchObject({ ok: true, effectiveStartMode: 'direct' });
	});
	it('keeps deleted references and incomplete drafts but reports why they cannot be dispatched', () => {
		const result = validateCapture(
			{
				executionScope: { kind: 'group', groupId: 'deleted' },
				role: { namespace: 'other', profileId: 'reviewer' },
				repositoryId: 'missing',
				workingDirectory: '/repo',
			},
			context
		);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(
				evaluateCaptureReadiness(result.options, { ...context, repositoryIds: ['repo'] })
			).toEqual(['group-missing', 'role-missing', 'repository-unresolved']);
		expect(evaluateCaptureReadiness({}, { ...context, repositoryIds: [] })).toEqual([
			'missing-scope',
			'repository-unresolved',
		]);
	});
	it('captures deleted agents and pins without substituting another worker', () => {
		const options = {
			executionScope: { kind: 'agent' as const, agentId: 'deleted' },
			assigneeAgentId: 'deleted',
			repositoryId: 'repo-a',
			workingDirectory: '/repo-a',
		};
		const captured = validateCapture(options, context);
		expect(captured).toMatchObject({ ok: true, options });
		if (!captured.ok) throw new Error('expected capture');
		expect(
			evaluateCaptureReadiness(captured.options, {
				...context,
				repositoryIds: ['repo-a', 'repo-b'],
			})
		).toEqual(['target-missing']);
	});
	it('requires an explicit known repository even when several are available', () => {
		const readinessContext = { ...context, repositoryIds: ['repo-a', 'repo-b'] };
		const scope = { executionScope: { kind: 'agent' as const, agentId: 'a' } };
		expect(evaluateCaptureReadiness(scope, readinessContext)).toEqual(['repository-unresolved']);
		expect(
			evaluateCaptureReadiness(
				{ ...scope, repositoryId: 'repo-b', workingDirectory: '/repo-b' },
				readinessContext
			)
		).toEqual([]);
		expect(validateCapture({ ...scope, assigneeAgentId: 'b' }, context)).toEqual({
			ok: false,
			errors: ['pin-outside-scope'],
		});
	});
});
