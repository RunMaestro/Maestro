/**
 * FindingDetails
 *
 * Component for displaying detailed information about LLM Guard security findings.
 * Used as a popover/panel when clicking on security badges or indicators.
 *
 * Features:
 * - Display list of findings with type, confidence, values
 * - Copy finding to clipboard
 * - Link to documentation for finding types
 * - Partially masked display for secrets
 * - Position information
 */

import React, { memo, useCallback, useState } from 'react';
import {
	Shield,
	ShieldAlert,
	ShieldX,
	ShieldCheck,
	Copy,
	Check,
	ExternalLink,
	AlertTriangle,
	Key,
	Mail,
	Phone,
	CreditCard,
	Hash,
	Lock,
	User,
	FileText,
	ChevronDown,
	ChevronRight,
	Globe,
	MapPin,
	Fingerprint,
	Eye,
	EyeOff,
	Binary,
	FileCode,
	Database,
	Wallet,
	type LucideIcon,
} from 'lucide-react';
import type { Theme } from '../types';
import type { SecurityEvent } from '../../main/preload/security';
import { safeClipboardWrite } from '../utils/clipboard';

/** Individual finding from a security event */
export interface Finding {
	type: string;
	value: string;
	start: number;
	end: number;
	confidence: number;
	replacement?: string;
}

export interface FindingDetailsProps {
	theme: Theme;
	/** List of findings to display */
	findings: Finding[];
	/** Optional header text */
	title?: string;
	/** Whether to show in compact mode */
	compact?: boolean;
	/** Callback when a finding is copied */
	onCopy?: (finding: Finding) => void;
	/** Callback when documentation link is clicked */
	onDocClick?: (findingType: string) => void;
}

// Fallback documentation URL
const DEFAULT_DOC_URL = 'https://docs.runmaestro.ai/security/llm-guard';

// Get documentation URL for a finding type (uses prefix matching for comprehensive coverage)
const getDocUrlForType = (type: string): string => {
	// Secrets
	if (type.includes('GITHUB')) return DEFAULT_DOC_URL + '#github-tokens';
	if (type.includes('AWS')) return DEFAULT_DOC_URL + '#aws-credentials';
	if (type.includes('OPENAI')) return DEFAULT_DOC_URL + '#api-keys';
	if (type.includes('AZURE')) return DEFAULT_DOC_URL + '#azure-credentials';
	if (type.includes('GOOGLE')) return DEFAULT_DOC_URL + '#google-credentials';
	if (type.includes('STRIPE')) return DEFAULT_DOC_URL + '#stripe-keys';
	if (type.includes('SLACK')) return DEFAULT_DOC_URL + '#slack-tokens';
	if (type.includes('DISCORD')) return DEFAULT_DOC_URL + '#discord-tokens';
	if (type.includes('SENTRY')) return DEFAULT_DOC_URL + '#sentry-dsn';
	if (type.includes('CONNECTION_STRING') || type.includes('DATABASE'))
		return DEFAULT_DOC_URL + '#database-credentials';
	if (type.includes('PRIVATE_KEY') || type.includes('RSA') || type.includes('OPENSSH'))
		return DEFAULT_DOC_URL + '#private-keys';
	if (type.includes('HIGH_ENTROPY')) return DEFAULT_DOC_URL + '#high-entropy-detection';
	if (type.startsWith('SECRET_')) return DEFAULT_DOC_URL + '#secrets';

	// PII
	if (type === 'PII_EMAIL') return DEFAULT_DOC_URL + '#email-addresses';
	if (type === 'PII_PHONE') return DEFAULT_DOC_URL + '#phone-numbers';
	if (type === 'PII_SSN') return DEFAULT_DOC_URL + '#social-security-numbers';
	if (type === 'PII_CREDIT_CARD') return DEFAULT_DOC_URL + '#credit-cards';
	if (type === 'PII_IP_ADDRESS') return DEFAULT_DOC_URL + '#ip-addresses';
	if (type.includes('ADDRESS') || type.includes('ZIP') || type.includes('PO_BOX'))
		return DEFAULT_DOC_URL + '#addresses';
	if (type.includes('NAME')) return DEFAULT_DOC_URL + '#names';
	if (type.includes('CRYPTO')) return DEFAULT_DOC_URL + '#cryptocurrency-wallets';
	if (type.startsWith('PII_')) return DEFAULT_DOC_URL + '#pii';

	// Prompt Injection
	if (type.includes('DAN') || type.includes('NO_RESTRICTIONS'))
		return DEFAULT_DOC_URL + '#jailbreak-detection';
	if (type.includes('CHATML') || type.includes('LLAMA') || type.includes('DELIMITER'))
		return DEFAULT_DOC_URL + '#delimiter-injection';
	if (type.includes('PROMPT_INJECTION')) return DEFAULT_DOC_URL + '#prompt-injection';

	// Output Injection
	if (type.includes('OUTPUT_INJECTION')) return DEFAULT_DOC_URL + '#output-injection';

	// Structural
	if (type.startsWith('STRUCTURAL_')) return DEFAULT_DOC_URL + '#structural-analysis';

	// Invisible characters
	if (type.startsWith('INVISIBLE_')) return DEFAULT_DOC_URL + '#invisible-characters';

	// Encoding attacks
	if (type.startsWith('ENCODING_')) return DEFAULT_DOC_URL + '#encoding-attacks';

	// Banned content
	if (type.startsWith('BANNED_')) return DEFAULT_DOC_URL + '#banned-content';

	return DEFAULT_DOC_URL;
};

