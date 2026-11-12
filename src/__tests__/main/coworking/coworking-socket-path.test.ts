/**
 * Bridge socket path resolution tests.
 *
 * Contract: on POSIX the bridge socket lives inside userData, EXCEPT when that
 * path is too long to fit in `sockaddr_un.sun_path` (104 bytes on macOS/BSD,
 * 108 on Linux). Over the limit, bind() rejects the address and Node reports
 * `listen EINVAL`, which silently disabled coworking for users with a deep
 * userData directory (MAESTRO-WH). The fallback is a short temp-dir path keyed
 * by the same userData hash the Windows named pipe uses.
 *
 * `SUN_PATH_MAX` is derived from `process.platform` at module scope, so each
 * platform case stubs the platform and re-imports via vi.resetModules().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const { userDataPath } = vi.hoisted(() => ({ userDataPath: { value: '/tmp/maestro' } }));

vi.mock('electron', () => ({
	app: { getPath: (name: string) => (name === 'userData' ? userDataPath.value : '/unused') },
}));

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** Fresh module instance so SUN_PATH_MAX re-evaluates for the stubbed platform. */
async function loadGetBridgeSocketPath(): Promise<() => string> {
	vi.resetModules();
	const mod = await import('../../../main/coworking/coworking-socket-path');
	return mod.getBridgeSocketPath;
}

describe('getBridgeSocketPath', () => {
	beforeEach(() => {
		userDataPath.value = '/tmp/maestro';
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
	});

	it('keeps the socket inside userData when the path fits in sun_path', async () => {
		setPlatform('darwin');
		userDataPath.value = '/Users/dev/Library/Application Support/maestro';
		const getBridgeSocketPath = await loadGetBridgeSocketPath();

		expect(getBridgeSocketPath()).toBe(
			'/Users/dev/Library/Application Support/maestro/coworking.sock'
		);
	});

	it('falls back to a short temp-dir socket when userData overflows sun_path', async () => {
		setPlatform('darwin');
		// The exact path from MAESTRO-WH: 123 bytes with /coworking.sock appended,
		// against a 104-byte macOS sun_path.
		userDataPath.value =
			'/Users/felipegobbi/Library/Application Support/maestro/Maestro-rc/artifacts/runtime/starred-unread-test-data';
		const getBridgeSocketPath = await loadGetBridgeSocketPath();

		const socketPath = getBridgeSocketPath();

		expect(socketPath).not.toContain('starred-unread-test-data');
		expect(path.dirname(socketPath)).toBe(os.tmpdir());
		expect(path.basename(socketPath)).toMatch(/^maestro-coworking-[0-9a-f]{16}\.sock$/);
		// The whole point: the result is actually bindable.
		expect(Buffer.byteLength(socketPath) + 1).toBeLessThanOrEqual(104);
	});

	it('honours the larger Linux sun_path limit', async () => {
		// 106 bytes with /coworking.sock appended: over the macOS 104 limit but
		// inside the Linux 108 one, so Linux must keep it in userData.
		const dir = `/home/dev/${'d'.repeat(80)}`;
		userDataPath.value = dir;
		expect(Buffer.byteLength(`${dir}/coworking.sock`) + 1).toBe(106);

		setPlatform('linux');
		const onLinux = await loadGetBridgeSocketPath();
		expect(onLinux()).toBe(`${dir}/coworking.sock`);

		setPlatform('darwin');
		const onDarwin = await loadGetBridgeSocketPath();
		expect(path.dirname(onDarwin())).toBe(os.tmpdir());
	});

	it('gives different userData directories different fallback sockets', async () => {
		setPlatform('darwin');
		const deep = `/Users/dev/Library/Application Support/maestro/${'nested/'.repeat(10)}`;

		userDataPath.value = `${deep}profile-a`;
		const first = (await loadGetBridgeSocketPath())();
		userDataPath.value = `${deep}profile-b`;
		const second = (await loadGetBridgeSocketPath())();

		expect(path.dirname(first)).toBe(os.tmpdir());
		expect(first).not.toBe(second);
	});

	it('still returns a per-userData named pipe on Windows', async () => {
		setPlatform('win32');
		userDataPath.value = 'C:\\Users\\dev\\AppData\\Roaming\\maestro';
		const getBridgeSocketPath = await loadGetBridgeSocketPath();

		expect(getBridgeSocketPath()).toMatch(/^\\\\\.\\pipe\\maestro-coworking-[0-9a-f]{16}$/);
	});
});
