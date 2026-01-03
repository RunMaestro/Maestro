/**
 * wizardPrompts.ts
 *
 * System prompts and structured output parsing for the onboarding wizard's
 * AI-driven project discovery conversation.
 */

import { getRandomInitialQuestion } from './fillerPhrases';
import { wizardSystemPrompt, wizardSystemContinuationPrompt } from '../../../../prompts';
import { substituteTemplateVariables, type TemplateContext } from '../../../utils/templateVariables';

/**
 * Structured response format expected from the agent
 */
export interface StructuredAgentResponse {
  /** Confidence level (0-100) indicating how well the agent understands the project */
  confidence: number;
  /** Whether the agent feels ready to proceed with document generation */
  ready: boolean;
  /** The agent's message to display to the user */
  message: string;
}

/**
 * Result of parsing an agent response
 */
export interface ParsedResponse {
  /** The parsed structured response, or null if parsing failed */
  structured: StructuredAgentResponse | null;
  /** The raw response text (for fallback display) */
  rawText: string;
  /** Whether parsing was successful */
  parseSuccess: boolean;
  /** Error message if parsing failed */
  parseError?: string;
}

/**
 * Existing document from a previous wizard session
 */
export interface ExistingDocument {
  /** Document filename */
  filename: string;
  /** Document content */
  content: string;
}

/**
 * Configuration for generating the system prompt
 */
export interface SystemPromptConfig {
  /** Agent/project name provided by the user */
  agentName: string;
  /** Directory path where the agent will work */
  agentPath: string;
  /** Existing Auto Run documents (when continuing from previous session) */
  existingDocs?: ExistingDocument[];
}

/**
 * JSON schema for structured output (for documentation and validation)
 */
export const STRUCTURED_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Confidence level (0-100) indicating how well you understand the project goals and requirements',
    },
    ready: {
      type: 'boolean',
      description: 'Whether you feel ready to create a Playbook for this project',
    },
    message: {
      type: 'string',
      description: 'Your response message to the user (questions, clarifications, or confirmation)',
    },
  },
  required: ['confidence', 'ready', 'message'],
} as const;

/**
 * Suffix appended to each user message to remind the agent about JSON format
 */
export const STRUCTURED_OUTPUT_SUFFIX = `

IMPORTANT: Remember to respond ONLY with valid JSON in this exact format:
{"confidence": <0-100>, "ready": <true/false>, "message": "<your response>"}`;

/**
 * Default confidence level when parsing fails
 */
const DEFAULT_CONFIDENCE = 20;

/**
 * Threshold above which we consider the agent ready to proceed
 */
export const READY_CONFIDENCE_THRESHOLD = 80;

/**
 * Generate the system prompt for the wizard conversation
 *
 * @param config Configuration including agent name and path
 * @returns The complete system prompt for the agent
 */
export function generateSystemPrompt(config: SystemPromptConfig): string {
  const { agentName, agentPath, existingDocs } = config;
  const projectName = agentName || 'this project';

  // Build existing docs section if continuing from previous session
  let existingDocsSection = '';
  if (existingDocs && existingDocs.length > 0) {
    const docsContent = existingDocs.map(doc => `### ${doc.filename}\n\n${doc.content}\n`).join('\n---\n\n');
    existingDocsSection = wizardSystemContinuationPrompt.replace('{{EXISTING_DOCS}}', docsContent);
  }

  // First, handle wizard-specific variables that have different semantics
  // from the central template system. We do this BEFORE the central function
  // so they take precedence over central defaults.
  // - PROJECT_NAME: wizard uses user-provided agentName (or "this project"),
  //   not the path-derived name from the central system
  // - READY_CONFIDENCE_THRESHOLD: wizard-specific constant
  let prompt = wizardSystemPrompt
    .replace(/\{\{PROJECT_NAME\}\}/gi, projectName)
    .replace(/\{\{READY_CONFIDENCE_THRESHOLD\}\}/gi, String(READY_CONFIDENCE_THRESHOLD));

  // Build template context for remaining variables (date/time, etc.)
  const templateContext: TemplateContext = {
    session: {
      id: 'wizard',
      name: projectName,
      toolType: 'claude-code',
      cwd: agentPath,
      fullPath: agentPath,
    },
  };

  // Substitute any remaining template variables using the central function
  prompt = substituteTemplateVariables(prompt, templateContext);

  return prompt + existingDocsSection;
}

/**
 * Parse a structured response from the agent
 *
 * Attempts to extract JSON from the response, with multiple fallback strategies
 * for common formatting issues (markdown code blocks, extra text, etc.)
 *
 * @param response The raw response string from the agent
 * @returns ParsedResponse with structured data or fallback handling
 */
export function parseStructuredOutput(response: string): ParsedResponse {
  const rawText = response.trim();

  // Strategy 1: Try direct JSON parse
  try {
    const parsed = JSON.parse(rawText);
    if (isValidStructuredResponse(parsed)) {
      return {
        structured: normalizeResponse(parsed),
        rawText,
        parseSuccess: true,
      };
    }
  } catch {
    // Continue to next strategy
  }

  // Strategy 2: Extract JSON from markdown code blocks
  const codeBlockMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (isValidStructuredResponse(parsed)) {
        return {
          structured: normalizeResponse(parsed),
          rawText,
          parseSuccess: true,
        };
      }
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 3: Find JSON object pattern in text
  const jsonMatch = rawText.match(/\{[\s\S]*"confidence"[\s\S]*"ready"[\s\S]*"message"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (isValidStructuredResponse(parsed)) {
        return {
          structured: normalizeResponse(parsed),
          rawText,
          parseSuccess: true,
        };
      }
    } catch {
      // Continue to next strategy
    }
  }

  // Strategy 4: Find any JSON object pattern
  const anyJsonMatch = rawText.match(/\{[^{}]*\}/);
  if (anyJsonMatch) {
    try {
      const parsed = JSON.parse(anyJsonMatch[0]);
      if (isValidStructuredResponse(parsed)) {
        return {
          structured: normalizeResponse(parsed),
          rawText,
          parseSuccess: true,
        };
      }
    } catch {
      // Continue to fallback
    }
  }

  // Fallback: Create a response from the raw text
  return createFallbackResponse(rawText);
}

