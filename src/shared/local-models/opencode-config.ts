/**
 * OpenCode's inline config document (`OPENCODE_CONFIG_CONTENT`), as pure
 * functions.
 *
 * OpenCode takes its providers from one JSON document in one variable, and the
 * same variable carries Maestro's permission block (the provider default), the
 * read-only override of it, or the user's own config. So a launch that points
 * OpenCode somewhere ADDS to the document it would otherwise carry, never
 * replaces it: replacing it would drop `question: deny` and hang batch mode.
 * The Run on recipe and the Local Models gateway both build on these helpers.
 */

/** The variable OpenCode reads an inline config document from. */
export const OPENCODE_CONFIG_ENV_VAR = 'OPENCODE_CONFIG_CONTENT';

/**
 * The built-in OpenCode providers a gateway carries: the two whose wire
 * formats the Maestro token proxy routes (Anthropic Messages, OpenAI
 * Responses). Every other provider is switched off for a gateway launch, so a
 * model from one of them fails by name instead of running direct while the
 * agent is shown as proxied.
 */
export const OPENCODE_GATEWAY_PROVIDERS = ['anthropic', 'openai'] as const;

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The document as an object. A value that is not a JSON object cannot be
 * added to, and OpenCode could not have read it either, so it counts as empty.
 */
export function parseOpenCodeConfig(text: string | undefined): Record<string, unknown> {
	if (!text) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return isJsonObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** `current` with one provider entry set; every other key of it is kept. */
export function withOpenCodeProvider(
	current: string | undefined,
	providerId: string,
	provider: unknown
): string {
	const config = parseOpenCodeConfig(current);
	const providers = isJsonObject(config.provider) ? config.provider : {};
	return JSON.stringify({ ...config, provider: { ...providers, [providerId]: provider } });
}

/**
 * `current` with a gateway added: the base URL of each provider in
 * {@link OPENCODE_GATEWAY_PROVIDERS} set to `baseUrl`, and only those
 * providers enabled (narrowed further by the document's own list, when it has
 * one). Each provider entry keeps its other keys.
 *
 * `baseUrl` is what OpenCode's `options.baseURL` takes: the API root WITH its
 * version (`.../v1`). OpenCode appends `/messages` for Anthropic and
 * `/responses` for OpenAI (measured, OpenCode 2.2.7).
 */
export function withOpenCodeGateway(current: string | undefined, baseUrl: string): string {
	const config = parseOpenCodeConfig(current);
	const providers = isJsonObject(config.provider) ? { ...config.provider } : {};
	for (const id of OPENCODE_GATEWAY_PROVIDERS) {
		const entry = isJsonObject(providers[id]) ? providers[id] : {};
		const options = isJsonObject(entry.options) ? entry.options : {};
		providers[id] = { ...entry, options: { ...options, baseURL: baseUrl } };
	}
	const enabled = Array.isArray(config.enabled_providers)
		? config.enabled_providers.filter((id): id is string =>
				(OPENCODE_GATEWAY_PROVIDERS as readonly unknown[]).includes(id)
			)
		: [...OPENCODE_GATEWAY_PROVIDERS];
	return JSON.stringify({ ...config, enabled_providers: enabled, provider: providers });
}

/**
 * Whether a document names a base URL for a provider a gateway would carry.
 * Such a document is the user's own choice of address, and wins over the
 * gateway the way a user's base-URL variable does.
 */
export function openCodeConfigNamesBaseUrl(text: string | undefined): boolean {
	const providers = parseOpenCodeConfig(text).provider;
	if (!isJsonObject(providers)) return false;
	return OPENCODE_GATEWAY_PROVIDERS.some((id) => {
		const entry = providers[id];
		const options = isJsonObject(entry) ? entry.options : undefined;
		return isJsonObject(options) && typeof options.baseURL === 'string' && options.baseURL !== '';
	});
}
