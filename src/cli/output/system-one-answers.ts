// What `maestro-cli s1 yes | pick | rate | ask | rank | usage | cost` print for
// a person or an agent reading a terminal.
//
// These lines are plain text on purpose, with no color: an agent reads them out
// of a tool result and a script cuts them with `awk`. The numbers a script acts
// on go to standard output; the line that says which engine answered, and what
// it cost, goes to standard error, so `$(maestro-cli s1 yes ...)` holds the
// answer and nothing else.

import { formatCount } from '../../shared/formatters';
import {
	JEV_CHARS_PER_TOKEN,
	JEV_MAX_REQUEST_TOKENS,
	JEV_MAX_STATE_AND_QUESTION_TOKENS,
	type SystemOneAnswer,
	type SystemOneQuestion,
	type SystemOneText,
} from '../../shared/local-models/system-one';
import type {
	SystemOneAgentAnswerMeta,
	SystemOneAgentBudget,
} from '../../shared/local-models/system-one-agent';
import {
	formatSystemOneCost,
	type SystemOneJobEstimate,
	type SystemOneUsageReport,
} from '../../shared/local-models/system-one-spend';

/** Longest level description quoted beside a score. */
const LEVEL_CHARS = 80;

/** A rubric level in a few words: its text, or the field of a structured level that names it. */
export function describeSystemOneLevel(level: SystemOneText | undefined): string {
	if (level === undefined) return '';
	if (typeof level === 'string') return level;
	if (!Array.isArray(level)) {
		for (const key of ['what', 'level', 'description', 'name']) {
			if (typeof level[key] === 'string') return level[key] as string;
		}
	}
	const text = JSON.stringify(level);
	return text.length > LEVEL_CHARS ? `${text.slice(0, LEVEL_CHARS - 3)}...` : text;
}

/** `billing 0.83, orders 0.10`: every option with its probability, most likely first. */
export function formatSystemOneProbabilities(
	probabilities: Record<string, number> | undefined,
	omit?: string
): string {
	return Object.entries(probabilities ?? {})
		.filter(([option]) => option !== omit)
		.sort((a, b) => b[1] - a[1])
		.map(([option, probability]) => `${option} ${probability.toFixed(2)}`)
		.join(', ');
}

/** The rubric level a score is nearest to, as an index. */
export function nearestSystemOneLevel(score: number, levels: number): number {
	return Math.min(Math.max(Math.round(score), 0), Math.max(levels - 1, 0));
}

/**
 * One answer of `s1 ask`, on one line: the question's id, its type, and what
 * the engine said. `question` gives a score its rubric, so the line can say
 * which level the position is nearest to.
 */
export function formatSystemOneAnswer(
	id: string,
	answer: SystemOneAnswer,
	question?: SystemOneQuestion,
	idWidth = 24
): string {
	const name = id.padEnd(idWidth);
	if (answer.type === 'noul') {
		const p = answer.probability;
		return `${name} noul    ${p.toFixed(2)}   ${p >= 0.5 ? 'yes' : 'no'}`;
	}
	if (answer.type === 'choice') {
		const own = answer.probabilities?.[answer.choice];
		const numbers = [
			own === undefined ? null : `p=${own.toFixed(2)}`,
			answer.confidence === undefined ? null : `conf=${answer.confidence.toFixed(2)}`,
		].filter((part) => part !== null);
		const others = formatSystemOneProbabilities(answer.probabilities, answer.choice);
		return [
			`${name} choice  ${answer.choice}`,
			...(numbers.length > 0 ? [numbers.join(' ')] : []),
			...(others ? [`[${others}]`] : []),
		].join('   ');
	}
	const levels = question?.type === 'score' ? question.criteria : [];
	const count = levels.length || answer.probabilities?.length || 0;
	const top = count > 0 ? `/${count - 1}` : '';
	const nearest = describeSystemOneLevel(levels[nearestSystemOneLevel(answer.score, count)]);
	return [
		`${name} score   ${answer.score.toFixed(2)}${top}`,
		...(answer.confidence === undefined ? [] : [`conf=${answer.confidence.toFixed(2)}`]),
		...(nearest ? [`≈ ${nearest}`] : []),
	].join('   ');
}

/** `$0.0123 of $1.00 today`: the day's spend across all agents against its budget. */
export function formatSystemOneBudget(budget: SystemOneAgentBudget): string {
	return `${formatSystemOneCost(budget.spentTodayUsd)} of ${formatSystemOneCost(budget.dailyBudgetUsd)} today`;
}

/**
 * The line under every answer: which engine gave it and whether its numbers
 * are calibrated, the model, and what it cost. A cached answer says so, because
 * nothing was sent for it. An agent must never read a local judge's number as a
 * calibrated probability, so the engine is always named.
 */
export function formatSystemOneAnswerMeta(
	meta: Pick<
		SystemOneAgentAnswerMeta,
		| 'engineLabel'
		| 'calibrated'
		| 'model'
		| 'cached'
		| 'latencyMs'
		| 'tokens'
		| 'costUsd'
		| 'redacted'
		| 'budget'
	>
): string {
	const engine = meta.calibrated
		? `${meta.engineLabel}, calibrated`
		: /not calibrated/i.test(meta.engineLabel)
			? meta.engineLabel
			: `${meta.engineLabel}, not calibrated`;
	const parts = [engine, ...(meta.model ? [meta.model] : [])];
	if (meta.cached) {
		parts.push('cached answer, 0 tokens sent (--no-cache asks again)');
	} else {
		parts.push(
			`${formatCount(meta.tokens.inputTokens)} in / ${formatCount(meta.tokens.outputTokens)} out tokens`,
			`${Math.round(meta.latencyMs)} ms`,
			formatSystemOneCost(meta.costUsd)
		);
	}
	if (meta.redacted) parts.push('secrets redacted before sending');
	parts.push(formatSystemOneBudget(meta.budget));
	return `· ${parts.join(' · ')}`;
}