/**
 * Check if an object matches the expected structured response format
 */
function isValidStructuredResponse(obj: unknown): obj is StructuredAgentResponse {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const response = obj as Record<string, unknown>;

  // Check required fields exist with correct types
  const hasConfidence = typeof response.confidence === 'number';
  const hasReady = typeof response.ready === 'boolean';
  const hasMessage = typeof response.message === 'string';

  return hasConfidence && hasReady && hasMessage;
}

/**
 * Normalize a response to ensure valid ranges and types
 */
function normalizeResponse(response: StructuredAgentResponse): StructuredAgentResponse {
  return {
    confidence: Math.max(0, Math.min(100, Math.round(response.confidence))),
    ready: response.ready && response.confidence >= READY_CONFIDENCE_THRESHOLD,
    message: response.message.trim(),
  };
}

/**
 * Create a fallback response when parsing fails
 * Uses heuristics to extract useful information from raw text
 */
function createFallbackResponse(rawText: string): ParsedResponse {
  // Try to extract confidence from text patterns like "confidence: 50" or "50% confident"
  let confidence = DEFAULT_CONFIDENCE;
  const confidenceMatch = rawText.match(/confidence[:\s]*(\d+)/i) ||
    rawText.match(/(\d+)\s*%?\s*confiden/i);
  if (confidenceMatch) {
    const extractedConfidence = parseInt(confidenceMatch[1], 10);
    if (extractedConfidence >= 0 && extractedConfidence <= 100) {
      confidence = extractedConfidence;
    }
  }

  // Try to detect ready status from text
  const readyPatterns = /\b(ready to proceed|ready to create|let's proceed|shall we proceed|i'm ready)\b/i;
  const notReadyPatterns = /\b(need more|clarif|question|tell me more|could you explain)\b/i;

  let ready = false;
  if (confidence >= READY_CONFIDENCE_THRESHOLD && readyPatterns.test(rawText)) {
    ready = true;
  }
  if (notReadyPatterns.test(rawText)) {
    ready = false;
  }

  // Use the raw text as the message, cleaning up any JSON artifacts
  let message = rawText
    .replace(/```(?:json)?/g, '')
    .replace(/```/g, '')
    .replace(/^\s*\{[\s\S]*?\}\s*$/g, '') // Remove complete JSON blocks
    .trim();

  // If message is empty after cleanup, use a generic fallback
  if (!message) {
    message = rawText;
  }

  return {
    structured: {
      confidence,
      ready,
      message,
    },
    rawText,
    parseSuccess: false,
    parseError: 'Could not parse structured JSON response, using fallback extraction',
  };
}

/**
 * Get the initial question to display before the first agent response.
 * Returns a randomly selected variant for variety.
 */
export function getInitialQuestion(): string {
  return getRandomInitialQuestion();
}

/**
 * Format a user message with the structured output suffix
 *
 * @param userMessage The user's message
 * @returns The message with JSON format reminder appended
 */
export function formatUserMessage(userMessage: string): string {
  return userMessage + STRUCTURED_OUTPUT_SUFFIX;
}

/**
 * Check if a response indicates the agent is ready to proceed
 *
 * @param response The parsed structured response
 * @returns Whether the agent is ready (confidence >= threshold and ready=true)
 */
export function isReadyToProceed(response: StructuredAgentResponse): boolean {
  return response.ready && response.confidence >= READY_CONFIDENCE_THRESHOLD;
}

/**
 * Get the color for the confidence meter based on the level
 *
 * Green only appears at or above the ready threshold (80).
 * Below that, it transitions from red -> orange -> yellow.
 *
 * @param confidence The confidence level (0-100)
 * @returns HSL color string
 */
export function getConfidenceColor(confidence: number): string {
  // Clamp confidence to 0-100
  const clampedConfidence = Math.max(0, Math.min(100, confidence));

  // Color mapping based on ready threshold (80):
  // 0-40: red (0) -> orange (30)
  // 40-80: orange (30) -> yellow (60)
  // 80-100: green (120) - only green at/above threshold
  let hue: number;
  if (clampedConfidence >= READY_CONFIDENCE_THRESHOLD) {
    // At or above threshold: green
    hue = 120;
  } else if (clampedConfidence >= 40) {
    // 40-79: orange (30) -> yellow (60)
    hue = 30 + ((clampedConfidence - 40) / 40) * 30;
  } else {
    // 0-39: red (0) -> orange (30)
    hue = (clampedConfidence / 40) * 30;
  }

  return `hsl(${hue}, 80%, 45%)`;
}

// Export combined wizardPrompts object for convenient importing
export const wizardPrompts = {
  generateSystemPrompt,
  parseStructuredOutput,
  getInitialQuestion,
  formatUserMessage,
  isReadyToProceed,
  getConfidenceColor,
  STRUCTURED_OUTPUT_SCHEMA,
  STRUCTURED_OUTPUT_SUFFIX,
  READY_CONFIDENCE_THRESHOLD,
};
