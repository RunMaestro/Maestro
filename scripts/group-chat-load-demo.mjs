import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findAvailablePort } from './dev-port.mjs';

export const GROUP_CHAT_LOAD_DEMO_ID = '00000000-0000-4000-8000-000000000423';
export const GROUP_CHAT_LOAD_DEMO_NAME = 'Synthetic Group Chat Load';
export const GROUP_CHAT_LOAD_DEMO_COUNTS = Object.freeze({
	groups: 32,
	sessions: 93,
	aiTabs: 361,
	largestGroupSessions: 17,
	participants: 8,
	messages: 423,
});

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.dirname(SCRIPTS_DIR);
const RUNTIME_ROOT = path.join(REPO_ROOT, 'artifacts', 'runtime');
const NULL_AGENT_ID = 'e2e-null-agent';
const GROUP_SESSION_COUNTS = [17, ...Array(14).fill(3), ...Array(17).fill(2)];
const PARTICIPANT_COLORS = [
	'#60a5fa',
	'#34d399',
	'#fbbf24',
	'#f472b6',
	'#a78bfa',
	'#fb7185',
	'#22d3ee',
	'#a3e635',
];

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, '\t')}\n`, 'utf8');
}

function createTemporaryDemoDir(prefix) {
	fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
	return fs.mkdtempSync(path.join(RUNTIME_ROOT, prefix));
}

function escapeGroupChatContent(content) {
	return content.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');
}

function createAiTab(sessionIndex, tabIndex, now) {
	const id = `synthetic-tab-${String(sessionIndex + 1).padStart(3, '0')}-${String(tabIndex + 1).padStart(2, '0')}`;
	return {
		id,
		agentSessionId: null,
		name: `Synthetic Tab ${String(tabIndex + 1).padStart(2, '0')}`,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: now + tabIndex,
		state: 'idle',
	};
}

function createSession(demoDir, sessionIndex, groupId, now) {
	const sessionNumber = String(sessionIndex + 1).padStart(3, '0');
	const workspace = path.join(demoDir, 'workspaces', `synthetic-session-${sessionNumber}`);
	fs.mkdirSync(workspace, { recursive: true });

	const tabCount = sessionIndex < 11 ? 3 : 4;
	const aiTabs = Array.from({ length: tabCount }, (_, tabIndex) =>
		createAiTab(sessionIndex, tabIndex, now)
	);

	return {
		id: `synthetic-session-${sessionNumber}`,
		groupId,
		name: `Synthetic Agent ${sessionNumber}`,
		toolType: NULL_AGENT_ID,
		state: 'idle',
		cwd: workspace,
		fullPath: workspace,
		projectRoot: workspace,
		createdAt: now + sessionIndex,
		updatedAt: now + sessionIndex,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs,
		activeTabId: aiTabs[0].id,
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		browserTabs: [],
		activeBrowserTabId: null,
		terminalTabs: [],
		activeTerminalTabId: null,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai', id: tab.id })),
		unifiedClosedTabHistory: [],
		tabGroups: [],
		activeGroupId: null,
	};
}

function createSyntheticMessage(index) {
	const messageNumber = String(index + 1).padStart(3, '0');
	let content = `Synthetic load message ${messageNumber}. This deterministic content exercises wrapping, timestamps, markdown, and virtualized scrolling without using production text.`;

	if ((index + 1) % 7 === 0) {
		content += '\n\n- synthetic state update\n- synthetic verification item';
	}
	if ((index + 1) % 19 === 0) {
		content += `\n\nInline sample: \`synthetic-${messageNumber}\` with a literal pipe | and path C:\\synthetic.`;
	}

	return content;
}

function assertEmptyTarget(demoDir) {
	fs.mkdirSync(demoDir, { recursive: true });
	const existing = fs.readdirSync(demoDir);
	if (existing.length > 0) {
		throw new Error(`Refusing to seed non-empty MAESTRO_DEMO_DIR: ${demoDir}`);
	}
}

