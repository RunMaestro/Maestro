/**
 * Passthrough tests for the Cue config normalizer's `time.once` + `notify`
 * fields. These fields were added in Phase 01; this file guards against
 * silent drops in `normalizeSubscription` / `normalizeNotify` that the
 * validator wouldn't catch (loadCueConfig skips validation but always runs
 * the normalizer).
 *
 * Pattern mirrors `cue-config-normalizer-fanout.test.ts`: real temp project
 * root + yaml.dump → parseCueConfigDocument → materializeCueConfig.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	parseCueConfigDocument,
	materializeCueConfig,
} from '../../../../main/cue/config/cue-config-normalizer';

let projectRoot = '';

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-once-norm-'));
});

afterEach(() => {
	if (projectRoot && fs.existsSync(projectRoot)) {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

describe('normalizer - time.once field passthrough', () => {
	it('passes through fire_at as a string', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'reminder' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00-05:00',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		expect(doc).not.toBeNull();
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].fire_at).toBe('2026-05-22T14:30:00-05:00');
	});

	it('drops non-string fire_at to undefined', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'r' },
					agent_id: 'agent-xyz',
					fire_at: 12345,
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].fire_at).toBeUndefined();
	});

	it('passes through grace_minutes when it is a non-negative integer', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'r' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
					grace_minutes: 45,
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].grace_minutes).toBe(45);
	});

	it('passes through grace_minutes: 0 (disables missed-fire rescue)', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'r' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
					grace_minutes: 0,
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		// `0` must survive - the trigger source treats it as "disable rescue"
		// and the normalizer's defensive coercion must not collapse it to
		// undefined (which would let the runtime default of 360 take over).
		expect(config.subscriptions[0].grace_minutes).toBe(0);
	});

	it('drops non-integer / negative grace_minutes to undefined', () => {
		const cases = [10.5, -1, Number.NaN, 'huge', null];
		for (const value of cases) {
			const raw = yaml.dump({
				subscriptions: [
					{
						name: 'task-1',
						event: 'time.once',
						action: 'notify',
						notify: { message: 'r' },
						agent_id: 'agent-xyz',
						fire_at: '2026-05-22T14:30:00Z',
						grace_minutes: value,
					},
				],
			});
			const doc = parseCueConfigDocument(raw, projectRoot);
			const { config } = materializeCueConfig(doc!);
			expect(config.subscriptions[0].grace_minutes).toBeUndefined();
		}
	});

	it('passes through self_destruct_on_failure: true', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'r' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
					self_destruct_on_failure: true,
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].self_destruct_on_failure).toBe(true);
	});

	it('passes through self_destruct_on_failure: false', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'r' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
					self_destruct_on_failure: false,
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		// `false` must survive - the runtime default is `true`, so a dropped
		// `false` would silently re-enable self-destruct on failure.
		expect(config.subscriptions[0].self_destruct_on_failure).toBe(false);
	});

	it('drops non-boolean self_destruct_on_failure to undefined', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'r' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
					self_destruct_on_failure: 'yes',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].self_destruct_on_failure).toBeUndefined();
	});

	it('passes agent_id through unchanged', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'r' },
					agent_id: 'fe7c6b37-d7b1-4c2f-9049-f2288dd10c16',
					fire_at: '2026-05-22T14:30:00Z',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].agent_id).toBe('fe7c6b37-d7b1-4c2f-9049-f2288dd10c16');
	});
});

describe('normalizer - action: notify passthrough', () => {
	it('passes through action: notify and a full notify block', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'hi there', sticky: true },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		const sub = config.subscriptions[0];
		expect(sub.action).toBe('notify');
		expect(sub.notify).toEqual({ message: 'hi there', sticky: true });
	});

	it('preserves notify with only a message (no sticky)', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 'reminder' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].notify).toEqual({ message: 'reminder' });
	});

	it('preserves empty notify object (executor falls back to label/prompt/name)', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: {},
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].notify).toEqual({});
	});

	it('drops malformed notify (non-object) to undefined', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: 'oops',
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].notify).toBeUndefined();
	});

	it('drops non-string notify.message and non-boolean notify.sticky silently', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'notify',
					notify: { message: 42, sticky: 'yes' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		// The validator surfaces these as errors when invoked; the normalizer
		// is the lenient pass that strips garbage so loadCueConfig (which
		// skips validation) doesn't propagate non-CueNotifyConfig values into
		// the runtime.
		expect(config.subscriptions[0].notify).toEqual({});
	});

	it('rejects unknown action values (leaves action undefined)', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'task-1',
					event: 'time.once',
					action: 'explode',
					notify: { message: 'r' },
					agent_id: 'agent-xyz',
					fire_at: '2026-05-22T14:30:00Z',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		expect(config.subscriptions[0].action).toBeUndefined();
	});
});
