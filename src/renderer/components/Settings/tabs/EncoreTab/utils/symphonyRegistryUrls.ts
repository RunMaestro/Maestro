import { SYMPHONY_REGISTRY_URL } from '../../../../../../shared/symphony-constants';

export interface RegistryUrlValidationResult {
	canonical?: string;
	error?: string;
}

export function canonicalizeRegistryUrl(raw: string): string {
	const url = new URL(raw.trim());
	url.hash = '';
	return url.href;
}

export function validateRegistryUrl(
	raw: string,
	existingUrls: string[],
	defaultUrl = SYMPHONY_REGISTRY_URL
): RegistryUrlValidationResult {
	const trimmed = raw.trim();
	if (!trimmed) return { error: 'URL cannot be empty' };

	let canonical: string;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			return { error: 'URL must use HTTP or HTTPS' };
		}
		canonical = canonicalizeRegistryUrl(trimmed);
	} catch {
		return { error: 'Invalid URL format' };
	}

	try {
		if (canonical === canonicalizeRegistryUrl(defaultUrl)) {
			return { error: 'This is the default registry URL' };
		}
	} catch {
		/* default URL should always parse */
	}

	const existing = new Set(
		existingUrls.map((url) => {
			try {
				return canonicalizeRegistryUrl(url);
			} catch {
				return url.trim();
			}
		})
	);
	if (existing.has(canonical)) return { error: 'URL already added' };

	return { canonical };
}
