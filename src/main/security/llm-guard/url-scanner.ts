/**
 * URL Scanner for LLM Guard
 *
 * Detects potentially malicious URL patterns in text:
 * - URLs with suspicious TLDs (.tk, .ml, .ga, etc.)
 * - IP address URLs (http://192.168.x.x)
 * - URLs with encoded characters in hostname
 * - URLs with excessive subdomains
 * - Punycode/homograph domains (IDN homograph attacks)
 * - Known URL shorteners (optional warning)
 */

import type { LlmGuardFinding } from './types';

// Suspicious TLDs often associated with malicious activity
const SUSPICIOUS_TLDS = new Set([
	'tk', // Tokelau - frequently used for free domains
	'ml', // Mali - frequently used for free domains
	'ga', // Gabon - frequently used for free domains
	'cf', // Central African Republic - frequently used for free domains
	'gq', // Equatorial Guinea - frequently used for free domains
	'top',
	'xyz',
	'work',
	'click',
	'link',
	'icu',
	'buzz',
	'club',
	'gdn',
	'men',
	'cam',
	'loan',
	'stream',
	'download',
	'racing',
	'win',
	'bid',
	'date',
	'review',
	'trade',
	'webcam',
	'party',
	'science',
	'cricket',
	'faith',
	'accountant',
]);

// Known URL shorteners
const URL_SHORTENERS = new Set([
	'bit.ly',
	'bitly.com',
	'goo.gl',
	't.co',
	'tinyurl.com',
	'ow.ly',
	'is.gd',
	'buff.ly',
	'adf.ly',
	'bit.do',
	'mcaf.ee',
	'su.pr',
	'tiny.cc',
	'v.gd',
	'yourls.org',
	'cutt.ly',
	'rb.gy',
	'shorturl.at',
	's.coop',
	'j.mp',
	'qr.ae',
	'bl.ink',
	'tiny.one',
	'tr.im',
	'po.st',
]);

