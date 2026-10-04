import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	ComputerHistoryService,
	type ObserverSupervisorLike,
} from '../../../main/computer-history/computer-history-service';
import { parseSegmentText } from '../../../shared/computer-history/reader';
import type { HelperCommand } from '../../../shared/computer-history/types';
import type { ObserverSupervisorDeps } from '../../../main/computer-history/observer-supervisor';

let userData: string;
let enabled: boolean;
let now: number;
let sent: HelperCommand[];
let supervisorDeps: ObserverSupervisorDeps | null;
let running: boolean;

const T0 = Date.parse('2026-10-03T14:10:00.000Z');

function fakeSupervisor(deps: ObserverSupervisorDeps): ObserverSupervisorLike {
	supervisorDeps = deps;
	return {
		start: vi.fn(() => {
			running = true;
			deps.onSpawned?.();
		}),
		stop: vi.fn(() => {
			running = false;
		}),
		send: vi.fn((cmd: HelperCommand) => {
			if (!running) return false;
			sent.push(cmd);
			return true;
		}),
		isRunning: () => running,
		status: () => ({
			state: running ? 'running' : 'stopped',
			restarts: 0,
			binaryPath: '/bin/maestro-observer',
			recentStderr: [],
		}),
	};
}

function makeService(extra: Partial<ConstructorParameters<typeof ComputerHistoryService>[0]> = {}) {
	return new ComputerHistoryService({
		userDataDir: userData,
		isEnabled: () => enabled,
		createSupervisor: fakeSupervisor,
		resolveBinary: () => '/bin/maestro-observer',
		platform: 'darwin',
		now: () => now,
		getBlockPids: () => [999],
		...extra,
	});
}

function storeFile(...parts: string[]) {
	return path.join(userData, 'computer-history', ...parts);
}

function segmentEvents() {
	const p = storeFile('segments', '2026-10-03', '1410Z.jsonl');
	return fs.existsSync(p) ? parseSegmentText(fs.readFileSync(p, 'utf-8')) : [];
}

function textEvent(text: string, extra: Record<string, unknown> = {}) {
	return {
		v: 1,
		ts: new Date(now).toISOString(),
		kind: 'text.committed',
		app: { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 42 },
		window: { title: 'general - Acme' },
		element: { role: 'text_area', label: 'Message' },
		text,
		reason: 'cleared',
		...extra,
	};
}

beforeEach(() => {
	userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-service-'));
	enabled = true;
	now = T0 + 1000;
	sent = [];
	supervisorDeps = null;
	running = false;
});
afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(userData, { recursive: true, force: true });
});

describe('ComputerHistoryService lifecycle', () => {
	it('does nothing when the flag is off', async () => {
		enabled = false;
		const service = makeService();
		await service.start();
		expect(service.isRunning()).toBe(false);
		expect(fs.existsSync(storeFile())).toBe(false);
		expect(service.status().state).toBe('off');
	});

	it('writes SCHEMA.md and config.json on start and configures the helper', async () => {
		const service = makeService();
		await service.start();
		expect(fs.readFileSync(storeFile('SCHEMA.md'), 'utf-8')).toContain('Untrusted content warning');
		expect(JSON.parse(fs.readFileSync(storeFile('config.json'), 'utf-8')).retentionDays).toBe(90);
		const configure = sent.find((c) => c.cmd === 'configure');
		expect(configure).toMatchObject({
			cmd: 'configure',
			blockPids: [999],
			blockDomains: [],
			snapshots: true,
			maxTextBytes: 8192,
			maxSnapshotBytes: 32768,
		});
		expect((configure as { blockApps: string[] }).blockApps).toEqual(
			expect.arrayContaining([
				'com.maestro.app',
				'com.1password.1password',
				'com.apple.keychainaccess',
			])
		);
		expect(service.status().state).toBe('starting');
		await service.stop();
	});

	it('reports recording / blocked from helper.status and notifies listeners', async () => {
		const onStatusChange = vi.fn();
		const service = makeService({ onStatusChange });
		await service.start();
		await service.ingest({
			v: 1,
			ts: new Date(now).toISOString(),
			kind: 'helper.status',
			status: { version: '0.1.0', platform: 'macos', state: 'blocked', permission: 'denied' },
		});
		expect(service.status().state).toBe('blocked');
		await service.ingest({
			v: 1,
			ts: new Date(now).toISOString(),
			kind: 'helper.status',
			status: { version: '0.1.0', platform: 'macos', state: 'running', permission: 'granted' },
		});
		expect(service.status().state).toBe('recording');
		expect(onStatusChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ state: 'recording' })
		);
		await service.stop();
		expect(service.status().state).toBe('off');
	});
});

