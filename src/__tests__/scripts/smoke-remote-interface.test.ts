/**
 * The remote-interface smoke test dials a running Maestro the way a browser
 * does. These tests pin its pure parts: where it finds the app, how it reads
 * flags, and what counts as a healthy run. The live run needs a running app.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
	DEFAULTS,
	HOST_OUTPUT_CEILING_BYTES,
	READ_CHANNELS,
	assessRun,
	defaultDataDir,
	parseArgs,
} from '../../../scripts/smoke-remote-interface.mjs';
import { WEB_CLIENT_MAX_BUFFERED_BYTES } from '../../main/web-server/services/socket-send';

const allReplies = () =>
	Object.fromEntries(READ_CHANNELS.map((channel) => [channel, { ok: true, bytes: 10, ms: 5 }]));

describe('smoke-remote-interface: defaultDataDir', () => {
	it('prefers MAESTRO_USER_DATA', () => {
		expect(defaultDataDir('darwin', { MAESTRO_USER_DATA: '/demo' }, '/home/u')).toBe('/demo');
	});

	it.each([
		['darwin', {}, path.join('/home/u', 'Library', 'Application Support', 'maestro')],
		['win32', { APPDATA: '/roaming' }, path.join('/roaming', 'maestro')],
		['linux', {}, path.join('/home/u', '.config', 'maestro')],
	])('finds the %s production profile', (platform, env, expected) => {
		expect(defaultDataDir(platform as NodeJS.Platform, env, '/home/u')).toBe(expected);
	});
});

describe('smoke-remote-interface: parseArgs', () => {
	it('uses the defaults with no flags', () => {
		expect(parseArgs([])).toEqual(DEFAULTS);
	});

	it('reads the profile, host, and timeouts in seconds', () => {
		expect(
			parseArgs(['--data-dir', '/demo', '--host', '192.168.1.46', '--settle', '2'])
		).toMatchObject({ dataDir: '/demo', host: '192.168.1.46', settleMs: 2000 });
	});

	it('refuses an unknown flag or a flag with no value', () => {
		expect(() => parseArgs(['--bogus', 'x'])).toThrow('Unknown argument');
		expect(() => parseArgs(['--host'])).toThrow('Missing value');
	});
});

describe('smoke-remote-interface: assessRun', () => {
	it('keeps its ceiling in step with the host', () => {
		expect(HOST_OUTPUT_CEILING_BYTES).toBe(WEB_CLIENT_MAX_BUFFERED_BYTES);
	});

	it('passes a run where every read answers and the socket stays open', () => {
		expect(assessRun({ replies: allReplies(), messages: [], close: null })).toEqual({
			failures: [],
			warnings: [],
		});
	});

	it('fails the run the phone saw: 1013 before the bootstrap answered', () => {
		const replies = allReplies();
		delete replies['sessions:getBootstrap'];
		const { failures } = assessRun({
			replies,
			messages: [],
			close: { code: 1013, reason: 'Client output backlog exceeded' },
		});
		expect(failures).toEqual([
			'the host closed the socket: 1013 Client output backlog exceeded',
			'sessions:getBootstrap never answered',
		]);
	});

	it('fails a read the host refused', () => {
		const replies = {
			...allReplies(),
			'fs:homeDir': { ok: false, bytes: 1, ms: 1, error: 'denied' },
		};
		expect(assessRun({ replies, messages: [], close: null }).failures).toEqual([
			'fs:homeDir failed: denied',
		]);
	});

	it('fails a message over the ceiling and warns past half of it', () => {
		const { failures, warnings } = assessRun({
			replies: allReplies(),
			messages: [
				{ label: 'reply to sessions:getBootstrap', bytes: 47_000_000 },
				{ label: 'event sessions:lifecycleSync', bytes: 5_000_000 },
			],
			close: null,
		});
		expect(failures).toEqual([
			"reply to sessions:getBootstrap is 47.00 MB, over the host's 8 MiB per-client ceiling",
		]);
		expect(warnings).toEqual([
			'event sessions:lifecycleSync is 5.00 MB, more than half the 8 MiB ceiling',
		]);
	});
});
