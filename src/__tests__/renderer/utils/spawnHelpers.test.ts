import { describe, it, expect, afterEach } from 'vitest';
import { getStdinFlags } from '../../../renderer/utils/spawnHelpers';

describe('getStdinFlags', () => {
	afterEach(() => {
		(window as any).maestro = { platform: 'darwin' };
	});

	it('returns both false on non-Windows platforms', () => {
		(window as any).maestro = { platform: 'darwin' };
		const result = getStdinFlags({ isSshSession: false, supportsStreamJsonInput: true });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});

	it('returns sendPromptViaStdin when Windows + stream-json supported', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({ isSshSession: false, supportsStreamJsonInput: true });
		expect(result).toEqual({ sendPromptViaStdin: true, sendPromptViaStdinRaw: false });
	});

	it('returns sendPromptViaStdinRaw when Windows + stream-json unsupported', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({ isSshSession: false, supportsStreamJsonInput: false });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: true });
	});

	it('returns both false for SSH sessions on Windows', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({ isSshSession: true, supportsStreamJsonInput: true });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});

	it('returns both false for SSH sessions on Windows without stream-json', () => {
		(window as any).maestro = { platform: 'win32' };
		const result = getStdinFlags({ isSshSession: true, supportsStreamJsonInput: false });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});
});