// Regex to extract URLs from text
// Matches http, https, ftp, and protocol-relative URLs
const URL_REGEX =
	/(?:https?|ftp):\/\/(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:\/[^\s"'<>]*)?/gi;

// URL-encoded hostname characters pattern
const ENCODED_HOSTNAME_REGEX = /%[0-9A-Fa-f]{2}/g;

// Excessive subdomain pattern (more than 4 parts)
const EXCESSIVE_SUBDOMAINS_THRESHOLD = 4;

export interface UrlFinding extends LlmGuardFinding {
	url: string;
	reasons: string[];
}

/**
 * Extracts the hostname from a URL string.
 */
function extractHostname(url: string): string | null {
	try {
		// Try to parse as URL
		const parsed = new URL(url);
		return parsed.hostname.toLowerCase();
	} catch {
		// If URL constructor fails, try manual extraction
		const match = url.match(/(?:https?|ftp):\/\/([^/:]+)/i);
		return match ? match[1].toLowerCase() : null;
	}
}

/**
 * Gets the TLD from a hostname.
 */
function getTld(hostname: string): string | null {
	const parts = hostname.split('.');
	if (parts.length < 2) return null;
	return parts[parts.length - 1].toLowerCase();
}

/**
 * Checks if a hostname is an IP address.
 */
function isIpAddress(hostname: string): boolean {
	return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

/**
 * Checks if a hostname contains punycode (IDN).
 */
function containsPunycode(hostname: string): boolean {
	return hostname.includes('xn--');
}

/**
 * Counts subdomain levels in a hostname.
 */
function getSubdomainCount(hostname: string): number {
	// Remove www if present and count dots
	const cleanHostname = hostname.replace(/^www\./i, '');
	const parts = cleanHostname.split('.');
	// Subtract 2 for domain + TLD
	return Math.max(0, parts.length - 2);
}

/**
 * Checks if URL contains encoded characters in the hostname portion.
 */
function hasEncodedHostname(url: string): boolean {
	try {
		// Validate that the URL is parseable
		new URL(url);
		// Extract hostname portion from the raw URL string
		const hostnameFromUrl = url.substring(
			url.indexOf('://') + 3,
			url.indexOf('/', url.indexOf('://') + 3) === -1
				? url.length
				: url.indexOf('/', url.indexOf('://') + 3)
		);
		return ENCODED_HOSTNAME_REGEX.test(hostnameFromUrl);
	} catch {
		return false;
	}
}

/**
 * Checks if a hostname is a known URL shortener.
 */
function isUrlShortener(hostname: string): boolean {
	// Check exact match
	if (URL_SHORTENERS.has(hostname)) return true;

	// Check without www
	const withoutWww = hostname.replace(/^www\./i, '');
	return URL_SHORTENERS.has(withoutWww);
}

/**
 * Calculate suspicion score for a URL based on various indicators.
 * Returns a score between 0 and 1.
 */
function calculateSuspicionScore(reasons: string[]): number {
	// Weight different indicators
	const weights: Record<string, number> = {
		ip_address: 0.75,
		suspicious_tld: 0.6,
		punycode: 0.7,
		encoded_hostname: 0.8,
		excessive_subdomains: 0.55,
		url_shortener: 0.3,
	};

	let score = 0;
	let maxWeight = 0;

	for (const reason of reasons) {
		const weight = weights[reason] || 0.5;
		score += weight;
		maxWeight = Math.max(maxWeight, weight);
	}

	// Boost score if multiple indicators are present
	if (reasons.length > 1) {
		score = Math.min(1, maxWeight + (reasons.length - 1) * 0.15);
	} else {
		score = maxWeight;
	}

	return score;
}

/**
 * Analyze a single URL for suspicious patterns.
 * Returns an array of reasons why the URL is suspicious (empty if not suspicious).
 */
function analyzeUrl(url: string): string[] {
	const reasons: string[] = [];
	const hostname = extractHostname(url);

	if (!hostname) return reasons;

	// Check for IP address URL
	if (isIpAddress(hostname)) {
		reasons.push('ip_address');
	}

	// Check for suspicious TLD
	const tld = getTld(hostname);
	if (tld && SUSPICIOUS_TLDS.has(tld)) {
		reasons.push('suspicious_tld');
	}

	// Check for punycode (potential IDN homograph attack)
	if (containsPunycode(hostname)) {
		reasons.push('punycode');
	}

	// Check for encoded characters in hostname
	if (hasEncodedHostname(url)) {
		reasons.push('encoded_hostname');
	}

	// Check for excessive subdomains
	if (getSubdomainCount(hostname) >= EXCESSIVE_SUBDOMAINS_THRESHOLD) {
		reasons.push('excessive_subdomains');
	}

	// Check for URL shortener
	if (isUrlShortener(hostname)) {
		reasons.push('url_shortener');
	}

	return reasons;
}

/**
 * Generate a human-readable description of why a URL is suspicious.
 */
function getReasonDescription(reasons: string[]): string {
	const descriptions: Record<string, string> = {
		ip_address: 'IP address URL',
		suspicious_tld: 'suspicious TLD',
		punycode: 'IDN/punycode domain',
		encoded_hostname: 'URL-encoded hostname',
		excessive_subdomains: 'excessive subdomains',
		url_shortener: 'URL shortener',
	};

	return reasons.map((r) => descriptions[r] || r).join(', ');
}

/**
 * Scan text for potentially malicious URLs.
 *
 * @param text - The text to scan for URLs
 * @param options - Optional configuration
 * @returns Array of findings for detected suspicious URLs
 */
export function scanUrls(
	text: string,
	options: {
		warnOnShorteners?: boolean;
		minConfidence?: number;
	} = {}
): LlmGuardFinding[] {
	const { warnOnShorteners = true, minConfidence = 0.3 } = options;

	const findings: LlmGuardFinding[] = [];
	const urlMatcher = new RegExp(URL_REGEX.source, URL_REGEX.flags);
	let match: RegExpExecArray | null;

	while ((match = urlMatcher.exec(text)) !== null) {
		const url = match[0];
		const reasons = analyzeUrl(url);

		// Filter out URL shortener warnings if disabled
		if (!warnOnShorteners) {
			const shortenerIndex = reasons.indexOf('url_shortener');
			if (shortenerIndex !== -1) {
				reasons.splice(shortenerIndex, 1);
			}
		}

		// Skip if no suspicious indicators
		if (reasons.length === 0) continue;

		const confidence = calculateSuspicionScore(reasons);

		// Skip if below minimum confidence
		if (confidence < minConfidence) continue;

		findings.push({
			type: 'MALICIOUS_URL',
			value: url,
			start: match.index,
			end: match.index + url.length,
			confidence,
			replacement: `[SUSPICIOUS_URL: ${getReasonDescription(reasons)}]`,
		});
	}

	return findings;
}

/**
 * Scan text for URLs and return detailed analysis.
 * This is useful for debugging or displaying detailed information to users.
 *
 * @param text - The text to scan for URLs
 * @returns Array of detailed URL findings
 */
export function scanUrlsDetailed(text: string): UrlFinding[] {
	const findings: UrlFinding[] = [];
	const urlMatcher = new RegExp(URL_REGEX.source, URL_REGEX.flags);
	let match: RegExpExecArray | null;

	while ((match = urlMatcher.exec(text)) !== null) {
		const url = match[0];
		const reasons = analyzeUrl(url);

		// Include all URLs in detailed scan, even non-suspicious ones
		const confidence = reasons.length > 0 ? calculateSuspicionScore(reasons) : 0;

		findings.push({
			type: reasons.length > 0 ? 'MALICIOUS_URL' : 'URL',
			value: url,
			url,
			start: match.index,
			end: match.index + url.length,
			confidence,
			reasons,
			replacement:
				reasons.length > 0 ? `[SUSPICIOUS_URL: ${getReasonDescription(reasons)}]` : undefined,
		});
	}

	return findings;
}

// Export utility functions for testing
export const _internals = {
	extractHostname,
	getTld,
	isIpAddress,
	containsPunycode,
	getSubdomainCount,
	hasEncodedHostname,
	isUrlShortener,
	analyzeUrl,
	calculateSuspicionScore,
	SUSPICIOUS_TLDS,
	URL_SHORTENERS,
};
