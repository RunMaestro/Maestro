import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { ANTIGRAVITY_SDK_SIDECAR } from '../../../main/process-manager/spawners/antigravitySdkSidecar';

const PYTHON =
	[process.env.ANTIGRAVITY_PYTHON, 'python', 'python3'].find(
		(candidate): candidate is string =>
			!!candidate && spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0
	) ?? '';
const PYTHON_AVAILABLE = PYTHON !== '';

const STUB = String.raw`
import sys, types
google = types.ModuleType("google")
antigravity = types.ModuleType("google.antigravity")
hooks = types.ModuleType("google.antigravity.hooks")
policy = types.ModuleType("google.antigravity.hooks.policy")
class Config:
    def __init__(self, **kwargs):
        self.policies = kwargs.get("policies")
class Response:
    def __init__(self, value): self.value = value
    async def text(self): return self.value
class Agent:
    def __init__(self, config): self.config = config
    async def __aenter__(self): return self
    async def __aexit__(self, *args): return None
    async def chat(self, _prompt):
        call = types.SimpleNamespace(name="run_command", parameters={"CommandLine": "echo one"})
        allowed = await self.config.policies[0][1](call)
        return Response("APPROVED" if allowed else "DENIED")
antigravity.Agent = Agent
antigravity.LocalAgentConfig = Config
antigravity.CapabilitiesConfig = Config
policy.safe_defaults = lambda handler: [("safe", handler)]
policy.allow = lambda _pattern: [("allow", None)]
hooks.policy = policy
sys.modules["google"] = google
sys.modules["google.antigravity"] = antigravity
sys.modules["google.antigravity.hooks"] = hooks
sys.modules["google.antigravity.hooks.policy"] = policy
`;

// Adds the SDK's types module and an Agent that reports the model it was given.
const EFFORT_STUB = String.raw`
import enum
agtypes = types.ModuleType("google.antigravity.types")
class ThinkingLevel(enum.Enum):
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    EXTRA_HIGH = "extra_high"
class ModelType(enum.Enum):
    TEXT = "text"
class Options:
    def __init__(self, thinking_level): self.thinking_level = thinking_level
class Endpoint:
    def __init__(self, options): self.options = options
class GeminiAPIEndpoint(Endpoint): pass
class VertexEndpoint(Endpoint): pass
class ModelTarget:
    def __init__(self, name, types, endpoint):
        self.name, self.types, self.endpoint = name, types, endpoint
agtypes.ThinkingLevel = ThinkingLevel
agtypes.ModelType = ModelType
agtypes.GeminiModelOptions = Options
agtypes.GeminiAPIEndpoint = GeminiAPIEndpoint
agtypes.VertexEndpoint = VertexEndpoint
agtypes.ModelTarget = ModelTarget
antigravity.types = agtypes
sys.modules["google.antigravity.types"] = agtypes
class ModelConfig:
    def __init__(self, **kwargs): self.model = kwargs.get("model")
class ModelAgent(Agent):
    async def chat(self, _prompt):
        m = self.config.model
        if isinstance(m, str):
            return Response(m)
        level = m.endpoint.options.thinking_level.name
        return Response(f"{m.name} {type(m.endpoint).__name__} {level} {m.types[0].name}")
antigravity.Agent = ModelAgent
antigravity.LocalAgentConfig = ModelConfig
`;

describe.skipIf(!PYTHON_AVAILABLE)('Antigravity SDK sidecar', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	afterEach(() => {
		child?.kill();
		child = undefined;
	});

	// The sidecar picks a Vertex endpoint from these; never inherit the developer's.
	const GEMINI_API_ENV = {
		GOOGLE_GENAI_USE_VERTEXAI: 'false',
		GOOGLE_GENAI_USE_ENTERPRISE: 'false',
	};

	function runSidecar(
		stub: string,
		params: Record<string, unknown>,
		env: Record<string, string> = GEMINI_API_ENV
	) {
		const wrapper = `${stub}\nexec(compile(${JSON.stringify(ANTIGRAVITY_SDK_SIDECAR)}, "sidecar.py", "exec"))\n`;
		child = spawn(PYTHON, ['-u', '-c', wrapper], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, ...env },
		});
		let buffer = '';
		const texts: string[] = [];
		const completed = Promise.withResolvers<number>();
		child.stdout.on('data', (chunk) => {
			buffer += String(chunk);
			while (buffer.includes('\n')) {
				const index = buffer.indexOf('\n');
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line) continue;
				const frame = JSON.parse(line);
				if (frame.method === 'approval') {
					child!.stdin.write(
						JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { allow: true } }) + '\n'
					);
				} else if (frame.method === 'text') {
					texts.push(frame.params.text);
				} else if (frame.method === 'complete') {
					completed.resolve(frame.params.code);
				}
			}
		});
		child.stdin.write(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 'start-1',
				method: 'start',
				params: { cwd: process.cwd(), prompt: 'run', ...params },
			}) + '\n'
		);
		return { code: completed.promise, texts };
	}

	it('emits a policy approval request and uses its single response', async () => {
		const run = runSidecar(STUB, { permission_mode: 'standard' });
		await expect(run.code).resolves.toBe(0);
		expect(run.texts).toEqual(['APPROVED']);
		child!.stdin.end();
	}, 15_000);

	it('carries the effort as the thinking level of a Gemini API model target', async () => {
		const run = runSidecar(STUB + EFFORT_STUB, {
			permission_mode: 'full',
			model: 'gemini-4-neon',
			effort: 'xhigh',
		});
		await expect(run.code).resolves.toBe(0);
		expect(run.texts).toEqual(['gemini-4-neon GeminiAPIEndpoint EXTRA_HIGH TEXT']);
		child!.stdin.end();
	}, 15_000);

	it('carries the effort on a Vertex model target when Vertex is selected', async () => {
		const run = runSidecar(
			STUB + EFFORT_STUB,
			{ permission_mode: 'full', model: 'gemini-4-hydrogen', effort: 'low' },
			{ GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_GENAI_USE_ENTERPRISE: 'false' }
		);
		await expect(run.code).resolves.toBe(0);
		expect(run.texts).toEqual(['gemini-4-hydrogen VertexEndpoint LOW TEXT']);
		child!.stdin.end();
	}, 15_000);

	it('passes a model with no effort through by name', async () => {
		const run = runSidecar(STUB + EFFORT_STUB, { permission_mode: 'full', model: 'gemini-4-neon' });
		await expect(run.code).resolves.toBe(0);
		expect(run.texts).toEqual(['gemini-4-neon']);
		child!.stdin.end();
	}, 15_000);
});
