const GITHUB_ACCEPT = 'application/vnd.github.v3+json';
const GITHUB_USER_AGENT = 'Maestro-Symphony';

export type SymphonyRequestHeaders =
	| Headers
	| Record<string, string>
	| ReadonlyArray<readonly [string, string]>;

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((header) => header.toLowerCase() === name.toLowerCase());
}

/**
 * Builds headers for Symphony GitHub API requests without replacing endpoint-specific
 * content, conditional, authorization, or caller-provided protocol headers.
 */
export function buildSymphonyGitHubHeaders(
	callerHeaders?: SymphonyRequestHeaders,
	authToken?: string
): Record<string, string> {
	const headers: Record<string, string> = {};
	if (callerHeaders instanceof Headers) {
		Object.assign(headers, Object.fromEntries(callerHeaders.entries()));
	} else if (Array.isArray(callerHeaders)) {
		for (const [name, value] of callerHeaders) {
			headers[name] = value;
		}
	} else if (callerHeaders) {
		Object.assign(headers, callerHeaders);
	}

	if (!hasHeader(headers, 'Accept')) headers.Accept = GITHUB_ACCEPT;
	if (!hasHeader(headers, 'User-Agent')) headers['User-Agent'] = GITHUB_USER_AGENT;
	if (authToken && !hasHeader(headers, 'Authorization'))
		headers.Authorization = `Bearer ${authToken}`;

	return headers;
}
