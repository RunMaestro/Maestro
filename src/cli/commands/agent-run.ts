import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
	AGENT_RUN_STATUSES,
	validateAgentRunStrict,
	type AgentRun,
	type AgentRunEvent,
	type AgentRunStatus,
} from '../../shared/agent-run';
import { validateCampaignStrict, type Campaign, type CampaignStatus } from '../../shared/campaign';
import {
	appendAgentRunEvent,
	getAgentRun,
	getCampaign,
	listAgentRuns,
	listCampaigns,
	readAgentRunEvents,
	upsertAgentRun,
	upsertCampaign,
} from '../services/agent-run-store';

const CAMPAIGN_STATUSES = new Set([
	'queued',
	'running',
	'needs_review',
	'blocked',
	'complete',
	'archived',
]);

interface JsonFileOptions {
	file?: string;
	json?: boolean;
}

export interface AgentRunRecordOptions extends JsonFileOptions {}

export interface AgentRunAppendEventOptions {
	type?: string;
	status?: string;
	message?: string;
	json?: boolean;
}

export interface AgentRunListOptions {
	status?: string;
	campaign?: string;
	limit?: string;
	json?: boolean;
}

export interface AgentRunShowOptions {
	json?: boolean;
}

export interface CampaignRecordOptions extends JsonFileOptions {}

export interface CampaignListOptions {
	status?: string;
	limit?: string;
	json?: boolean;
}

export interface CampaignShowOptions {
	json?: boolean;
}

function emitJson(payload: Record<string, unknown>): void {
	console.log(JSON.stringify(payload, null, 2));
}

function fail(error: string, code: string): void {
	emitJson({ success: false, error, code });
	process.exit(1);
}

function readJsonFile(
	filePath: string | undefined
): { ok: true; value: unknown } | { ok: false; error: string; code: string } {
	if (!filePath) {
		return { ok: false, error: 'Missing required --file option', code: 'MISSING_FILE_OPTION' };
	}

	if (!existsSync(filePath)) {
		return { ok: false, error: `File not found: ${filePath}`, code: 'FILE_NOT_FOUND' };
	}

	try {
		return { ok: true, value: JSON.parse(readFileSync(filePath, 'utf8')) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Invalid JSON in ${filePath}: ${message}`, code: 'INVALID_JSON' };
	}
}

function requireAgentRun(value: unknown): AgentRun {
	const run = validateAgentRunStrict(value);
	if (!run) {
		throw new Error('Agent run file must contain a valid agent run object');
	}
	return run;
}

function requireCampaign(value: unknown): Campaign {
	const campaign = validateCampaignStrict(value);
	if (!campaign) {
		throw new Error('Campaign file must contain a valid campaign object');
	}
	return campaign;
}

function parseLimit(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw.trim())) {
		throw new Error(`Invalid --limit value: ${raw} (expected non-negative integer)`);
	}
	return Number(raw);
}

function parseAgentRunStatus(raw: string | undefined): AgentRunStatus | undefined {
	if (raw === undefined) return undefined;
	if (!AGENT_RUN_STATUSES.includes(raw as AgentRunStatus)) {
		throw new Error(`Invalid --status value: ${raw}`);
	}
	return raw as AgentRunStatus;
}

function parseCampaignStatus(raw: string | undefined): CampaignStatus | undefined {
	if (raw === undefined) return undefined;
	if (!CAMPAIGN_STATUSES.has(raw)) {
		throw new Error(`Invalid --status value: ${raw}`);
	}
	return raw as CampaignStatus;
}

function formatRunLine(run: AgentRun): string {
	const name = run.agentName ?? run.agentId ?? run.model ?? '';
	const detail = name ? `  ${name}` : '';
	return `${run.id}  ${run.status}  ${run.provider}${detail}`;
}

function formatCampaignLine(campaign: Campaign): string {
	return `${campaign.id}  ${campaign.status}  ${campaign.title}`;
}

export function agentRunRecord(options: AgentRunRecordOptions): void {
	const loaded = readJsonFile(options.file);
	if (!loaded.ok) {
		fail(loaded.error, loaded.code);
		return;
	}

	try {
		const run = requireAgentRun(loaded.value);
		const saved = upsertAgentRun(run);
		if (options.json) {
			emitJson({ success: true, run: saved });
		} else {
			console.log(`Recorded agent run ${saved.id} (${saved.status}).`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, 'INVALID_AGENT_RUN');
	}
}

export function agentRunAppendEvent(runId: string, options: AgentRunAppendEventOptions): void {
	try {
		if (!options.type || options.type.trim() === '') {
			throw new Error('Missing required --type option');
		}
		const status = parseAgentRunStatus(options.status);
		const event: AgentRunEvent = {
			id: `evt_${randomUUID()}`,
			runId,
			timestamp: Date.now(),
			type: options.type,
			...(options.message !== undefined ? { message: options.message } : {}),
			...(status !== undefined ? { status } : {}),
		};
		const saved = appendAgentRunEvent(event);
		if (options.json) {
			emitJson({ success: true, event: saved });
		} else {
			console.log(`Appended ${saved.type} event to ${saved.runId}.`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, 'INVALID_AGENT_RUN_EVENT');
	}
}

export function agentRunList(options: AgentRunListOptions): void {
	try {
		const status = parseAgentRunStatus(options.status);
		const limit = parseLimit(options.limit);
		const runs = listAgentRuns({
			...(status !== undefined ? { status } : {}),
			...(options.campaign !== undefined ? { campaignId: options.campaign } : {}),
			...(limit !== undefined ? { limit } : {}),
		});

		if (options.json) {
			emitJson({ success: true, runs });
			return;
		}

		if (runs.length === 0) {
			console.log('No agent runs found.');
			return;
		}

		for (const run of runs) {
			console.log(formatRunLine(run));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, 'INVALID_AGENT_RUN_FILTER');
	}
}

export function agentRunShow(runId: string, options: AgentRunShowOptions): void {
	try {
		const run = getAgentRun(runId);
		if (!run) {
			fail(`Agent run not found: ${runId}`, 'AGENT_RUN_NOT_FOUND');
			return;
		}
		const events = readAgentRunEvents(runId);
		if (options.json) {
			emitJson({ success: true, run, events });
			return;
		}
		console.log(formatRunLine(run));
		console.log(`Events: ${events.length}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, 'AGENT_RUN_SHOW_FAILED');
	}
}

