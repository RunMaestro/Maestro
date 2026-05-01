// Internal MCP-style tool registry.
//
// This is an in-process surface for tools exposed to internal Maestro
// orchestration and external agents. It is intentionally distinct from the
// hosted public docs MCP server (https://docs.runmaestro.ai/mcp): tools
// registered here describe Maestro's own state (Work Graph, etc.), and are
// invoked directly by callers in the main process. There is no transport or
// JSON-RPC framing here; callers can attach their own.

export type McpJsonValue =
	| string
	| number
	| boolean
	| null
	| McpJsonValue[]
	| { [key: string]: McpJsonValue };

/**
 * Minimal JSON-Schema subset describing tool inputs. Modeled after the MCP
 * tools/list response — only the fields we currently consume are typed.
 */
export interface McpToolInputSchema {
	type: 'object';
	properties?: Record<string, McpJsonValue>;
	required?: string[];
	additionalProperties?: boolean;
	description?: string;
}

export interface McpTool<TInput = unknown, TOutput = unknown> {
	name: string;
	description: string;
	inputSchema: McpToolInputSchema;
	handler: (input: TInput) => Promise<TOutput> | TOutput;
}

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: McpToolInputSchema;
}

export class McpToolRegistry {
	private readonly tools = new Map<string, McpTool>();

	register(tool: McpTool): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`MCP tool already registered: ${tool.name}`);
		}
		this.tools.set(tool.name, tool);
	}

	registerMany(tools: McpTool[]): void {
		for (const tool of tools) {
			this.register(tool);
		}
	}

	unregister(name: string): boolean {
		return this.tools.delete(name);
	}

	clear(): void {
		this.tools.clear();
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	get(name: string): McpTool | undefined {
		return this.tools.get(name);
	}

	list(): McpToolDefinition[] {
		return Array.from(this.tools.values()).map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
		}));
	}

	async invoke<TOutput = unknown>(name: string, input: unknown): Promise<TOutput> {
		const tool = this.tools.get(name);
		if (!tool) {
			throw new Error(`Unknown MCP tool: ${name}`);
		}
		const result = await tool.handler(input);
		return result as TOutput;
	}
}

let registry: McpToolRegistry | null = null;

export function getMcpToolRegistry(): McpToolRegistry {
	if (!registry) {
		registry = new McpToolRegistry();
	}
	return registry;
}

/**
 * Reset the registry. Intended for tests; callers in production should not
 * need to invoke this.
 */
export function resetMcpToolRegistry(): void {
	registry = null;
}
