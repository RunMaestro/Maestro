import { describe, it, expect } from 'vitest';
import { getRevealLabel, getOpenInLabel } from '../../../renderer/utils/platformUtils';

describe('platformUtils', () => {
	describe('getRevealLabel', () => {
		it('returns "Reveal in Finder" for darwin', () => {
			expect(getRevealLabel('darwin')).toBe('Reveal in Finder');
		});

		it('returns "Reveal in Explorer" for win32', () => {
			expect(getRevealLabel('win32')).toBe('Reveal in Explorer');
		});

		it('returns "Reveal in File Manager" for linux', () => {
			expect(getRevealLabel('linux')).toBe('Reveal in File Manager');
		});

		it('returns "Reveal in Finder" for unknown platforms', () => {
			expect(getRevealLabel('freebsd')).toBe('Reveal in Finder');
			expect(getRevealLabel('')).toBe('Reveal in Finder');
		});
	});

	describe('getOpenInLabel', () => {
		it('returns "Open in Finder" for darwin', () => {
			expect(getOpenInLabel('darwin')).toBe('Open in Finder');
		});

		it('returns "Open in Explorer" for win32', () => {
			expect(getOpenInLabel('win32')).toBe('Open in Explorer');
		});

		it('returns "Open in File Manager" for linux', () => {
			expect(getOpenInLabel('linux')).toBe('Open in File Manager');
		});

		it('returns "Open in Finder" for unknown platforms', () => {
			expect(getOpenInLabel('freebsd')).toBe('Open in Finder');
			expect(getOpenInLabel('')).toBe('Open in Finder');
		});
	});
});