export function campaignRecord(options: CampaignRecordOptions): void {
	const loaded = readJsonFile(options.file);
	if (!loaded.ok) {
		fail(loaded.error, loaded.code);
		return;
	}

	try {
		const campaign = requireCampaign(loaded.value);
		const saved = upsertCampaign(campaign);
		if (options.json) {
			emitJson({ success: true, campaign: saved });
		} else {
			console.log(`Recorded campaign ${saved.id} (${saved.status}).`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, 'INVALID_CAMPAIGN');
	}
}

export function campaignList(options: CampaignListOptions): void {
	try {
		const status = parseCampaignStatus(options.status);
		const limit = parseLimit(options.limit);
		const campaigns = listCampaigns({
			...(status !== undefined ? { status } : {}),
			...(limit !== undefined ? { limit } : {}),
		});

		if (options.json) {
			emitJson({ success: true, campaigns });
			return;
		}

		if (campaigns.length === 0) {
			console.log('No campaigns found.');
			return;
		}

		for (const campaign of campaigns) {
			console.log(formatCampaignLine(campaign));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, 'INVALID_CAMPAIGN_FILTER');
	}
}

export function campaignShow(campaignId: string, options: CampaignShowOptions): void {
	try {
		const campaign = getCampaign(campaignId);
		if (!campaign) {
			fail(`Campaign not found: ${campaignId}`, 'CAMPAIGN_NOT_FOUND');
			return;
		}
		if (options.json) {
			emitJson({ success: true, campaign });
			return;
		}
		console.log(formatCampaignLine(campaign));
		console.log(`Runs: ${campaign.runIds?.length ?? 0}  Tasks: ${campaign.tasks?.length ?? 0}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, 'CAMPAIGN_SHOW_FAILED');
	}
}