// Icon mapping for finding types - comprehensive coverage for all LLM Guard finding types
const getIconForType = (type: string): LucideIcon => {
	// Secrets
	if (type.includes('CONNECTION_STRING') || type.includes('DATABASE')) return Database;
	if (
		type.includes('PRIVATE_KEY') ||
		type.includes('RSA') ||
		type.includes('OPENSSH') ||
		type.includes('PGP') ||
		type.includes('EC_PRIVATE')
	)
		return Lock;
	if (type.includes('HIGH_ENTROPY')) return Hash;
	if (
		type.includes('KEY') ||
		type.includes('TOKEN') ||
		type.includes('SECRET') ||
		type.includes('PASSWORD')
	)
		return Key;

	// PII
	if (type === 'PII_EMAIL') return Mail;
	if (type === 'PII_PHONE') return Phone;
	if (type === 'PII_CREDIT_CARD') return CreditCard;
	if (type === 'PII_SSN' || type.includes('FINGERPRINT')) return Fingerprint;
	if (type === 'PII_IP_ADDRESS') return Globe;
	if (type.includes('ADDRESS') || type.includes('ZIP') || type.includes('PO_BOX')) return MapPin;
	if (type.includes('NAME') || type.includes('USER')) return User;
	if (
		type.includes('CRYPTO') ||
		type.includes('BITCOIN') ||
		type.includes('ETHEREUM') ||
		type.includes('WALLET')
	)
		return Wallet;
	if (type.startsWith('PII_')) return User;

	// Prompt/Output Injection
	if (type.includes('INJECTION') || type.includes('JAILBREAK')) return AlertTriangle;
	if (type.includes('DAN')) return ShieldX;

	// Structural
	if (type.startsWith('STRUCTURAL_') || type.includes('BASE64')) return FileCode;

	// Invisible characters
	if (type.startsWith('INVISIBLE_') || type.includes('ZERO_WIDTH') || type.includes('RTL'))
		return EyeOff;
	if (type.includes('HOMOGLYPH')) return Eye;

	// Encoding attacks
	if (type.startsWith('ENCODING_')) return Binary;

	// Banned content
	if (type.startsWith('BANNED_')) return ShieldX;

	return FileText;
};

// Color mapping for finding categories
const getCategoryColor = (type: string, theme: Theme) => {
	// High severity: injection, jailbreak, banned content
	if (
		type.includes('INJECTION') ||
		type.includes('JAILBREAK') ||
		type.includes('LEAK') ||
		type.startsWith('BANNED_')
	) {
		return { bg: theme.colors.error + '20', text: theme.colors.error, border: theme.colors.error };
	}
	// Medium severity: secrets
	if (
		type.startsWith('SECRET_') ||
		type.includes('PASSWORD') ||
		type.includes('TOKEN') ||
		type.includes('KEY')
	) {
		return {
			bg: theme.colors.warning + '20',
			text: theme.colors.warning,
			border: theme.colors.warning,
		};
	}
	// Medium-low: PII
	if (type.startsWith('PII_')) {
		return {
			bg: theme.colors.accent + '20',
			text: theme.colors.accent,
			border: theme.colors.accent,
		};
	}
	// Low-medium: invisible characters and encoding attacks
	if (type.startsWith('INVISIBLE_') || type.startsWith('ENCODING_')) {
		return {
			bg: theme.colors.warning + '15',
			text: theme.colors.warning,
			border: theme.colors.warning + '60',
		};
	}
	// Low: structural analysis
	if (type.startsWith('STRUCTURAL_')) {
		return {
			bg: theme.colors.accent + '15',
			text: theme.colors.accent,
			border: theme.colors.accent + '60',
		};
	}
	return { bg: theme.colors.bgActivity, text: theme.colors.textMain, border: theme.colors.border };
};

