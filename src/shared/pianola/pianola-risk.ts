/**
 * Pianola risk rating - PURE.
 *
 * Rates how risky it would be to act on a detected prompt, ordered
 * low < medium < high. Kept in its own module so the taxonomy is easy to audit,
 * extend, and test in isolation from the classifier.
 *
 * Matching uses word-boundary regexes, not raw substrings, so `auth` does not
 * match `author` and `token` does not match `tokenizer`. High is checked before
 * medium, so the most severe match wins.
 *
 * Safety bias: when in doubt we rate higher. The policy escalates anything high
 * unconditionally and only auto-answers on an explicit rule, so an over-estimate
 * costs an extra escalation (safe) while an under-estimate could auto-answer
 * something dangerous (unsafe).
 */

import type { PianolaRisk } from './types';

const RISK_ORDER: Record<PianolaRisk, number> = { low: 0, medium: 1, high: 2 };

/** True if risk `a` is at most as severe as `b`. */
export function riskAtMost(a: PianolaRisk, b: PianolaRisk): boolean {
	return RISK_ORDER[a] <= RISK_ORDER[b];
}

/** The more severe of two risks. */
export function maxRisk(a: PianolaRisk, b: PianolaRisk): PianolaRisk {
	return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * High risk: destructive, irreversible, security-sensitive, financial, or
 * outward-facing actions. Single common words (push, merge, send, delete) are
 * qualified so everyday prose does not trip them.
 */
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
	// Destructive filesystem / data
	/\brm\s+-rf\b/i,
	/\bdrop\s+(table|database)\b/i,
	/\b(wipe|wiping|truncate|truncating|destroy|destroying|purge|purging)\b/i,
	/\bdelete\s+(the\s+|all\s+|every\s+)?(file|files|data|database|table|branch|repo|repository|directory|folder|account|user|everything)\b/i,
	// Version control - irreversible or outward-facing
	/\bforce[-\s]?push(ing)?\b/i,
	/\bgit\s+push\b/i,
	/\bpush\s+(to|--force|origin|remote|upstream)\b/i,
	/\bpush\s+(the\s+|my\s+|these\s+|all\s+|your\s+|this\s+)?(branch|branches|code|commit|commits|change|changes|it|up)\b/i,
	/\breset\s+--hard\b/i,
	/\b(rebase|rebasing)\b/i,
	/\bmerge\s+(the\s+|this\s+|that\s+|my\s+|your\s+)?(pr|pull\s+request|branch|branches|into\s+\w+|to\s+main|to\s+master|it|changes?)\b/i,
	/\b(revert|reverting|revoke|revoking)\b/i,
	// Deploy / publish / release
	/\b(deploy|deploying|deployment|publish|publishing|release|releasing)\b/i,
	/\bproduction\b/i,
	/\b(to|on|in|into)\s+prod\b/i,
	/\bship\s+(it|to)\b/i,
	// Secrets / auth / permissions
	/\b(secret|secrets|password|passwords|credential|credentials|passphrase)\b/i,
	/\bapi[-\s]?keys?\b/i,
	/\bprivate\s+keys?\b/i,
	/\b(access|auth|api|secret|bearer|refresh|session)\s+tokens?\b/i,
	/\b(disable|bypass|skip|remove|drop|change|reset|grant|revoke|update|modify)\s+(the\s+|all\s+|my\s+)?(auth(?:entication|orization)?|permissions?|access\s+control|rbac)\b/i,
	/\.env\b/i,
	/\b(chmod|chown|sudo)\b/i,
	// Financial / outward communication
	/\b(payment|payments|charge|charging|invoice|billing|refund)\b/i,
	/\bsend\s+(an?\s+)?(email|message|slack|text|dm)\b/i,
	/\bemail(?:ing)?\s+(the\s+|a\s+|an\s+|all\s+)?(team|users?|customers?|clients?|report|them|everyone|list|stakeholders?)\b/i,
	/\bpublish\s+(a\s+)?(post|article|comment)\b/i,
	// Disk / device / data destruction
	/\bdd\s+if=/i,
	/\bmkfs(\.\w+)?\b/i,
	/\b(fdisk|parted)\b/i,
	/\bformat\s+[a-z]:/i,
	/>\s*\/dev\/(sd|nvme|disk)/i,
	/\bof=\/dev\/(sd|nvme|disk)/i,
	// Process / machine control
	// Qualified so dev prose ("graceful shutdown hook", "reboot my understanding")
	// does not trip; only command-shaped uses (sudo/flag/target/now) rate high.
	/\bsudo\s+(shutdown|reboot|poweroff|halt)\b/i,
	/\b(shutdown|reboot|poweroff)\s+(now\b|-\w|the\s+(server|machine|system|box|host|vm|instance|node|pod))/i,
	/\bkill\s+-9\b/i,
	/\b(pkill|killall)\s+-?\w/i,
	/\bsystemctl\s+(stop|disable|mask)\b/i,
	// Containers / orchestration / infrastructure-as-code
	/\bkubectl\s+(delete|drain|cordon)\b/i,
	/\bhelm\s+(delete|uninstall)\b/i,
	/\bdocker\s+(rm|rmi|prune|volume\s+rm|system\s+prune)\b/i,
	/\bdocker[-\s]?compose\s+down\b/i,
	/\bterraform\s+(apply|destroy)\b/i,
	/\bpulumi\s+(up|destroy)\b/i,
	// Cloud object-store / resource deletion
	/\baws\s+s3\s+(rb|rm)\b/i,
	/\b(gcloud|az)\b[^\n]*\bdelete\b/i,
	// Remote-code execution / supply chain
	/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
	/\bnpm\s+publish\b/i,
	// Git destructive / history-rewriting
	/\bgit\s+clean\s+-[a-z]*f/i,
	/\bgit\s+stash\s+(drop|clear)\b/i,
	/\bgit\s+branch\s+-D\b/i,
	/\bgit\s+update-ref\s+-d\b/i,
];

/**
 * Medium risk: meaningful but recoverable engineering choices.
 */
const MEDIUM_RISK_PATTERNS: readonly RegExp[] = [
	/\b(install|installing|uninstall|upgrade|upgrading|downgrade|downgrading|bump|bumping)\b/i,
	/\b(dependency|dependencies|package|packages)\b/i,
	/\b(refactor|refactoring|rename|renaming|restructure|restructuring)\b/i,
	/\b(migrate|migrating|migration|migrations)\b/i,
	/\b(schema|config|configuration|configure)\b/i,
	/\b(delete|deleting|remove|removing|overwrite|overwriting)\b/i,
	/\b(move|moving|create|creating)\s+(a\s+|the\s+)?files?\b/i,
	/\bcommit(ting)?\b/i,
	/\btest\s+strategy\b/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((re) => re.test(text));
}

/** Rate the risk implied by free text. High is checked before medium. */
export function rateRisk(text: string): PianolaRisk {
	if (matchesAny(text, HIGH_RISK_PATTERNS)) return 'high';
	if (matchesAny(text, MEDIUM_RISK_PATTERNS)) return 'medium';
	return 'low';
}
