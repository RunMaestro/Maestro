/**
 * Group Chat Integration Tests (Real Agents)
 *
 * These tests verify that group chat works with real AI agents:
 * 1. Detect available agents (Claude Code, Codex, OpenCode)
 * 2. Randomly select one as moderator, others as participants
 * 3. Have a real conversation between them
 * 4. Test argument building with and without images
 *
 * REQUIREMENTS:
 * - At least 2 AI provider CLIs must be installed
 * - They make real API calls and may incur costs
 *
 * These tests are SKIPPED by default. To run them:
 *   RUN_INTEGRATION_TESTS=true npm test -- group-chat-integration
 *
 * IMPORTANT: These tests mirror the actual argument building logic from:
 * - src/main/agent-detector.ts (agent definitions with arg builders)
 * - src/main/ipc/handlers/process.ts (IPC spawn handler)
 * - src/main/process-manager.ts (ProcessManager.spawn)
 *
 * If those files change, these tests should be updated to match.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import { getAgentCapabilities } from '../../main/agent-capabilities';

const execAsync = promisify(exec);

// Skip integration tests by default - they make real API calls and may incur costs.
const SKIP_INTEGRATION = process.env.RUN_INTEGRATION_TESTS !== 'true';

// Timeout for agent responses
const AGENT_TIMEOUT = 120_000; // 2 minutes per agent
const TEST_TIMEOUT = 300_000; // 5 minutes total for multi-agent tests

// Test directory
const TEST_CWD = process.cwd();

interface AgentConfig {
	id: string;
	name: string;
	command: string;
	checkCommand: string;
	/**
	 * Build args for batch mode with a prompt.
	 * These should mirror the logic in:
	 * - agent-detector.ts (base args, batchModePrefix, batchModeArgs, jsonOutputArgs, etc.)
	 * - process.ts IPC handler (arg assembly order)
	 * - process-manager.ts (--input-format stream-json for images)
	 */
	buildArgs: (prompt: string, options?: { images?: string[] }) => string[];
	/** Parse response text from output */
	parseResponse: (output: string) => string | null;
	/** Check if output indicates success */
	isSuccessful: (output: string, exitCode: number) => boolean;
}

