import { test as base, expect, helpers } from './fixtures/electron-app';
import path from 'path';
import fs from 'fs';

const OPENCLAW_AGENT_NAME = 'main';
const OPENCLAW_SESSION_ID = 'fixture-session-001';
const INITIAL_PROMPT = 'First prompt from fixture';
const INITIAL_REPLY_PREFIX = 'Mock OpenClaw reply:';
const FAILURE_PROMPT = 'trigger auth failure';
const AUTH_ERROR_MESSAGE = 'Gateway authentication failed. Please check your OpenClaw token.';

type OpenClawFixtures = {
	openClawProjectDir: string;
	openClawMockBinaryPath: string;
};

function buildMockOpenClawScript(): string {
	return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function getFlag(name) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function appendJsonLine(filePath, record) {
	fs.appendFileSync(filePath, JSON.stringify(record) + '\\n', 'utf8');
}

const agentName = getFlag('--agent') || process.env.MAESTRO_OPENCLAW_FIXTURE_AGENT || 'main';
const prompt = getFlag('--message') || '';
const rawSessionId =
	getFlag('--session-id') || process.env.MAESTRO_OPENCLAW_FIXTURE_SESSION_ID || 'fixture-session-001';
const now = new Date().toISOString();
const homeDir = process.env.HOME || process.cwd();
const sessionProjectPath = process.env.MAESTRO_OPENCLAW_FIXTURE_PROJECT_PATH || process.cwd();
const sessionDir = path.join(homeDir, '.openclaw', '.openclaw', 'agents', agentName, 'sessions');
const sessionFile = path.join(sessionDir, rawSessionId + '.jsonl');

fs.mkdirSync(sessionDir, { recursive: true });

if (!fs.existsSync(sessionFile) || fs.statSync(sessionFile).size === 0) {
	appendJsonLine(sessionFile, {
		type: 'session',
		version: 3,
		id: rawSessionId,
		timestamp: now,
		cwd: sessionProjectPath,
	});
}

if (prompt.trim()) {
	appendJsonLine(sessionFile, {
		type: 'message',
		id: rawSessionId + '-user-' + Date.now(),
		parentId: null,
		timestamp: now,
		message: {
			role: 'user',
			content: [{ type: 'text', text: prompt }],
		},
	});
}

if (/auth failure|trigger auth/i.test(prompt)) {
	process.stderr.write('gateway auth failed: deterministic fixture rejected the request\\n');
	process.exit(1);
}

const responseText = args.includes('--session-id')
	? 'Resumed mock OpenClaw reply: ' + prompt
	: 'Mock OpenClaw reply: ' + prompt;

appendJsonLine(sessionFile, {
	type: 'message',
	id: rawSessionId + '-assistant-' + Date.now(),
	parentId: rawSessionId + '-user',
	timestamp: new Date(Date.now() + 1000).toISOString(),
	message: {
		role: 'assistant',
		content: [{ type: 'text', text: responseText }],
	},
});

process.stdout.write(
	JSON.stringify({
		payloads: [{ text: responseText, mediaUrl: null }],
		meta: {
			durationMs: 12,
			agentMeta: {
				agentName,
				sessionId: rawSessionId,
				provider: 'fixture',
				model: 'mock-openclaw',
				usage: {
					input: Math.max(prompt.length, 1),
					output: responseText.length,
					total: Math.max(prompt.length, 1) + responseText.length,
				},
				lastCallUsage: {
					input: Math.max(prompt.length, 1),
					output: responseText.length,
					total: Math.max(prompt.length, 1) + responseText.length,
				},
			},
		},
	})
);
`;
}

const test = base.extend<OpenClawFixtures>({
	openClawProjectDir: async ({ testDataDir }, use) => {
		const projectDir = path.join(testDataDir, 'openclaw-project');
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, 'package.json'),
			JSON.stringify({ name: 'openclaw-fixture-project', private: true }, null, 2)
		);
		fs.writeFileSync(path.join(projectDir, 'README.md'), '# OpenClaw Fixture Project\n');
		await use(projectDir);
	},

	openClawMockBinaryPath: async ({ testDataDir }, use) => {
		const mockBinDir = path.join(testDataDir, 'mock-bin');
		const mockBinaryPath = path.join(mockBinDir, 'openclaw');
		fs.mkdirSync(mockBinDir, { recursive: true });
		fs.writeFileSync(mockBinaryPath, buildMockOpenClawScript(), 'utf8');
		fs.chmodSync(mockBinaryPath, 0o755);
		await use(mockBinaryPath);
	},

	launchEnv: async ({ testDataDir, openClawMockBinaryPath, openClawProjectDir }, use) => {
		const mockBinDir = path.dirname(openClawMockBinaryPath);
		const mockHomeDir = path.join(testDataDir, 'mock-home');

		fs.mkdirSync(mockHomeDir, { recursive: true });

		await use({
			PATH: `${mockBinDir}:${process.env.PATH || ''}`,
			HOME: mockHomeDir,
			MAESTRO_OPENCLAW_FIXTURE_AGENT: OPENCLAW_AGENT_NAME,
			MAESTRO_OPENCLAW_FIXTURE_SESSION_ID: OPENCLAW_SESSION_ID,
			MAESTRO_OPENCLAW_FIXTURE_PROJECT_PATH: openClawProjectDir,
		});
	},
});

test.describe('OpenClaw session flow', () => {
	test('creates an OpenClaw agent, resumes its stored session, and shows auth recovery actions', async ({
		window,
		openClawProjectDir,
		openClawMockBinaryPath,
	}) => {
		const agentName = `OpenClaw Fixture ${path.basename(openClawProjectDir)}`;

		await helpers.createAgent(window, {
			name: agentName,
			provider: 'OpenClaw',
			workingDir: openClawProjectDir,
			customPath: openClawMockBinaryPath,
		});

		await helpers.sendAgentMessage(window, INITIAL_PROMPT);
		await expect(window.getByText(new RegExp(INITIAL_REPLY_PREFIX, 'i'))).toBeVisible({
			timeout: 10000,
		});

		await helpers.openAgentSessions(window);
		const sessionsPanelTitle = window.getByText(
			new RegExp(`OpenClaw Sessions for ${agentName}`, 'i')
		);
		await expect(sessionsPanelTitle).toBeVisible({ timeout: 10000 });
		await expect(window.getByText(/1 session/i)).toBeVisible({ timeout: 10000 });
		await expect(window.getByText(/# Maestro System Context/i).first()).toBeVisible({
			timeout: 10000,
		});
		await window.getByTitle('Resume session in new tab').first().click();
		await expect(sessionsPanelTitle).not.toBeVisible({ timeout: 10000 });
		await expect(window.getByRole('button', { name: 'MAIN:FIXTURE' })).toBeVisible({
			timeout: 10000,
		});

		await helpers.sendAgentMessage(window, FAILURE_PROMPT);
		await expect(window.getByRole('button', { name: 'View Details' })).toBeVisible({
			timeout: 10000,
		});
		const errorDialog = window.getByRole('dialog', { name: 'Authentication Required' });
		await expect(errorDialog).toBeVisible({ timeout: 10000 });
		await expect(errorDialog.getByText(AUTH_ERROR_MESSAGE)).toBeVisible();
		await expect(errorDialog.getByRole('button', { name: 'Re-authenticate' })).toBeVisible();
		await expect(errorDialog.getByRole('button', { name: 'Start New Session' })).toBeVisible();
	});
});