export function seedGroupChatLoadDemo(demoDir) {
	const resolvedDemoDir = path.resolve(demoDir);
	assertEmptyTarget(resolvedDemoDir);

	const now = Date.UTC(2026, 0, 1, 12, 0, 0);
	const groups = GROUP_SESSION_COUNTS.map((_, groupIndex) => ({
		id: `synthetic-group-${String(groupIndex + 1).padStart(2, '0')}`,
		name: `Synthetic Group ${String(groupIndex + 1).padStart(2, '0')}`,
		emoji: 'G',
		collapsed: groupIndex !== 0,
	}));

	const sessions = [];
	let sessionIndex = 0;
	for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
		for (let memberIndex = 0; memberIndex < GROUP_SESSION_COUNTS[groupIndex]; memberIndex += 1) {
			sessions.push(createSession(resolvedDemoDir, sessionIndex, groups[groupIndex].id, now));
			sessionIndex += 1;
		}
	}

	writeJson(path.join(resolvedDemoDir, 'maestro-settings.json'), {
		activeThemeId: 'dracula',
		groupChatsExpanded: true,
		suppressWindowsWarning: true,
	});
	writeJson(path.join(resolvedDemoDir, 'maestro-groups.json'), { groups });
	writeJson(path.join(resolvedDemoDir, 'maestro-sessions.json'), {
		sessions,
		activeSessionId: sessions[0].id,
	});

	const groupChatDir = path.join(resolvedDemoDir, 'group-chats', GROUP_CHAT_LOAD_DEMO_ID);
	const imagesDir = path.join(groupChatDir, 'images');
	const logPath = path.join(groupChatDir, 'chat.log');
	fs.mkdirSync(imagesDir, { recursive: true });

	const participants = Array.from(
		{ length: GROUP_CHAT_LOAD_DEMO_COUNTS.participants },
		(_, participantIndex) => ({
			name: `Synthetic Participant ${String(participantIndex + 1).padStart(2, '0')}`,
			agentId: NULL_AGENT_ID,
			sessionId: sessions[participantIndex].id,
			addedAt: now + participantIndex,
			lastActivity: now + participantIndex,
			contextUsage: 0,
			color: PARTICIPANT_COLORS[participantIndex],
			tokenCount: 0,
			messageCount: 0,
			processingTimeMs: 0,
			totalCost: 0,
		})
	);

	writeJson(path.join(groupChatDir, 'metadata.json'), {
		id: GROUP_CHAT_LOAD_DEMO_ID,
		name: GROUP_CHAT_LOAD_DEMO_NAME,
		createdAt: now,
		updatedAt: now,
		moderatorAgentId: NULL_AGENT_ID,
		moderatorSessionId: `group-chat-${GROUP_CHAT_LOAD_DEMO_ID}-moderator-synthetic`,
		participants,
		logPath,
		imagesDir,
		draftMessage: '',
		archived: false,
	});

	const logLines = Array.from(
		{ length: GROUP_CHAT_LOAD_DEMO_COUNTS.messages },
		(_, messageIndex) => {
			const sender =
				messageIndex % 11 === 0
					? 'user'
					: messageIndex % 5 === 0
						? 'moderator'
						: participants[messageIndex % participants.length].name;
			const timestamp = new Date(now + messageIndex * 60_000).toISOString();
			return `${timestamp}|${sender}|${escapeGroupChatContent(createSyntheticMessage(messageIndex))}`;
		}
	);
	fs.writeFileSync(logPath, `${logLines.join('\n')}\n`, 'utf8');
	fs.writeFileSync(path.join(groupChatDir, 'history.jsonl'), '', 'utf8');

	const manifest = validateGroupChatLoadDemo(resolvedDemoDir);
	writeJson(path.join(resolvedDemoDir, 'group-chat-load-manifest.json'), manifest);
	return manifest;
}

