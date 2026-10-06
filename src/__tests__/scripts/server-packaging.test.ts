/**
 * The container image and the systemd unit start the same engine with the
 * same service-mode flags. These checks keep the two, the health probe, and
 * the stop timeouts from drifting apart (see docs/maestro-cue-server.md).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const packagingDir = path.resolve(__dirname, '../../../packaging/server');
const read = (name: string) => fs.readFileSync(path.join(packagingDir, name), 'utf8');

const dockerfile = read('Dockerfile');
const unit = read('maestro-cue.service');
const compose = read('compose.yaml');
const wrapper = read('maestro-cli');

/** The JSON array of a Dockerfile exec-form instruction. */
function execForm(instruction: string): string[] {
	const match = dockerfile.match(new RegExp(`^${instruction} (\\[.*\\])$`, 'm'));
	if (!match) throw new Error(`no exec-form ${instruction} in the Dockerfile`);
	return JSON.parse(match[1]);
}

/** Every value of a systemd `Key=` line. */
function unitValues(key: string): string[] {
	return [...unit.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((m) => m[1].trim());
}

function unitValue(key: string): string {
	const values = unitValues(key);
	expect(values, `${key}= in maestro-cue.service`).toHaveLength(1);
	return values[0];
}

/** Value of `--flag <value>` in an argument list. */
function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

const containerArgs = execForm('CMD');
const unitArgs = unitValue('ExecStart').split(/\s+/);

describe('server packaging', () => {
	it('starts the engine with the same arguments in the image and the unit', () => {
		expect(unitArgs[0]).toBe('/usr/local/bin/maestro-cli');
		expect(unitArgs.slice(1)).toEqual(containerArgs);
	});

	it('passes every flag of the service-mode contract', () => {
		expect(containerArgs.slice(0, 3)).toEqual(['cue', 'engine', 'start']);
		expect(flag(containerArgs, '--data-dir')).toBe('/var/lib/maestro/data');
		expect(flag(containerArgs, '--status-port')).toBe('7433');
		expect(flag(containerArgs, '--log-format')).toBe('json');
		expect(flag(containerArgs, '--drain-timeout')).toBe('90');
		expect(containerArgs).toContain('--require-ready');
	});

	it('probes health on the status port the engine is given', () => {
		const healthcheck = dockerfile.match(/^\s*CMD \[.*\/healthz.*\]$/m)?.[0] ?? '';
		expect(healthcheck).toContain(`127.0.0.1:${flag(containerArgs, '--status-port')}/healthz`);
	});

	it('gives the drain time to finish before anything is killed', () => {
		const drain = Number(flag(containerArgs, '--drain-timeout'));
		expect(Number(unitValue('TimeoutStopSec'))).toBeGreaterThan(drain);
		const grace = compose.match(/stop_grace_period: (\d+)s/)?.[1];
		expect(Number(grace)).toBeGreaterThan(drain);
	});

	it('runs the engine under a supervisor that reaches its process tree', () => {
		expect(execForm('ENTRYPOINT').slice(0, 3)).toEqual(['/usr/bin/tini', '-g', '--']);
		expect(unitValue('KillMode')).toBe('mixed');
	});

	it('uses notify readiness and the watchdog, with restarts', () => {
		expect(unitValue('Type')).toBe('notify');
		expect(unitValue('NotifyAccess')).toBe('all');
		expect(unitValue('WatchdogSec')).toBe('30');
		expect(unitValue('Restart')).toBe('on-failure');
	});

	it('runs as the maestro user with the data directory writable', () => {
		expect(unitValue('User')).toBe('maestro');
		expect(dockerfile).toMatch(/^USER maestro$/m);
		const writable = unitValue('ReadWritePaths').split(/\s+/);
		expect(writable).toContain('/var/lib/maestro');
		expect(flag(containerArgs, '--data-dir')?.startsWith('/var/lib/maestro/')).toBe(true);
	});

	it('points the wrapper and both environments at one data directory', () => {
		const dataDir = flag(containerArgs, '--data-dir');
		expect(wrapper).toContain(`MAESTRO_USER_DATA:-${dataDir}`);
		expect(unitValues('Environment')).toContain(`MAESTRO_USER_DATA=${dataDir}`);
		expect(dockerfile).toContain(`MAESTRO_USER_DATA=${dataDir}`);
	});
});
