#!/usr/bin/env node
// Credential-free Codex JSONL stand-in with a real, silent stdio MCP child.
const { spawn } = require('child_process');
const { writeFileSync } = require('fs');
const phase = process.argv.find((arg) => arg.startsWith('--fixture-phase='))?.split('=')[1];
const pidFile = process.argv
	.find((arg) => arg.startsWith('--fixture-pids='))
	?.slice('--fixture-pids='.length);
if (phase === 'resistant') process.on('SIGTERM', () => console.log('STOPPING'));
if (phase === 'late-output' || phase === 'after-model-late-output')
	process.on('SIGTERM', () => {
		process.stdout.write(
			JSON.stringify({
				type: 'item.completed',
				item: { id: 'late', type: 'agent_message', text: 'Last answer' },
			}),
			() => process.exit(0)
		);
	});
if (phase === 'success') {
	return process.stdout.write(
		JSON.stringify({
			type: 'item.completed',
			item: { id: 'answer', type: 'agent_message', text: 'Done' },
		}) + '\n',
		() => process.exit(0)
	);
}
const mcp = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); console.log('ready')"], {
	stdio: ['ignore', 'pipe', 'inherit'],
});
mcp.stdout.once('data', () => {
	if (pidFile) writeFileSync(pidFile, JSON.stringify({ agent: process.pid, mcp: mcp.pid }));
	console.log('MCP_READY:' + mcp.pid);
	if (phase !== 'startup' && phase !== 'resistant' && phase !== 'late-output')
		console.log(
			JSON.stringify({
				type: 'item.completed',
				item: { id: 'message', type: 'agent_message', text: 'Starting work' },
			})
		);
	if (phase === 'mcp-tool')
		console.log(
			JSON.stringify({
				type: 'item.started',
				item: { id: 'mcp', type: 'mcp_tool_call', server: 'fixture', tool: 'wait', arguments: {} },
			})
		);
});
setInterval(() => {}, 1000);
