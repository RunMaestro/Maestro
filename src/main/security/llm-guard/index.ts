import { PiiVault } from './vault';
import { scanUrls } from './url-scanner';
import { scanCode } from './code-scanner';
import { applyCustomPatterns, sanitizeCustomPatternMatches } from './custom-patterns';
import type {
	CustomPattern,
	LlmGuardConfig,
	LlmGuardFinding,
	LlmGuardInterAgentResult,
	LlmGuardPostResult,
	LlmGuardPreResult,
	LlmGuardVaultSnapshot,
	OutputInjectionResult,
	StructuralAnalysisResult,
	StructuralIssue,
} from './types';

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const IPV4_REGEX =
	/\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
// Credit card regex with specific prefixes:
// - Visa: starts with 4 (13-19 digits)
// - Mastercard: starts with 5[1-5] or 2[2-7] (16 digits)
// - Amex: starts with 3[47] (15 digits)
// - Discover: starts with 6 (16-19 digits)
const CREDIT_CARD_REGEX =
	/\b(?:4[ -]*(?:\d[ -]*){12,18}|5[1-5][ -]*(?:\d[ -]*){14}|2[2-7][ -]*(?:\d[ -]*){14}|3[47][ -]*(?:\d[ -]*){13}|6[ -]*(?:\d[ -]*){15,18})\b/g;

