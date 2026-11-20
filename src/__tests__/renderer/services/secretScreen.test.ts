/**
 * @file secretScreen.test.ts
 * @description The one "Publish anyway?" flow shared by the gist modal, the
 * Feedback chat, and Create Debug Package: ask once on a refusal, repeat the
 * same request with `allowSecrets` on a yes, and send nothing on a no.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	confirmSecretFindings,
	withSecretScreenConfirm,
} from '../../../renderer/services/secretScreen';
import { useSecretScreenStore } from '../../../renderer/stores/secretScreenStore';
import type { SecretFinding } from '../../../shared/secretScan';

const findings: SecretFinding[] = [{ kind: 'aws-access-key', line: 3, preview: '••••••••MPLE' }];

const refusal = {
	success: false,
	error: 'Found 1 possible secret in the gist. Nothing was sent.',
	code: 'SECRETS_FOUND',
	secretFindings: findings,
	secretScreenNote: 'Secret screen model did not run.',
};

const front = () => useSecretScreenStore.getState().queue[0];
const pendingRequest = async () => {
	await vi.waitFor(() => expect(useSecretScreenStore.getState().queue).toHaveLength(1));
	return front();
};

describe('confirmSecretFindings', () => {
	beforeEach(() => {
		useSecretScreenStore.setState({ queue: [] });
	});

	it('queues a request and resolves true on yes', async () => {
		const answer = confirmSecretFindings(findings, { subject: 'this gist' });

		expect(front()).toMatchObject({
			subject: 'this gist',
			findings,
			confirmLabel: 'Publish anyway',
		});
		useSecretScreenStore.getState().settle(front().id, true);

		await expect(answer).resolves.toBe(true);
		expect(useSecretScreenStore.getState().queue).toEqual([]);
	});

	it('resolves false on cancel or close', async () => {
		const answer = confirmSecretFindings(findings, { subject: 'this gist' });
		useSecretScreenStore.getState().settle(front().id, false);
		await expect(answer).resolves.toBe(false);
	});

	it('takes a caller label and note', () => {
		void confirmSecretFindings(findings, {
			subject: 'this support package',
			confirmLabel: 'Create anyway',
			note: 'model down',
		});
		expect(front()).toMatchObject({ confirmLabel: 'Create anyway', note: 'model down' });
	});

	it('ignores a settle for a request that is already gone', async () => {
		const answer = confirmSecretFindings(findings, { subject: 'this gist' });
		const { id } = front();
		useSecretScreenStore.getState().settle(id, true);
		// ConfirmModal calls onConfirm and then onClose; the second must not flip it.
		useSecretScreenStore.getState().settle(id, false);
		await expect(answer).resolves.toBe(true);
	});

	it('keeps two requests apart', async () => {
		const first = confirmSecretFindings(findings, { subject: 'this gist' });
		const second = confirmSecretFindings(findings, { subject: 'this feedback' });
		const [a, b] = useSecretScreenStore.getState().queue;

		useSecretScreenStore.getState().settle(a.id, false);
		expect(front().subject).toBe('this feedback');
		useSecretScreenStore.getState().settle(b.id, true);

		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(true);
	});
});

describe('withSecretScreenConfirm', () => {
	beforeEach(() => {
		useSecretScreenStore.setState({ queue: [] });
	});

	it('returns a clean result without asking anything', async () => {
		const attempt = vi.fn().mockResolvedValue({ success: true, gistUrl: 'u' });

		const outcome = await withSecretScreenConfirm(attempt, { subject: 'this gist' });

		expect(outcome).toEqual({ result: { success: true, gistUrl: 'u' }, declined: false });
		expect(attempt).toHaveBeenCalledTimes(1);
		expect(attempt).toHaveBeenCalledWith(false);
		expect(useSecretScreenStore.getState().queue).toEqual([]);
	});

	it('does not ask about an ordinary failure', async () => {
		const failure = { success: false, error: 'gh is not installed' };
		const attempt = vi.fn().mockResolvedValue(failure);

		const outcome = await withSecretScreenConfirm(attempt, { subject: 'this gist' });

		expect(outcome).toEqual({ result: failure, declined: false });
		expect(useSecretScreenStore.getState().queue).toEqual([]);
	});

	it('asks on a refusal and repeats the request with allowSecrets on yes', async () => {
		const attempt = vi
			.fn()
			.mockResolvedValueOnce(refusal)
			.mockResolvedValueOnce({ success: true, gistUrl: 'u' });

		const pending = withSecretScreenConfirm(attempt, { subject: 'this gist' });
		const request = await pendingRequest();
		expect(request.findings).toEqual(findings);
		expect(request.note).toBe('Secret screen model did not run.');
		expect(attempt).toHaveBeenCalledTimes(1);

		useSecretScreenStore.getState().settle(request.id, true);

		await expect(pending).resolves.toEqual({
			result: { success: true, gistUrl: 'u' },
			declined: false,
		});
		expect(attempt.mock.calls).toEqual([[false], [true]]);
	});

	it('sends nothing on a no and hands back the refusal marked declined', async () => {
		const attempt = vi.fn().mockResolvedValueOnce(refusal);

		const pending = withSecretScreenConfirm(attempt, { subject: 'this gist' });
		const request = await pendingRequest();
		useSecretScreenStore.getState().settle(request.id, false);

		await expect(pending).resolves.toEqual({ result: refusal, declined: true });
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});