export function validateGroupChatLoadDemo(demoDir) {
	const resolvedDemoDir = path.resolve(demoDir);
	const { groups } = JSON.parse(
		fs.readFileSync(path.join(resolvedDemoDir, 'maestro-groups.json'), 'utf8')
	);
	const { sessions } = JSON.parse(
		fs.readFileSync(path.join(resolvedDemoDir, 'maestro-sessions.json'), 'utf8')
	);
	const metadata = JSON.parse(
		fs.readFileSync(
			path.join(resolvedDemoDir, 'group-chats', GROUP_CHAT_LOAD_DEMO_ID, 'metadata.json'),
			'utf8'
		)
	);
	const messageCount = fs
		.readFileSync(
			path.join(resolvedDemoDir, 'group-chats', GROUP_CHAT_LOAD_DEMO_ID, 'chat.log'),
			'utf8'
		)
		.split('\n')
		.filter(Boolean).length;
	const sessionsPerGroup = new Map(groups.map((group) => [group.id, 0]));
	for (const session of sessions) {
		sessionsPerGroup.set(session.groupId, (sessionsPerGroup.get(session.groupId) ?? 0) + 1);
	}

	const actual = {
		groups: groups.length,
		sessions: sessions.length,
		aiTabs: sessions.reduce((total, session) => total + session.aiTabs.length, 0),
		largestGroupSessions: Math.max(...sessionsPerGroup.values()),
		participants: metadata.participants.length,
		messages: messageCount,
	};

	for (const [key, expected] of Object.entries(GROUP_CHAT_LOAD_DEMO_COUNTS)) {
		if (actual[key] !== expected) {
			throw new Error(
				`Invalid synthetic load cardinality for ${key}: ${actual[key]} != ${expected}`
			);
		}
	}

	return {
		schemaVersion: 1,
		kind: 'synthetic-group-chat-load',
		groupChatId: GROUP_CHAT_LOAD_DEMO_ID,
		groupChatName: GROUP_CHAT_LOAD_DEMO_NAME,
		providerProcessesEnabled: false,
		counts: actual,
	};
}

function waitForExit(child) {
	return new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => resolve({ code: code ?? 0, signal }));
	});
}

