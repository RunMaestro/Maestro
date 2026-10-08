// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('chokidar', () => ({
	watch: () => Object.assign(new EventEmitter(), { close: vi.fn() }),
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { watchCueConfigFile } from '../../../main/cue/config/cue-config-repository';
import { writeCueYamlAtomicSync } from '../../../main/cue/cue-yaml-write';

describe('YAML reconciliation when native notifications are lost', () => {
	let root: string;
	let config: string;
	let cleanup: () => void;
	beforeEach(() => {
		fs.mkdirSync('.build', { recursive: true });
		root = fs.mkdtempSync(path.resolve('.build/cue-reconcile-test-'));
		fs.mkdirSync(path.join(root, '.maestro'));
		config = path.join(root, '.maestro/cue.yaml');
		fs.writeFileSync(config, 'subscriptions: []\n');
		vi.useFakeTimers();
	});
	afterEach(() => {
		cleanup?.();
		vi.useRealTimers();
		fs.rmSync(root, { recursive: true, force: true });
	});
	it('recovers changed bytes despite equal size and timestamp, once, with a health warning', () => {
		fs.writeFileSync(config, 'subscriptions: [a]\n');
		const stamp = fs.statSync(config).mtime;
		const onChange = vi.fn();
		const onWarning = vi.fn();
		cleanup = watchCueConfigFile(root, onChange, { onWarning });
		writeCueYamlAtomicSync(config, 'subscriptions: [b]\n');
		fs.utimesSync(config, stamp, stamp);
		vi.advanceTimersByTime(31_000);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Missed config change'));
		vi.advanceTimersByTime(60_000);
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('detects creation/deletion and stops health polling on teardown', () => {
		fs.unlinkSync(config);
		const onChange = vi.fn();
		cleanup = watchCueConfigFile(root, onChange);
		writeCueYamlAtomicSync(config, 'subscriptions: []\n');
		vi.advanceTimersByTime(31_000);
		expect(onChange).toHaveBeenCalledTimes(1);
		fs.unlinkSync(config);
		vi.advanceTimersByTime(30_000);
		expect(onChange).toHaveBeenCalledTimes(2);
		cleanup();
		writeCueYamlAtomicSync(config, 'subscriptions: [a]\n');
		vi.advanceTimersByTime(60_000);
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it('retries a failed reload rather than marking stale runtime content reconciled', () => {
		const onChange = vi.fn().mockImplementationOnce(() => {
			throw new Error('reload unavailable');
		});
		const onWarning = vi.fn();
		cleanup = watchCueConfigFile(root, onChange, { onWarning });
		writeCueYamlAtomicSync(config, 'subscriptions: [a]\n');
		vi.advanceTimersByTime(31_000);
		expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('Config reload failed'));
		vi.advanceTimersByTime(30_000);
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});