const SECRET_PATTERNS = [
	// GitHub tokens (from gitleaks)
	{
		type: 'SECRET_GITHUB_TOKEN',
		regex: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9_]{36,}\b/g,
		confidence: 0.99,
	},
	{
		// Fine-grained PAT (82 chars)
		type: 'SECRET_GITHUB_PAT',
		regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
		confidence: 0.99,
	},
	// AWS credentials (improved from gitleaks - catches more key types)
	{
		type: 'SECRET_AWS_ACCESS_KEY',
		regex: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g,
		confidence: 0.98,
	},
	{
		type: 'SECRET_AWS_SECRET_KEY',
		regex:
			/(?:aws_secret_access_key|aws_secret|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
		confidence: 0.97,
	},
	// Azure Storage Key
	{
		type: 'SECRET_AZURE_STORAGE_KEY',
		regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{88}/g,
		confidence: 0.99,
	},
	// Google API keys
	{
		type: 'SECRET_GOOGLE_API_KEY',
		regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
		confidence: 0.98,
	},
	{
		// Google OAuth token
		type: 'SECRET_GOOGLE_OAUTH_TOKEN',
		regex: /\bya29\.[0-9A-Za-z_-]+\b/g,
		confidence: 0.95,
	},
	{
		type: 'SECRET_GOOGLE_OAUTH_SECRET',
		regex: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g,
		confidence: 0.99,
	},
	// Slack tokens (improved from gitleaks - more flexible)
	{
		type: 'SECRET_SLACK_TOKEN',
		regex: /\bxox[baprs]-[0-9a-zA-Z-]{10,72}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_SLACK_WEBHOOK',
		regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+/]{43,46}/g,
		confidence: 0.99,
	},
	// Discord Bot Token (from gitleaks)
	{
		type: 'SECRET_DISCORD_BOT_TOKEN',
		regex: /\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/g,
		confidence: 0.95,
	},
	// Stripe keys (improved - supports test and live, more flexible length)
	{
		type: 'SECRET_STRIPE_KEY',
		regex: /\b(?:sk|rk|pk)_(?:live|test|prod)_[a-zA-Z0-9]{10,99}\b/g,
		confidence: 0.99,
	},
	// Twilio credentials
	{
		type: 'SECRET_TWILIO_ACCOUNT_SID',
		regex: /\bAC[a-f0-9]{32}\b/g,
		confidence: 0.98,
	},
	{
		type: 'SECRET_TWILIO_AUTH_TOKEN',
		regex: /(?:twilio_auth_token|TWILIO_AUTH_TOKEN|auth_token)\s*[:=]\s*['"]?([a-f0-9]{32})['"]?/gi,
		confidence: 0.95,
	},
	// OpenAI keys (improved - multiple formats)
	{
		// Modern OpenAI keys with project/service prefixes
		type: 'SECRET_OPENAI_KEY',
		regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/g,
		confidence: 0.99,
	},
	{
		// Legacy/simple OpenAI keys
		type: 'SECRET_OPENAI_KEY_LEGACY',
		regex: /\bsk-[A-Za-z0-9]{32,}\b/g,
		confidence: 0.9,
	},
	// Anthropic API keys
	{
		type: 'SECRET_ANTHROPIC_KEY',
		regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
		confidence: 0.99,
	},
	// Telegram Bot Token (from secrets-patterns-db)
	{
		type: 'SECRET_TELEGRAM_BOT_TOKEN',
		regex: /\b[0-9]+:AA[0-9A-Za-z_-]{33}\b/g,
		confidence: 0.98,
	},
	// JWT tokens (from gitleaks)
	{
		type: 'SECRET_JWT_TOKEN',
		regex: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.[a-zA-Z0-9/_-]{10,}\b/g,
		confidence: 0.85,
	},
	// Database connection strings
	{
		type: 'SECRET_CONNECTION_STRING_POSTGRES',
		regex: /\bpostgres(?:ql)?:\/\/[^\s'"]+/g,
		confidence: 0.95,
	},
	{
		type: 'SECRET_CONNECTION_STRING_MYSQL',
		regex: /\bmysql:\/\/[^\s'"]+/g,
		confidence: 0.95,
	},
	{
		type: 'SECRET_CONNECTION_STRING_MONGODB',
		regex: /\bmongodb(?:\+srv)?:\/\/[^\s'"]+/g,
		confidence: 0.95,
	},
	{
		type: 'SECRET_CONNECTION_STRING_REDIS',
		regex: /\bredis:\/\/[^\s'"]+/g,
		confidence: 0.95,
	},
	{
		type: 'SECRET_CONNECTION_STRING_SQLSERVER',
		regex: /Server=[^;]+;.*(?:Password|Pwd)=[^;]+/gi,
		confidence: 0.93,
	},
	// Cloud provider credentials - Heroku
	{
		type: 'SECRET_HEROKU_API_KEY',
		regex:
			/[hH]eroku.*[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g,
		confidence: 0.95,
	},
	// DigitalOcean Token
	{
		type: 'SECRET_DIGITALOCEAN_TOKEN',
		regex: /\bdop_v1_[a-f0-9]{64}\b/g,
		confidence: 0.99,
	},
	// Netlify Access Token (with context check)
	{
		type: 'SECRET_NETLIFY_TOKEN',
		regex:
			/(?:netlify|NETLIFY)[\w_]*(?:token|TOKEN|key|KEY)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{45,})['"]?/gi,
		confidence: 0.92,
	},
	// Vercel Token (with context check)
	{
		type: 'SECRET_VERCEL_TOKEN',
		regex:
			/(?:vercel|VERCEL)[\w_]*(?:token|TOKEN|key|KEY)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{24,})['"]?/gi,
		confidence: 0.92,
	},
	// Cloudflare API Token (with context check)
	{
		type: 'SECRET_CLOUDFLARE_TOKEN',
		regex:
			/(?:cloudflare|CLOUDFLARE|cf|CF)[\w_]*(?:token|TOKEN|key|KEY|api|API)\s*[:=]\s*['"]?([A-Za-z0-9_-]{40})['"]?/gi,
		confidence: 0.92,
	},
	// Code repository tokens - GitLab
	{
		type: 'SECRET_GITLAB_PAT',
		regex: /\bglpat-[0-9a-zA-Z_-]{20,}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_GITLAB_PIPELINE_TOKEN',
		regex: /\bglpt-[0-9a-zA-Z_-]{20,}\b/g,
		confidence: 0.99,
	},
	// Bitbucket App Password (with context)
	{
		type: 'SECRET_BITBUCKET_APP_PASSWORD',
		regex:
			/(?:bitbucket|BITBUCKET)[\w_]*(?:password|PASSWORD|token|TOKEN|app_password)\s*[:=]\s*['"]?([a-zA-Z0-9]{24,})['"]?/gi,
		confidence: 0.9,
	},
	// CircleCI Token
	{
		type: 'SECRET_CIRCLECI_TOKEN',
		regex: /\bcircle-token-[a-f0-9]{40}\b/g,
		confidence: 0.99,
	},
	// Travis CI Token (with context)
	{
		type: 'SECRET_TRAVIS_TOKEN',
		regex:
			/(?:travis|TRAVIS)[\w_]*(?:token|TOKEN|api_key|API_KEY)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
		confidence: 0.9,
	},
	// Jenkins API Token (with context)
	{
		type: 'SECRET_JENKINS_TOKEN',
		regex:
			/(?:jenkins|JENKINS)[\w_]*(?:token|TOKEN|api_key|API_KEY|password|PASSWORD)\s*[:=]\s*['"]?([a-fA-F0-9]{32,})['"]?/gi,
		confidence: 0.9,
	},
	// Private keys and certificates
	{
		type: 'SECRET_RSA_PRIVATE_KEY',
		regex: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_OPENSSH_PRIVATE_KEY',
		regex: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_PGP_PRIVATE_KEY',
		regex: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_EC_PRIVATE_KEY',
		regex: /-----BEGIN EC PRIVATE KEY-----[\s\S]*?-----END EC PRIVATE KEY-----/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_GENERIC_PRIVATE_KEY',
		regex: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,
		confidence: 0.99,
	},
	// SaaS API keys - SendGrid
	{
		type: 'SECRET_SENDGRID_API_KEY',
		regex: /\bSG\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{30,}\b/g,
		confidence: 0.99,
	},
	// Mailchimp API Key
	{
		type: 'SECRET_MAILCHIMP_API_KEY',
		regex: /\b[a-f0-9]{32}-us[0-9]{1,2}\b/g,
		confidence: 0.95,
	},
	// Postmark Server Token (with context)
	{
		type: 'SECRET_POSTMARK_TOKEN',
		regex:
			/(?:postmark|POSTMARK)[\w_]*(?:token|TOKEN|api_key|API_KEY)\s*[:=]\s*['"]?([a-f0-9-]{36})['"]?/gi,
		confidence: 0.9,
	},
	// Datadog API Key
	{
		type: 'SECRET_DATADOG_API_KEY',
		regex: /\bdd[a-f0-9]{32}\b/g,
		confidence: 0.95,
	},
	// New Relic License Key
	{
		type: 'SECRET_NEWRELIC_LICENSE_KEY',
		regex: /\bNRAK-[A-Z0-9]{27}\b/g,
		confidence: 0.99,
	},
	// PagerDuty API Key (with context)
	{
		type: 'SECRET_PAGERDUTY_TOKEN',
		regex:
			/(?:pagerduty|PAGERDUTY|pd|PD)[\w_]*(?:token|TOKEN|api_key|API_KEY)\s*[:=]\s*['"]?([a-zA-Z0-9+/=]{20,})['"]?/gi,
		confidence: 0.9,
	},
	// Sentry DSN
	{
		type: 'SECRET_SENTRY_DSN',
		regex: /https:\/\/[a-f0-9]{32}@[a-z0-9.]+\.sentry\.io\/[0-9]+/g,
		confidence: 0.99,
	},
	// npm tokens (from gitleaks)
	{
		type: 'SECRET_NPM_TOKEN',
		regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
		confidence: 0.99,
	},
	// PyPI API tokens (from gitleaks)
	{
		type: 'SECRET_PYPI_TOKEN',
		regex: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g,
		confidence: 0.99,
	},
	// NuGet API Key (from gitleaks)
	{
		type: 'SECRET_NUGET_API_KEY',
		regex: /\boy2[a-z0-9]{43}\b/g,
		confidence: 0.95,
	},
	// Shopify tokens (from gitleaks)
	{
		type: 'SECRET_SHOPIFY_ACCESS_TOKEN',
		regex: /\bshpat_[a-fA-F0-9]{32}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_SHOPIFY_CUSTOM_TOKEN',
		regex: /\bshpca_[a-fA-F0-9]{32}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_SHOPIFY_PRIVATE_TOKEN',
		regex: /\bshppa_[a-fA-F0-9]{32}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_SHOPIFY_SHARED_SECRET',
		regex: /\bshpss_[a-fA-F0-9]{32}\b/g,
		confidence: 0.99,
	},
	// Doppler API Token (from gitleaks)
	{
		type: 'SECRET_DOPPLER_TOKEN',
		regex: /\bdp\.pt\.[a-zA-Z0-9]{43}\b/g,
		confidence: 0.99,
	},
	// Hashicorp Vault Token (from gitleaks)
	{
		type: 'SECRET_VAULT_TOKEN',
		regex: /\bhvs\.[a-zA-Z0-9_-]{24,}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_VAULT_BATCH_TOKEN',
		regex: /\bhvb\.[a-zA-Z0-9_-]{24,}\b/g,
		confidence: 0.99,
	},
	// Linear API Key (from gitleaks)
	{
		type: 'SECRET_LINEAR_API_KEY',
		regex: /\blin_api_[a-zA-Z0-9]{40}\b/g,
		confidence: 0.99,
	},
	// Supabase tokens (from gitleaks)
	{
		type: 'SECRET_SUPABASE_TOKEN',
		regex: /\bsbp_[a-f0-9]{40}\b/g,
		confidence: 0.99,
	},
	// Pulumi Access Token (from gitleaks)
	{
		type: 'SECRET_PULUMI_TOKEN',
		regex: /\bpul-[a-f0-9]{40}\b/g,
		confidence: 0.99,
	},
	// Grafana API Key (from gitleaks)
	{
		type: 'SECRET_GRAFANA_API_KEY',
		regex: /\beyJrIjoi[a-zA-Z0-9_-]{50,}\b/g,
		confidence: 0.95,
	},
	// Algolia API Key (from gitleaks)
	{
		type: 'SECRET_ALGOLIA_API_KEY',
		regex: /\b[a-f0-9]{32}\b(?=.*algolia)/gi,
		confidence: 0.85,
	},
	// Firebase tokens (from gitleaks)
	{
		type: 'SECRET_FIREBASE_TOKEN',
		regex: /\bAAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}\b/g,
		confidence: 0.95,
	},
	// Age secret key (from gitleaks) - encryption tool
	{
		type: 'SECRET_AGE_SECRET_KEY',
		regex: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}\b/g,
		confidence: 0.99,
	},
	// 1Password secret automation tokens (from gitleaks)
	{
		type: 'SECRET_1PASSWORD_TOKEN',
		regex: /\bops_[a-zA-Z0-9_-]{61,64}\b/g,
		confidence: 0.99,
	},
	// Figma tokens (from gitleaks)
	{
		type: 'SECRET_FIGMA_TOKEN',
		regex: /\bfig[dp]_[a-zA-Z0-9_-]{40,}\b/g,
		confidence: 0.99,
	},
	// Fastly API Token (from gitleaks)
	{
		type: 'SECRET_FASTLY_API_TOKEN',
		regex:
			/(?:fastly|FASTLY)[\w_]*(?:token|TOKEN|api_key|API_KEY)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{32})['"]?/gi,
		confidence: 0.92,
	},
	// Plaid client credentials (from gitleaks)
	{
		type: 'SECRET_PLAID_CLIENT_ID',
		regex: /(?:plaid|PLAID)[\w_]*client[\w_]*id\s*[:=]\s*['"]?([a-f0-9]{24})['"]?/gi,
		confidence: 0.9,
	},
	{
		type: 'SECRET_PLAID_SECRET',
		regex: /(?:plaid|PLAID)[\w_]*secret\s*[:=]\s*['"]?([a-f0-9]{30})['"]?/gi,
		confidence: 0.9,
	},
	// Generic bearer tokens (from gitleaks) - lower confidence as generic
	{
		type: 'SECRET_BEARER_TOKEN',
		regex: /(?:bearer|Bearer|BEARER)\s+[a-zA-Z0-9_\-.~+/]+=*/g,
		confidence: 0.7,
	},
	// Generic API key patterns with context (from gitleaks)
	{
		type: 'SECRET_GENERIC_API_KEY',
		regex: /(?:api[_-]?key|apikey|API[_-]?KEY)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
		confidence: 0.75,
	},
	{
		type: 'SECRET_GENERIC_SECRET',
		regex: /(?:secret[_-]?key|secretkey|SECRET[_-]?KEY)\s*[:=]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
		confidence: 0.75,
	},
	// Hugging Face tokens (from gitleaks)
	{
		type: 'SECRET_HUGGINGFACE_TOKEN',
		regex: /\bhf_[a-zA-Z0-9]{34,}\b/g,
		confidence: 0.99,
	},
	// Replicate API token
	{
		type: 'SECRET_REPLICATE_TOKEN',
		regex: /\br8_[a-zA-Z0-9]{40}\b/g,
		confidence: 0.99,
	},
	// Cohere API Key
	{
		type: 'SECRET_COHERE_API_KEY',
		regex:
			/(?:cohere|COHERE)[\w_]*(?:api[_-]?key|API[_-]?KEY)\s*[:=]\s*['"]?([a-zA-Z0-9]{40})['"]?/gi,
		confidence: 0.9,
	},
];

// High-entropy detection configuration
const ENTROPY_CONFIG = {
	minLength: 20,
	base64Threshold: 4.5,
	hexThreshold: 3.5,
	// Patterns to exclude from entropy scanning (UUIDs, timestamps, file hashes, crypto wallets, API keys, etc.)
	excludePatterns: [
		// UUID v4 format
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		// Timestamps (Unix milliseconds or similar)
		/^[0-9]{10,13}$/,
		// Common file hash formats (MD5, SHA1, SHA256) when standalone
		/^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/i,
		// Git commit hashes
		/^[a-f0-9]{7,40}$/i,
		// Version numbers
		/^v?\d+\.\d+\.\d+/,
		// Semantic version identifiers
		/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/,
		// Google API keys (AIza prefix)
		/^AIza[0-9A-Za-z_-]{35}$/,
		// Google OAuth Client Secret (GOCSPX prefix)
		/^GOCSPX-[A-Za-z0-9_-]{28}$/,
		// Bitcoin legacy addresses (1 or 3 prefix, base58)
		/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
		// Bitcoin SegWit addresses (bech32)
		/^bc1[a-z0-9]{39,59}$/,
		// Ethereum addresses
		/^0x[a-fA-F0-9]{40}$/,
		// Litecoin addresses
		/^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/,
		// Litecoin bech32 addresses
		/^ltc1[a-z0-9]{39,59}$/,
		// Ripple addresses
		/^r[0-9a-zA-Z]{24,34}$/,
		// Monero addresses (start with 4 + digit/A/B, then 93 base58 chars)
		/^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
	],
};

/**
 * Calculate Shannon entropy of a string.
 * Higher entropy indicates more randomness, which is characteristic of secrets.
 */
function calculateShannonEntropy(text: string): number {
	if (!text || text.length === 0) return 0;

	const frequencyMap = new Map<string, number>();
	for (const char of text) {
		frequencyMap.set(char, (frequencyMap.get(char) || 0) + 1);
	}

	let entropy = 0;
	const length = text.length;
	for (const count of frequencyMap.values()) {
		const probability = count / length;
		entropy -= probability * Math.log2(probability);
	}

	return entropy;
}

/**
 * Detect high-entropy strings that may be secrets.
 * Returns findings for strings that exceed the entropy threshold.
 */
function detectHighEntropyStrings(text: string): LlmGuardFinding[] {
	const findings: LlmGuardFinding[] = [];

	// Match potential secrets: alphanumeric strings with optional special chars
	// Base64 pattern: alphanumeric plus +/=
	const base64Pattern = /\b[A-Za-z0-9+/=]{20,}\b/g;
	// Hex pattern: only hex characters
	const hexPattern = /\b[a-fA-F0-9]{20,}\b/g;

	const checkString = (
		match: RegExpExecArray,
		threshold: number,
		isHex: boolean
	): LlmGuardFinding | null => {
		const value = match[0];

		// Check exclusion patterns
		for (const excludePattern of ENTROPY_CONFIG.excludePatterns) {
			if (excludePattern.test(value)) {
				return null;
			}
		}

		const entropy = calculateShannonEntropy(value);
		if (entropy < threshold) {
			return null;
		}

		// Calculate confidence based on entropy level and string characteristics
		// Higher entropy = higher confidence, capped at 0.85 for generic detection
		const baseConfidence = Math.min(0.85, 0.5 + (entropy - threshold) * 0.1);
		// Longer strings get slightly higher confidence
		const lengthBonus = Math.min(0.1, (value.length - ENTROPY_CONFIG.minLength) * 0.002);
		const confidence = Math.min(0.85, baseConfidence + lengthBonus);

		return {
			type: isHex ? 'SECRET_HIGH_ENTROPY_HEX' : 'SECRET_HIGH_ENTROPY_BASE64',
			value,
			start: match.index,
			end: match.index + value.length,
			confidence,
		};
	};

	// Check base64 patterns
	let match: RegExpExecArray | null;
	const base64Matcher = new RegExp(base64Pattern.source, base64Pattern.flags);
	while ((match = base64Matcher.exec(text)) !== null) {
		const finding = checkString(match, ENTROPY_CONFIG.base64Threshold, false);
		if (finding) {
			findings.push(finding);
		}
	}

	// Check hex patterns (only if not already matched as base64)
	const hexMatcher = new RegExp(hexPattern.source, hexPattern.flags);
	while ((match = hexMatcher.exec(text)) !== null) {
		// Skip if this overlaps with an existing finding
		const overlaps = findings.some(
			(f) =>
				(match!.index >= f.start && match!.index < f.end) ||
				(match!.index + match![0].length > f.start && match!.index + match![0].length <= f.end)
		);
		if (overlaps) continue;

		const finding = checkString(match, ENTROPY_CONFIG.hexThreshold, true);
		if (finding) {
			findings.push(finding);
		}
	}

	return findings;
}

// Cryptocurrency wallet address patterns
const CRYPTO_WALLET_PATTERNS = [
	// Bitcoin mainnet (legacy P2PKH addresses starting with 1, P2SH starting with 3)
	{
		type: 'PII_CRYPTO_BITCOIN_LEGACY',
		regex: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
		confidence: 0.82,
	},
	// Bitcoin SegWit (bech32 addresses starting with bc1)
	{
		type: 'PII_CRYPTO_BITCOIN_SEGWIT',
		regex: /\bbc1[a-z0-9]{39,59}\b/g,
		confidence: 0.95,
	},
	// Ethereum addresses
	{
		type: 'PII_CRYPTO_ETHEREUM',
		regex: /\b0x[a-fA-F0-9]{40}\b/g,
		confidence: 0.9,
	},
	// Litecoin (L for legacy, M for P2SH, ltc1 for bech32)
	{
		type: 'PII_CRYPTO_LITECOIN',
		regex: /\b(?:[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}|ltc1[a-z0-9]{39,59})\b/g,
		confidence: 0.8,
	},
	// Ripple (XRP) addresses start with r
	{
		type: 'PII_CRYPTO_RIPPLE',
		regex: /\br[0-9a-zA-Z]{24,34}\b/g,
		confidence: 0.78,
	},
	// Monero addresses (start with 4 followed by 0-9 or A-B)
	{
		type: 'PII_CRYPTO_MONERO',
		regex: /\b4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}\b/g,
		confidence: 0.95,
	},
	// Solana addresses (with context check to reduce false positives)
	{
		type: 'PII_CRYPTO_SOLANA',
		regex: /(?:solana|SOL|sol_address|wallet)\s*[:=]?\s*['"]?([1-9A-HJ-NP-Za-km-z]{32,44})['"]?/gi,
		confidence: 0.85,
	},
];

// Physical address patterns
const ADDRESS_PATTERNS = [
	// US Street Address pattern
	{
		type: 'PII_STREET_ADDRESS',
		regex:
			/\b\d{1,5}\s+[\w\s]{2,30}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Trail|Trl|Parkway|Pkwy|Highway|Hwy)\.?(?:\s+(?:Apt|Suite|Ste|Unit|#)\s*[A-Za-z0-9-]+)?\b/gi,
		confidence: 0.72,
	},
	// PO Box
	{
		type: 'PII_PO_BOX',
		regex: /\bP\.?O\.?\s*Box\s*\d+\b/gi,
		confidence: 0.92,
	},
	// US ZIP Code (5 or 9 digit with context - following state abbreviation or city)
	{
		type: 'PII_ZIP_CODE',
		regex:
			/\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+(\d{5}(?:-\d{4})?)\b/g,
		confidence: 0.85,
	},
];

// Name and identity patterns (heuristic-based with lower confidence)
const NAME_PATTERNS = [
	// "Name: John Smith" or "Full Name: ..." patterns
	{
		type: 'PII_NAME_FIELD',
		regex: /(?:(?:full\s+)?name|nombre)\s*[:=]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi,
		confidence: 0.68,
	},
	// Title patterns: Mr./Mrs./Ms./Dr./Prof. followed by name
	{
		type: 'PII_NAME_TITLE',
		regex: /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g,
		confidence: 0.62,
	},
	// "signed by" or "authorized by" followed by name
	{
		type: 'PII_NAME_SIGNATURE',
		regex:
			/(?:signed|authorized|approved|witnessed)\s+by\s*[:=]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/gi,
		confidence: 0.65,
	},
];

// Shared PII patterns used by both anonymizePii (pre-scan) and detectPiiLeakage (post-scan)
const PII_PATTERNS = [
	{ type: 'PII_EMAIL', regex: EMAIL_REGEX, confidence: 0.99 },
	{ type: 'PII_PHONE', regex: PHONE_REGEX, confidence: 0.92 },
	{ type: 'PII_SSN', regex: SSN_REGEX, confidence: 0.97 },
	{ type: 'PII_IP_ADDRESS', regex: IPV4_REGEX, confidence: 0.88 },
	{ type: 'PII_CREDIT_CARD', regex: CREDIT_CARD_REGEX, confidence: 0.75 },
	// Include crypto, address, and name patterns
	...CRYPTO_WALLET_PATTERNS,
	...ADDRESS_PATTERNS,
	...NAME_PATTERNS,
];

// Invisible character detection patterns
const INVISIBLE_CHAR_PATTERNS = {
	// Zero-width characters
	zeroWidth: {
		// eslint-disable-next-line no-misleading-character-class -- Intentionally matching zero-width joiners
		pattern: /[\u200B\u200C\u200D\uFEFF]/g,
		type: 'INVISIBLE_ZERO_WIDTH',
		description: 'Zero-width characters (ZWSP, ZWNJ, ZWJ, BOM)',
		confidence: 0.95,
	},
	// Right-to-left override characters (can be used to reverse text visually)
	rtlOverride: {
		pattern: /[\u202E\u202D\u202A\u202B\u202C\u2066\u2067\u2068\u2069]/g,
		type: 'INVISIBLE_RTL_OVERRIDE',
		description: 'Right-to-left override/embedding characters',
		confidence: 0.98,
	},
	// Variation selectors (can modify how characters appear)
	variationSelectors: {
		pattern: /[\uFE00-\uFE0F]/g,
		type: 'INVISIBLE_VARIATION_SELECTOR',
		description: 'Unicode variation selectors',
		confidence: 0.75,
	},
	// Control characters (except common whitespace)
	controlChars: {
		// U+0000-U+001F except tab (0x09), newline (0x0A), carriage return (0x0D)
		pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
		type: 'INVISIBLE_CONTROL_CHAR',
		description: 'Control characters (non-whitespace)',
		confidence: 0.92,
	},
	// Soft hyphen and other invisible formatters
	invisibleFormatters: {
		// eslint-disable-next-line no-misleading-character-class -- Intentionally matching invisible format characters
		pattern: /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2060-\u206F]/g,
		type: 'INVISIBLE_FORMATTER',
		description: 'Invisible formatting characters (soft hyphen, etc.)',
		confidence: 0.88,
	},
	// Tag characters (rarely used legitimately)
	// Note: Tag characters are in plane 14 (U+E0000-E007F), which requires
	// the 'u' flag and \u{XXXXX} syntax for correct handling
	tagCharacters: {
		pattern: /[\u{E0000}-\u{E007F}]/gu,
		type: 'INVISIBLE_TAG_CHAR',
		description: 'Unicode tag characters',
		confidence: 0.96,
	},
};

// Homoglyph mappings for common Cyrillic/Greek lookalikes
const HOMOGLYPH_MAPPINGS: { [key: string]: string } = {
	// Cyrillic lookalikes
	'\u0410': 'A', // А -> A
	'\u0412': 'B', // В -> B
	'\u0421': 'C', // С -> C
	'\u0415': 'E', // Е -> E
	'\u041D': 'H', // Н -> H
	'\u0406': 'I', // І -> I
	'\u0408': 'J', // Ј -> J
	'\u041A': 'K', // К -> K
	'\u041C': 'M', // М -> M
	'\u041E': 'O', // О -> O
	'\u0420': 'P', // Р -> P
	'\u0405': 'S', // Ѕ -> S
	'\u0422': 'T', // Т -> T
	'\u0425': 'X', // Х -> X
	'\u0427': 'Y', // Ч -> similar to Y (not exact)
	'\u0430': 'a', // а -> a
	'\u0435': 'e', // е -> e
	'\u043E': 'o', // о -> o
	'\u0440': 'p', // р -> p
	'\u0441': 'c', // с -> c
	'\u0443': 'y', // у -> y (similar)
	'\u0445': 'x', // х -> x
	// Greek lookalikes
	'\u0391': 'A', // Α -> A
	'\u0392': 'B', // Β -> B
	'\u0395': 'E', // Ε -> E
	'\u0397': 'H', // Η -> H
	'\u0399': 'I', // Ι -> I
	'\u039A': 'K', // Κ -> K
	'\u039C': 'M', // Μ -> M
	'\u039D': 'N', // Ν -> N
	'\u039F': 'O', // Ο -> O
	'\u03A1': 'P', // Ρ -> P
	'\u03A4': 'T', // Τ -> T
	'\u03A7': 'X', // Χ -> X
	'\u03A5': 'Y', // Υ -> Y
	'\u03B1': 'a', // α -> a (similar)
	'\u03B5': 'e', // ε -> similar to e
	'\u03BF': 'o', // ο -> o
	'\u03C1': 'p', // ρ -> p
	'\u03C5': 'u', // υ -> similar to u
};

// Build regex for homoglyph detection
const homoglyphChars = Object.keys(HOMOGLYPH_MAPPINGS).join('');
const HOMOGLYPH_REGEX = new RegExp(`[${homoglyphChars}]`, 'g');

// Encoding attack patterns
const ENCODING_ATTACK_PATTERNS = {
	// HTML entities in non-HTML context
	htmlEntities: {
		// Named entities like &lt;, &gt;, &amp;, &quot;
		named: /&(?:lt|gt|amp|quot|apos|nbsp);/gi,
		// Decimal entities like &#60;, &#62;
		decimal: /&#\d{1,5};/g,
		// Hex entities like &#x3C;, &#x3E;
		hex: /&#x[0-9A-Fa-f]{1,4};/gi,
		type: 'ENCODING_HTML_ENTITY',
		confidence: 0.82,
	},
	// URL encoding in non-URL context
	urlEncoding: {
		// Suspicious URL-encoded characters (common injection chars)
		pattern: /%(?:3[CEF]|2[267F]|[01][0-9A-Fa-f]|5[BCD]|7[BCD])/gi,
		type: 'ENCODING_URL_ENCODED',
		confidence: 0.78,
	},
	// Unicode escapes
	unicodeEscapes: {
		// \u0000 or \x00 format
		pattern: /\\u[0-9A-Fa-f]{4}|\\x[0-9A-Fa-f]{2}/g,
		type: 'ENCODING_UNICODE_ESCAPE',
		confidence: 0.72,
	},
	// Punycode domains (can be used for IDN homograph attacks)
	punycode: {
		// xn-- prefix indicates punycode encoding
		pattern: /\bxn--[a-z0-9-]+(?:\.[a-z]{2,})+\b/gi,
		type: 'ENCODING_PUNYCODE',
		confidence: 0.85,
	},
	// Octal escapes
	octalEscapes: {
		pattern: /\\[0-7]{1,3}/g,
		type: 'ENCODING_OCTAL_ESCAPE',
		confidence: 0.7,
	},
	// Double encoding (URL encoded %25 sequences)
	doubleEncoding: {
		pattern: /%25[0-9A-Fa-f]{2}/gi,
		type: 'ENCODING_DOUBLE_ENCODED',
		confidence: 0.88,
	},
};

/**
 * Detect invisible characters in text that could be used for injection attacks.
 * These characters are often invisible or nearly invisible but can affect how
 * text is processed or displayed.
 *
 * @param text - The text to analyze
 * @returns Array of findings for detected invisible characters
 */
export function detectInvisibleCharacters(text: string): LlmGuardFinding[] {
	const findings: LlmGuardFinding[] = [];

	// Check each invisible character pattern
	for (const [, config] of Object.entries(INVISIBLE_CHAR_PATTERNS)) {
		const matcher = new RegExp(config.pattern.source, config.pattern.flags);
		let match: RegExpExecArray | null;

		while ((match = matcher.exec(text)) !== null) {
			const char = match[0];
			const codePoint = char.codePointAt(0) || 0;

			findings.push({
				type: config.type,
				value: char,
				start: match.index,
				end: match.index + char.length,
				confidence: config.confidence,
				replacement: `[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}]`,
			});
		}
	}

	// Check for homoglyphs
	const homoglyphMatcher = new RegExp(HOMOGLYPH_REGEX.source, HOMOGLYPH_REGEX.flags);
	let match: RegExpExecArray | null;
	const homoglyphClusters: { start: number; end: number; chars: string[] }[] = [];

	while ((match = homoglyphMatcher.exec(text)) !== null) {
		const char = match[0];
		const index = match.index;

		// Try to group adjacent homoglyphs
		const lastCluster = homoglyphClusters[homoglyphClusters.length - 1];
		if (lastCluster && lastCluster.end === index) {
			lastCluster.end = index + 1;
			lastCluster.chars.push(char);
		} else {
			homoglyphClusters.push({
				start: index,
				end: index + 1,
				chars: [char],
			});
		}
	}

	// Report homoglyph clusters (more significant when multiple are grouped)
	for (const cluster of homoglyphClusters) {
		// Higher confidence for clusters of homoglyphs vs single characters
		const confidence = cluster.chars.length > 1 ? 0.88 : 0.72;
		const latinEquivalent = cluster.chars.map((c) => HOMOGLYPH_MAPPINGS[c] || c).join('');

		findings.push({
			type: 'INVISIBLE_HOMOGLYPH',
			value: cluster.chars.join(''),
			start: cluster.start,
			end: cluster.end,
			confidence,
			// Show what the homoglyphs look like in Latin
			replacement: `[HOMOGLYPH:${latinEquivalent}]`,
		});
	}

	return findings;
}

/**
 * Detect encoding attacks in text that could be used to bypass filters.
 * This includes HTML entities, URL encoding, Unicode escapes, etc.
 *
 * @param text - The text to analyze
 * @returns Array of findings for detected encoding attacks
 */
export function detectEncodingAttacks(text: string): LlmGuardFinding[] {
	const findings: LlmGuardFinding[] = [];

	// Check HTML entities
	const htmlConfig = ENCODING_ATTACK_PATTERNS.htmlEntities;
	for (const pattern of [htmlConfig.named, htmlConfig.decimal, htmlConfig.hex]) {
		const matcher = new RegExp(pattern.source, pattern.flags);
		let match: RegExpExecArray | null;

		while ((match = matcher.exec(text)) !== null) {
			const value = match[0];

			// Try to decode the entity for the replacement hint
			let decoded = value;
			if (value.startsWith('&#x')) {
				const codePoint = parseInt(value.slice(3, -1), 16);
				decoded = String.fromCodePoint(codePoint);
			} else if (value.startsWith('&#')) {
				const codePoint = parseInt(value.slice(2, -1), 10);
				decoded = String.fromCodePoint(codePoint);
			} else {
				// Named entities
				const entityMap: { [key: string]: string } = {
					'&lt;': '<',
					'&gt;': '>',
					'&amp;': '&',
					'&quot;': '"',
					'&apos;': "'",
					'&nbsp;': ' ',
				};
				decoded = entityMap[value.toLowerCase()] || value;
			}

			findings.push({
				type: htmlConfig.type,
				value,
				start: match.index,
				end: match.index + value.length,
				confidence: htmlConfig.confidence,
				replacement: decoded,
			});
		}
	}

	// Check URL encoding
	const urlConfig = ENCODING_ATTACK_PATTERNS.urlEncoding;
	const urlMatcher = new RegExp(urlConfig.pattern.source, urlConfig.pattern.flags);
	let urlMatch: RegExpExecArray | null;

	while ((urlMatch = urlMatcher.exec(text)) !== null) {
		const value = urlMatch[0];
		const decoded = decodeURIComponent(value);

		findings.push({
			type: urlConfig.type,
			value,
			start: urlMatch.index,
			end: urlMatch.index + value.length,
			confidence: urlConfig.confidence,
			replacement: decoded,
		});
	}

	// Check Unicode escapes
	const unicodeConfig = ENCODING_ATTACK_PATTERNS.unicodeEscapes;
	const unicodeMatcher = new RegExp(unicodeConfig.pattern.source, unicodeConfig.pattern.flags);
	let unicodeMatch: RegExpExecArray | null;

	while ((unicodeMatch = unicodeMatcher.exec(text)) !== null) {
		const value = unicodeMatch[0];
		let decoded = value;

		try {
			if (value.startsWith('\\u')) {
				const codePoint = parseInt(value.slice(2), 16);
				decoded = String.fromCodePoint(codePoint);
			} else if (value.startsWith('\\x')) {
				const codePoint = parseInt(value.slice(2), 16);
				decoded = String.fromCodePoint(codePoint);
			}
		} catch {
			// Invalid code point, keep original
		}

		findings.push({
			type: unicodeConfig.type,
			value,
			start: unicodeMatch.index,
			end: unicodeMatch.index + value.length,
			confidence: unicodeConfig.confidence,
			replacement: decoded,
		});
	}

	// Check Punycode
	const punycodeConfig = ENCODING_ATTACK_PATTERNS.punycode;
	const punycodeMatcher = new RegExp(punycodeConfig.pattern.source, punycodeConfig.pattern.flags);
	let punycodeMatch: RegExpExecArray | null;

	while ((punycodeMatch = punycodeMatcher.exec(text)) !== null) {
		const value = punycodeMatch[0];

		findings.push({
			type: punycodeConfig.type,
			value,
			start: punycodeMatch.index,
			end: punycodeMatch.index + value.length,
			confidence: punycodeConfig.confidence,
		});
	}

	// Check Octal escapes
	const octalConfig = ENCODING_ATTACK_PATTERNS.octalEscapes;
	const octalMatcher = new RegExp(octalConfig.pattern.source, octalConfig.pattern.flags);
	let octalMatch: RegExpExecArray | null;

	while ((octalMatch = octalMatcher.exec(text)) !== null) {
		const value = octalMatch[0];
		const codePoint = parseInt(value.slice(1), 8);
		const decoded = String.fromCodePoint(codePoint);

		findings.push({
			type: octalConfig.type,
			value,
			start: octalMatch.index,
			end: octalMatch.index + value.length,
			confidence: octalConfig.confidence,
			replacement: decoded,
		});
	}

	// Check Double encoding
	const doubleConfig = ENCODING_ATTACK_PATTERNS.doubleEncoding;
	const doubleMatcher = new RegExp(doubleConfig.pattern.source, doubleConfig.pattern.flags);
	let doubleMatch: RegExpExecArray | null;

	while ((doubleMatch = doubleMatcher.exec(text)) !== null) {
		const value = doubleMatch[0];
		// Decode once to get the single-encoded form
		const decoded = decodeURIComponent(value);

		findings.push({
			type: doubleConfig.type,
			value,
			start: doubleMatch.index,
			end: doubleMatch.index + value.length,
			confidence: doubleConfig.confidence,
			replacement: decoded,
		});
	}

	return findings;
}

/**
 * Strip invisible characters from text for sanitization.
 *
 * @param text - The text to sanitize
 * @returns Text with invisible characters removed
 */
export function stripInvisibleCharacters(text: string): string {
	let result = text;

	// Remove all invisible character patterns
	for (const [, config] of Object.entries(INVISIBLE_CHAR_PATTERNS)) {
		result = result.replace(config.pattern, '');
	}

	return result;
}

const PROMPT_INJECTION_PATTERNS = [
	// Original patterns
	{
		type: 'PROMPT_INJECTION_IGNORE_INSTRUCTIONS',
		regex: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?|context)/gi,
		confidence: 0.98,
	},
	{
		type: 'PROMPT_INJECTION_SYSTEM_PROMPT',
		regex: /(?:reveal|show|print|dump)\s+(?:the\s+)?system\s+prompt/gi,
		confidence: 0.93,
	},
	{
		type: 'PROMPT_INJECTION_ROLE_OVERRIDE',
		regex: /you\s+are\s+now\s+(?:a|an)?/gi,
		confidence: 0.84,
	},
	{
		type: 'PROMPT_INJECTION_NEW_INSTRUCTIONS',
		regex: /\bnew\s+instructions?\s*:/gi,
		confidence: 0.78,
	},

	// Delimiter injection patterns (ChatML, Llama, etc.)
	{
		type: 'PROMPT_INJECTION_CHATML_DELIMITER',
		regex: /<\|(?:system|user|assistant)\|>/gi,
		confidence: 0.95,
	},
	{
		type: 'PROMPT_INJECTION_LLAMA_DELIMITER',
		regex: /\[(?:INST|\/INST)\]/g,
		confidence: 0.93,
	},
	{
		type: 'PROMPT_INJECTION_ROLE_DELIMITER',
		regex: /^(?:Human|Assistant|System|User):/gim,
		confidence: 0.88,
	},
	{
		type: 'PROMPT_INJECTION_MARKDOWN_ROLE',
		regex: /^#{1,3}\s*(?:System|User|Assistant):/gim,
		confidence: 0.9,
	},

	// Jailbreak patterns
	{
		type: 'PROMPT_INJECTION_DAN_MODE',
		regex: /\bDAN\s+mode\b|\bDo\s+Anything\s+Now\b/gi,
		confidence: 0.97,
	},
	{
		type: 'PROMPT_INJECTION_NO_RESTRICTIONS',
		regex: /pretend\s+(?:you\s+)?(?:have|had)\s+no\s+restrictions/gi,
		confidence: 0.95,
	},
	{
		type: 'PROMPT_INJECTION_ACT_AS_IF',
		regex: /act\s+as\s+if\s+you\s+(?:can|could|are|were)/gi,
		confidence: 0.85,
	},
	{
		type: 'PROMPT_INJECTION_ROLEPLAY_GAME',
		regex: /let'?s\s+play\s+a\s+game\s+where\s+you/gi,
		confidence: 0.82,
	},
	{
		type: 'PROMPT_INJECTION_HYPOTHETICAL',
		regex: /in\s+a\s+hypothetical\s+scenario\s+where/gi,
		confidence: 0.75,
	},

	// Context override patterns
	{
		type: 'PROMPT_INJECTION_DISREGARD',
		regex:
			/\b(?:disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|your)\s+(?:instructions|rules|guidelines|programming)/gi,
		confidence: 0.96,
	},
	{
		type: 'PROMPT_INJECTION_NEW_INSTRUCTIONS_ALT',
		regex: /your\s+new\s+instructions\s+are/gi,
		confidence: 0.94,
	},
	{
		type: 'PROMPT_INJECTION_FROM_NOW_ON',
		regex: /from\s+now\s+on\s+you\s+will/gi,
		confidence: 0.88,
	},
	{
		type: 'PROMPT_INJECTION_SWITCH_ROLE',
		regex: /switch\s+to\s+(?:a\s+)?(?:\w+\s+)?(?:role|persona|character|mode)/gi,
		confidence: 0.86,
	},
];

/**
 * Output injection patterns - detect LLM responses that could inject malicious
 * content into the user's next prompt or trick them into executing harmful actions.
 *
 * NOTE: These use LOWER confidence thresholds than input detection because:
 * 1. False positives on output are more disruptive (breaks valid content)
 * 2. We only warn on output injection, never sanitize or block
 * 3. Some patterns may appear in legitimate code examples or documentation
 */
const OUTPUT_INJECTION_PATTERNS = [
	// Copy-paste injection attempts
	{
		type: 'OUTPUT_INJECTION_COPY_PASTE_REQUEST',
		// Asks user to copy/paste content into their next message or prompt
		regex:
			/(?:please\s+)?(?:copy\s+(?:and\s+)?paste|paste)\s+(?:this|the\s+following|below)\s+(?:into|to)\s+(?:your\s+)?(?:next\s+)?(?:message|prompt|input|chat)/gi,
		confidence: 0.72,
		description: 'Requests user to copy content into their next prompt',
	},
	{
		type: 'OUTPUT_INJECTION_SEND_THIS_MESSAGE',
		// Direct instruction to send specific text
		regex:
			/(?:send|type|enter|submit|input)\s+(?:this|the\s+following)\s+(?:exact(?:ly)?|as\s+is|verbatim)\s*(?:message|text|prompt|:)/gi,
		confidence: 0.68,
		description: 'Instructs user to send specific text verbatim',
	},

	// Hidden instruction injection in code blocks
	{
		type: 'OUTPUT_INJECTION_CODE_BLOCK_INSTRUCTION',
		// System prompts or injection attempts hidden within code blocks
		regex:
			/```[\s\S]*?(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|system\s*:\s*you\s+are|you\s+are\s+now\s+a|reveal\s+(?:the\s+)?system\s+prompt)[\s\S]*?```/gi,
		confidence: 0.55, // Lower confidence - legitimate docs may contain examples
		description: 'Suspicious injection pattern found within code block',
	},

	// Markdown/formatting that could trick the user
	{
		type: 'OUTPUT_INJECTION_INVISIBLE_TEXT',
		// Zero-width or invisible characters used to hide text
		// eslint-disable-next-line no-misleading-character-class -- Intentionally detecting zero-width joiners for security
		regex: /[\u200B\u200C\u200D\uFEFF].*[\u200B\u200C\u200D\uFEFF]/g,
		confidence: 0.78,
		description: 'Invisible characters surrounding potentially hidden text',
	},
	{
		type: 'OUTPUT_INJECTION_TINY_TEXT',
		// HTML/markdown trying to make text very small or invisible
		regex:
			/<(?:span|div|p)\s+style\s*=\s*["'][^"']*(?:font-size\s*:\s*(?:0|1|2)px|color\s*:\s*(?:transparent|white|#fff(?:fff)?)|opacity\s*:\s*0)[^"']*["'][^>]*>/gi,
		confidence: 0.82,
		description: 'HTML attempting to hide text through styling',
	},

	// Social engineering attempts
	{
		type: 'OUTPUT_INJECTION_URGENCY_PATTERN',
		// Creates false urgency to bypass user's careful review
		regex:
			/(?:urgent(?:ly)?|immediately|quick(?:ly)?|before\s+(?:the\s+)?time\s+(?:runs?\s+out|expires?))\s*[!:].{0,50}(?:paste|copy|send|enter|run|execute)/gi,
		confidence: 0.62,
		description: 'Creates urgency to pressure user into quick action',
	},
	{
		type: 'OUTPUT_INJECTION_FAKE_SYSTEM_MESSAGE',
		// Attempts to impersonate system messages
		regex:
			/\[(?:SYSTEM|ADMIN|MODERATOR|BOT)\]\s*[:>]|\*\*\[?(?:SYSTEM|ADMIN|MODERATOR)\]?\*\*\s*:/gi,
		confidence: 0.65,
		description: 'Attempts to impersonate system or admin messages',
	},

	// Attempts to inject shell commands
	{
		type: 'OUTPUT_INJECTION_SHELL_INJECTION',
		// Suspicious shell commands that should never be blindly copy-pasted
		regex:
			/(?:^|\n)\s*(?:sudo\s+)?(?:rm\s+-rf\s+[\/~]|curl\s+.*\|\s*(?:sudo\s+)?(?:bash|sh)|wget\s+.*-O\s*-\s*\|\s*(?:bash|sh)|chmod\s+\+x\s+.*&&\s*\.\/)/gm,
		confidence: 0.75,
		description: 'Potentially dangerous shell command that could harm the system',
	},

	// Data exfiltration attempts
	{
		type: 'OUTPUT_INJECTION_DATA_REQUEST',
		// Asks user to provide sensitive data in their next message
		regex:
			/(?:provide|share|send|give|enter|input|tell\s+me)\s+(?:your|the)\s+(?:(?:api|secret|auth(?:entication)?)\s+(?:key|token)|password|credentials?|(?:credit\s+)?card\s+(?:number|details?)|ssn|social\s+security)/gi,
		confidence: 0.85,
		description: 'Attempts to solicit sensitive information from user',
	},

	// Fake completion/continuation tricks
	{
		type: 'OUTPUT_INJECTION_FAKE_COMPLETION',
		// Tries to make user think a task is complete when it requires pasting more
		regex:
			/(?:task\s+)?(?:completed?|done|finished)\s*[!.]+\s*(?:now\s+)?(?:just\s+)?(?:paste|copy|enter|send)/gi,
		confidence: 0.6,
		description: 'Fake completion message followed by request to paste',
	},

	// Attempts to establish persistent influence
	{
		type: 'OUTPUT_INJECTION_PERSISTENT_INSTRUCTION',
		// Tries to inject instructions that persist across conversations
		regex:
			/(?:always|from\s+now\s+on|in\s+(?:all\s+)?future\s+(?:conversations?|chats?|messages?)|remember\s+to\s+always)\s+(?:start|begin|include|add|prefix|append)/gi,
		confidence: 0.7,
		description: 'Attempts to establish persistent behavioral changes',
	},
];

// Structural analysis patterns for detecting prompt templates and suspicious structures
const STRUCTURAL_PATTERNS = {
	// Multiple "system" or "instruction" sections in text
	systemSections: [
		/\[(?:system|sys)\s*(?:prompt|message|instructions?)\]/gi,
		/\{(?:system|sys)\s*(?:prompt|message|instructions?)\}/gi,
		/<<\s*system\s*>>/gi,
		/\bsystem\s*:\s*\{/gi,
		/\brole\s*[:=]\s*["']?system["']?/gi,
	],

	// JSON structures that look like prompt templates
	jsonPromptTemplate: [
		// Match JSON with role/content structure typical of chat messages
		/\{\s*["']role["']\s*:\s*["'](?:system|user|assistant)["']\s*,\s*["']content["']\s*:/gi,
		// Match messages array pattern
		/["']messages["']\s*:\s*\[\s*\{/gi,
		// Match prompt field in JSON
		/["'](?:system_?prompt|instructions|system_?message)["']\s*:/gi,
	],

	// XML structures that look like prompt templates
	xmlPromptTemplate: [
		/<system(?:\s+[^>]*)?>[\s\S]*?<\/system>/gi,
		/<instructions(?:\s+[^>]*)?>[\s\S]*?<\/instructions>/gi,
		/<prompt(?:\s+[^>]*)?>[\s\S]*?<\/prompt>/gi,
		/<message\s+role\s*=\s*["']?(?:system|user|assistant)["']?/gi,
	],

	// Markdown headers mimicking system prompts
	markdownSystemHeaders: [
		/^#{1,3}\s*(?:system\s+prompt|system\s+instructions|system\s+message)\s*$/gim,
		/^#{1,3}\s*(?:instructions\s+for\s+the\s+ai|ai\s+instructions)\s*$/gim,
		/^#{1,3}\s*(?:hidden\s+instructions|secret\s+instructions)\s*$/gim,
	],

	// Base64 encoded blocks (potential hidden instructions)
	// Must be at least 20 chars of valid base64 to reduce false positives
	base64Blocks: [
		// Standalone base64 strings (at least 32 chars, likely encoded content)
		/(?:^|\s)([A-Za-z0-9+/]{32,}(?:={0,2}))(?:\s|$)/gm,
		// Explicitly marked base64 content
		/base64\s*[:=]\s*["']?([A-Za-z0-9+/]{20,}={0,2})["']?/gi,
		// Data URI with base64
		/data:[^;]+;base64,([A-Za-z0-9+/]{20,}={0,2})/gi,
	],
};

/**
 * Analyze text for structural patterns that may indicate prompt injection.
 * This function detects suspicious structural patterns like:
 * - Multiple "system" or "instruction" sections
 * - JSON/XML structures that look like prompt templates
 * - Markdown headers that mimic system prompts
 * - Base64 encoded blocks (potential hidden instructions)
 *
 * @param text - The text to analyze
 * @returns StructuralAnalysisResult with score, issues, and findings
 */
export function analyzePromptStructure(text: string): StructuralAnalysisResult {
	const issues: StructuralIssue[] = [];
	const findings: LlmGuardFinding[] = [];

	// Helper to collect matches from patterns
	const collectIssues = (
		patterns: RegExp[],
		type: StructuralIssue['type'],
		description: string,
		severity: number
	) => {
		for (const pattern of patterns) {
			const matcher = new RegExp(pattern.source, pattern.flags);
			let match: RegExpExecArray | null;

			while ((match = matcher.exec(text)) !== null) {
				const value = match[0];
				const start = match.index;
				const end = start + value.length;

				// Check for duplicate/overlapping issues
				const isDuplicate = issues.some(
					(existing) =>
						existing.type === type &&
						((start >= existing.start && start < existing.end) ||
							(end > existing.start && end <= existing.end))
				);

				if (!isDuplicate) {
					issues.push({
						type,
						description,
						severity,
						start,
						end,
						value,
					});

					findings.push({
						type: `STRUCTURAL_${type}`,
						value,
						start,
						end,
						confidence: severity,
					});
				}
			}
		}
	};

	// Detect system section patterns
	collectIssues(
		STRUCTURAL_PATTERNS.systemSections,
		'MULTIPLE_SYSTEM_SECTIONS',
		'Detected system/instruction section markers that may indicate prompt template injection',
		0.85
	);

	// Detect JSON prompt template patterns
	collectIssues(
		STRUCTURAL_PATTERNS.jsonPromptTemplate,
		'JSON_PROMPT_TEMPLATE',
		'Detected JSON structure resembling chat message format (potential prompt injection)',
		0.88
	);

	// Detect XML prompt template patterns
	collectIssues(
		STRUCTURAL_PATTERNS.xmlPromptTemplate,
		'XML_PROMPT_TEMPLATE',
		'Detected XML structure resembling prompt template format',
		0.86
	);

	// Detect markdown system headers
	collectIssues(
		STRUCTURAL_PATTERNS.markdownSystemHeaders,
		'MARKDOWN_SYSTEM_HEADER',
		'Detected markdown header mimicking system prompt section',
		0.82
	);

	// Detect base64 blocks with additional validation
	for (const pattern of STRUCTURAL_PATTERNS.base64Blocks) {
		const matcher = new RegExp(pattern.source, pattern.flags);
		let match: RegExpExecArray | null;

		while ((match = matcher.exec(text)) !== null) {
			// Get the captured group if present, otherwise the full match
			const base64Value = match[1] || match[0];
			const fullMatch = match[0];
			const start = match.index;
			const end = start + fullMatch.length;

			// Additional validation for base64:
			// - Must be valid base64 (divisible by 4 when including padding)
			// - Try to decode and check if it looks like text/instructions
			if (isLikelyEncodedInstructions(base64Value)) {
				const isDuplicate = issues.some(
					(existing) =>
						existing.type === 'BASE64_BLOCK' &&
						((start >= existing.start && start < existing.end) ||
							(end > existing.start && end <= existing.end))
				);

				if (!isDuplicate) {
					issues.push({
						type: 'BASE64_BLOCK',
						description: 'Detected base64 encoded block that may contain hidden instructions',
						severity: 0.78,
						start,
						end,
						value: fullMatch,
					});

					findings.push({
						type: 'STRUCTURAL_BASE64_BLOCK',
						value: fullMatch,
						start,
						end,
						confidence: 0.78,
					});
				}
			}
		}
	}

	// Calculate overall score based on number and severity of issues
	let score = 0;
	if (issues.length > 0) {
		// Use weighted scoring: higher severity issues contribute more
		const totalSeverity = issues.reduce((sum, issue) => sum + issue.severity, 0);
		// Normalize by number of issues but cap contribution
		const normalizedScore = Math.min(1, totalSeverity / issues.length);
		// Boost score if multiple issues found (indicates more sophisticated attack)
		const countMultiplier = Math.min(1.5, 1 + issues.length * 0.1);
		score = Math.min(1, normalizedScore * countMultiplier);

		// Additional boost for finding multiple system sections (strong signal)
		const systemSectionCount = issues.filter((i) => i.type === 'MULTIPLE_SYSTEM_SECTIONS').length;
		if (systemSectionCount >= 2) {
			score = Math.min(1, score * 1.2);
		}
	}

	return {
		score,
		issues,
		findings,
	};
}

/**
 * Check if a base64 string likely contains encoded text instructions.
 * This helps reduce false positives from legitimate base64 content like images.
 */
function isLikelyEncodedInstructions(base64: string): boolean {
	// Basic validation: must be valid base64 format
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
		return false;
	}

	// Must be reasonable length (too short = likely not instructions)
	if (base64.length < 20) {
		return false;
	}

	try {
		// Attempt to decode
		const decoded = Buffer.from(base64, 'base64').toString('utf8');

		// Check if decoded content looks like text/instructions
		// - Should contain mostly printable ASCII
		// - Should have some word-like patterns
		const printableRatio = (decoded.match(/[\x20-\x7E]/g) || []).length / decoded.length;
		const hasWords = /\b[a-zA-Z]{3,}\b/.test(decoded);
		const hasInstructionKeywords =
			/\b(?:ignore|forget|override|instructions?|system|prompt|assistant|user|role)\b/i.test(
				decoded
			);

		// High confidence if it looks like text with instruction keywords
		if (printableRatio > 0.9 && hasInstructionKeywords) {
			return true;
		}

		// Medium confidence if it's mostly readable text
		if (printableRatio > 0.85 && hasWords) {
			return true;
		}

		return false;
	} catch {
		// If decoding fails, it's not valid base64 text
		return false;
	}
}

/**
 * Check text for banned substrings and banned topic patterns.
 * This allows users to define custom blocklists for specific content.
 *
 * @param text - The text to check
 * @param config - LlmGuardConfig containing banSubstrings and banTopicsPatterns
 * @returns Array of findings for detected banned content
 */
export function checkBannedContent(text: string, config: LlmGuardConfig): LlmGuardFinding[] {
	const findings: LlmGuardFinding[] = [];
	const lowerText = text.toLowerCase();

	// Check for banned substrings (exact match, case-insensitive)
	if (config.banSubstrings && config.banSubstrings.length > 0) {
		for (const substring of config.banSubstrings) {
			if (!substring || substring.trim() === '') continue;

			const lowerSubstring = substring.toLowerCase();
			let searchStart = 0;

			// Find all occurrences of the substring
			while (searchStart < lowerText.length) {
				const index = lowerText.indexOf(lowerSubstring, searchStart);
				if (index === -1) break;

				findings.push({
					type: 'BANNED_SUBSTRING',
					value: text.substring(index, index + substring.length),
					start: index,
					end: index + substring.length,
					confidence: 1.0, // Exact match = 100% confidence
				});

				searchStart = index + 1;
			}
		}
	}

	// Check for banned topic patterns (regex, case-insensitive)
	if (config.banTopicsPatterns && config.banTopicsPatterns.length > 0) {
		for (const pattern of config.banTopicsPatterns) {
			if (!pattern || pattern.trim() === '') continue;

			try {
				// Create case-insensitive regex from the pattern
				const regex = new RegExp(pattern, 'gi');
				let match: RegExpExecArray | null;

				while ((match = regex.exec(text)) !== null) {
					// Avoid infinite loops on zero-length matches
					if (match[0].length === 0) {
						regex.lastIndex++;
						continue;
					}

					findings.push({
						type: 'BANNED_TOPIC',
						value: match[0],
						start: match.index,
						end: match.index + match[0].length,
						confidence: 0.95, // Regex match has slightly lower confidence than exact
					});
				}
			} catch {
				// Invalid regex pattern - skip it silently
				// (could log a warning in production)
			}
		}
	}

	return findings;
}

/**
 * Detect output injection patterns in LLM responses.
 * These patterns identify attempts by the LLM to:
 * - Trick users into copy-pasting malicious content
 * - Hide instructions in code blocks or invisible text
 * - Social engineer users into harmful actions
 * - Exfiltrate sensitive data
 * - Establish persistent influence across conversations
 *
 * NOTE: This function only WARNS, never sanitizes output, because:
 * 1. Sanitizing output could break legitimate code examples
 * 2. False positives on output are more disruptive to user experience
 * 3. Users should be alerted but allowed to review the content
 *
 * @param text - The LLM response text to analyze
 * @returns OutputInjectionResult with findings and detection status
 */
export function detectOutputInjection(text: string): OutputInjectionResult {
	const findings: LlmGuardFinding[] = [];

	for (const pattern of OUTPUT_INJECTION_PATTERNS) {
		const matcher = new RegExp(pattern.regex.source, pattern.regex.flags);
		let match: RegExpExecArray | null;

		while ((match = matcher.exec(text)) !== null) {
			const value = match[0];

			// Skip empty matches to prevent infinite loops
			if (value.length === 0) {
				matcher.lastIndex++;
				continue;
			}

			findings.push({
				type: pattern.type,
				value,
				start: match.index,
				end: match.index + value.length,
				confidence: pattern.confidence,
			});
		}
	}

	// Calculate highest confidence from all findings
	const highestConfidence = findings.reduce((max, finding) => Math.max(max, finding.confidence), 0);

	return {
		findings,
		hasInjection: findings.length > 0,
		highestConfidence,
	};
}

export const DEFAULT_LLM_GUARD_CONFIG: LlmGuardConfig = {
	enabled: false,
	action: 'sanitize',
	input: {
		anonymizePii: true,
		redactSecrets: true,
		detectPromptInjection: true,
		structuralAnalysis: true,
		invisibleCharacterDetection: true,
		scanUrls: true,
	},
	output: {
		deanonymizePii: true,
		redactSecrets: true,
		detectPiiLeakage: true,
		detectOutputInjection: true,
		scanUrls: true,
	},
	thresholds: {
		promptInjection: 0.7,
	},
};

export function normalizeLlmGuardConfig(config?: Partial<LlmGuardConfig> | null): LlmGuardConfig {
	return {
		...DEFAULT_LLM_GUARD_CONFIG,
		...config,
		input: {
			...DEFAULT_LLM_GUARD_CONFIG.input,
			...(config?.input || {}),
		},
		output: {
			...DEFAULT_LLM_GUARD_CONFIG.output,
			...(config?.output || {}),
		},
		thresholds: {
			...DEFAULT_LLM_GUARD_CONFIG.thresholds,
			...(config?.thresholds || {}),
		},
	};
}

/**
 * Merge a session-level security policy with the global LLM Guard configuration.
 * Session policy values override global settings where specified.
 *
 * This enables per-session security customization:
 * - More strict settings for sensitive projects
 * - Relaxed settings for internal/test projects
 * - Different ban lists per project
 *
 * @param globalConfig - The global LLM Guard configuration from settings
 * @param sessionPolicy - Optional session-level policy overrides
 * @returns Merged configuration with session overrides applied
 */
export function mergeSecurityPolicy(
	globalConfig: Partial<LlmGuardConfig> | null | undefined,
	sessionPolicy: Partial<LlmGuardConfig> | null | undefined
): LlmGuardConfig {
	// Start with normalized global config
	const normalized = normalizeLlmGuardConfig(globalConfig);

	// If no session policy, return normalized global config
	if (!sessionPolicy) {
		return normalized;
	}

	// Deep merge session policy over global config
	// Session policy values take precedence where specified
	return {
		...normalized,
		// Override top-level settings if explicitly set in session policy
		...(sessionPolicy.enabled !== undefined && { enabled: sessionPolicy.enabled }),
		...(sessionPolicy.action !== undefined && { action: sessionPolicy.action }),
		// Deep merge input settings
		input: {
			...normalized.input,
			...(sessionPolicy.input || {}),
		},
		// Deep merge output settings
		output: {
			...normalized.output,
			...(sessionPolicy.output || {}),
		},
		// Deep merge thresholds
		thresholds: {
			...normalized.thresholds,
			...(sessionPolicy.thresholds || {}),
		},
		// Merge ban lists - session lists are additive to global lists
		banSubstrings: mergeArrays(normalized.banSubstrings, sessionPolicy.banSubstrings),
		banTopicsPatterns: mergeArrays(normalized.banTopicsPatterns, sessionPolicy.banTopicsPatterns),
		// Merge custom patterns - session patterns are added to global patterns
		customPatterns: mergeCustomPatterns(normalized.customPatterns, sessionPolicy.customPatterns),
	};
}

/**
 * Helper to merge string arrays, removing duplicates.
 * Session values are added to global values.
 */
function mergeArrays(
	globalArray: string[] | undefined,
	sessionArray: string[] | undefined
): string[] | undefined {
	if (!sessionArray || sessionArray.length === 0) {
		return globalArray;
	}
	if (!globalArray || globalArray.length === 0) {
		return sessionArray;
	}
	// Combine and deduplicate
	return [...new Set([...globalArray, ...sessionArray])];
}

/**
 * Helper to merge custom patterns arrays.
 * Session patterns with same ID override global patterns.
 * Session patterns with new IDs are added.
 */
function mergeCustomPatterns(
	globalPatterns: CustomPattern[] | undefined,
	sessionPatterns: CustomPattern[] | undefined
): CustomPattern[] | undefined {
	if (!sessionPatterns || sessionPatterns.length === 0) {
		return globalPatterns;
	}
	if (!globalPatterns || globalPatterns.length === 0) {
		return sessionPatterns;
	}

	// Create a map of global patterns by ID
	const patternMap = new Map<string, CustomPattern>();
	for (const pattern of globalPatterns) {
		patternMap.set(pattern.id, pattern);
	}

	// Override or add session patterns
	for (const pattern of sessionPatterns) {
		patternMap.set(pattern.id, pattern);
	}

	return Array.from(patternMap.values());
}

export function runLlmGuardPre(
	prompt: string,
	config?: Partial<LlmGuardConfig> | null
): LlmGuardPreResult {
	const effectiveConfig = normalizeLlmGuardConfig(config);
	if (!effectiveConfig.enabled) {
		return {
			sanitizedPrompt: prompt,
			vault: { entries: [] },
			findings: [],
			blocked: false,
			warned: false,
		};
	}

	let sanitizedPrompt = prompt;
	const findings: LlmGuardFinding[] = [];

	// Step 1: Detect invisible characters FIRST (before any other processing)
	// This catches zero-width characters, RTL overrides, homoglyphs, etc.
	const invisibleCharDetectionEnabled = effectiveConfig.input.invisibleCharacterDetection !== false;
	if (invisibleCharDetectionEnabled) {
		const invisibleCharFindings = detectInvisibleCharacters(sanitizedPrompt);
		findings.push(...invisibleCharFindings);

		// Also detect encoding attacks (HTML entities, URL encoding, Unicode escapes, etc.)
		const encodingAttackFindings = detectEncodingAttacks(sanitizedPrompt);
		findings.push(...encodingAttackFindings);

		// Optionally strip invisible characters from the prompt for sanitization
		// This is done in 'sanitize' mode to clean up the prompt
		if (effectiveConfig.action === 'sanitize' && invisibleCharFindings.length > 0) {
			sanitizedPrompt = stripInvisibleCharacters(sanitizedPrompt);
		}
	}

	// Step 2: Check for banned content (substrings and topic patterns)
	const bannedContentFindings = checkBannedContent(sanitizedPrompt, effectiveConfig);
	findings.push(...bannedContentFindings);

	// Step 3: Redact secrets
	if (effectiveConfig.input.redactSecrets) {
		const secretScan = redactSecrets(sanitizedPrompt);
		sanitizedPrompt = secretScan.text;
		findings.push(...secretScan.findings);
	}

	// Step 3.5: Scan URLs for potentially malicious patterns
	// Must run BEFORE PII anonymization so IP addresses in URLs are detected
	if (effectiveConfig.input.scanUrls !== false) {
		const urlFindings = scanUrls(sanitizedPrompt);
		findings.push(...urlFindings);
	}

	// Step 3.6: Apply custom patterns
	if (effectiveConfig.customPatterns && effectiveConfig.customPatterns.length > 0) {
		const customFindings = applyCustomPatterns(sanitizedPrompt, effectiveConfig.customPatterns);
		findings.push(...customFindings);

		// Sanitize matches if in sanitize mode
		if (effectiveConfig.action === 'sanitize') {
			sanitizedPrompt = sanitizeCustomPatternMatches(sanitizedPrompt, customFindings);
		}
	}

	// Step 4: Anonymize PII
	const vault = new PiiVault();
	if (effectiveConfig.input.anonymizePii) {
		const piiScan = anonymizePii(sanitizedPrompt, vault);
		sanitizedPrompt = piiScan.text;
		findings.push(...piiScan.findings);
	}

	let blocked = false;
	let blockReason: string | undefined;
	let warned = false;
	let warningReason: string | undefined;

	// Step 5: Detect prompt injection patterns
	if (effectiveConfig.input.detectPromptInjection) {
		// Run prompt injection detection on the sanitized prompt so that
		// start/end positions are consistent with the returned sanitizedPrompt.
		const promptInjectionFindings = detectPromptInjection(sanitizedPrompt);
		findings.push(...promptInjectionFindings);

		// Step 6: Run structural analysis (if enabled)
		const structuralAnalysisEnabled = effectiveConfig.input.structuralAnalysis !== false;
		if (structuralAnalysisEnabled) {
			const structuralResult = analyzePromptStructure(sanitizedPrompt);
			findings.push(...structuralResult.findings);
		}

		// Calculate highest injection score from prompt injection findings
		// Note: BANNED_ findings are NOT included here - they're handled separately below
		const injectionRelatedTypes = ['PROMPT_INJECTION_', 'STRUCTURAL_', 'INVISIBLE_', 'ENCODING_'];
		const injectionFindings = findings.filter((f) =>
			injectionRelatedTypes.some((prefix) => f.type.startsWith(prefix))
		);

		// Calculate combined score: use max confidence, but boost if multiple types detected
		let highestScore = injectionFindings.reduce(
			(maxScore, finding) => Math.max(maxScore, finding.confidence),
			0
		);

		// Boost score slightly if multiple different attack types detected
		const uniqueAttackCategories = new Set(
			injectionFindings.map((f) => {
				for (const prefix of injectionRelatedTypes) {
					if (f.type.startsWith(prefix)) return prefix;
				}
				return 'OTHER';
			})
		);
		if (uniqueAttackCategories.size >= 2) {
			// Boost by 5% for each additional attack category (up to 15%)
			const boost = Math.min(0.15, (uniqueAttackCategories.size - 1) * 0.05);
			highestScore = Math.min(1, highestScore + boost);
		}

		if (highestScore >= effectiveConfig.thresholds.promptInjection) {
			if (effectiveConfig.action === 'block') {
				blocked = true;
				blockReason = 'Prompt blocked by LLM Guard due to prompt injection signals.';
			} else if (effectiveConfig.action === 'warn') {
				warned = true;
				warningReason = 'Prompt contains potential prompt injection signals.';
			}
		}
	}

	// Check if banned content should trigger block/warn
	if (!blocked && bannedContentFindings.length > 0) {
		if (effectiveConfig.action === 'block') {
			blocked = true;
			blockReason = 'Prompt blocked by LLM Guard due to banned content.';
		} else if (effectiveConfig.action === 'warn' && !warned) {
			warned = true;
			warningReason = 'Prompt contains banned content.';
		}
	}

	// Check if custom patterns with block action should trigger block/warn
	const customBlockingFindings = findings.filter((f) => {
		if (!f.type.startsWith('CUSTOM_')) return false;
		// Check if the pattern that matched has 'block' action
		const pattern = effectiveConfig.customPatterns?.find(
			(p) => (f as { patternId?: string }).patternId === p.id
		);
		return pattern?.action === 'block';
	});

	if (!blocked && customBlockingFindings.length > 0) {
		blocked = true;
		blockReason = 'Prompt blocked by LLM Guard due to custom pattern match.';
	}

	// Check if custom patterns with warn action should trigger warning
	const customWarningFindings = findings.filter((f) => {
		if (!f.type.startsWith('CUSTOM_')) return false;
		const pattern = effectiveConfig.customPatterns?.find(
			(p) => (f as { patternId?: string }).patternId === p.id
		);
		return pattern?.action === 'warn';
	});

	if (!warned && customWarningFindings.length > 0) {
		warned = true;
		warningReason = 'Prompt contains matches for custom security patterns.';
	}

	// For 'warn' mode, also set warning when PII or secrets were sanitized
	if (effectiveConfig.action === 'warn' && findings.length > 0 && !warned) {
		const hasSecretOrPii = findings.some(
			(finding) => finding.type.startsWith('SECRET_') || finding.type.startsWith('PII_')
		);
		if (hasSecretOrPii) {
			warned = true;
			warningReason = 'Prompt contained sensitive data that was sanitized.';
		}
	}

	return {
		sanitizedPrompt,
		vault: vault.toJSON(),
		findings,
		blocked,
		blockReason,
		warned,
		warningReason,
	};
}

export function runLlmGuardPost(
	response: string,
	vault: LlmGuardVaultSnapshot | undefined,
	config?: Partial<LlmGuardConfig> | null
): LlmGuardPostResult {
	const effectiveConfig = normalizeLlmGuardConfig(config);
	if (!effectiveConfig.enabled) {
		return {
			sanitizedResponse: response,
			findings: [],
			blocked: false,
			warned: false,
		};
	}

	let sanitizedResponse = effectiveConfig.output.deanonymizePii
		? PiiVault.deanonymize(response, vault)
		: response;
	const findings: LlmGuardFinding[] = [];

	if (effectiveConfig.output.redactSecrets) {
		const secretScan = redactSecrets(sanitizedResponse);
		sanitizedResponse = secretScan.text;
		findings.push(...secretScan.findings);
	}

	if (effectiveConfig.output.detectPiiLeakage) {
		const piiLeakageFindings = detectPiiLeakage(sanitizedResponse, vault);
		findings.push(...piiLeakageFindings);
	}

	// Scan output for malicious URLs
	if (effectiveConfig.output.scanUrls !== false) {
		const urlFindings = scanUrls(sanitizedResponse);
		findings.push(...urlFindings);
	}

	// Apply custom patterns to output
	if (effectiveConfig.customPatterns && effectiveConfig.customPatterns.length > 0) {
		const customFindings = applyCustomPatterns(sanitizedResponse, effectiveConfig.customPatterns);
		findings.push(...customFindings);

		// Sanitize matches if in sanitize mode
		if (effectiveConfig.action === 'sanitize') {
			sanitizedResponse = sanitizeCustomPatternMatches(sanitizedResponse, customFindings);
		}
	}

	// Scan output for dangerous code patterns (always warn, never block or sanitize)
	let hasDangerousCode = false;
	if (effectiveConfig.output.scanCode !== false) {
		const codeFindings = scanCode(sanitizedResponse);
		findings.push(...codeFindings);
		hasDangerousCode = codeFindings.length > 0;
	}

	// Detect output injection patterns (always warn, never block or sanitize)
	let hasOutputInjection = false;
	if (effectiveConfig.output.detectOutputInjection !== false) {
		const outputInjectionResult = detectOutputInjection(sanitizedResponse);
		findings.push(...outputInjectionResult.findings);
		hasOutputInjection = outputInjectionResult.hasInjection;
	}

	const hasSensitiveContent = findings.some(
		(finding) => finding.type.startsWith('SECRET_') || finding.type.startsWith('PII_')
	);

	const hasMaliciousUrl = findings.some((finding) => finding.type === 'MALICIOUS_URL');

	// Check for custom patterns that should block
	const hasCustomBlockPattern = findings.some((f) => {
		if (!f.type.startsWith('CUSTOM_')) return false;
		const pattern = effectiveConfig.customPatterns?.find(
			(p) => (f as { patternId?: string }).patternId === p.id
		);
		return pattern?.action === 'block';
	});

	const hasCustomWarningPattern = findings.some((f) => {
		if (!f.type.startsWith('CUSTOM_')) return false;
		const pattern = effectiveConfig.customPatterns?.find(
			(p) => (f as { patternId?: string }).patternId === p.id
		);
		return pattern?.action === 'warn';
	});

	const blocked =
		(effectiveConfig.action === 'block' && hasSensitiveContent) || hasCustomBlockPattern;
	// Warn if: (1) sensitive content in warn mode OR (2) output injection detected OR (3) malicious URL detected OR (4) dangerous code detected OR (5) custom warning pattern
	// Note: Output injection, malicious URLs, and dangerous code only warn, never block (per design)
	const warned =
		(effectiveConfig.action === 'warn' && hasSensitiveContent) ||
		hasOutputInjection ||
		hasMaliciousUrl ||
		hasDangerousCode ||
		hasCustomWarningPattern;

	// Build warning reason
	let warningReason: string | undefined;
	if (warned) {
		const reasons: string[] = [];
		if (hasSensitiveContent) {
			reasons.push('sensitive data that was sanitized');
		}
		if (hasOutputInjection) {
			reasons.push('potential output injection patterns');
		}
		if (hasMaliciousUrl) {
			reasons.push('potentially malicious URLs');
		}
		if (hasDangerousCode) {
			reasons.push('potentially dangerous code patterns');
		}
		if (hasCustomWarningPattern) {
			reasons.push('custom pattern matches');
		}
		warningReason = `Response contained ${reasons.join(' and ')}.`;
	}

	// Update block reason if custom pattern blocked
	const blockReason = hasCustomBlockPattern
		? 'Response blocked by LLM Guard due to custom pattern match.'
		: blocked
			? 'Response blocked by LLM Guard due to sensitive content.'
			: undefined;

	return {
		sanitizedResponse,
		findings,
		blocked,
		blockReason,
		warned,
		warningReason,
	};
}

/**
 * Run LLM Guard inter-agent protection for Group Chat.
 * This function is called when one agent's output is being passed as input to another agent.
 * It applies both output scanning (on the source agent's response) and input scanning
 * (as the target agent's input) to detect and prevent prompt injection "chains".
 *
 * @param message - The message being passed from source agent to target agent
 * @param sourceAgent - Name of the agent whose output is being scanned
 * @param targetAgent - Name of the agent who will receive the message
 * @param config - Optional LLM Guard configuration
 * @returns LlmGuardInterAgentResult with sanitized message and findings
 */
export function runLlmGuardInterAgent(
	message: string,
	sourceAgent: string,
	targetAgent: string,
	config?: Partial<LlmGuardConfig> | null
): LlmGuardInterAgentResult {
	const effectiveConfig = normalizeLlmGuardConfig(config);

	// Check if inter-agent scanning is disabled
	if (!effectiveConfig.enabled || effectiveConfig.groupChat?.interAgentScanEnabled === false) {
		return {
			sanitizedMessage: message,
			findings: [],
			blocked: false,
			warned: false,
			sourceAgent,
			targetAgent,
		};
	}

	let sanitizedMessage = message;
	const findings: LlmGuardFinding[] = [];

	// Step 1: Apply output scanning (source agent's response)
	// This detects output injection patterns, dangerous code, malicious URLs
	if (effectiveConfig.output.detectOutputInjection !== false) {
		const outputInjectionResult = detectOutputInjection(sanitizedMessage);
		// Add INTER_AGENT_ prefix to distinguish from regular output findings
		for (const finding of outputInjectionResult.findings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}
	}

	if (effectiveConfig.output.scanCode !== false) {
		const codeFindings = scanCode(sanitizedMessage);
		for (const finding of codeFindings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}
	}

	if (effectiveConfig.output.scanUrls !== false) {
		const urlFindings = scanUrls(sanitizedMessage);
		for (const finding of urlFindings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}
	}

	// Step 2: Apply input scanning (target agent's perspective)
	// Detect prompt injection attempts in the message
	if (effectiveConfig.input.detectPromptInjection) {
		const promptInjectionFindings = detectPromptInjection(sanitizedMessage);
		for (const finding of promptInjectionFindings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}

		// Structural analysis
		if (effectiveConfig.input.structuralAnalysis !== false) {
			const structuralResult = analyzePromptStructure(sanitizedMessage);
			for (const finding of structuralResult.findings) {
				findings.push({
					...finding,
					type: `INTER_AGENT_${finding.type}`,
				});
			}
		}
	}

	// Step 3: Detect invisible characters and encoding attacks
	if (effectiveConfig.input.invisibleCharacterDetection !== false) {
		const invisibleCharFindings = detectInvisibleCharacters(sanitizedMessage);
		for (const finding of invisibleCharFindings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}

		const encodingAttackFindings = detectEncodingAttacks(sanitizedMessage);
		for (const finding of encodingAttackFindings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}

		// Strip invisible characters in sanitize mode
		if (effectiveConfig.action === 'sanitize' && invisibleCharFindings.length > 0) {
			sanitizedMessage = stripInvisibleCharacters(sanitizedMessage);
		}
	}

	// Step 4: Check for banned content
	const bannedContentFindings = checkBannedContent(sanitizedMessage, effectiveConfig);
	for (const finding of bannedContentFindings) {
		findings.push({
			...finding,
			type: `INTER_AGENT_${finding.type}`,
		});
	}

	// Step 5: Redact secrets (don't let secrets propagate between agents)
	if (effectiveConfig.input.redactSecrets) {
		const secretScan = redactSecrets(sanitizedMessage);
		sanitizedMessage = secretScan.text;
		for (const finding of secretScan.findings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}
	}

	// Step 6: Apply custom patterns
	if (effectiveConfig.customPatterns && effectiveConfig.customPatterns.length > 0) {
		const customFindings = applyCustomPatterns(sanitizedMessage, effectiveConfig.customPatterns);
		for (const finding of customFindings) {
			findings.push({
				...finding,
				type: `INTER_AGENT_${finding.type}`,
			});
		}

		if (effectiveConfig.action === 'sanitize') {
			sanitizedMessage = sanitizeCustomPatternMatches(sanitizedMessage, customFindings);
		}
	}

	// Determine block/warn status based on findings
	let blocked = false;
	let blockReason: string | undefined;
	let warned = false;
	let warningReason: string | undefined;

	// Calculate injection-related score
	const injectionRelatedPrefixes = [
		'INTER_AGENT_PROMPT_INJECTION_',
		'INTER_AGENT_STRUCTURAL_',
		'INTER_AGENT_INVISIBLE_',
		'INTER_AGENT_ENCODING_',
		'INTER_AGENT_OUTPUT_INJECTION_',
	];
	const injectionFindings = findings.filter((f) =>
		injectionRelatedPrefixes.some((prefix) => f.type.startsWith(prefix))
	);

	let highestScore = injectionFindings.reduce(
		(maxScore, finding) => Math.max(maxScore, finding.confidence),
		0
	);

	// Boost score if multiple attack categories detected
	const uniqueCategories = new Set(
		injectionFindings.map((f) => {
			for (const prefix of injectionRelatedPrefixes) {
				if (f.type.startsWith(prefix)) return prefix;
			}
			return 'OTHER';
		})
	);
	if (uniqueCategories.size >= 2) {
		const boost = Math.min(0.15, (uniqueCategories.size - 1) * 0.05);
		highestScore = Math.min(1, highestScore + boost);
	}

	// Check threshold
	if (highestScore >= effectiveConfig.thresholds.promptInjection) {
		if (effectiveConfig.action === 'block') {
			blocked = true;
			blockReason = `Inter-agent message blocked: potential prompt injection detected (from ${sourceAgent} to ${targetAgent}).`;
		} else if (effectiveConfig.action === 'warn') {
			warned = true;
			warningReason = `Inter-agent message warning: potential prompt injection signals (from ${sourceAgent} to ${targetAgent}).`;
		}
	}

	// Check banned content
	if (!blocked && bannedContentFindings.length > 0) {
		if (effectiveConfig.action === 'block') {
			blocked = true;
			blockReason = `Inter-agent message blocked: contains banned content (from ${sourceAgent} to ${targetAgent}).`;
		} else if (effectiveConfig.action === 'warn' && !warned) {
			warned = true;
			warningReason = `Inter-agent message warning: contains banned content (from ${sourceAgent} to ${targetAgent}).`;
		}
	}

	// Check custom blocking patterns
	const customBlockingFindings = findings.filter((f) => {
		if (!f.type.startsWith('INTER_AGENT_CUSTOM_')) return false;
		const pattern = effectiveConfig.customPatterns?.find(
			(p) => (f as { patternId?: string }).patternId === p.id
		);
		return pattern?.action === 'block';
	});

	if (!blocked && customBlockingFindings.length > 0) {
		blocked = true;
		blockReason = `Inter-agent message blocked: custom pattern match (from ${sourceAgent} to ${targetAgent}).`;
	}

	// Check custom warning patterns
	const customWarningFindings = findings.filter((f) => {
		if (!f.type.startsWith('INTER_AGENT_CUSTOM_')) return false;
		const pattern = effectiveConfig.customPatterns?.find(
			(p) => (f as { patternId?: string }).patternId === p.id
		);
		return pattern?.action === 'warn';
	});

	if (!warned && customWarningFindings.length > 0) {
		warned = true;
		warningReason = `Inter-agent message warning: custom pattern match (from ${sourceAgent} to ${targetAgent}).`;
	}

	// Always warn on dangerous code patterns (never block for code)
	const hasDangerousCode = findings.some((f) => f.type.startsWith('INTER_AGENT_DANGEROUS_CODE'));
	if (hasDangerousCode && !warned) {
		warned = true;
		warningReason = `Inter-agent message warning: contains potentially dangerous code patterns (from ${sourceAgent} to ${targetAgent}).`;
	}

	// Warn on malicious URLs
	const hasMaliciousUrl = findings.some((f) => f.type === 'INTER_AGENT_MALICIOUS_URL');
	if (hasMaliciousUrl && !warned) {
		warned = true;
		warningReason = `Inter-agent message warning: contains potentially malicious URLs (from ${sourceAgent} to ${targetAgent}).`;
	}

	return {
		sanitizedMessage,
		findings,
		blocked,
		blockReason,
		warned,
		warningReason,
		sourceAgent,
		targetAgent,
	};
}

function collectMatches(
	regex: RegExp,
	text: string,
	type: string,
	confidence: number
): LlmGuardFinding[] {
	const findings: LlmGuardFinding[] = [];
	const matcher = new RegExp(regex.source, regex.flags);
	let match: RegExpExecArray | null;

	while ((match = matcher.exec(text)) !== null) {
		const value = match[0];
		findings.push({
			type,
			value,
			start: match.index,
			end: match.index + value.length,
			confidence,
		});
	}

	return findings;
}

function applyReplacements(
	text: string,
	findings: LlmGuardFinding[],
	replacementBuilder: (finding: LlmGuardFinding, index: number) => string
): { text: string; findings: LlmGuardFinding[] } {
	// Sort by start position descending to process from end to beginning.
	// This ensures earlier positions remain valid after replacements.
	const sortedFindings = [...findings].sort((a, b) => b.start - a.start);

	// Filter out overlapping findings: keep the first (rightmost) finding
	// when multiple findings overlap the same region.
	const nonOverlapping: LlmGuardFinding[] = [];
	let lastStart = Infinity;

	for (const finding of sortedFindings) {
		// If this finding ends after where the last accepted finding starts,
		// it overlaps—skip it.
		if (finding.end > lastStart) {
			continue;
		}
		nonOverlapping.push(finding);
		lastStart = finding.start;
	}

	let nextText = text;
	const appliedFindings: LlmGuardFinding[] = [];

	nonOverlapping.forEach((finding, reverseIndex) => {
		const index = nonOverlapping.length - reverseIndex;
		const replacement = replacementBuilder(finding, index);
		nextText = nextText.slice(0, finding.start) + replacement + nextText.slice(finding.end);
		appliedFindings.push({ ...finding, replacement });
	});

	return {
		text: nextText,
		findings: appliedFindings.sort((a, b) => a.start - b.start),
	};
}

function redactSecrets(text: string): { text: string; findings: LlmGuardFinding[] } {
	// First, collect all pattern-based findings
	const patternFindings = SECRET_PATTERNS.flatMap((pattern) =>
		collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
	);

	// Then collect high-entropy findings
	const entropyFindings = detectHighEntropyStrings(text);

	// Filter out entropy findings that overlap with pattern findings
	// (pattern-based detection is more specific and should take precedence)
	const filteredEntropyFindings = entropyFindings.filter((entropyFinding) => {
		return !patternFindings.some(
			(patternFinding) =>
				(entropyFinding.start >= patternFinding.start &&
					entropyFinding.start < patternFinding.end) ||
				(entropyFinding.end > patternFinding.start && entropyFinding.end <= patternFinding.end) ||
				(entropyFinding.start <= patternFinding.start && entropyFinding.end >= patternFinding.end)
		);
	});

	const findings = [...patternFindings, ...filteredEntropyFindings];

	if (!findings.length) {
		return { text, findings: [] };
	}

	return applyReplacements(
		text,
		findings,
		(finding, index) => `[REDACTED_${finding.type}_${index}]`
	);
}

function anonymizePii(
	text: string,
	vault: PiiVault
): { text: string; findings: LlmGuardFinding[] } {
	const findings = PII_PATTERNS.flatMap((pattern) =>
		collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
	).filter((finding) => {
		if (finding.type !== 'PII_CREDIT_CARD') return true;
		return passesLuhnCheck(finding.value.replace(/[ -]/g, ''));
	});

	if (!findings.length) {
		return { text, findings: [] };
	}

	return applyReplacements(text, findings, (finding, index) => {
		const placeholder = `[${finding.type.replace('PII_', '')}_${index}]`;
		vault.add({
			placeholder,
			original: finding.value,
			type: finding.type,
		});
		return placeholder;
	});
}

function detectPromptInjection(text: string): LlmGuardFinding[] {
	return PROMPT_INJECTION_PATTERNS.flatMap((pattern) =>
		collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
	);
}

function detectPiiLeakage(text: string, vault?: LlmGuardVaultSnapshot): LlmGuardFinding[] {
	const allowedValues = new Set((vault?.entries || []).map((entry) => entry.original));
	return PII_PATTERNS.flatMap((pattern) =>
		collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
	)
		.filter((finding) => {
			// Apply Luhn check for credit cards
			if (finding.type === 'PII_CREDIT_CARD') {
				return passesLuhnCheck(finding.value.replace(/[ -]/g, ''));
			}
			return true;
		})
		.filter((finding) => !allowedValues.has(finding.value));
}

function passesLuhnCheck(value: string): boolean {
	if (!/^\d{13,19}$/.test(value)) return false;

	let sum = 0;
	let shouldDouble = false;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		let digit = Number(value[index]);
		if (shouldDouble) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		shouldDouble = !shouldDouble;
	}

	return sum % 10 === 0;
}

/**
 * Result of lightweight input scanning for real-time preview.
 * Used to show visual indicators of sensitive content in the input area.
 */
export interface InputScanPreviewResult {
	/** Detected findings with positions for UI highlighting */
	findings: LlmGuardFinding[];
	/** Time taken to scan in milliseconds */
	scanDurationMs: number;
}

/**
 * Lightweight input scanning for real-time preview in the input area.
 * Scans for PII and secrets only (skips URL/code/injection analysis for performance).
 * Used to show visual pill indicators of what will be anonymized before sending.
 *
 * @param text - The input text to scan
 * @param config - Optional LLM Guard config (uses defaults if not provided)
 * @returns Findings with positions suitable for UI highlighting
 */
export function scanInputForPreview(
	text: string,
	config?: Partial<LlmGuardConfig> | null
): InputScanPreviewResult {
	const startTime = performance.now();

	// Skip scanning for very short inputs
	if (!text || text.length < 3) {
		return { findings: [], scanDurationMs: 0 };
	}

	const normalizedConfig = normalizeLlmGuardConfig(config);
	const findings: LlmGuardFinding[] = [];

	// Scan for PII (emails, phones, IPs, SSNs, credit cards)
	if (normalizedConfig.input.anonymizePii) {
		const piiFindings = PII_PATTERNS.flatMap((pattern) =>
			collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
		).filter((finding) => {
			// Apply Luhn check for credit cards
			if (finding.type === 'PII_CREDIT_CARD') {
				return passesLuhnCheck(finding.value.replace(/[ -]/g, ''));
			}
			return true;
		});
		findings.push(...piiFindings);
	}

	// Scan for secrets (API keys, tokens, etc.)
	if (normalizedConfig.input.redactSecrets) {
		const secretFindings = SECRET_PATTERNS.flatMap((pattern) =>
			collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
		);
		findings.push(...secretFindings);
	}

	// Apply custom patterns if defined
	if (normalizedConfig.customPatterns?.length) {
		const customFindings = applyCustomPatterns(text, normalizedConfig.customPatterns);
		findings.push(...customFindings);
	}

	// Sort findings by start position for consistent rendering
	findings.sort((a, b) => a.start - b.start);

	// Remove overlapping findings (keep higher confidence)
	const dedupedFindings = findings.filter((finding, index) => {
		for (let i = 0; i < index; i++) {
			const prev = findings[i];
			// Check for overlap
			if (finding.start < prev.end && finding.end > prev.start) {
				// Keep higher confidence finding
				return finding.confidence > prev.confidence;
			}
		}
		return true;
	});

	const scanDurationMs = performance.now() - startTime;

	return {
		findings: dedupedFindings,
		scanDurationMs,
	};
}

export { scanUrls, scanUrlsDetailed } from './url-scanner';
export type { UrlFinding } from './url-scanner';

export { scanCode, scanCodeDetailed, containsDangerousCode } from './code-scanner';
export type { CodeFinding } from './code-scanner';

export {
	applyCustomPatterns,
	sanitizeCustomPatternMatches,
	validatePattern,
	testPattern,
	generatePatternId,
	createDefaultPattern,
	exportPatterns,
	importPatterns,
} from './custom-patterns';
export type {
	PatternValidationResult,
	PatternTestResult,
	CustomPatternFinding,
} from './custom-patterns';

export type {
	CustomPattern,
	CustomPatternType,
	LlmGuardConfig,
	LlmGuardFinding,
	LlmGuardInterAgentResult,
	LlmGuardPostResult,
	LlmGuardPreResult,
	LlmGuardState,
	LlmGuardVaultSnapshot,
	OutputInjectionResult,
	StructuralAnalysisResult,
	StructuralIssue,
} from './types';
