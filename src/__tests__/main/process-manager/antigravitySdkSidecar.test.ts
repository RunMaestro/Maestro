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

describe.skipIf(!PYTHON_AVAILABLE)('Antigravity SDK sidecar', () => {
	let child: ChildProcessWithoutNullStreams | undefined;
	afterEach(() => {
		child?.kill();
		child = undefined;
	});

	it('emits a policy approval request and uses its single response', async () => {
		const wrapper = `${STUB}\nexec(compile(${JSON.stringify(ANTIGRAVITY_SDK_SIDECAR)}, "sidecar.py", "exec"))\n`;
		child = spawn(PYTHON, ['-u', '-c', wrapper], { stdio: ['pipe', 'pipe', 'pipe'] });
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
				params: { cwd: process.cwd(), prompt: 'run', permission_mode: 'standard' },
			}) + '\n'
		);
		await expect(completed.promise).resolves.toBe(0);
		expect(texts).toEqual(['APPROVED']);
		child.stdin.end();
	}, 15_000);
});
