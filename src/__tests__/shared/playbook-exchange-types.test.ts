import { describe, it, expect } from 'vitest';
import {
	isPlaybookSourceChannel,
	PLAYBOOK_PRISTINE_SOURCE_DIR,
	readPlaybookExchangeHints,
} from '../../shared/types';

describe('readPlaybookExchangeHints', () => {
	it('keeps well-formed interaction, scope, and report', () => {
		expect(
			readPlaybookExchangeHints({ interaction: 'guided', scope: 'machine', report: 'Report' })
		).toEqual({
			interaction: 'guided',
			scope: 'machine',
			report: 'Report',
		});
	});

	it('strips a trailing .md and surrounding space from report', () => {
		expect(readPlaybookExchangeHints({ report: '  Final-Report.MD ' })).toEqual({
			report: 'Final-Report',
		});
	});

	it('drops values with the wrong shape', () => {
		expect(readPlaybookExchangeHints({ interaction: 'wizard', scope: 7, report: '   ' })).toEqual(
			{}
		);
		expect(readPlaybookExchangeHints({ report: '.md' })).toEqual({});
		expect(readPlaybookExchangeHints({})).toEqual({});
	});
});

describe('isPlaybookSourceChannel', () => {
	it('accepts only official and local', () => {
		expect(isPlaybookSourceChannel('official')).toBe(true);
		expect(isPlaybookSourceChannel('local')).toBe(true);
		expect(isPlaybookSourceChannel('Official')).toBe(false);
		expect(isPlaybookSourceChannel(undefined)).toBe(false);
	});
});

describe('PLAYBOOK_PRISTINE_SOURCE_DIR', () => {
	it('starts with a dot folder so Auto Run never lists the copies', () => {
		expect(PLAYBOOK_PRISTINE_SOURCE_DIR.startsWith('.')).toBe(true);
	});
});