async function cleanupAfterParent(parentPidValue, demoDir) {
	const parentPid = Number(parentPidValue);
	const resolvedDemoDir = path.resolve(demoDir);
	const isManagedDemoDir =
		Number.isInteger(parentPid) &&
		parentPid > 0 &&
		resolvedDemoDir.startsWith(`${RUNTIME_ROOT}${path.sep}`) &&
		path.basename(resolvedDemoDir).startsWith('maestro-group-chat-load-');
	if (!isManagedDemoDir) {
		throw new Error('Refusing unsafe Group Chat load demo cleanup request');
	}
	while (true) {
		try {
			process.kill(parentPid, 0);
		} catch {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	await new Promise((resolve) => setTimeout(resolve, 5_000));
	fs.rmSync(resolvedDemoDir, { recursive: true, force: true });
}

async function waitForCdp(port, timeoutMs = 30_000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (response.ok) return;
		} catch {
			// Electron has not opened the CDP endpoint yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out waiting for Electron CDP on port ${port}`);
}

async function openSeededGroupChat() {
	const port = process.env.MAESTRO_CDP_PORT;
	if (!port) throw new Error('MAESTRO_CDP_PORT is required to open the seeded Group Chat');
	await waitForCdp(port);

	const selector = `[data-nav-key="groupchat:${GROUP_CHAT_LOAD_DEMO_ID}"]`;
	const actions = [
		{
			a: 'eval',
			expr: `for (let i = 0; i < 300; i += 1) { if (document.querySelector(${JSON.stringify(selector)})) return true; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Synthetic Group Chat did not appear');`,
		},
		{ a: 'sleep', ms: 1_000 },
		{ a: 'clickSel', sel: selector },
		{
			a: 'eval',
			expr: `for (let i = 0; i < 120; i += 1) { const input = document.querySelector('textarea[placeholder*="Type a message"]'); if (input) return true; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Group Chat input did not appear');`,
		},
		{ a: 'focusSel', sel: 'textarea[placeholder*="Type a message"]' },
	];

	const driver = spawn(
		process.execPath,
		[path.join(SCRIPTS_DIR, 'cdp-drive.mjs'), JSON.stringify(actions)],
		{
			cwd: REPO_ROOT,
			env: process.env,
			stdio: ['ignore', 'pipe', 'inherit'],
		}
	);
	let driverOutput = '';
	driver.stdout.setEncoding('utf8');
	driver.stdout.on('data', (chunk) => {
		driverOutput += chunk;
	});
	const result = await waitForExit(driver);
	if (result.code !== 0) {
		throw new Error(`CDP Group Chat opener exited with code ${result.code}`);
	}
	const actionResults = JSON.parse(driverOutput);
	const failedAction = actionResults.find(
		(action) => action.error || action.value?.error || (action.a === 'focusSel' && !action.rect)
	);
	if (failedAction) {
		throw new Error(`CDP Group Chat opener failed: ${JSON.stringify(failedAction)}`);
	}
	console.log(
		'[group-chat-load-demo] Group Chat visible and input focused. Type manually; do not press Enter.'
	);
}

async function launchDemo() {
	// Always allocate a fresh directory here. Maestro-managed shells can inherit
	// MAESTRO_DEMO_DIR from the parent app, and reusing it would mix this load
	// fixture with another running instance.
	const demoDir = createTemporaryDemoDir('maestro-group-chat-load-');
	const cleanupDemoDir = () => fs.rmSync(demoDir, { recursive: true, force: true });
	process.once('exit', cleanupDemoDir);
	const cdpPort = String(await findAvailablePort(12345, 100));
	const manifest = seedGroupChatLoadDemo(demoDir);
	const env = {
		...process.env,
		MAESTRO_DEMO_DIR: demoDir,
		MAESTRO_CDP_PORT: cdpPort,
		MAESTRO_DISABLE_GROUP_CHAT_PROVIDERS: '1',
	};

	console.log(`[group-chat-load-demo] MAESTRO_DEMO_DIR=${demoDir}`);
	console.log(`[group-chat-load-demo] Seeded ${JSON.stringify(manifest.counts)}`);
	const cleanupWatchdog = spawn(
		process.execPath,
		[SCRIPT_PATH, '--cleanup-after', String(process.pid), demoDir],
		{
			cwd: REPO_ROOT,
			detached: true,
			stdio: 'ignore',
		}
	);
	cleanupWatchdog.unref();

	const opener = spawn(process.execPath, [SCRIPT_PATH, '--open-seeded-chat'], {
		cwd: REPO_ROOT,
		env,
		stdio: 'inherit',
	});
	const dev = spawn(process.execPath, [path.join(SCRIPTS_DIR, 'dev.mjs')], {
		cwd: REPO_ROOT,
		env,
		stdio: 'inherit',
	});

	let shuttingDown = false;
	let forcedCleanupTimer;
	let requestedExitCode;
	const shutdown = (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		requestedExitCode = signal === 'SIGINT' ? 130 : 143;
		cleanupDemoDir();
		if (opener.exitCode === null) opener.kill(signal);
		if (dev.exitCode === null) dev.kill(signal);
		forcedCleanupTimer = setTimeout(() => {
			cleanupDemoDir();
			process.exit(requestedExitCode);
		}, 3_000);
	};
	process.once('SIGINT', () => shutdown('SIGINT'));
	process.once('SIGTERM', () => shutdown('SIGTERM'));

	opener.once('exit', (code) => {
		if (code && dev.exitCode === null) {
			console.error(`[group-chat-load-demo] Failed to open the seeded Group Chat (code ${code})`);
			dev.kill('SIGTERM');
		}
	});

	const result = await waitForExit(dev);
	if (forcedCleanupTimer) clearTimeout(forcedCleanupTimer);
	await new Promise((resolve) => setTimeout(resolve, 500));
	cleanupDemoDir();
	process.exitCode = requestedExitCode ?? result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const mode = process.argv[2];
	if (mode === '--seed-only') {
		const targetDir = process.argv[3]
			? path.resolve(process.argv[3])
			: createTemporaryDemoDir('maestro-group-chat-load-seed-');
		const manifest = seedGroupChatLoadDemo(targetDir);
		console.log(JSON.stringify({ demoDir: targetDir, ...manifest }, null, 2));
	} else if (mode === '--open-seeded-chat') {
		await openSeededGroupChat();
	} else if (mode === '--cleanup-after') {
		await cleanupAfterParent(process.argv[3], process.argv[4]);
	} else {
		await launchDemo();
	}
}