const AGENTS: AgentConfig[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		checkCommand: 'claude --version',
		/**
		 * Mirrors agent-detector.ts Claude Code definition:
		 *   args: ['--print', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions']
		 *
		 * And process-manager.ts spawn() logic for images:
		 *   if (hasImages && prompt && capabilities.supportsStreamJsonInput) {
		 *     finalArgs = [...args, '--input-format', 'stream-json'];
		 *   }
		 */
		buildArgs: (prompt: string, options?: { images?: string[] }) => {
			const baseArgs = [
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--dangerously-skip-permissions',
			];

			const hasImages = options?.images && options.images.length > 0;
			const capabilities = getAgentCapabilities('claude-code');

			if (hasImages && capabilities.supportsStreamJsonInput) {
				// With images: add --input-format stream-json (prompt sent via stdin)
				return [...baseArgs, '--input-format', 'stream-json'];
			} else {
				// Without images: prompt as CLI argument
				return [...baseArgs, '--', prompt];
			}
		},
		parseResponse: (output: string) => {
			for (const line of output.split('\n')) {
				try {
					const json = JSON.parse(line);
					if (json.type === 'result' && json.result) return json.result;
				} catch {
					/* ignore non-JSON lines */
				}
			}
			return null;
		},
		isSuccessful: (_output: string, exitCode: number) => exitCode === 0,
	},
	{
		id: 'codex',
		name: 'Codex',
		command: 'codex',
		checkCommand: 'codex --version',
		/**
		 * Mirrors agent-detector.ts Codex definition:
		 *   batchModePrefix: ['exec']
		 *   batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
		 *   jsonOutputArgs: ['--json']
		 *   workingDirArgs: (dir) => ['-C', dir]
		 *
		 * And process-manager.ts spawn() logic for images:
		 *   Codex does NOT support --input-format stream-json (supportsStreamJsonInput: false)
		 */
		buildArgs: (prompt: string, options?: { images?: string[] }) => {
			const args = [
				'exec',
				'--dangerously-bypass-approvals-and-sandbox',
				'--skip-git-repo-check',
				'--json',
				'-C',
				TEST_CWD,
			];

			// IMPORTANT: This mirrors process-manager.ts logic
			// Codex does NOT support --input-format stream-json (supportsStreamJsonInput: false)
			const hasImages = options?.images && options.images.length > 0;
			const capabilities = getAgentCapabilities('codex');

			if (hasImages && capabilities.supportsStreamJsonInput) {
				// This branch should NEVER execute for Codex
				throw new Error('Codex should not support stream-json input - capability misconfigured');
			}

			// Regular batch mode - prompt as CLI arg
			return [...args, '--', prompt];
		},
		parseResponse: (output: string) => {
			const responses: string[] = [];
			for (const line of output.split('\n')) {
				try {
					const json = JSON.parse(line);
					if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
						if (json.item.text) responses.push(json.item.text);
					}
				} catch {
					/* ignore non-JSON lines */
				}
			}
			return responses.length > 0 ? responses.join('\n') : null;
		},
		isSuccessful: (output: string, exitCode: number) => {
			if (exitCode !== 0) return false;
			for (const line of output.split('\n')) {
				try {
					const json = JSON.parse(line);
					if (json.type === 'turn.completed') return true;
				} catch {
					/* ignore */
				}
			}
			return false;
		},
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		command: 'opencode',
		checkCommand: 'opencode --version',
		/**
		 * Mirrors agent-detector.ts OpenCode definition:
		 *   promptArgs: (prompt) => ['-p', prompt]  // -p flag enables YOLO mode (auto-approve)
		 *   jsonOutputArgs: ['--format', 'json']
		 *
		 * And process-manager.ts spawn() logic for images:
		 *   OpenCode does NOT support --input-format stream-json (supportsStreamJsonInput: false)
		 */
		buildArgs: (prompt: string, options?: { images?: string[] }) => {
			const args = ['--format', 'json'];

			// IMPORTANT: This mirrors process-manager.ts logic
			// OpenCode does NOT support --input-format stream-json (supportsStreamJsonInput: false)
			const hasImages = options?.images && options.images.length > 0;
			const capabilities = getAgentCapabilities('opencode');

			if (hasImages && capabilities.supportsStreamJsonInput) {
				// This branch should NEVER execute for OpenCode
				throw new Error('OpenCode should not support stream-json input - capability misconfigured');
			}

			// OpenCode uses -p flag for prompt (enables YOLO mode with auto-approve)
			return [...args, '-p', prompt];
		},
		parseResponse: (output: string) => {
			const responses: string[] = [];
			for (const line of output.split('\n')) {
				try {
					const json = JSON.parse(line);
					if (json.type === 'text' && json.part?.text) {
						responses.push(json.part.text);
					}
				} catch {
					/* ignore non-JSON lines */
				}
			}
			return responses.length > 0 ? responses.join('') : null;
		},
		isSuccessful: (_output: string, exitCode: number) => exitCode === 0,
	},
];

/**
 * Check if an agent CLI is available
 */
