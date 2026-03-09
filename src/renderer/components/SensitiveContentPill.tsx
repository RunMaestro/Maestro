/**
 * SensitiveContentPill - Visual pill indicator for detected sensitive content.
 * Used in SensitiveContentOverlay to highlight PII, secrets, and other sensitive data.
 *
 * Features:
 * - Category-based color coding (PII=blue, secrets=red, credit cards=amber)
 * - Truncated display for long values
 * - Hover tooltip showing full value and anonymization notice
 */

import { memo, useState, useRef, useEffect } from 'react';
import { Eye, EyeOff, Mail, Phone, CreditCard, Key, Globe, Shield } from 'lucide-react';
import type { Theme } from '../types';
import type { InputScanFinding } from '../../main/preload/security';
import { getFindingCategory, getFindingLabel } from '../hooks/input/useSensitiveContentDetection';

interface SensitiveContentPillProps {
	finding: InputScanFinding;
	theme: Theme;
}

/**
 * Get the icon component for a finding type
 */
function getFindingIcon(type: string): React.ReactNode {
	if (type === 'PII_EMAIL') return <Mail size={10} />;
	if (type === 'PII_PHONE') return <Phone size={10} />;
	if (type === 'PII_CREDIT_CARD') return <CreditCard size={10} />;
	if (type === 'PII_IP_ADDRESS') return <Globe size={10} />;
	if (type.startsWith('SECRET_')) return <Key size={10} />;
	return <Shield size={10} />;
}

/**
 * Get colors for a finding category
 */
function getCategoryColors(category: string): { bg: string; border: string; text: string } {
	switch (category) {
		case 'pii':
			return {
				bg: 'rgba(59, 130, 246, 0.15)', // Blue with low opacity
				border: 'rgba(59, 130, 246, 0.4)',
				text: '#3B82F6',
			};
		case 'secret':
			return {
				bg: 'rgba(239, 68, 68, 0.15)', // Red with low opacity
				border: 'rgba(239, 68, 68, 0.4)',
				text: '#EF4444',
			};
		case 'credit_card':
			return {
				bg: 'rgba(245, 158, 11, 0.15)', // Amber with low opacity
				border: 'rgba(245, 158, 11, 0.4)',
				text: '#F59E0B',
			};
		default:
			return {
				bg: 'rgba(156, 163, 175, 0.15)', // Gray with low opacity
				border: 'rgba(156, 163, 175, 0.4)',
				text: '#9CA3AF',
			};
	}
}

/**
 * Truncate a value for display in the pill
 */
function truncateValue(value: string, maxLength: number = 12): string {
	if (value.length <= maxLength) return value;

	// For emails, show first part and domain hint
	if (value.includes('@')) {
		const [local, domain] = value.split('@');
		if (local.length > 4) {
			return `${local.slice(0, 4)}...@${domain.slice(0, 3)}...`;
		}
	}

	// For other values, show beginning and end
	const halfLen = Math.floor((maxLength - 3) / 2);
	return `${value.slice(0, halfLen)}...${value.slice(-halfLen)}`;
}

/**
 * Mask a sensitive value for the tooltip
 */
function maskValue(value: string, type: string): string {
	if (type === 'PII_CREDIT_CARD') {
		// Show only last 4 digits
		const digits = value.replace(/\D/g, '');
		return `****-****-****-${digits.slice(-4)}`;
	}
	if (type === 'PII_SSN') {
		return '***-**-' + value.slice(-4);
	}
	if (type.startsWith('SECRET_')) {
		// Show first 4 and last 4 characters
		if (value.length > 12) {
			return `${value.slice(0, 4)}${'*'.repeat(Math.min(8, value.length - 8))}${value.slice(-4)}`;
		}
		return '*'.repeat(value.length);
	}
	return value;
}

export const SensitiveContentPill = memo(function SensitiveContentPill({
	finding,
	theme,
}: SensitiveContentPillProps) {
	const [isHovered, setIsHovered] = useState(false);
	const [showFull, setShowFull] = useState(false);
	const pillRef = useRef<HTMLSpanElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const [tooltipPosition, setTooltipPosition] = useState<'above' | 'below'>('above');

	const category = getFindingCategory(finding.type);
	const colors = getCategoryColors(category);
	const label = getFindingLabel(finding.type);
	const icon = getFindingIcon(finding.type);
	const displayValue = truncateValue(finding.value);
	const maskedValue = maskValue(finding.value, finding.type);

	// Calculate tooltip position to avoid viewport overflow
	useEffect(() => {
		if (isHovered && pillRef.current) {
			const rect = pillRef.current.getBoundingClientRect();
			// If pill is in the top half of viewport, show tooltip below
			setTooltipPosition(rect.top < 200 ? 'below' : 'above');
		}
	}, [isHovered]);

	return (
		<span
			ref={pillRef}
			className="relative inline-flex items-center gap-0.5 px-1 py-0 rounded text-xs font-mono cursor-help transition-all duration-150"
			style={{
				backgroundColor: colors.bg,
				border: `1px solid ${colors.border}`,
				color: colors.text,
				fontSize: '0.7rem',
				lineHeight: '1.4',
				verticalAlign: 'baseline',
			}}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => {
				setIsHovered(false);
				setShowFull(false);
			}}
		>
			{/* Icon */}
			<span className="opacity-70">{icon}</span>

			{/* Truncated value */}
			<span className="opacity-90">{displayValue}</span>

			{/* Hover tooltip */}
			{isHovered && (
				<div
					ref={tooltipRef}
					className="absolute z-50 px-2 py-1.5 rounded shadow-lg text-xs"
					style={{
						backgroundColor: theme.colors.bgActivity,
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textMain,
						left: '50%',
						transform: 'translateX(-50%)',
						...(tooltipPosition === 'above'
							? { bottom: '100%', marginBottom: '4px' }
							: { top: '100%', marginTop: '4px' }),
						minWidth: '180px',
						maxWidth: '280px',
						whiteSpace: 'nowrap',
					}}
				>
					{/* Header */}
					<div
						className="flex items-center gap-1 mb-1 pb-1 border-b"
						style={{ borderColor: theme.colors.border }}
					>
						<span style={{ color: colors.text }}>{icon}</span>
						<span className="font-medium" style={{ color: colors.text }}>
							{label}
						</span>
					</div>

					{/* Value display */}
					<div className="flex items-center gap-1 mb-1">
						<span className="font-mono text-xs" style={{ color: theme.colors.textDim }}>
							{showFull ? finding.value : maskedValue}
						</span>
						<button
							className="p-0.5 rounded hover:bg-white/10 transition-colors"
							onClick={(e) => {
								e.stopPropagation();
								setShowFull(!showFull);
							}}
							title={showFull ? 'Hide full value' : 'Show full value'}
						>
							{showFull ? (
								<EyeOff size={12} style={{ color: theme.colors.textDim }} />
							) : (
								<Eye size={12} style={{ color: theme.colors.textDim }} />
							)}
						</button>
					</div>

					{/* Notice */}
					<div
						className="text-xs italic opacity-70"
						style={{ color: theme.colors.textDim, fontSize: '0.65rem' }}
					>
						Will be anonymized when sent
					</div>
				</div>
			)}
		</span>
	);
});

SensitiveContentPill.displayName = 'SensitiveContentPill';

export default SensitiveContentPill;