/** One ranked candidate: its probability, its key, and the candidate on one line. */
export function formatSystemOneRankRow(
	result: { key: string; p: number },
	item: unknown,
	keyWidth: number,
	width: number
): string {
	const text = (typeof item === 'string' ? item : (JSON.stringify(item) ?? '')).replace(
		/\s*\n\s*/g,
		' '
	);
	const shown = text.length > width ? `${text.slice(0, Math.max(width - 3, 0))}...` : text;
	return `${result.p.toFixed(3)}  ${result.key.padEnd(keyWidth)}  ${shown}`;
}

function formatLocalTime(at: number): string {
	const date = new Date(at);
	const two = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Lay out rows of cells in columns, the first left-aligned and the rest right-aligned. */
function table(rows: string[][]): string[] {
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
	return rows.map((row) =>
		row
			.map((cell, column) =>
				column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])
			)
			.join('  ')
			.trimEnd()
	);
}

/**
 * `maestro-cli s1 usage`: today's spend against the budget, then one row per
 * agent since the start of the window, highest spend first.
 */
export function formatSystemOneUsage(report: SystemOneUsageReport): string {
	const { budget } = report;
	const lines = [
		`SYSTEM ONE USAGE  ${report.engineLabel}  since ${formatLocalTime(report.since)}, kept ${report.retentionDays} days`,
	];
	if (report.notice) lines.push(`  ${report.notice}`);
	lines.push(
		`  Today       ${formatSystemOneBudget(budget)} across all agents, ${formatSystemOneCost(budget.remainingTodayUsd)} left`
	);
	if (budget.agent) {
		const own = budget.agent;
		lines.push(
			`  This agent  ${formatSystemOneCost(own.spentTodayUsd)} today${own.budgetUsd === null ? ', no cap of its own' : ` of ${formatSystemOneCost(own.budgetUsd)}`}`
		);
	}
	if (report.rows.length === 0) {
		lines.push('', '  No agent requests in this window.');
		return lines.join('\n');
	}

	const cells = (
		name: string,
		row: Pick<
			SystemOneUsageReport['totals'],
			'requests' | 'cachedRequests' | 'tokensIn' | 'tokensOut' | 'costUsd'
		>,
		latency: string
	) => [
		name,
		formatCount(row.requests),
		formatCount(row.cachedRequests),
		formatCount(row.tokensIn),
		formatCount(row.tokensOut),
		formatSystemOneCost(row.costUsd),
		latency,
	];
	const rows = [
		['agent', 'requests', 'cached', 'in tokens', 'out', 'cost', 'avg ms'],
		...report.rows.map((row) =>
			cells(
				row.agentId === null ? '(no agent)' : (row.agentName ?? row.agentId),
				row,
				String(row.averageLatencyMs)
			)
		),
		...(report.rows.length > 1 ? [cells('total', report.totals, '')] : []),
	];
	lines.push('', ...table(rows).map((line) => `  ${line}`));
	return lines.join('\n');
}

/**
 * `maestro-cli s1 cost`: the tokens of one request against the engine's limit,
 * the requests a job splits into, and the price. `note` says what the price
 * assumes when no engine is chosen.
 */
export function formatSystemOneJobEstimate(
	estimate: SystemOneJobEstimate,
	engineLabel: string,
	note?: string
): string {
	const tokens = (count: number) => formatCount(count);
	const overhead =
		estimate.overheadTokensPerRequest > 0
			? ` + ${estimate.overheadTokensPerRequest} the engine adds`
			: '';
	const fit =
		estimate.fits === null
			? "the local judge's limit is its model's context, checked when it is asked"
			: `${estimate.fits ? 'fits' : 'EXCEEDS'} the request limit (${tokens(JEV_MAX_STATE_AND_QUESTION_TOKENS)} for the state and its longest question, ${tokens(JEV_MAX_REQUEST_TOKENS)} in all)`;
	const lines = [
		`state        ${tokens(estimate.stateTokens)} tokens (estimated at ${JEV_CHARS_PER_TOKEN} characters a token)`,
		`per request  ${tokens(estimate.tokensPerRequest)} tokens = state + ${estimate.questionsPerRequest} question(s) x ~${estimate.questionTokensEach}${overhead}; ${fit}`,
	];
	if (estimate.shape !== 'request') {
		lines.push(
			`job          ${tokens(estimate.items)} ${estimate.shape === 'rank' ? 'candidates' : 'rows'} in ${tokens(estimate.requests)} request(s), ${tokens(estimate.inputTokens)} input tokens`
		);
	}
	const each =
		estimate.shape === 'request' || estimate.costUsd === 0
			? ''
			: ` (${formatSystemOneCost(estimate.costUsd / estimate.items)} an item)`;
	lines.push(
		estimate.pricePerMtokUsd > 0
			? `cost         ${formatSystemOneCost(estimate.costUsd)} on ${engineLabel} at $${estimate.pricePerMtokUsd} per million input tokens${each}`
			: `cost         $0: ${engineLabel} runs on your own hardware`
	);
	if (note) lines.push(note);
	return lines.join('\n');
}