async function isAgentAvailable(agent: AgentConfig): Promise<boolean> {
	try {
		await execAsync(agent.checkCommand);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run an agent command and capture output
 */
function runAgent(
	agent: AgentConfig,
	prompt: string,
	timeout: number = AGENT_TIMEOUT
): Promise<{ stdout: string; stderr: string; exitCode: number; response: string | null }> {
	return new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		const args = agent.buildArgs(prompt);

		const proc = spawn(agent.command, args, {
			cwd: TEST_CWD,
			env: { ...process.env },
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// Close stdin immediately
		proc.stdin?.end();

		proc.stdout?.on('data', (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on('data', (data) => {
			stderr += data.toString();
		});

		const timeoutId = setTimeout(() => {
			proc.kill('SIGTERM');
			resolve({
				stdout,
				stderr: stderr + '\n[TIMEOUT]',
				exitCode: 124,
				response: null,
			});
		}, timeout);

		proc.on('close', (code) => {
			clearTimeout(timeoutId);
			const response = agent.parseResponse(stdout);
			resolve({
				stdout,
				stderr,
				exitCode: code ?? 1,
				response,
			});
		});

		proc.on('error', (err) => {
			clearTimeout(timeoutId);
			stderr += err.message;
			resolve({
				stdout,
				stderr,
				exitCode: 1,
				response: null,
			});
		});
	});
}

/**
 * Shuffle array (Fisher-Yates)
 */
function shuffle<T>(array: T[]): T[] {
	const result = [...array];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

describe.skipIf(SKIP_INTEGRATION)('Group Chat Integration Tests (Real Agents)', () => {
	let availableAgents: AgentConfig[] = [];
	let moderator: AgentConfig;
	let participants: AgentConfig[];

	beforeAll(async () => {
		console.log('\n🔍 Detecting available agents...');

		// Check which agents are available
		for (const agent of AGENTS) {
			const available = await isAgentAvailable(agent);
			if (available) {
				availableAgents.push(agent);
				console.log(`  ✅ ${agent.name} available`);
			} else {
				console.log(`  ❌ ${agent.name} not available`);
			}
		}

		if (availableAgents.length < 2) {
			console.log('\n⚠️  Need at least 2 agents for group chat tests');
			return;
		}

		// Randomly shuffle and assign roles
		const shuffled = shuffle(availableAgents);
		moderator = shuffled[0];
		participants = shuffled.slice(1);

		console.log(`\n📋 Role Assignment:`);
		console.log(`  🎯 Moderator: ${moderator.name}`);
		console.log(`  👥 Participants: ${participants.map((p) => p.name).join(', ')}`);
	});

	it('should have at least 2 agents available', () => {
		expect(availableAgents.length).toBeGreaterThanOrEqual(2);
	});

	it(
		'moderator can receive and respond to a user message',
		async () => {
			if (availableAgents.length < 2) {
				console.log('Skipping: not enough agents');
				return;
			}

			const prompt = `You are a moderator in a group chat. A user just asked: "What is 2 + 2?"

Respond briefly with the answer. Just say the answer, nothing else.`;

			console.log(`\n🎯 Testing moderator (${moderator.name})...`);
			const result = await runAgent(moderator, prompt);

			console.log(`  Exit code: ${result.exitCode}`);
			console.log(`  Response: ${result.response?.substring(0, 200) || '[no response]'}`);

			expect(result.exitCode).toBe(0);
			expect(result.response).toBeTruthy();
			expect(result.response?.toLowerCase()).toContain('4');
		},
		AGENT_TIMEOUT
	);

	it(
		'participant agent can respond to a task',
		async () => {
			if (availableAgents.length < 2 || participants.length === 0) {
				console.log('Skipping: not enough agents');
				return;
			}

			const participant = participants[0];
			const prompt = `You are a participant in a group chat named "NumberGenerator".
The moderator asked you: "Please pick a random number between 1 and 10."

Respond with just the number you picked, nothing else.`;

			console.log(`\n👤 Testing participant (${participant.name})...`);
			const result = await runAgent(participant, prompt);

			console.log(`  Exit code: ${result.exitCode}`);
			console.log(`  Response: ${result.response?.substring(0, 200) || '[no response]'}`);

			expect(result.exitCode).toBe(0);
			expect(result.response).toBeTruthy();
			// Response should contain a number 1-10
			expect(result.response).toMatch(/[1-9]|10/);
		},
		AGENT_TIMEOUT
	);

	it(
		'simulated group chat: moderator delegates to participant',
		async () => {
			if (availableAgents.length < 2 || participants.length === 0) {
				console.log('Skipping: not enough agents');
				return;
			}

			const participant = participants[0];
			console.log(`\n🗣️  Simulated Group Chat Flow:`);
			console.log(`  Moderator: ${moderator.name}`);
			console.log(`  Participant: ${participant.name}`);

			// Step 1: User message to moderator
			console.log(`\n  Step 1: User asks moderator...`);
			const moderatorPrompt = `You are a moderator coordinating a group chat with a participant named "Helper".

The user asked: "Ask Helper to tell me a fun fact about cats."

Your job is to relay this to Helper. Respond with exactly what you would say to Helper.
Be brief and direct. Start your response with "@Helper:"`;

			const modResult = await runAgent(moderator, moderatorPrompt);
			console.log(
				`  Moderator response: ${modResult.response?.substring(0, 150) || '[no response]'}`
			);

			expect(modResult.exitCode).toBe(0);
			expect(modResult.response).toBeTruthy();

			// Step 2: Forward to participant
			console.log(`\n  Step 2: Participant responds...`);
			const participantPrompt = `You are a participant in a group chat named "Helper".

The moderator said: "${modResult.response?.substring(0, 200)}"

Please respond with a brief fun fact about cats. Keep it to one sentence.`;

			const partResult = await runAgent(participant, participantPrompt);
			console.log(
				`  Participant response: ${partResult.response?.substring(0, 150) || '[no response]'}`
			);

			expect(partResult.exitCode).toBe(0);
			expect(partResult.response).toBeTruthy();
			// Should mention cats or something cat-related
			expect(
				partResult.response?.toLowerCase().includes('cat') ||
					partResult.response?.toLowerCase().includes('feline') ||
					partResult.response?.toLowerCase().includes('kitten') ||
					partResult.response?.toLowerCase().includes('purr') ||
					partResult.response?.toLowerCase().includes('meow') ||
					partResult.response?.toLowerCase().includes('whisker')
			).toBe(true);

			// Step 3: Moderator summarizes
			console.log(`\n  Step 3: Moderator summarizes...`);
			const summaryPrompt = `You are a moderator. Helper responded with: "${partResult.response?.substring(0, 200)}"

Summarize this for the user. Be brief, one sentence max.`;

			const summaryResult = await runAgent(moderator, summaryPrompt);
			console.log(
				`  Final summary: ${summaryResult.response?.substring(0, 150) || '[no response]'}`
			);

			expect(summaryResult.exitCode).toBe(0);
			expect(summaryResult.response).toBeTruthy();
		},
		TEST_TIMEOUT
	);

	it(
		'multiple participants can collaborate on a task',
		async () => {
			if (availableAgents.length < 3) {
				console.log('Skipping: need at least 3 agents for multi-participant test');
				return;
			}

			const [agent1, agent2] = participants.slice(0, 2);
			console.log(`\n🤝 Multi-Participant Collaboration:`);
			console.log(`  Moderator: ${moderator.name}`);
			console.log(`  Agent1: ${agent1.name}`);
			console.log(`  Agent2: ${agent2.name}`);

			// Step 1: Moderator assigns task to Agent1
			console.log(`\n  Step 1: Moderator asks Agent1 for a number...`);
			const task1Prompt = `You are Agent1 in a group chat. The moderator asked you to pick a number between 1 and 50.
Respond with just the number, nothing else.`;

			const result1 = await runAgent(agent1, task1Prompt);
			const number1 = parseInt(result1.response?.match(/\d+/)?.[0] || '0');
			console.log(`  Agent1 picked: ${number1}`);

			expect(result1.exitCode).toBe(0);
			expect(number1).toBeGreaterThan(0);
			expect(number1).toBeLessThanOrEqual(50);

			// Step 2: Moderator asks Agent2 to add to it
			console.log(`\n  Step 2: Moderator asks Agent2 to add 25...`);
			const task2Prompt = `You are Agent2 in a group chat. Agent1 picked the number ${number1}.
The moderator asked you to add 25 to that number.
Respond with just the result number, nothing else.`;

			const result2 = await runAgent(agent2, task2Prompt);
			const number2 = parseInt(result2.response?.match(/\d+/)?.[0] || '0');
			console.log(`  Agent2 calculated: ${number2}`);

			expect(result2.exitCode).toBe(0);
			expect(number2).toBe(number1 + 25);

			// Step 3: Moderator verifies
			console.log(`\n  Step 3: Moderator verifies...`);
			const verifyPrompt = `You are a moderator. Agent1 picked ${number1}, Agent2 added 25 and got ${number2}.
Is ${number2} correct? Reply with just "correct" or "incorrect".`;

			const verifyResult = await runAgent(moderator, verifyPrompt);
			console.log(`  Verification: ${verifyResult.response?.substring(0, 50) || '[no response]'}`);

			expect(verifyResult.exitCode).toBe(0);
			expect(verifyResult.response?.toLowerCase()).toContain('correct');
		},
		TEST_TIMEOUT
	);

	it(
		'moderator orchestrates code generation and review workflow',
		async () => {
			if (availableAgents.length < 3) {
				console.log('Skipping: need at least 3 agents for orchestration test');
				return;
			}

			const [coder, reviewer] = participants.slice(0, 2);

			console.log(`\n🎭 Moderator-Orchestrated Workflow:`);
			console.log(`  Moderator: ${moderator.name}`);
			console.log(`  Coder: ${coder.name}`);
			console.log(`  Reviewer: ${reviewer.name}`);

			// Step 1: User asks moderator to coordinate a task
			console.log(`\n  Step 1: Moderator plans the workflow...`);
			const planPrompt = `You are a moderator coordinating a group chat with two participants:
- @Coder: writes code
- @Reviewer: reviews code

The user asked: "Write a simple add function and have it reviewed."

Plan how you will coordinate this. Your response must include:
1. Which participant you'll ask first (use @mention)
2. What you'll ask them to do

Format your response as:
DELEGATE_TO: [Coder or Reviewer]
TASK: [what to ask them]`;

			const planResult = await runAgent(moderator, planPrompt);
			console.log(
				`  Moderator's plan: ${planResult.response?.substring(0, 200) || '[no response]'}`
			);

			expect(planResult.exitCode).toBe(0);
			expect(planResult.response).toBeTruthy();
			// Moderator should delegate to Coder first
			expect(planResult.response?.toLowerCase()).toMatch(/coder|code/i);

			// Step 2: Coder writes the function (output only, no file creation)
			console.log(`\n  Step 2: Coder writes the function...`);
			const codePrompt = `You are a coder in a group chat. The moderator asked you to write a simple JavaScript add function.

Write a simple add function that takes two numbers and returns their sum.
Output ONLY the code, nothing else. No explanation, no markdown fences.`;

			const codeResult = await runAgent(coder, codePrompt);
			const generatedCode = codeResult.response || '';
			console.log(`  Coder's code: ${generatedCode.substring(0, 150)}`);

			expect(codeResult.exitCode).toBe(0);
			expect(generatedCode).toBeTruthy();
			// Should contain function-like code
			expect(generatedCode).toMatch(/function|add|=>|\+|return/i);

			// Step 3: Moderator routes to reviewer with the code
			console.log(`\n  Step 3: Moderator asks reviewer to check the code...`);
			const reviewRequestPrompt = `You are a moderator. The Coder wrote this code:

${generatedCode.substring(0, 300)}

Ask the Reviewer to check if this code is correct.
Respond with what you would say to @Reviewer. Be brief.`;

			const reviewRequestResult = await runAgent(moderator, reviewRequestPrompt);
			console.log(
				`  Moderator to reviewer: ${reviewRequestResult.response?.substring(0, 150) || '[no response]'}`
			);

			expect(reviewRequestResult.exitCode).toBe(0);

			// Step 4: Reviewer evaluates the code
			console.log(`\n  Step 4: Reviewer evaluates the code...`);
			const reviewPrompt = `You are a code reviewer in a group chat. The moderator asked you to review this JavaScript add function:

${generatedCode.substring(0, 300)}

Evaluate if this code correctly adds two numbers.
Respond with exactly: REVIEW: [PASS or FAIL] - [one sentence reason]`;

			const reviewResult = await runAgent(reviewer, reviewPrompt);
			console.log(
				`  Reviewer verdict: ${reviewResult.response?.substring(0, 150) || '[no response]'}`
			);

			expect(reviewResult.exitCode).toBe(0);
			expect(reviewResult.response).toBeTruthy();
			// Reviewer should give a verdict
			expect(reviewResult.response?.toLowerCase()).toMatch(
				/pass|fail|correct|incorrect|valid|invalid/i
			);

			// Step 5: Moderator summarizes to user
			console.log(`\n  Step 5: Moderator reports back to user...`);
			const summaryPrompt = `You are a moderator. The workflow is complete:
- Coder wrote: ${generatedCode.substring(0, 100)}
- Reviewer said: "${reviewResult.response?.substring(0, 100)}"

Summarize the outcome for the user in one sentence. Start with "RESULT:"`;

			const summaryResult = await runAgent(moderator, summaryPrompt);
			console.log(
				`  Final summary: ${summaryResult.response?.substring(0, 150) || '[no response]'}`
			);

			expect(summaryResult.exitCode).toBe(0);
			expect(summaryResult.response?.toLowerCase()).toMatch(
				/result|complete|success|pass|add|function/i
			);
		},
		TEST_TIMEOUT
	);
});

/**
 * Argument Building Tests
 *
 * These tests validate that buildArgs correctly handles the image capability check
 * for all agents. This mirrors the bug fix in process-manager.ts where
 * --input-format stream-json was being added unconditionally to all agents.
 */
describe.skipIf(SKIP_INTEGRATION)('Agent Argument Building Tests', () => {
	// Test all agents, even if not available (this is arg building, not execution)
	for (const agent of AGENTS) {
		describe(agent.name, () => {
			it('should build valid args without images', () => {
				const prompt = 'Test prompt';
				const args = agent.buildArgs(prompt);

				console.log(`\n📝 ${agent.name} args without images: ${args.join(' ')}`);

				// Should NOT have --input-format without images
				expect(args.includes('--input-format')).toBe(false);

				// Should have the prompt
				expect(args.includes(prompt)).toBe(true);
			});

			it('should build valid args with images', () => {
				const prompt = 'Test prompt';
				const fakeImage =
					'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
				const args = agent.buildArgs(prompt, { images: [fakeImage] });

				console.log(`\n🖼️  ${agent.name} args with images: ${args.join(' ')}`);

				const capabilities = getAgentCapabilities(agent.id);
				const hasInputFormat = args.includes('--input-format');

				if (capabilities.supportsStreamJsonInput) {
					// Claude Code should have --input-format stream-json
					expect(hasInputFormat).toBe(true);
					expect(args.includes('stream-json')).toBe(true);
					// Should NOT have the prompt as an arg (it's sent via stdin)
					expect(args.includes(prompt)).toBe(false);
				} else {
					// Codex, OpenCode should NOT have --input-format
					expect(hasInputFormat).toBe(false);
					// Should have the prompt as an arg
					expect(args.includes(prompt)).toBe(true);
				}
			});

			it('should have consistent capability check behavior', () => {
				// Verify that the capability flag matches our expectations
				const capabilities = getAgentCapabilities(agent.id);

				if (agent.id === 'claude-code') {
					expect(capabilities.supportsStreamJsonInput).toBe(true);
				} else {
					expect(capabilities.supportsStreamJsonInput).toBe(false);
				}
			});
		});
	}
});

/**
 * Standalone test runner for manual testing
 * Run with: npx tsx src/__tests__/integration/group-chat-integration.test.ts
 */
if (require.main === module) {
	(async () => {
		console.log('🧪 Running Group Chat Integration Tests (standalone)\n');

		// Detect available agents
		console.log('🔍 Detecting available agents...');
		const available: AgentConfig[] = [];
		for (const agent of AGENTS) {
			if (await isAgentAvailable(agent)) {
				available.push(agent);
				console.log(`  ✅ ${agent.name}`);
			} else {
				console.log(`  ❌ ${agent.name}`);
			}
		}

		if (available.length < 2) {
			console.log('\n❌ Need at least 2 agents for group chat. Exiting.');
			process.exit(1);
		}

		// Assign roles
		const shuffled = shuffle(available);
		const moderator = shuffled[0];
		const participant = shuffled[1];

		console.log(`\n📋 Role Assignment:`);
		console.log(`  Moderator: ${moderator.name}`);
		console.log(`  Participant: ${participant.name}`);

		// Run a simple conversation
		console.log(`\n${'='.repeat(60)}`);
		console.log('Starting Group Chat Conversation');
		console.log('='.repeat(60));

		// User message
		console.log('\n👤 User: "Ask the participant to tell me a joke"');

		// Moderator delegates
		console.log(`\n🎯 ${moderator.name} (Moderator):`);
		const modResult = await runAgent(
			moderator,
			`You are a moderator. A user asked you to ask the participant to tell a joke.
Respond with what you would say to @Participant to relay this request. Be brief.`
		);
		console.log(`   ${modResult.response?.substring(0, 200) || '[no response]'}`);

		// Participant responds
		console.log(`\n👥 ${participant.name} (Participant):`);
		const partResult = await runAgent(
			participant,
			`You are a participant named "Joker" in a group chat.
The moderator asked you to tell a joke.
Tell a short, clean joke.`
		);
		console.log(`   ${partResult.response?.substring(0, 300) || '[no response]'}`);

		// Moderator summarizes
		console.log(`\n🎯 ${moderator.name} (Moderator - Summary):`);
		const summaryResult = await runAgent(
			moderator,
			`You are a moderator. The participant responded with:
"${partResult.response?.substring(0, 200)}"
Summarize this for the user in one brief sentence.`
		);
		console.log(`   ${summaryResult.response?.substring(0, 200) || '[no response]'}`);

		console.log(`\n${'='.repeat(60)}`);
		console.log('✅ Group Chat Conversation Complete');
		console.log('='.repeat(60));
	})();
}
