/**
 * @file checkin.test.ts
 * @description Tests for the anonymous DAU/MAU check-in ping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

const CHECKIN_ENDPOINT = 'https://runmaestro.ai/api/telemetry/checkin';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

let userDataDir: string;

// Minimal Electron `app` stand-in - checkin.ts only ever calls getPath +
// getVersion, and imports the App type only (no runtime electron dependency).
function makeApp(version = '9.9.9') {
	return {
		getPath: (name: string) => {
			expect(name).toBe('userData');
			return userDataDir;
		},
		getVersion: () => version,
	} as unknown as import('electron').App;
}

// Fresh module instance per test so the module-level install-id cache is reset.
async function loadModule() {
	vi.resetModules();
	return import('../../main/checkin');
}

describe('checkin', () => {
	beforeEach(() => {
		userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-checkin-'));
		mockFetch.mockReset();
		mockFetch.mockResolvedValue({ ok: true, status: 200 });
	});

	afterEach(() => {
		fs.rmSync(userDataDir, { recursive: true, force: true });
	});

	it('generates and persists a UUID, then POSTs guid + version', async () => {
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp('1.2.3'));

		expect(mockFetch).toHaveBeenCalledTimes(1);
		const [url, opts] = mockFetch.mock.calls[0];
		expect(url).toBe(CHECKIN_ENDPOINT);
		expect(opts.method).toBe('POST');
		const body = JSON.parse(opts.body as string);
		expect(body.guid).toMatch(UUID_RE);
		expect(body.version).toBe('1.2.3');
		// platform/arch come straight from process and are always present.
		expect(body.platform).toBe(process.platform);
		expect(body.arch).toBe(process.arch);

		// Persisted to userData/checkin-id.json with the same id.
		const raw = await fsp.readFile(path.join(userDataDir, 'checkin-id.json'), 'utf-8');
		expect(JSON.parse(raw).installId).toBe(body.guid);
	});

	it('includes theme when a non-empty id is passed', async () => {
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp(), 'monokai');

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.theme).toBe('monokai');
	});

	it('omits theme when unresolved (undefined/null/empty)', async () => {
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp(), null);
		await sendCheckin(makeApp(), '');
		await sendCheckin(makeApp());

		for (const call of mockFetch.mock.calls) {
			const body = JSON.parse(call[1].body);
			expect('theme' in body).toBe(false);
			// guid/version/platform/arch still present on every ping.
			expect(body.guid).toMatch(UUID_RE);
			expect(body.platform).toBe(process.platform);
			expect(body.arch).toBe(process.arch);
		}
	});

	it('reuses the persisted UUID across process restarts', async () => {
		// First "process" mints and persists an id.
		const first = await loadModule();
		await first.sendCheckin(makeApp());
		const firstGuid = JSON.parse(mockFetch.mock.calls[0][1].body).guid;

		// Second "process" (fresh module, same userData) reuses it.
		const second = await loadModule();
		await second.sendCheckin(makeApp());
		const secondGuid = JSON.parse(mockFetch.mock.calls[1][1].body).guid;

		expect(secondGuid).toBe(firstGuid);
	});

	it('mints a fresh id when the stored file is corrupt', async () => {
		fs.writeFileSync(path.join(userDataDir, 'checkin-id.json'), '{ not valid json');
		const { sendCheckin } = await loadModule();
		await sendCheckin(makeApp());

		const body = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(body.guid).toMatch(UUID_RE);
	});

	it('swallows network failures without throwing', async () => {
		mockFetch.mockRejectedValue(new Error('offline'));
		const { sendCheckin } = await loadModule();
		await expect(sendCheckin(makeApp())).resolves.toBeUndefined();
	});
});
