import { isPromise } from 'node:util/types';
import { isValidAllowlistMember } from '../../shared/plugins/permissions';
import { PluginAuthorityError } from '../../shared/plugins/plugin-json';
export { PluginAuthorityError, pluginJson, pluginRequest } from '../../shared/plugins/plugin-json';

/** Host assertions must be synchronous, with no result. Async never grants authority. */
export function assertPluginAuthority(assertion: () => void): void {
	try {
		const result: unknown = assertion();
		if (result !== undefined) {
			if (isPromise(result))
				void Promise.prototype.then.call(
					result,
					() => undefined,
					() => undefined
				);
			throw new PluginAuthorityError('PLUGIN_DENIED');
		}
	} catch (error) {
		throw error instanceof PluginAuthorityError ? error : new PluginAuthorityError('PLUGIN_DENIED');
	}
}

export function requirePluginAgentId(value: unknown): string {
	if (!isValidAllowlistMember(value) || !/^[\x21-\x7e]{1,128}$/.test(value))
		throw new PluginAuthorityError('PLUGIN_INVALID');
	return value;
}
