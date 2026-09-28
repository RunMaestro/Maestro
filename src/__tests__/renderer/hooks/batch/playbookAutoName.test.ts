import { describe, it, expect } from 'vitest';
import {
	autoPlaybookName,
	extractPlaybookCodename,
} from '../../../../renderer/hooks/batch/usePlaybookManagement';

describe('extractPlaybookCodename', () => {
	it('uses the dated folder, minus its date', () => {
		expect(extractPlaybookCodename('2026-09-25-Desktop-Apps/CONTEXT')).toBe('Desktop-Apps');
		expect(extractPlaybookCodename('2026-09-26-Census-Dashboard-V2/CENSUS-V2-02.md')).toBe(
			'Census-Dashboard-V2'
		);
	});

	it('uses a flat file name, minus date and phase number', () => {
		expect(extractPlaybookCodename('Auth-Rewrite-01')).toBe('Auth-Rewrite');
		expect(extractPlaybookCodename('2026-01-02-Auth-Rewrite-03.md')).toBe('Auth-Rewrite');
		expect(extractPlaybookCodename('notes')).toBe('notes');
	});

	it('falls back when nothing is left', () => {
		expect(extractPlaybookCodename('2026-01-02')).toBe('Playbook');
		expect(extractPlaybookCodename('')).toBe('Playbook');
	});
});

describe('autoPlaybookName', () => {
	const now = new Date(2026, 8, 6, 23, 30);

	it('stamps the local date', () => {
		expect(autoPlaybookName('2026-09-25-Desktop-Apps/CONTEXT', [], now)).toBe(
			'2026-09-06-Desktop-Apps'
		);
	});

	it('suffixes a name that is already taken', () => {
		const taken = ['2026-09-06-Desktop-Apps', '2026-09-06-Desktop-Apps-2'];
		expect(autoPlaybookName('Desktop-Apps-01', taken, now)).toBe('2026-09-06-Desktop-Apps-3');
	});
});
