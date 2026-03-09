/**
 * LlmGuardTab - LLM Guard settings tab for SettingsModal
 *
 * Contains: Master enable/disable toggle, action mode selector,
 * input protection settings, output protection settings,
 * custom regex patterns, and confidence threshold slider for prompt injection detection.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
	Shield,
	ShieldAlert,
	ShieldCheck,
	ShieldX,
	AlertTriangle,
	Eye,
	Lock,
	Unlock,
	Ban,
	Type,
	Search,
	Bell,
	Plus,
	Trash2,
	Edit2,
	Check,
	X,
	Play,
	Download,
	Upload,
	Code,
	ChevronDown,
	ChevronRight,
	Users,
	Settings2,
	AlertCircle,
	Lightbulb,
	RefreshCw,
	XCircle,
	ExternalLink,
} from 'lucide-react';
import { useSettings } from '../../../hooks';
import type { Theme, LlmGuardAction, CustomPattern, CustomPatternType } from '../../../types';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';

export interface LlmGuardTabProps {
	theme: Theme;
}

// Generate a unique ID for a new custom pattern
function generatePatternId(): string {
	return `pattern_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Validate a regex pattern string
function validatePattern(pattern: string): { valid: boolean; error?: string } {
	if (!pattern || pattern.trim() === '') {
		return { valid: false, error: 'Pattern cannot be empty' };
	}
	try {
		new RegExp(pattern, 'gi');
		return { valid: true };
	} catch (e) {
		const error = e instanceof Error ? e.message : 'Invalid regex pattern';
		return { valid: false, error };
	}
}

// Test a pattern against sample text
function testPattern(pattern: string, sampleText: string): { matches: string[]; error?: string } {
	const validation = validatePattern(pattern);
	if (!validation.valid) {
		return { matches: [], error: validation.error };
	}
	try {
		const regex = new RegExp(pattern, 'gi');
		const matches: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(sampleText)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			matches.push(match[0]);
		}
		return { matches };
	} catch (e) {
		return { matches: [], error: e instanceof Error ? e.message : 'Error testing pattern' };
	}
}

export function LlmGuardTab({ theme }: LlmGuardTabProps) {
	const { llmGuardSettings, setLlmGuardSettings, updateLlmGuardSettings } = useSettings();

	// Custom patterns state
	const [editingPatternId, setEditingPatternId] = useState<string | null>(null);
	const [editingPattern, setEditingPattern] = useState<CustomPattern | null>(null);
	const [testText, setTestText] = useState('');
	const [testResults, setTestResults] = useState<{ matches: string[]; error?: string } | null>(
		null
	);
	const [patternValidationError, setPatternValidationError] = useState<string | null>(null);
	const [expandedPatterns, setExpandedPatterns] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Configuration import/export state
	const configFileInputRef = useRef<HTMLInputElement>(null);
	const [configImportError, setConfigImportError] = useState<string | null>(null);
	const [configImportWarnings, setConfigImportWarnings] = useState<string[]>([]);
	const [showImportSuccess, setShowImportSuccess] = useState(false);

	// Recommendations state
	type SecurityRecommendation = {
		id: string;
		category: string;
		severity: 'low' | 'medium' | 'high';
		title: string;
		description: string;
		actionItems: string[];
		affectedEventCount: number;
		relatedFindingTypes: string[];
		generatedAt: number;
	};
	const [recommendations, setRecommendations] = useState<SecurityRecommendation[]>([]);
	const [recommendationsLoading, setRecommendationsLoading] = useState(false);
	const [expandedRecommendations, setExpandedRecommendations] = useState(false);
	const [dismissedRecommendationIds, setDismissedRecommendationIds] = useState<string[]>([]);

	// Load recommendations on mount and when settings change
	useEffect(() => {
		const loadRecommendations = async () => {
			setRecommendationsLoading(true);
			try {
				const recs = await window.maestro.security.getRecommendations(llmGuardSettings, {
					excludeDismissed: true,
					dismissedIds: dismissedRecommendationIds,
				});
				setRecommendations(recs);
			} catch (err) {
				console.error('Failed to load recommendations:', err);
				setRecommendations([]);
			} finally {
				setRecommendationsLoading(false);
			}
		};

		loadRecommendations();
	}, [llmGuardSettings, dismissedRecommendationIds]);

	// Dismiss a recommendation
	const handleDismissRecommendation = useCallback((id: string) => {
		setDismissedRecommendationIds((prev) => [...prev, id]);
	}, []);

	// Refresh recommendations
	const handleRefreshRecommendations = useCallback(async () => {
		setRecommendationsLoading(true);
		try {
			const recs = await window.maestro.security.getRecommendations(llmGuardSettings, {
				excludeDismissed: true,
				dismissedIds: dismissedRecommendationIds,
			});
			setRecommendations(recs);
		} catch (err) {
			console.error('Failed to refresh recommendations:', err);
		} finally {
			setRecommendationsLoading(false);
		}
	}, [llmGuardSettings, dismissedRecommendationIds]);

	const handleToggleEnabled = () => {
		updateLlmGuardSettings({ enabled: !llmGuardSettings.enabled });
	};

	const handleActionChange = (action: LlmGuardAction) => {
		updateLlmGuardSettings({ action });
	};

	const handleInputToggle = (key: keyof typeof llmGuardSettings.input) => {
		updateLlmGuardSettings({
			input: {
				...llmGuardSettings.input,
				[key]: !llmGuardSettings.input[key],
			},
		});
	};

	const handleOutputToggle = (key: keyof typeof llmGuardSettings.output) => {
		updateLlmGuardSettings({
			output: {
				...llmGuardSettings.output,
				[key]: !llmGuardSettings.output[key],
			},
		});
	};

	const handleThresholdChange = (value: number) => {
		updateLlmGuardSettings({
			thresholds: {
				...llmGuardSettings.thresholds,
				promptInjection: value,
			},
		});
	};

	const handleBanSubstringsChange = (value: string) => {
		const substrings = value
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		updateLlmGuardSettings({ banSubstrings: substrings });
	};

	const handleBanTopicsPatternsChange = (value: string) => {
		const patterns = value
			.split('\n')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		updateLlmGuardSettings({ banTopicsPatterns: patterns });
	};

	// Custom pattern handlers
	const handleAddPattern = useCallback(() => {
		const newPattern: CustomPattern = {
			id: generatePatternId(),
			name: '',
			pattern: '',
			type: 'other',
			action: 'warn',
			confidence: 0.8,
			enabled: true,
			description: '',
		};
		setEditingPattern(newPattern);
		setEditingPatternId('new');
		setPatternValidationError(null);
		setTestResults(null);
		setTestText('');
	}, []);

	const handleEditPattern = useCallback((pattern: CustomPattern) => {
		setEditingPattern({ ...pattern });
		setEditingPatternId(pattern.id);
		setPatternValidationError(null);
		setTestResults(null);
		setTestText('');
	}, []);

	const handleSavePattern = useCallback(() => {
		if (!editingPattern) return;

		// Validate pattern
		if (!editingPattern.name.trim()) {
			setPatternValidationError('Pattern name is required');
			return;
		}

		const validation = validatePattern(editingPattern.pattern);
		if (!validation.valid) {
			setPatternValidationError(validation.error || 'Invalid pattern');
			return;
		}

		const currentPatterns = llmGuardSettings.customPatterns ?? [];

		if (editingPatternId === 'new') {
			// Add new pattern
			updateLlmGuardSettings({
				customPatterns: [...currentPatterns, editingPattern],
			});
		} else {
			// Update existing pattern
			updateLlmGuardSettings({
				customPatterns: currentPatterns.map((p) =>
					p.id === editingPatternId ? editingPattern : p
				),
			});
		}

		setEditingPattern(null);
		setEditingPatternId(null);
		setPatternValidationError(null);
	}, [editingPattern, editingPatternId, llmGuardSettings.customPatterns, updateLlmGuardSettings]);

	const handleCancelEdit = useCallback(() => {
		setEditingPattern(null);
		setEditingPatternId(null);
		setPatternValidationError(null);
		setTestResults(null);
	}, []);

	const handleDeletePattern = useCallback(
		(patternId: string) => {
			const currentPatterns = llmGuardSettings.customPatterns ?? [];
			updateLlmGuardSettings({
				customPatterns: currentPatterns.filter((p) => p.id !== patternId),
			});
		},
		[llmGuardSettings.customPatterns, updateLlmGuardSettings]
	);

	const handleTogglePatternEnabled = useCallback(
		(patternId: string) => {
			const currentPatterns = llmGuardSettings.customPatterns ?? [];
			updateLlmGuardSettings({
				customPatterns: currentPatterns.map((p) =>
					p.id === patternId ? { ...p, enabled: !p.enabled } : p
				),
			});
		},
		[llmGuardSettings.customPatterns, updateLlmGuardSettings]
	);

	const handleTestPattern = useCallback(() => {
		if (!editingPattern) return;
		const result = testPattern(editingPattern.pattern, testText);
		setTestResults(result);
	}, [editingPattern, testText]);

	const handleExportPatterns = useCallback(() => {
		const patterns = llmGuardSettings.customPatterns ?? [];
		const json = JSON.stringify(patterns, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'llm-guard-custom-patterns.json';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}, [llmGuardSettings.customPatterns]);

	const handleImportPatterns = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			if (!file) return;

			const reader = new FileReader();
			reader.onload = (e) => {
				try {
					const json = e.target?.result as string;
					const parsed = JSON.parse(json);

					if (!Array.isArray(parsed)) {
						console.error('Invalid patterns file: expected array');
						return;
					}

					const importedPatterns: CustomPattern[] = [];
					for (const item of parsed) {
						if (
							typeof item.name !== 'string' ||
							typeof item.pattern !== 'string' ||
							!['secret', 'pii', 'injection', 'other'].includes(item.type) ||
							!['warn', 'sanitize', 'block'].includes(item.action) ||
							typeof item.confidence !== 'number'
						) {
							continue;
						}

						const validation = validatePattern(item.pattern);
						if (!validation.valid) continue;

						importedPatterns.push({
							id: generatePatternId(),
							name: item.name,
							pattern: item.pattern,
							type: item.type,
							action: item.action,
							confidence: Math.max(0, Math.min(1, item.confidence)),
							enabled: item.enabled !== false,
							description: item.description || '',
						});
					}

					if (importedPatterns.length > 0) {
						const currentPatterns = llmGuardSettings.customPatterns ?? [];
						updateLlmGuardSettings({
							customPatterns: [...currentPatterns, ...importedPatterns],
						});
					}
				} catch (err) {
					console.error('Failed to import patterns:', err);
				}
			};
			reader.readAsText(file);

			// Reset input so the same file can be imported again
			if (fileInputRef.current) {
				fileInputRef.current.value = '';
			}
		},
		[llmGuardSettings.customPatterns, updateLlmGuardSettings]
	);

	// Configuration export/import handlers
	const handleExportConfig = useCallback(async () => {
		try {
			const jsonString = await window.maestro.security.exportConfig(llmGuardSettings);
			const blob = new Blob([jsonString], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `llm-guard-config-${new Date().toISOString().split('T')[0]}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error('Failed to export configuration:', err);
		}
	}, [llmGuardSettings]);

	const handleImportConfig = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			if (!file) return;

			setConfigImportError(null);
			setConfigImportWarnings([]);
			setShowImportSuccess(false);

			const reader = new FileReader();
			reader.onload = async (e) => {
				try {
					const jsonString = e.target?.result as string;
					const result = await window.maestro.security.importConfig(jsonString);

					if (!result.success) {
						setConfigImportError(result.errors.join('\n'));
						return;
					}

					// Apply the imported configuration
					setLlmGuardSettings(result.config);

					if (result.warnings.length > 0) {
						setConfigImportWarnings(result.warnings);
					}

					setShowImportSuccess(true);
					setTimeout(() => setShowImportSuccess(false), 3000);
				} catch (err) {
					const message = err instanceof Error ? err.message : 'Failed to import configuration';
					setConfigImportError(message);
				}
			};
			reader.readAsText(file);

			// Reset input so the same file can be imported again
			if (configFileInputRef.current) {
				configFileInputRef.current.value = '';
			}
		},
		[setLlmGuardSettings]
	);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<div className="flex items-center justify-between mb-2">
					<h3
						className="text-sm font-bold flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
					>
						<Shield className="w-5 h-5" />
						LLM Guard
						<span
							className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
							style={{
								backgroundColor: theme.colors.warning + '30',
								color: theme.colors.warning,
							}}
						>
							Beta
						</span>
					</h3>
					<button
						onClick={() =>
							window.maestro.shell.openExternal('https://docs.runmaestro.ai/security/llm-guard')
						}
						className="flex items-center gap-1 text-xs hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.accent }}
						title="View LLM Guard documentation"
					>
						<ExternalLink className="w-3.5 h-3.5" />
						Docs
					</button>
				</div>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Protect sensitive data in AI interactions. LLM Guard scans messages for PII, secrets, and
					potential prompt injection attacks before sending to AI providers, and monitors outputs
					for data leakage.
				</p>
			</div>

			{/* Master Enable/Disable Toggle */}
			<div
				className="rounded-lg border p-4"
				style={{
					borderColor: llmGuardSettings.enabled ? theme.colors.accent : theme.colors.border,
					backgroundColor: llmGuardSettings.enabled ? `${theme.colors.accent}08` : 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between text-left"
					onClick={handleToggleEnabled}
				>
					<div className="flex items-center gap-3">
						{llmGuardSettings.enabled ? (
							<ShieldCheck className="w-5 h-5" style={{ color: theme.colors.success }} />
						) : (
							<ShieldX className="w-5 h-5" style={{ color: theme.colors.textDim }} />
						)}
						<div>
							<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								{llmGuardSettings.enabled ? 'LLM Guard Enabled' : 'LLM Guard Disabled'}
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								{llmGuardSettings.enabled
									? 'Scanning all AI interactions for sensitive content'
									: 'No scanning or protection active'}
							</div>
						</div>
					</div>
					<div
						className="relative w-10 h-5 rounded-full transition-colors"
						style={{
							backgroundColor: llmGuardSettings.enabled ? theme.colors.accent : theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: llmGuardSettings.enabled ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
				</button>
			</div>

			{/* Configuration Import/Export */}
			<div
				className="rounded-lg border p-4"
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
				}}
			>
				<div
					className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Settings2 className="w-3 h-3" />
					Configuration
				</div>
				<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
					Export your LLM Guard settings to share with your team or import settings from a
					configuration file.
				</p>

				<div className="flex items-center gap-2">
					<button
						onClick={handleExportConfig}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							borderColor: theme.colors.border,
						}}
					>
						<Download className="w-3 h-3" />
						Export Configuration
					</button>
					<label
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							borderColor: theme.colors.border,
						}}
					>
						<Upload className="w-3 h-3" />
						Import Configuration
						<input
							ref={configFileInputRef}
							type="file"
							accept=".json"
							onChange={handleImportConfig}
							className="hidden"
						/>
					</label>
				</div>

				{/* Import success message */}
				{showImportSuccess && (
					<div
						className="mt-3 p-2 rounded text-xs flex items-center gap-2"
						style={{
							backgroundColor: theme.colors.success + '20',
							color: theme.colors.success,
						}}
					>
						<Check className="w-3 h-3" />
						Configuration imported successfully
					</div>
				)}

				{/* Import warnings */}
				{configImportWarnings.length > 0 && (
					<div
						className="mt-3 p-2 rounded text-xs"
						style={{
							backgroundColor: theme.colors.warning + '20',
							color: theme.colors.warning,
						}}
					>
						<div className="font-medium mb-1">Import warnings:</div>
						<ul className="list-disc list-inside">
							{configImportWarnings.map((warning, i) => (
								<li key={i}>{warning}</li>
							))}
						</ul>
					</div>
				)}

				{/* Import error */}
				{configImportError && (
					<div
						className="mt-3 p-2 rounded text-xs"
						style={{
							backgroundColor: theme.colors.error + '20',
							color: theme.colors.error,
						}}
					>
						<div className="font-medium mb-1">Import failed:</div>
						<pre className="whitespace-pre-wrap font-mono text-[10px]">{configImportError}</pre>
					</div>
				)}
			</div>

			{/* Security Recommendations Section */}
			<div
				className="rounded-lg border p-4"
				style={{
					borderColor:
						recommendations.filter((r) => r.severity === 'high').length > 0
							? theme.colors.error
							: recommendations.filter((r) => r.severity === 'medium').length > 0
								? theme.colors.warning
								: theme.colors.border,
					backgroundColor:
						recommendations.filter((r) => r.severity === 'high').length > 0
							? `${theme.colors.error}08`
							: recommendations.filter((r) => r.severity === 'medium').length > 0
								? `${theme.colors.warning}08`
								: theme.colors.bgMain,
				}}
			>
				<div className="flex items-center justify-between mb-3">
					<button
						className="flex items-center gap-2 text-left"
						onClick={() => setExpandedRecommendations(!expandedRecommendations)}
					>
						{expandedRecommendations ? (
							<ChevronDown className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						) : (
							<ChevronRight className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						)}
						<div
							className="text-xs font-bold opacity-70 uppercase flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<Lightbulb className="w-3 h-3" />
							Security Recommendations
							{recommendations.length > 0 && (
								<span
									className="px-1.5 py-0.5 rounded text-[9px] font-bold"
									style={{
										backgroundColor:
											recommendations.filter((r) => r.severity === 'high').length > 0
												? theme.colors.error
												: recommendations.filter((r) => r.severity === 'medium').length > 0
													? theme.colors.warning
													: theme.colors.accent,
										color: 'white',
									}}
								>
									{recommendations.length}
								</span>
							)}
						</div>
					</button>
					<button
						onClick={handleRefreshRecommendations}
						disabled={recommendationsLoading}
						className="p-1.5 rounded transition-colors hover:bg-white/10"
						title="Refresh recommendations"
					>
						<RefreshCw
							className={`w-3.5 h-3.5 ${recommendationsLoading ? 'animate-spin' : ''}`}
							style={{ color: theme.colors.textDim }}
						/>
					</button>
				</div>

				<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
					Actionable suggestions based on your security event patterns and configuration.
				</p>

				{expandedRecommendations && (
					<>
						{recommendationsLoading && recommendations.length === 0 && (
							<div className="text-center py-4">
								<RefreshCw
									className="w-5 h-5 mx-auto mb-2 animate-spin"
									style={{ color: theme.colors.textDim }}
								/>
								<p className="text-xs" style={{ color: theme.colors.textDim }}>
									Analyzing security events...
								</p>
							</div>
						)}

						{!recommendationsLoading && recommendations.length === 0 && (
							<div
								className="text-center py-6 rounded border border-dashed"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textDim,
								}}
							>
								<ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-50" />
								<p className="text-xs">No recommendations at this time</p>
								<p className="text-[10px] mt-1">Your security configuration looks good</p>
							</div>
						)}

						{recommendations.length > 0 && (
							<div className="space-y-2">
								{recommendations.map((rec) => (
									<div
										key={rec.id}
										className="p-3 rounded border"
										style={{
											borderColor:
												rec.severity === 'high'
													? theme.colors.error + '40'
													: rec.severity === 'medium'
														? theme.colors.warning + '40'
														: theme.colors.border,
											backgroundColor:
												rec.severity === 'high'
													? theme.colors.error + '10'
													: rec.severity === 'medium'
														? theme.colors.warning + '10'
														: theme.colors.bgActivity,
										}}
									>
										<div className="flex items-start justify-between gap-2">
											<div className="flex-1">
												<div className="flex items-center gap-2 mb-1">
													<span
														className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
														style={{
															backgroundColor:
																rec.severity === 'high'
																	? theme.colors.error
																	: rec.severity === 'medium'
																		? theme.colors.warning
																		: theme.colors.textDim,
															color: 'white',
														}}
													>
														{rec.severity}
													</span>
													<span
														className="text-xs font-medium"
														style={{ color: theme.colors.textMain }}
													>
														{rec.title}
													</span>
												</div>
												<p className="text-[11px] mb-2" style={{ color: theme.colors.textDim }}>
													{rec.description}
												</p>
												{rec.actionItems.length > 0 && (
													<ul className="space-y-0.5">
														{rec.actionItems.map((item, i) => (
															<li
																key={i}
																className="text-[10px] flex items-start gap-1.5"
																style={{ color: theme.colors.textDim }}
															>
																<span style={{ color: theme.colors.accent }}>•</span>
																{item}
															</li>
														))}
													</ul>
												)}
												{rec.affectedEventCount > 0 && (
													<div className="mt-2 text-[10px]" style={{ color: theme.colors.textDim }}>
														Based on {rec.affectedEventCount} event
														{rec.affectedEventCount !== 1 ? 's' : ''}
													</div>
												)}
											</div>
											<button
												onClick={() => handleDismissRecommendation(rec.id)}
												className="p-1 rounded transition-colors hover:bg-white/10 flex-shrink-0"
												title="Dismiss this recommendation"
											>
												<XCircle className="w-4 h-4" style={{ color: theme.colors.textDim }} />
											</button>
										</div>
									</div>
								))}
							</div>
						)}
					</>
				)}
			</div>

			{/* Settings (only shown when enabled) */}
			{llmGuardSettings.enabled && (
				<>
					{/* Action Mode Selector */}
					<div>
						<div
							className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<AlertTriangle className="w-3 h-3" />
							Action Mode
						</div>
						<ToggleButtonGroup
							options={[
								{ value: 'warn' as const, label: 'Warn' },
								{ value: 'sanitize' as const, label: 'Sanitize' },
								{ value: 'block' as const, label: 'Block' },
							]}
							value={llmGuardSettings.action}
							onChange={handleActionChange}
							theme={theme}
						/>
						<div
							className="mt-3 p-3 rounded border text-xs"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
							}}
						>
							{llmGuardSettings.action === 'warn' && (
								<div className="flex items-start gap-2">
									<Eye
										className="w-4 h-4 flex-shrink-0 mt-0.5"
										style={{ color: theme.colors.warning }}
									/>
									<div>
										<strong>Warn:</strong> Log findings to the security event log but don't modify
										content. Messages are sent as-is to the AI provider. Use this mode to audit what
										would be caught before enabling active protection.
									</div>
								</div>
							)}
							{llmGuardSettings.action === 'sanitize' && (
								<div className="flex items-start gap-2">
									<Lock
										className="w-4 h-4 flex-shrink-0 mt-0.5"
										style={{ color: theme.colors.accent }}
									/>
									<div>
										<strong>Sanitize:</strong> Replace sensitive content with placeholders before
										sending to AI. For example, email addresses become <code>[EMAIL_1]</code> and
										API keys become <code>[REDACTED]</code>. This is the recommended mode.
									</div>
								</div>
							)}
							{llmGuardSettings.action === 'block' && (
								<div className="flex items-start gap-2">
									<ShieldAlert
										className="w-4 h-4 flex-shrink-0 mt-0.5"
										style={{ color: theme.colors.error }}
									/>
									<div>
										<strong>Block:</strong> Stop processing entirely if sensitive content is
										detected. The message will not be sent to the AI provider. Use this mode for
										maximum security in sensitive environments.
									</div>
								</div>
							)}
						</div>
					</div>

					{/* Input Protection Section */}
					<div
						className="rounded-lg border p-4"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div
							className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<Lock className="w-3 h-3" />
							Input Protection
						</div>
						<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
							Scan and protect content before it is sent to AI providers.
						</p>

						<div className="space-y-3">
							{/* Anonymize PII */}
							<ToggleSetting
								label="Anonymize PII"
								description="Detect and replace personally identifiable information (names, emails, phone numbers, addresses, SSNs, etc.)"
								checked={llmGuardSettings.input.anonymizePii}
								onChange={() => handleInputToggle('anonymizePii')}
								theme={theme}
							/>

							{/* Redact Secrets */}
							<ToggleSetting
								label="Redact Secrets"
								description="Detect and redact API keys, passwords, tokens, private keys, and other credentials"
								checked={llmGuardSettings.input.redactSecrets}
								onChange={() => handleInputToggle('redactSecrets')}
								theme={theme}
							/>

							{/* Detect Prompt Injection */}
							<ToggleSetting
								label="Detect Prompt Injection"
								description="Identify potential prompt injection or jailbreak attempts in user input"
								checked={llmGuardSettings.input.detectPromptInjection}
								onChange={() => handleInputToggle('detectPromptInjection')}
								theme={theme}
							/>

							{/* Structural Analysis */}
							<ToggleSetting
								label="Structural Analysis"
								description="Analyze prompt structure for hidden system sections, JSON/XML templates, and base64-encoded blocks"
								checked={llmGuardSettings.input.structuralAnalysis ?? true}
								onChange={() => handleInputToggle('structuralAnalysis')}
								theme={theme}
							/>

							{/* Invisible Character Detection */}
							<ToggleSetting
								label="Invisible Character Detection"
								description="Detect zero-width characters, RTL overrides, homoglyphs, and encoding attacks that could hide malicious content"
								checked={llmGuardSettings.input.invisibleCharacterDetection ?? true}
								onChange={() => handleInputToggle('invisibleCharacterDetection')}
								theme={theme}
							/>

							{/* URL Scanning */}
							<ToggleSetting
								label="Malicious URL Detection"
								description="Detect potentially malicious URLs including IP addresses, suspicious TLDs, punycode domains, and URL shorteners"
								checked={llmGuardSettings.input.scanUrls ?? true}
								onChange={() => handleInputToggle('scanUrls')}
								theme={theme}
							/>
						</div>
					</div>

					{/* Output Protection Section */}
					<div
						className="rounded-lg border p-4"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div
							className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<Unlock className="w-3 h-3" />
							Output Protection
						</div>
						<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
							Scan AI responses before displaying them and reverse anonymization.
						</p>

						<div className="space-y-3">
							{/* De-anonymize PII */}
							<ToggleSetting
								label="De-anonymize PII"
								description="Restore anonymized PII placeholders back to original values in AI responses"
								checked={llmGuardSettings.output.deanonymizePii}
								onChange={() => handleOutputToggle('deanonymizePii')}
								theme={theme}
							/>

							{/* Redact Secrets */}
							<ToggleSetting
								label="Redact Secrets"
								description="Scan AI output for any secrets that may have been generated or leaked"
								checked={llmGuardSettings.output.redactSecrets}
								onChange={() => handleOutputToggle('redactSecrets')}
								theme={theme}
							/>

							{/* Detect PII Leakage */}
							<ToggleSetting
								label="Detect PII Leakage"
								description="Flag AI responses that contain PII not present in the original input"
								checked={llmGuardSettings.output.detectPiiLeakage}
								onChange={() => handleOutputToggle('detectPiiLeakage')}
								theme={theme}
							/>

							{/* URL Scanning */}
							<ToggleSetting
								label="Malicious URL Detection"
								description="Scan AI responses for potentially malicious URLs that could lead to phishing or malware sites"
								checked={llmGuardSettings.output.scanUrls ?? true}
								onChange={() => handleOutputToggle('scanUrls')}
								theme={theme}
							/>

							{/* Code Scanning */}
							<ToggleSetting
								label="Dangerous Code Detection"
								description="Detect potentially dangerous code patterns like rm -rf, curl | bash, SQL injection, and access to sensitive files"
								checked={llmGuardSettings.output.scanCode ?? true}
								onChange={() => handleOutputToggle('scanCode')}
								theme={theme}
							/>
						</div>
					</div>

					{/* Group Chat Protection Section */}
					<div
						className="rounded-lg border p-4"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div
							className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<Users className="w-3 h-3" />
							Group Chat Protection
						</div>
						<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
							Protect agents in Group Chat from cross-agent prompt injection and data leakage.
						</p>

						<div className="space-y-3">
							{/* Inter-agent Scanning */}
							<ToggleSetting
								label="Inter-Agent Scanning"
								description="Scan messages between agents in Group Chat to prevent prompt injection chains and data leakage"
								checked={llmGuardSettings.groupChat?.interAgentScanEnabled ?? true}
								onChange={() => {
									updateLlmGuardSettings({
										groupChat: {
											...llmGuardSettings.groupChat,
											interAgentScanEnabled: !(
												llmGuardSettings.groupChat?.interAgentScanEnabled ?? true
											),
										},
									});
								}}
								theme={theme}
							/>
						</div>
					</div>

					{/* Thresholds Section */}
					<div
						className="rounded-lg border p-4"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div
							className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<ShieldAlert className="w-3 h-3" />
							Detection Thresholds
						</div>

						{/* Prompt Injection Confidence */}
						<div>
							<div className="flex items-center justify-between mb-2">
								<span className="text-sm" style={{ color: theme.colors.textMain }}>
									Prompt Injection Confidence
								</span>
								<span
									className="text-sm font-mono px-2 py-0.5 rounded"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors.textMain,
									}}
								>
									{(llmGuardSettings.thresholds.promptInjection * 100).toFixed(0)}%
								</span>
							</div>
							<input
								type="range"
								min={0.5}
								max={1.0}
								step={0.05}
								value={llmGuardSettings.thresholds.promptInjection}
								onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
								className="w-full"
							/>
							<div
								className="flex justify-between text-[10px] mt-1"
								style={{ color: theme.colors.textDim }}
							>
								<span>50% (Sensitive)</span>
								<span>75%</span>
								<span>100% (Strict)</span>
							</div>
							<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
								Higher values require more confidence to flag potential prompt injection. Lower
								values are more sensitive but may produce false positives.
							</p>
						</div>
					</div>

					{/* Banned Content Section */}
					<div
						className="rounded-lg border p-4"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div
							className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<Ban className="w-3 h-3" />
							Banned Content
						</div>
						<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
							Define custom content that should be blocked or flagged. These rules are applied in
							addition to the built-in security checks.
						</p>

						{/* Ban Substrings */}
						<div className="mb-4">
							<div className="flex items-center gap-2 mb-2">
								<Type className="w-3 h-3" style={{ color: theme.colors.textDim }} />
								<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Banned Substrings
								</span>
							</div>
							<textarea
								value={(llmGuardSettings.banSubstrings ?? []).join('\n')}
								onChange={(e) => handleBanSubstringsChange(e.target.value)}
								placeholder="Enter exact text to block (one per line)&#10;Example:&#10;confidential&#10;proprietary&#10;do-not-share"
								className="w-full h-24 p-2 rounded border text-xs font-mono resize-y"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
							<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
								Case-insensitive exact substring matching. Messages containing these strings will be
								flagged.
							</p>
						</div>

						{/* Ban Topic Patterns */}
						<div>
							<div className="flex items-center gap-2 mb-2">
								<Search className="w-3 h-3" style={{ color: theme.colors.textDim }} />
								<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Banned Topic Patterns
								</span>
							</div>
							<textarea
								value={(llmGuardSettings.banTopicsPatterns ?? []).join('\n')}
								onChange={(e) => handleBanTopicsPatternsChange(e.target.value)}
								placeholder="Enter regex patterns to block (one per line)&#10;Example:&#10;password\s*[:=]\s*\S+&#10;api[_-]?key&#10;secret.*token"
								className="w-full h-24 p-2 rounded border text-xs font-mono resize-y"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
							<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
								Case-insensitive regex patterns. Messages matching these patterns will be flagged.
								Invalid regex patterns are silently ignored.
							</p>
						</div>
					</div>

					{/* Custom Patterns Section */}
					<div
						className="rounded-lg border p-4"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div
							className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2 cursor-pointer"
							style={{ color: theme.colors.textMain }}
							onClick={() => setExpandedPatterns(!expandedPatterns)}
						>
							{expandedPatterns ? (
								<ChevronDown className="w-3 h-3" />
							) : (
								<ChevronRight className="w-3 h-3" />
							)}
							<Code className="w-3 h-3" />
							Custom Regex Patterns
							{(llmGuardSettings.customPatterns?.length ?? 0) > 0 && (
								<span
									className="px-1.5 py-0.5 rounded text-[10px]"
									style={{
										backgroundColor: theme.colors.accent + '30',
										color: theme.colors.accent,
									}}
								>
									{llmGuardSettings.customPatterns?.length}
								</span>
							)}
						</div>

						{expandedPatterns && (
							<>
								<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
									Define custom regex patterns to detect specific content. Patterns are applied to
									both input and output scanning.
								</p>

								{/* Import/Export/Add buttons */}
								<div className="flex items-center gap-2 mb-4">
									<button
										onClick={handleAddPattern}
										className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors"
										style={{
											backgroundColor: theme.colors.accent,
											color: 'white',
										}}
									>
										<Plus className="w-3 h-3" />
										Add Pattern
									</button>
									<button
										onClick={handleExportPatterns}
										disabled={(llmGuardSettings.customPatterns?.length ?? 0) === 0}
										className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textMain,
											borderColor: theme.colors.border,
										}}
									>
										<Download className="w-3 h-3" />
										Export
									</button>
									<label
										className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer"
										style={{
											backgroundColor: theme.colors.bgActivity,
											color: theme.colors.textMain,
											borderColor: theme.colors.border,
										}}
									>
										<Upload className="w-3 h-3" />
										Import
										<input
											ref={fileInputRef}
											type="file"
											accept=".json"
											onChange={handleImportPatterns}
											className="hidden"
										/>
									</label>
								</div>

								{/* Pattern Editor (when editing) */}
								{editingPattern && (
									<div
										className="mb-4 p-3 rounded border"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: theme.colors.accent,
										}}
									>
										<div
											className="text-xs font-medium mb-3"
											style={{ color: theme.colors.textMain }}
										>
											{editingPatternId === 'new' ? 'New Pattern' : 'Edit Pattern'}
										</div>

										{/* Name */}
										<div className="mb-3">
											<label
												className="block text-[10px] uppercase font-medium mb-1"
												style={{ color: theme.colors.textDim }}
											>
												Name *
											</label>
											<input
												type="text"
												value={editingPattern.name}
												onChange={(e) =>
													setEditingPattern({ ...editingPattern, name: e.target.value })
												}
												placeholder="e.g., Internal Project Code"
												className="w-full px-2 py-1.5 rounded border text-xs"
												style={{
													backgroundColor: theme.colors.bgMain,
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
										</div>

										{/* Pattern */}
										<div className="mb-3">
											<label
												className="block text-[10px] uppercase font-medium mb-1"
												style={{ color: theme.colors.textDim }}
											>
												Regex Pattern *
											</label>
											<input
												type="text"
												value={editingPattern.pattern}
												onChange={(e) => {
													setEditingPattern({ ...editingPattern, pattern: e.target.value });
													setPatternValidationError(null);
												}}
												placeholder="e.g., PROJECT-[A-Z]{3}-\d{4}"
												className="w-full px-2 py-1.5 rounded border text-xs font-mono"
												style={{
													backgroundColor: theme.colors.bgMain,
													borderColor: patternValidationError
														? theme.colors.error
														: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
											{patternValidationError && (
												<p className="text-[10px] mt-1" style={{ color: theme.colors.error }}>
													{patternValidationError}
												</p>
											)}
										</div>

										{/* Type and Action */}
										<div className="flex gap-3 mb-3">
											<div className="flex-1">
												<label
													className="block text-[10px] uppercase font-medium mb-1"
													style={{ color: theme.colors.textDim }}
												>
													Type
												</label>
												<select
													value={editingPattern.type}
													onChange={(e) =>
														setEditingPattern({
															...editingPattern,
															type: e.target.value as CustomPatternType,
														})
													}
													className="w-full px-2 py-1.5 rounded border text-xs"
													style={{
														backgroundColor: theme.colors.bgMain,
														borderColor: theme.colors.border,
														color: theme.colors.textMain,
													}}
												>
													<option value="secret">Secret</option>
													<option value="pii">PII</option>
													<option value="injection">Injection</option>
													<option value="other">Other</option>
												</select>
											</div>
											<div className="flex-1">
												<label
													className="block text-[10px] uppercase font-medium mb-1"
													style={{ color: theme.colors.textDim }}
												>
													Action
												</label>
												<select
													value={editingPattern.action}
													onChange={(e) =>
														setEditingPattern({
															...editingPattern,
															action: e.target.value as LlmGuardAction,
														})
													}
													className="w-full px-2 py-1.5 rounded border text-xs"
													style={{
														backgroundColor: theme.colors.bgMain,
														borderColor: theme.colors.border,
														color: theme.colors.textMain,
													}}
												>
													<option value="warn">Warn</option>
													<option value="sanitize">Sanitize</option>
													<option value="block">Block</option>
												</select>
											</div>
										</div>

										{/* Confidence */}
										<div className="mb-3">
											<label
												className="block text-[10px] uppercase font-medium mb-1"
												style={{ color: theme.colors.textDim }}
											>
												Confidence: {(editingPattern.confidence * 100).toFixed(0)}%
											</label>
											<input
												type="range"
												min={0.1}
												max={1.0}
												step={0.05}
												value={editingPattern.confidence}
												onChange={(e) =>
													setEditingPattern({
														...editingPattern,
														confidence: parseFloat(e.target.value),
													})
												}
												className="w-full"
											/>
										</div>

										{/* Description */}
										<div className="mb-3">
											<label
												className="block text-[10px] uppercase font-medium mb-1"
												style={{ color: theme.colors.textDim }}
											>
												Description (optional)
											</label>
											<input
												type="text"
												value={editingPattern.description || ''}
												onChange={(e) =>
													setEditingPattern({ ...editingPattern, description: e.target.value })
												}
												placeholder="Brief description of what this pattern detects"
												className="w-full px-2 py-1.5 rounded border text-xs"
												style={{
													backgroundColor: theme.colors.bgMain,
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
										</div>

										{/* Test Pattern */}
										<div
											className="mb-3 p-2 rounded"
											style={{ backgroundColor: theme.colors.bgMain }}
										>
											<label
												className="block text-[10px] uppercase font-medium mb-1"
												style={{ color: theme.colors.textDim }}
											>
												Test Pattern
											</label>
											<div className="flex gap-2 mb-2">
												<input
													type="text"
													value={testText}
													onChange={(e) => setTestText(e.target.value)}
													placeholder="Enter sample text to test..."
													className="flex-1 px-2 py-1.5 rounded border text-xs"
													style={{
														backgroundColor: theme.colors.bgActivity,
														borderColor: theme.colors.border,
														color: theme.colors.textMain,
													}}
												/>
												<button
													onClick={handleTestPattern}
													disabled={!editingPattern.pattern || !testText}
													className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
													style={{
														backgroundColor: theme.colors.accent,
														color: 'white',
													}}
												>
													<Play className="w-3 h-3" />
													Test
												</button>
											</div>
											{testResults && (
												<div
													className="text-[10px] p-2 rounded"
													style={{
														backgroundColor: theme.colors.bgActivity,
														color: testResults.error ? theme.colors.error : theme.colors.textMain,
													}}
												>
													{testResults.error ? (
														<>Error: {testResults.error}</>
													) : testResults.matches.length === 0 ? (
														<>No matches found</>
													) : (
														<>
															Found {testResults.matches.length} match(es):{' '}
															<code>{testResults.matches.join(', ')}</code>
														</>
													)}
												</div>
											)}
										</div>

										{/* Save/Cancel buttons */}
										<div className="flex gap-2">
											<button
												onClick={handleSavePattern}
												className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-colors"
												style={{
													backgroundColor: theme.colors.success,
													color: 'white',
												}}
											>
												<Check className="w-3 h-3" />
												Save
											</button>
											<button
												onClick={handleCancelEdit}
												className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-colors"
												style={{
													backgroundColor: theme.colors.bgMain,
													color: theme.colors.textMain,
													borderColor: theme.colors.border,
												}}
											>
												<X className="w-3 h-3" />
												Cancel
											</button>
										</div>
									</div>
								)}

								{/* Pattern List */}
								{(llmGuardSettings.customPatterns?.length ?? 0) > 0 && !editingPattern && (
									<div className="space-y-2">
										{llmGuardSettings.customPatterns?.map((pattern) => (
											<div
												key={pattern.id}
												className="flex items-center justify-between p-2 rounded border"
												style={{
													backgroundColor: theme.colors.bgActivity,
													borderColor: theme.colors.border,
													opacity: pattern.enabled ? 1 : 0.6,
												}}
											>
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-2">
														<span
															className="text-sm font-medium truncate"
															style={{ color: theme.colors.textMain }}
														>
															{pattern.name || 'Unnamed Pattern'}
														</span>
														<span
															className="px-1.5 py-0.5 rounded text-[9px] uppercase"
															style={{
																backgroundColor:
																	pattern.type === 'secret'
																		? theme.colors.error + '30'
																		: pattern.type === 'pii'
																			? theme.colors.warning + '30'
																			: pattern.type === 'injection'
																				? theme.colors.accent + '30'
																				: theme.colors.textDim + '30',
																color:
																	pattern.type === 'secret'
																		? theme.colors.error
																		: pattern.type === 'pii'
																			? theme.colors.warning
																			: pattern.type === 'injection'
																				? theme.colors.accent
																				: theme.colors.textDim,
															}}
														>
															{pattern.type}
														</span>
														<span
															className="px-1.5 py-0.5 rounded text-[9px] uppercase"
															style={{
																backgroundColor:
																	pattern.action === 'block'
																		? theme.colors.error + '30'
																		: pattern.action === 'sanitize'
																			? theme.colors.accent + '30'
																			: theme.colors.warning + '30',
																color:
																	pattern.action === 'block'
																		? theme.colors.error
																		: pattern.action === 'sanitize'
																			? theme.colors.accent
																			: theme.colors.warning,
															}}
														>
															{pattern.action}
														</span>
													</div>
													<div
														className="text-[10px] font-mono truncate mt-0.5"
														style={{ color: theme.colors.textDim }}
													>
														{pattern.pattern}
													</div>
												</div>
												<div className="flex items-center gap-1 ml-2">
													<button
														onClick={() => handleTogglePatternEnabled(pattern.id)}
														className="p-1.5 rounded transition-colors hover:bg-white/10"
														title={pattern.enabled ? 'Disable' : 'Enable'}
													>
														{pattern.enabled ? (
															<Check
																className="w-3.5 h-3.5"
																style={{ color: theme.colors.success }}
															/>
														) : (
															<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
														)}
													</button>
													<button
														onClick={() => handleEditPattern(pattern)}
														className="p-1.5 rounded transition-colors hover:bg-white/10"
														title="Edit"
													>
														<Edit2
															className="w-3.5 h-3.5"
															style={{ color: theme.colors.textDim }}
														/>
													</button>
													<button
														onClick={() => handleDeletePattern(pattern.id)}
														className="p-1.5 rounded transition-colors hover:bg-white/10"
														title="Delete"
													>
														<Trash2 className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />
													</button>
												</div>
											</div>
										))}
									</div>
								)}

								{/* Empty state */}
								{(llmGuardSettings.customPatterns?.length ?? 0) === 0 && !editingPattern && (
									<div
										className="text-center py-6 rounded border border-dashed"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
									>
										<Code className="w-8 h-8 mx-auto mb-2 opacity-50" />
										<p className="text-xs">No custom patterns defined</p>
										<p className="text-[10px] mt-1">
											Click "Add Pattern" to create your first custom pattern
										</p>
									</div>
								)}
							</>
						)}
					</div>

					{/* Notifications Section */}
					<div
						className="rounded-lg border p-4"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<div
							className="text-xs font-bold opacity-70 uppercase mb-3 flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<Bell className="w-3 h-3" />
							Notifications
						</div>
						<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
							Configure how LLM Guard alerts you about security events.
						</p>

						<div className="space-y-3">
							{/* Show Security Toasts */}
							<ToggleSetting
								label="Show Security Toasts"
								description="Display toast notifications when content is blocked, sanitized, or security warnings are triggered"
								checked={llmGuardSettings.showSecurityToasts !== false}
								onChange={() =>
									updateLlmGuardSettings({
										showSecurityToasts: !(llmGuardSettings.showSecurityToasts !== false),
									})
								}
								theme={theme}
							/>

							{/* Show Input Preview */}
							<ToggleSetting
								label="Show Real-Time Input Preview"
								description="Highlight sensitive content (PII, secrets) in the input area with visual pills before sending. Helps you see what will be anonymized."
								checked={llmGuardSettings.showInputPreview !== false}
								onChange={() =>
									updateLlmGuardSettings({
										showInputPreview: !(llmGuardSettings.showInputPreview !== false),
									})
								}
								theme={theme}
							/>
						</div>
					</div>
				</>
			)}
		</div>
	);
}

/**
 * Toggle setting component for individual protection options
 */
interface ToggleSettingProps {
	label: string;
	description: string;
	checked: boolean;
	onChange: () => void;
	theme: Theme;
}

function ToggleSetting({ label, description, checked, onChange, theme }: ToggleSettingProps) {
	return (
		<div
			className="flex items-center justify-between p-2 rounded cursor-pointer hover:bg-white/5 transition-colors"
			onClick={onChange}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onChange();
				}
			}}
		>
			<div className="flex-1 pr-3">
				<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{label}
				</div>
				<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
					{description}
				</div>
			</div>
			<button
				onClick={(e) => {
					e.stopPropagation();
					onChange();
				}}
				className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
				style={{
					backgroundColor: checked ? theme.colors.accent : theme.colors.bgActivity,
				}}
				role="switch"
				aria-checked={checked}
				aria-label={label}
			>
				<span
					className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
						checked ? 'translate-x-4' : 'translate-x-0.5'
					}`}
				/>
			</button>
		</div>
	);
}