// Mask sensitive values for display
const maskValue = (value: string, type: string): string => {
	// For secrets, show first and last 4 chars with stars
	if (type.startsWith('SECRET_') || type.includes('PASSWORD') || type.includes('TOKEN')) {
		if (value.length <= 8) return '****';
		return value.slice(0, 4) + '****' + value.slice(-4);
	}
	// For credit cards, show last 4 digits
	if (type.includes('CREDIT_CARD')) {
		return '****' + value.slice(-4);
	}
	// For SSN, show format with X's
	if (type.includes('SSN')) {
		return 'XXX-XX-' + value.slice(-4);
	}
	// For email, show first char and domain
	if (type.includes('EMAIL') && value.includes('@')) {
		const [local, domain] = value.split('@');
		return local[0] + '***@' + domain;
	}
	// For phone, show last 4 digits
	if (type.includes('PHONE')) {
		return '***-***-' + value.slice(-4);
	}
	// Default: truncate long values
	if (value.length > 50) {
		return value.slice(0, 47) + '...';
	}
	return value;
};

// Format finding type for display
const formatFindingType = (type: string): string => {
	return type.replace(/_/g, ' ');
};

// Get confidence level label
const getConfidenceLabel = (confidence: number): { label: string; color: string } => {
	if (confidence >= 0.9) return { label: 'Very High', color: '#ef4444' };
	if (confidence >= 0.7) return { label: 'High', color: '#f97316' };
	if (confidence >= 0.5) return { label: 'Medium', color: '#eab308' };
	return { label: 'Low', color: '#22c55e' };
};

/** Individual finding row component */
interface FindingRowProps {
	finding: Finding;
	theme: Theme;
	compact?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onCopy?: (finding: Finding) => void;
	onDocClick?: (findingType: string) => void;
}

const FindingRow = memo(function FindingRow({
	finding,
	theme,
	compact,
	isExpanded,
	onToggleExpand,
	onCopy,
	onDocClick,
}: FindingRowProps) {
	const [copied, setCopied] = useState(false);
	const [showUnmasked, setShowUnmasked] = useState(false);
	const Icon = getIconForType(finding.type);
	const colors = getCategoryColor(finding.type, theme);
	const confidenceInfo = getConfidenceLabel(finding.confidence);

	const handleCopy = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			// Copy the finding details as JSON
			const details = {
				type: finding.type,
				value: finding.value,
				replacement: finding.replacement,
				confidence: finding.confidence,
				position: { start: finding.start, end: finding.end },
			};
			const success = await safeClipboardWrite(JSON.stringify(details, null, 2));
			if (success) {
				setCopied(true);
				onCopy?.(finding);
				setTimeout(() => setCopied(false), 2000);
			}
		},
		[finding, onCopy]
	);

	const handleDocClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			const docUrl = getDocUrlForType(finding.type);
			if (onDocClick) {
				onDocClick(finding.type);
			} else {
				window.maestro?.shell?.openExternal?.(docUrl);
			}
		},
		[finding.type, onDocClick]
	);

	return (
		<div
			className="rounded border transition-colors"
			style={{
				borderColor: colors.border + '40',
				backgroundColor: isExpanded ? colors.bg : 'transparent',
			}}
		>
			{/* Header - Always visible */}
			<button
				onClick={onToggleExpand}
				className="w-full flex items-center gap-2 p-2 hover:bg-white/5 transition-colors"
			>
				{/* Expand/Collapse */}
				{isExpanded ? (
					<ChevronDown
						className="w-3.5 h-3.5 flex-shrink-0"
						style={{ color: theme.colors.textDim }}
					/>
				) : (
					<ChevronRight
						className="w-3.5 h-3.5 flex-shrink-0"
						style={{ color: theme.colors.textDim }}
					/>
				)}

				{/* Icon */}
				<div
					className="w-6 h-6 flex items-center justify-center rounded flex-shrink-0"
					style={{ backgroundColor: colors.bg }}
				>
					<Icon className="w-3.5 h-3.5" style={{ color: colors.text }} />
				</div>

				{/* Type Label */}
				<span
					className="text-xs font-bold uppercase truncate flex-1 text-left"
					style={{ color: colors.text }}
				>
					{formatFindingType(finding.type)}
				</span>

				{/* Confidence Badge */}
				{!compact && (
					<span
						className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
						style={{
							backgroundColor: confidenceInfo.color + '20',
							color: confidenceInfo.color,
						}}
					>
						{(finding.confidence * 100).toFixed(0)}%
					</span>
				)}
			</button>

			{/* Expanded Details */}
			{isExpanded && (
				<div
					className="px-2 pb-2 space-y-2"
					style={{ borderTop: `1px solid ${theme.colors.border}30` }}
				>
					{/* Value Display */}
					<div className="pt-2">
						<div className="flex items-center justify-between mb-1">
							<span className="text-[10px] uppercase" style={{ color: theme.colors.textDim }}>
								{finding.replacement ? 'Original → Replacement' : 'Detected Value'}
							</span>
							{/* Show/Hide toggle for sensitive values */}
							{(finding.type.startsWith('SECRET_') || finding.type.startsWith('PII_')) && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										setShowUnmasked(!showUnmasked);
									}}
									className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textDim }}
									title={showUnmasked ? 'Mask value' : 'Show full value'}
								>
									{showUnmasked ? (
										<>
											<EyeOff className="w-2.5 h-2.5" />
											<span>Mask</span>
										</>
									) : (
										<>
											<Eye className="w-2.5 h-2.5" />
											<span>Show</span>
										</>
									)}
								</button>
							)}
						</div>
						<div
							className="font-mono text-xs p-2 rounded break-all"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							{finding.replacement ? (
								<>
									<span
										style={{
											color: theme.colors.error,
											textDecoration: 'line-through',
										}}
									>
										{showUnmasked ? finding.value : maskValue(finding.value, finding.type)}
									</span>
									<span style={{ color: theme.colors.textDim }}> → </span>
									<span style={{ color: theme.colors.success }}>{finding.replacement}</span>
								</>
							) : (
								<span style={{ color: theme.colors.textMain }}>
									{showUnmasked ? finding.value : maskValue(finding.value, finding.type)}
								</span>
							)}
						</div>
					</div>

					{/* Metadata */}
					<div
						className="flex items-center gap-4 text-[10px]"
						style={{ color: theme.colors.textDim }}
					>
						<span>
							<strong>Position:</strong> {finding.start}–{finding.end}
						</span>
						<span>
							<strong>Confidence:</strong>{' '}
							<span style={{ color: confidenceInfo.color }}>
								{confidenceInfo.label} ({(finding.confidence * 100).toFixed(0)}%)
							</span>
						</span>
					</div>

					{/* Actions */}
					<div className="flex items-center gap-2 pt-1">
						<button
							onClick={handleCopy}
							className="flex items-center gap-1 px-2 py-1 rounded text-[10px] hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							title="Copy finding details to clipboard"
						>
							{copied ? (
								<>
									<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
									<span>Copied</span>
								</>
							) : (
								<>
									<Copy className="w-3 h-3" />
									<span>Copy Details</span>
								</>
							)}
						</button>
						<button
							onClick={handleDocClick}
							className="flex items-center gap-1 px-2 py-1 rounded text-[10px] hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.accent }}
							title="View documentation for this finding type"
						>
							<ExternalLink className="w-3 h-3" />
							<span>Learn More</span>
						</button>
					</div>
				</div>
			)}
		</div>
	);
});

