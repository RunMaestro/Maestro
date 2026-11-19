/**
 * Tier C of a playbook run report, written at the end of a desktop Auto Run.
 *
 * - The playbook has a `report` document: run it once, after every other
 *   document, with the `playbook-report-document` prompt around it. Its reply
 *   gives the narrative plus "How to use it" and "Next steps".
 * - It has none (or the document cannot be read): one synthesis turn over the
 *   task synopses the run collected, on the cheap tier
 *   (`cheapTurnSettings()`), with the `playbook-report-synthesis` prompt.
 *
 * Skipped on a failed or stopped run. Never throws: a report without a
 * narrative shows the facts instead, so a failure here only costs the
 * narrative.
 */

import type { Session, UsageStats } from '../../../types';
import { cheapTurnSettings } from '../../../../shared/modelTiers';
import type { PlaybookParamSet } from '../../../../shared/playbookParams';
import {
	buildPlaybookReportDocumentPrompt,
	buildPlaybookReportSynthesisPrompt,
	parsePlaybookReportAnswer,
	parsePlaybookReportSynthesis,
	playbookReportNarrativeAllowed,
	preparePlaybookReportDocument,
	type PlaybookReportAuthoredParts,
	type PlaybookReportPromptContext,
	type PlaybookReportSynopsis,
} from '../../../../shared/playbookReportAuthoring';
import type {
	DiskEvidence,
	FinalSummaryFacts,
	PlaybookRunReportStatus,
} from '../../../../shared/playbookRunReport';
import { PROMPT_IDS } from '../../../../shared/promptDefinitions';
import { loadPlaybookReportPrompt } from '../../../services/playbookRunReport';
import { logger } from '../../../utils/logger';
import {
	substituteTemplateVariables,
	type TemplateContext,
} from '../../../utils/templateVariables';
import type { AutoRunSpawnAgentFn } from '../useDocumentProcessor';

const LOG_CONTEXT = '[BatchProcessor] Run report';

export interface AuthorRunReportParams {
	/** The agent the run executes in. */
	session: Session;
	/** The Auto Run folder holding the documents. */
	folderPath: string;
	/** Where the tasks ran (the worktree, when the run uses one). */
	effectiveCwd: string;
	sshRemoteId?: string;
	gitBranch?: string;
	groupName?: string;
	playbookName: string;
	/** `BatchRunPlaybook.reportDocument`: the run-list filename, without `.md`. */
	reportDocument?: string;
	status: PlaybookRunReportStatus;
	facts: FinalSummaryFacts;
	evidence?: DiskEvidence;
	synopses: readonly PlaybookReportSynopsis[];
	playbookParams?: PlaybookParamSet;
	/** The run's own model and effort, which the report document's turn keeps. */
	runModel?: string;
	runEffort?: string;
	onSpawnAgent: AutoRunSpawnAgentFn;
}

/** The authored parts, plus what the turn cost so the run's totals can count it. */
export interface AuthoredRunReport extends PlaybookReportAuthoredParts {
	usageStats?: UsageStats;
}

function promptContext(params: AuthorRunReportParams): PlaybookReportPromptContext {
	return {
		playbookName: params.playbookName,
		status: params.status,
		facts: params.facts,
		evidence: params.evidence,
	};
}

/**
 * The report document, ready to hand to the agent: template variables
 * expanded and parameter answers substituted, in memory only. Null when it
 * cannot be read or is empty.
 */
async function readReportDocument(
	params: AuthorRunReportParams,
	reportDocument: string
): Promise<{ path: string; content: string } | null> {
	const result = await window.maestro.autorun.readDoc(
		params.folderPath,
		`${reportDocument}.md`,
		params.sshRemoteId
	);
	if (!result?.success || typeof result.content !== 'string' || result.content.trim() === '') {
		return null;
	}
	const path = `${params.folderPath}/${reportDocument}.md`;
	const templateContext: TemplateContext = {
		session: params.session,
		gitBranch: params.gitBranch,
		groupName: params.groupName,
		groupId: params.session.groupId,
		activeTabId: params.session.activeTabId,
		autoRunFolder: params.folderPath,
		loopNumber: params.facts.loopsCompleted,
		documentName: reportDocument,
		documentPath: path,
	};
	const content = preparePlaybookReportDocument(
		result.content,
		(text) => substituteTemplateVariables(text, templateContext),
		params.playbookParams
	);
	return { path, content };
}

async function runReportDocument(
	params: AuthorRunReportParams,
	document: { path: string; content: string }
): Promise<AuthoredRunReport> {
	const template = await loadPlaybookReportPrompt(PROMPT_IDS.PLAYBOOK_REPORT_DOCUMENT);
	const prompt = buildPlaybookReportDocumentPrompt(template, {
		...promptContext(params),
		documentPath: document.path,
		documentContent: document.content,
	});
	const result = await params.onSpawnAgent(params.session.id, prompt, params.effectiveCwd, {
		...(params.runModel && { modelOverride: params.runModel }),
		...(params.runEffort && { effortOverride: params.runEffort }),
	});
	if (!result.success || !result.response) {
		logger.warn('Report document turn failed', LOG_CONTEXT, { error: result.error });
		return { usageStats: result.usageStats };
	}
	return { ...parsePlaybookReportAnswer(result.response), usageStats: result.usageStats };
}

async function runSynthesis(params: AuthorRunReportParams): Promise<AuthoredRunReport> {
	if (!params.synopses.some((synopsis) => synopsis.summary.trim() !== '')) return {};
	const template = await loadPlaybookReportPrompt(PROMPT_IDS.PLAYBOOK_REPORT_SYNTHESIS);
	const prompt = buildPlaybookReportSynthesisPrompt(template, {
		...promptContext(params),
		synopses: params.synopses,
	});
	const cheap = cheapTurnSettings(params.session.toolType);
	const result = await params.onSpawnAgent(params.session.id, prompt, params.effectiveCwd, {
		...(cheap.model && { modelOverride: cheap.model }),
		...(cheap.effort && { effortOverride: cheap.effort }),
	});
	if (!result.success || !result.response) {
		logger.warn('Report synthesis turn failed', LOG_CONTEXT, { error: result.error });
		return { usageStats: result.usageStats };
	}
	const narrative = parsePlaybookReportSynthesis(result.response);
	return { ...(narrative && { narrative }), usageStats: result.usageStats };
}

/** Write tier C for a finished run. Resolves to `{}` when there is nothing to write. */
export async function authorRunReport(params: AuthorRunReportParams): Promise<AuthoredRunReport> {
	if (!playbookReportNarrativeAllowed(params.status)) return {};
	try {
		if (params.reportDocument) {
			const document = await readReportDocument(params, params.reportDocument);
			if (document) return await runReportDocument(params, document);
			logger.warn('Report document is missing or empty; synthesizing instead', LOG_CONTEXT, {
				reportDocument: params.reportDocument,
			});
		}
		return await runSynthesis(params);
	} catch (error) {
		logger.warn('Run report narrative failed', LOG_CONTEXT, { error });
		return {};
	}
}