describe('ingest pipeline', () => {
	it('validates, redacts, and stores with seq; helper.* events are never stored', async () => {
		const service = makeService();
		await service.start();
		expect(
			await service.ingest(textEvent('my key is sk-ABCDEFGHIJKLMNOP1234 ok', { extra: 'dropped' }))
		).toBe(true);
		expect(
			await service.ingest(
				textEvent('page', {
					kind: 'window.changed',
					window: {
						title: 'Bearer abcdefghij1234567890',
						url: 'https://x.test/cb?access_token=abc123&q=hi',
					},
				})
			)
		).toBe(true);
		expect(
			await service.ingest({
				v: 1,
				ts: new Date(now).toISOString(),
				kind: 'helper.error',
				text: 'x',
			})
		).toBe(false);
		const events = segmentEvents();
		expect(events.map((e) => e.seq)).toEqual([0, 1]);
		expect(events[0].text).toBe('my key is [REDACTED_API_KEY] ok');
		expect((events[0] as unknown as Record<string, unknown>).extra).toBeUndefined();
		expect(events[1].window?.title).toBe('Bearer [REDACTED_BEARER_TOKEN]');
		expect(events[1].window?.url).toBe('https://x.test/cb?access_token=%5BREDACTED_SECRET%5D&q=hi');
		expect(service.status().eventsStored).toBe(2);
		await service.stop();
	});

	it('re-checks exclusions: built-ins, rules, own pids, private windows, blocked domains, snapshots off', async () => {
		const service = makeService();
		await service.start();
		await service.addRule('domain', 'bank.example.com');
		await service.setConfig({ snapshots: false });
		const dropped = [
			textEvent('a', { app: { id: 'com.1password.1password', name: '1Password', pid: 1 } }),
			textEvent('b', { app: { id: 'x', name: 'Self', pid: 999 } }),
			textEvent('c', { window: { title: 'Incognito - Chrome' } }),
			textEvent('d', { window: { title: 't', url: 'https://login.bank.example.com/' } }),
			textEvent('e', { kind: 'content.snapshot' }),
			{ kind: 'text.committed', ts: 'garbage' },
			'not an object',
		];
		for (const e of dropped) expect(await service.ingest(e)).toBe(false);
		expect(segmentEvents()).toEqual([]);
		expect(service.status().eventsDropped).toBe(dropped.length);
		await service.stop();
	});

	it('caps text to the byte limit and marks it truncated', async () => {
		const service = makeService();
		await service.start();
		await service.ingest(textEvent('z'.repeat(9000)));
		const [e] = segmentEvents();
		expect(e.text).toHaveLength(8192);
		expect(e.truncated).toBe(true);
		await service.stop();
	});

	it('ignores everything while stopped', async () => {
		const service = makeService();
		expect(await service.ingest(textEvent('x'))).toBe(false);
	});
});

describe('pause / resume', () => {
	it('pauses for a duration, drops events, and resumes on the timer', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		const service = makeService();
		await service.start();
		const status = await service.pause(60_000);
		expect(status.state).toBe('paused');
		expect(status.pausedUntil).toBe(new Date(now + 60_000).toISOString());
		expect(sent.at(-1)).toEqual({ cmd: 'pause' });
		expect(JSON.parse(fs.readFileSync(storeFile('config.json'), 'utf-8')).pausedUntil).toBe(
			status.pausedUntil
		);
		expect(await service.ingest(textEvent('while paused'))).toBe(false);
		now += 60_000;
		await vi.advanceTimersByTimeAsync(60_000);
		// resume() persists config.json (real fs) before telling the helper.
		await vi.waitFor(() => expect(sent.at(-1)).toEqual({ cmd: 'resume' }));
		expect(service.getConfig().pausedUntil).toBeNull();
		expect(await service.ingest(textEvent('after'))).toBe(true);
		await service.stop();
	});

	it('pause without a duration is forever until resume()', async () => {
		const service = makeService();
		await service.start();
		expect((await service.pause()).pausedUntil).toBe('forever');
		expect((await service.resume()).pausedUntil).toBeNull();
		await service.stop();
	});

	it('an expired pause from a previous run is cleared at start', async () => {
		fs.mkdirSync(storeFile(), { recursive: true });
		fs.writeFileSync(
			storeFile('config.json'),
			JSON.stringify({ pausedUntil: '2020-01-01T00:00:00Z' })
		);
		const service = makeService();
		await service.start();
		expect(service.getConfig().pausedUntil).toBeNull();
		await service.stop();
	});
});