/**
 * FindingDetails Component
 *
 * Displays a list of security findings with detailed information.
 * Features expandable rows with copy and documentation actions.
 */
export const FindingDetails = memo(function FindingDetails({
	theme,
	findings,
	title = 'Security Findings',
	compact = false,
	onCopy,
	onDocClick,
}: FindingDetailsProps) {
	const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

	const toggleExpand = useCallback((index: number) => {
		setExpandedIds((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(index)) {
				newSet.delete(index);
			} else {
				newSet.add(index);
			}
			return newSet;
		});
	}, []);

	// Expand all by default in non-compact mode
	const handleExpandAll = useCallback(() => {
		setExpandedIds(new Set(findings.map((_, i) => i)));
	}, [findings]);

	const handleCollapseAll = useCallback(() => {
		setExpandedIds(new Set());
	}, []);

	if (findings.length === 0) {
		return (
			<div
				className="flex flex-col items-center justify-center py-6 text-center"
				style={{ color: theme.colors.textDim }}
			>
				<ShieldCheck className="w-8 h-8 mb-2 opacity-50" />
				<div className="text-xs">No security findings</div>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{/* Header */}
			{!compact && (
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Shield className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span className="text-xs font-bold uppercase" style={{ color: theme.colors.textMain }}>
							{title}
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							({findings.length})
						</span>
					</div>
					<div className="flex items-center gap-1">
						<button
							onClick={handleExpandAll}
							className="text-[10px] px-2 py-0.5 rounded hover:bg-white/10"
							style={{ color: theme.colors.textDim }}
						>
							Expand All
						</button>
						<button
							onClick={handleCollapseAll}
							className="text-[10px] px-2 py-0.5 rounded hover:bg-white/10"
							style={{ color: theme.colors.textDim }}
						>
							Collapse All
						</button>
					</div>
				</div>
			)}

			{/* Findings List */}
			<div className="space-y-1.5">
				{findings.map((finding, index) => (
					<FindingRow
						key={`${finding.type}-${finding.start}-${index}`}
						finding={finding}
						theme={theme}
						compact={compact}
						isExpanded={expandedIds.has(index)}
						onToggleExpand={() => toggleExpand(index)}
						onCopy={onCopy}
						onDocClick={onDocClick}
					/>
				))}
			</div>
		</div>
	);
});

export default FindingDetails;
