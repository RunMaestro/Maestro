import { describe, it, expect, vi, afterEach } from 'vitest';
import { getStdinFlags } from '../../../renderer/utils/spawnHelpers';

describe('getStdinFlags', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns both false on non-Windows platforms', () => {
		vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
		const result = getStdinFlags({ isSshSession: false, supportsStreamJsonInput: true });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});

	it('returns sendPromptViaStdin when Windows + stream-json supported', () => {
		vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
		const result = getStdinFlags({ isSshSession: false, supportsStreamJsonInput: true });
		expect(result).toEqual({ sendPromptViaStdin: true, sendPromptViaStdinRaw: false });
	});

	it('returns sendPromptViaStdinRaw when Windows + stream-json unsupported', () => {
		vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
		const result = getStdinFlags({ isSshSession: false, supportsStreamJsonInput: false });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: true });
	});

	it('returns both false for SSH sessions on Windows', () => {
		vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
		const result = getStdinFlags({ isSshSession: true, supportsStreamJsonInput: true });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});

	it('returns both false for SSH sessions on Windows without stream-json', () => {
		vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32');
		const result = getStdinFlags({ isSshSession: true, supportsStreamJsonInput: false });
		expect(result).toEqual({ sendPromptViaStdin: false, sendPromptViaStdinRaw: false });
	});
});
