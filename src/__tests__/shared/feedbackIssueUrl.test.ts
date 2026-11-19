import { describe, it, expect } from 'vitest';
import {
	PREFILLED_ISSUE_URL_MAX_BYTES,
	cappedNewIssueUrl,
	githubNewIssueUrl,
} from '../../shared/feedback';

const REPO = 'RunMaestro/Maestro-Playbooks';
const TRAILER = '<!-- maestro:playbook-failure-fingerprint: 0123456789abcdef -->';

function bodyOf(url: string): string {
	return new URL(url).searchParams.get('body') ?? '';
}

describe('githubNewIssueUrl', () => {
	it('prefills the title and body, encoded', () => {
		const url = githubNewIssueUrl(REPO, 'A & B', 'line 1\nline 2');
		expect(url.startsWith(`https://github.com/${REPO}/issues/new?`)).toBe(true);
		const params = new URL(url).searchParams;
		expect(params.get('title')).toBe('A & B');
		expect(params.get('body')).toBe('line 1\nline 2');
	});
});

describe('cappedNewIssueUrl', () => {
	it('returns the whole body and no overflow when it fits', () => {
		const result = cappedNewIssueUrl(REPO, 'Title', 'short body', { trailer: TRAILER });
		expect(result.overflow).toBeNull();
		expect(bodyOf(result.url)).toBe(`short body\n\n${TRAILER}`);
	});

	it('caps the URL at 6KB by default and moves the rest to the overflow', () => {
		const lines = Array.from({ length: 400 }, (_, i) => `| Row ${i} | value ${i} |`);
		const body = lines.join('\n');
		const result = cappedNewIssueUrl(REPO, 'Title', body, { trailer: TRAILER });
		expect(result.url.length).toBeLessThanOrEqual(PREFILLED_ISSUE_URL_MAX_BYTES);
		expect(result.overflow).not.toBeNull();

		const sent = bodyOf(result.url);
		expect(sent).toContain('The rest of it is on your clipboard');
		expect(sent.endsWith(TRAILER)).toBe(true);
		// Cut at a line boundary: the kept part plus the overflow is the body.
		const kept = sent.slice(0, sent.indexOf('\n\n_This report was too long'));
		expect(kept.endsWith('|')).toBe(true);
		expect(`${kept}\n${result.overflow}`).toBe(body);
	});

	it('honors a smaller cap', () => {
		const body = 'x'.repeat(5000);
		const result = cappedNewIssueUrl(REPO, 'Title', body, { maxBytes: 1024 });
		expect(result.url.length).toBeLessThanOrEqual(1024);
		const sent = bodyOf(result.url);
		const kept = sent.slice(0, sent.indexOf('\n\n_This report was too long'));
		expect(kept + result.overflow).toBe(body);
	});

	it('never splits a surrogate pair', () => {
		const body = '\u{1F600}'.repeat(3000);
		expect(() => cappedNewIssueUrl(REPO, 'Title', body, { maxBytes: 2048 })).not.toThrow();
		const result = cappedNewIssueUrl(REPO, 'Title', body, { maxBytes: 2048 });
		expect(result.url.length).toBeLessThanOrEqual(2048);
	});
});