describe('rules', () => {
	it('adds (deduped), lists with built-ins, removes by id or value, and reconfigures the helper', async () => {
		const service = makeService();
		await service.start();
		const rule = await service.addRule('app', 'com.apple.MobileSMS');
		expect(rule).toMatchObject({ match: 'app', value: 'com.apple.mobilesms' });
		expect((await service.addRule('app', 'COM.APPLE.MOBILESMS')).id).toBe(rule.id);
		const configure = sent.filter((c) => c.cmd === 'configure').at(-1) as { blockApps: string[] };
		expect(configure.blockApps).toContain('com.apple.mobilesms');
		const listing = service.listRules();
		expect(listing.rules).toHaveLength(1);
		expect(listing.builtIn).toContain('com.maestro.app');
		await service.addRule('domain', 'https://bank.example.com/x');
		expect(await service.removeRule('bank.example.com')).toMatchObject({ match: 'domain' });
		expect(await service.removeRule(rule.id)).toMatchObject({ id: rule.id });
		expect(await service.removeRule('nope')).toBeNull();
		await expect(service.addRule('domain', 'not a domain')).rejects.toThrow(/not a domain/);
		await service.stop();
	});
});

describe('clear', () => {
	it('clears since a time (including the open segment) and clears all', async () => {
		const service = makeService();
		await service.start();
		await service.ingest(textEvent('one'));
		now = T0 + 600_000 + 5;
		await service.ingest(textEvent('two'));
		const recent = await service.clear({ sinceMs: T0 + 600_000 });
		expect(recent.deletedSegments).toBe(1);
		expect(service.status().currentSegment).toBeNull();
		expect(fs.existsSync(storeFile('segments', '2026-10-03', '1410Z.jsonl'))).toBe(true);
		expect(fs.existsSync(storeFile('segments', '2026-10-03', '1420Z.jsonl'))).toBe(false);
		await service.ingest(textEvent('three'));
		const all = await service.clear({ all: true });
		expect(all.deletedSegments).toBe(2);
		expect(fs.existsSync(storeFile('segments'))).toBe(false);
		expect(fs.existsSync(storeFile('config.json'))).toBe(true);
		await expect(service.clear({})).rejects.toThrow();
		await service.stop();
	});
});

describe('requestAccessibility', () => {
	it('macOS prompts only when not trusted', async () => {
		const trusted = vi.fn((prompt: boolean) => !prompt && false);
		const service = makeService({ isMacAccessibilityTrusted: trusted });
		expect((await service.requestAccessibility()).outcome).toBe('prompted');
		expect(trusted).toHaveBeenCalledWith(true);
		const granted = makeService({ isMacAccessibilityTrusted: () => true });
		expect((await granted.requestAccessibility()).outcome).toBe('granted');
	});

	it('Linux asks the running helper; Windows needs nothing', async () => {
		const linux = makeService({ platform: 'linux' });
		expect((await linux.requestAccessibility()).outcome).toBe('helper-not-running');
		await linux.start();
		expect((await linux.requestAccessibility()).outcome).toBe('enabled');
		expect(sent.at(-1)).toEqual({ cmd: 'enable-accessibility' });
		await linux.stop();
		const windows = makeService({ platform: 'win32' });
		expect(await windows.requestAccessibility()).toEqual({
			platform: 'windows',
			outcome: 'not_required',
		});
	});
});

describe('wiring', () => {
	it('routes supervisor messages into ingest', async () => {
		const service = makeService();
		await service.start();
		supervisorDeps!.onMessage(textEvent('via supervisor'));
		await vi.waitFor(() => expect(segmentEvents()).toHaveLength(1));
		const q = await service.query({ grep: /supervisor/i });
		expect(q.events).toHaveLength(1);
		await service.stop();
	});
});
