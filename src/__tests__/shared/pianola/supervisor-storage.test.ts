/**
 * @file supervisor-storage.test.ts
 * @description Tests for the pure Pianola supervisor-file validator. The validator
 * is the boundary that protects the desktop supervisor from a malformed or
 * hand-edited registry: good targets survive, targets missing their kind-specific
 * required fields are dropped, and junk degrades to an empty, well-formed object.
 */

import { describe, it, expect } from 'vitest';
import {
	validatePianolaSupervisorFile,
	validatePianolaSupervisedTarget,
	type PianolaSupervisedTarget,
} from '../../../shared/pianola/storage';

function validWatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'w1',
		kind: 'watch',
		enabled: true,
		createdAt: 1,
		tabId: 'tab-1',
		agentId: 'agent-1',
		...overrides,
	};
}

function validOrchestrate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'o1',
		kind: 'orchestrate',
		enabled: true,
		createdAt: 2,
		planId: 'plan-1',
		...overrides,
	};
}

describe('validatePianolaSupervisorFile', () => {
	it('accepts well-formed watch and orchestrate targets', () => {
		const result = validatePianolaSupervisorFile({
			targets: [validWatch(), validOrchestrate()],
		});
		expect(result.targets).toHaveLength(2);
		const [watch, orchestrate] = result.targets;
		expect(watch).toMatchObject({
			id: 'w1',
			kind: 'watch',
			tabId: 'tab-1',
			agentId: 'agent-1',
		});
		expect(orchestrate).toMatchObject({ id: 'o1', kind: 'orchestrate', planId: 'plan-1' });
	});

	it('keeps optional intervalSeconds and concurrency when present and numeric', () => {
		const result = validatePianolaSupervisorFile({
			targets: [
				validWatch({ intervalSeconds: 10 }),
				validOrchestrate({ intervalSeconds: 7, concurrency: 4 }),
			],
		});
		expect(result.targets[0].intervalSeconds).toBe(10);
		expect(result.targets[1].intervalSeconds).toBe(7);
		expect(result.targets[1].concurrency).toBe(4);
	});

	it('drops a watch target missing tabId or agentId', () => {
		const result = validatePianolaSupervisorFile({
			targets: [
				validWatch({ tabId: undefined }),
				validWatch({ id: 'w2', agentId: undefined }),
				validWatch({ id: 'w3' }),
			],
		});
		// Only the fully-specified watch survives.
		expect(result.targets).toHaveLength(1);
		expect(result.targets[0].id).toBe('w3');
	});

	it('drops an orchestrate target missing planId', () => {
		const result = validatePianolaSupervisorFile({
			targets: [validOrchestrate({ planId: undefined }), validOrchestrate({ id: 'o2' })],
		});
		expect(result.targets).toHaveLength(1);
		expect(result.targets[0].id).toBe('o2');
	});

	it('drops targets with an invalid kind, enabled, createdAt, or empty id', () => {
		const result = validatePianolaSupervisorFile({
			targets: [
				validWatch({ kind: 'nonsense' }),
				validWatch({ id: 'w2', enabled: 'yes' }),
				validWatch({ id: 'w3', createdAt: 'soon' }),
				validWatch({ id: '' }),
			],
		});
		expect(result.targets).toHaveLength(0);
	});

	it('returns a well-formed empty object for junk input', () => {
		expect(validatePianolaSupervisorFile(null)).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile(undefined)).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile('nope')).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile(42)).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile([])).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile({})).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile({ targets: 'not-an-array' })).toEqual({ targets: [] });
		expect(validatePianolaSupervisorFile({ targets: [1, 'x', null, {}] })).toEqual({ targets: [] });
	});
});

describe('validatePianolaSupervisedTarget', () => {
	it('returns the typed target for valid input', () => {
		const target = validatePianolaSupervisedTarget(validWatch());
		const expected: PianolaSupervisedTarget = {
			id: 'w1',
			kind: 'watch',
			enabled: true,
			createdAt: 1,
			tabId: 'tab-1',
			agentId: 'agent-1',
		};
		expect(target).toEqual(expected);
	});

	it('returns null for a non-finite numeric field', () => {
		expect(validatePianolaSupervisedTarget(validWatch({ createdAt: Number.NaN }))).toBeNull();
		expect(
			validatePianolaSupervisedTarget(validOrchestrate({ concurrency: Number.POSITIVE_INFINITY }))
		).toBeNull();
	});

	it('returns null when an optional field is present but the wrong type', () => {
		expect(validatePianolaSupervisedTarget(validWatch({ intervalSeconds: '5' }))).toBeNull();
		expect(validatePianolaSupervisedTarget(validOrchestrate({ planId: 123 }))).toBeNull();
	});
});
