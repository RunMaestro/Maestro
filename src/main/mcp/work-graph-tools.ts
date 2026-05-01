// Glue between the internal MCP registry and Work Graph tool builders.
//
// Kept thin so that adding new tool families (e.g. delivery planner) follows
// the same shape: import a builder, push the array into the registry.

import { getMcpToolRegistry, type McpToolRegistry } from './index';
import { buildWorkGraphMcpTools } from '../work-graph/mcp-tools';
import { getWorkGraphItemStore } from '../work-graph';

export interface RegisterWorkGraphMcpToolsOptions {
	/** Override the target registry. Tests use this to isolate state. */
	registry?: McpToolRegistry;
	/** Override the storage instance. Tests use this to inject fixtures. */
	store?: ReturnType<typeof getWorkGraphItemStore>;
}

export function registerWorkGraphMcpTools(
	options: RegisterWorkGraphMcpToolsOptions = {}
): McpToolRegistry {
	const registry = options.registry ?? getMcpToolRegistry();
	const store = options.store ?? getWorkGraphItemStore();
	registry.registerMany(buildWorkGraphMcpTools({ store }));
	return registry;
}
