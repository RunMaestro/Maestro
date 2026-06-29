// Test harness: a mock omp ExtensionAPI that records tool/handler registrations
// and lets tests drive lifecycle events. Not a test file itself.

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionEventHandler,
	ExtensionEventName,
	ToolDefinition,
	ZodModule,
	ZodType,
} from '@oh-my-pi/pi-coding-agent';

function makeZodType(): ZodType {
	const type: ZodType = {
		optional: () => type,
		default: () => type,
		describe: () => type,
	};
	return type;
}

const zod: ZodModule = {
	object: () => makeZodType(),
	string: () => makeZodType(),
	number: () => makeZodType(),
	boolean: () => makeZodType(),
};

export interface MockPi {
	pi: ExtensionAPI;
	tools: Map<string, ToolDefinition>;
	handlers: Map<ExtensionEventName, ExtensionEventHandler[]>;
}

export function makeMockPi(): MockPi {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<ExtensionEventName, ExtensionEventHandler[]>();
	const pi: ExtensionAPI = {
		setLabel: () => undefined,
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (def) => {
			tools.set(def.name, def);
		},
		registerCommand: () => undefined,
		appendEntry: () => undefined,
		setSessionName: async () => undefined,
		zod,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
	};
	return { pi, tools, handlers };
}

export function makeCtx(options: { cwd?: string; sessionFile?: string } = {}): ExtensionContext {
	return {
		cwd: options.cwd ?? '/repo',
		hasUI: false,
		sessionManager: { getSessionFile: () => options.sessionFile },
		ui: { notify: () => undefined },
	};
}

export function getTool(mock: MockPi, name: string): ToolDefinition {
	const tool = mock.tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return tool;
}

export async function fireEvent(
	mock: MockPi,
	event: ExtensionEventName,
	payload: ExtensionEvent,
	ctx: ExtensionContext
): Promise<void> {
	for (const handler of mock.handlers.get(event) ?? []) {
		await handler(payload, ctx);
	}
}

export function tokenOf(value: unknown): string {
	if (value && typeof value === 'object' && 'token' in value && typeof value.token === 'string') {
		return value.token;
	}
	return '';
}
