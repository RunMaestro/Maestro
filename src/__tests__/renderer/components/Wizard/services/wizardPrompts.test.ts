/**
 * wizardPrompts.test.ts
 *
 * Unit tests for the structured output parser and utility functions in wizardPrompts.ts.
 * Tests parsing strategies, fallback handling, validation, color generation, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStructuredOutput,
  generateSystemPrompt,
  formatUserMessage,
  isReadyToProceed,
  getConfidenceColor,
  getInitialQuestion,
  STRUCTURED_OUTPUT_SCHEMA,
  STRUCTURED_OUTPUT_SUFFIX,
  READY_CONFIDENCE_THRESHOLD,
  type StructuredAgentResponse,
  type ParsedResponse,
  type SystemPromptConfig,
} from '../../../../../renderer/components/Wizard/services/wizardPrompts';

describe('wizardPrompts', () => {
  describe('Constants', () => {
    describe('READY_CONFIDENCE_THRESHOLD', () => {
      it('should be 80', () => {
        expect(READY_CONFIDENCE_THRESHOLD).toBe(80);
      });
    });

    describe('STRUCTURED_OUTPUT_SCHEMA', () => {
      it('should define confidence as number 0-100', () => {
        expect(STRUCTURED_OUTPUT_SCHEMA.properties.confidence.type).toBe('number');
        expect(STRUCTURED_OUTPUT_SCHEMA.properties.confidence.minimum).toBe(0);
        expect(STRUCTURED_OUTPUT_SCHEMA.properties.confidence.maximum).toBe(100);
      });

      it('should define ready as boolean', () => {
        expect(STRUCTURED_OUTPUT_SCHEMA.properties.ready.type).toBe('boolean');
      });

      it('should define message as string', () => {
        expect(STRUCTURED_OUTPUT_SCHEMA.properties.message.type).toBe('string');
      });

      it('should require all three fields', () => {
        expect(STRUCTURED_OUTPUT_SCHEMA.required).toEqual(['confidence', 'ready', 'message']);
      });
    });

    describe('STRUCTURED_OUTPUT_SUFFIX', () => {
      it('should contain JSON format instructions', () => {
        expect(STRUCTURED_OUTPUT_SUFFIX).toContain('JSON');
        expect(STRUCTURED_OUTPUT_SUFFIX).toContain('confidence');
        expect(STRUCTURED_OUTPUT_SUFFIX).toContain('ready');
        expect(STRUCTURED_OUTPUT_SUFFIX).toContain('message');
      });
    });
  });

  describe('parseStructuredOutput', () => {
    describe('Strategy 1: Direct JSON parse', () => {
      it('should parse valid JSON with all required fields', () => {
        const input = '{"confidence": 75, "ready": false, "message": "Hello!"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured).toEqual({
          confidence: 75,
          ready: false,
          message: 'Hello!',
        });
        expect(result.rawText).toBe(input);
      });

      it('should parse JSON with extra whitespace', () => {
        const input = '  {"confidence": 50, "ready": false, "message": "Test"}  ';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(50);
      });

      it('should parse JSON with newlines in message', () => {
        const input = '{"confidence": 60, "ready": false, "message": "Line 1\\nLine 2\\nLine 3"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.message).toBe('Line 1\nLine 2\nLine 3');
      });

      it('should handle JSON with unicode characters in message', () => {
        const input = '{"confidence": 45, "ready": false, "message": "Hello 🎼 Maestro! こんにちは"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.message).toBe('Hello 🎼 Maestro! こんにちは');
      });

      it('should parse JSON with decimal confidence', () => {
        const input = '{"confidence": 75.7, "ready": false, "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        // Confidence should be rounded
        expect(result.structured?.confidence).toBe(76);
      });
    });

    describe('Strategy 2: Extract from markdown code blocks', () => {
      it('should extract JSON from ```json code block', () => {
        const input = 'Here is my response:\n```json\n{"confidence": 65, "ready": false, "message": "What type of project?"}\n```';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(65);
        expect(result.structured?.message).toBe('What type of project?');
      });

      it('should extract JSON from ``` code block without language', () => {
        const input = '```\n{"confidence": 40, "ready": false, "message": "Tell me more"}\n```';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(40);
      });

      it('should handle code block with surrounding text', () => {
        const input = 'I understand. Here is my response:\n\n```json\n{"confidence": 55, "ready": false, "message": "Got it!"}\n```\n\nLet me know if you need more.';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(55);
      });

      it('should handle multiline JSON in code block', () => {
        const input = '```json\n{\n  "confidence": 70,\n  "ready": false,\n  "message": "Multiline works"\n}\n```';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(70);
      });
    });

    describe('Strategy 3: Find JSON with required fields pattern', () => {
      it('should find JSON object with all required fields in mixed text', () => {
        const input = 'Here is some text before {"confidence": 80, "ready": true, "message": "Ready to go!"} and some text after';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(80);
        expect(result.structured?.ready).toBe(true);
      });

      it('should handle JSON object with fields in different order', () => {
        const input = '{"message": "Different order", "ready": false, "confidence": 30}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(30);
        expect(result.structured?.message).toBe('Different order');
      });
    });

    describe('Strategy 4: Find any JSON object', () => {
      it('should find simple JSON object as last resort', () => {
        const input = 'Some text {"confidence": 25, "ready": false, "message": "Basic"} more text';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(25);
      });
    });

    describe('Fallback response creation', () => {
      it('should create fallback when no valid JSON found', () => {
        const input = 'This is just plain text with no JSON at all';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.parseError).toContain('fallback');
        expect(result.structured).not.toBeNull();
        expect(result.structured?.confidence).toBe(20); // Default confidence
        expect(result.structured?.ready).toBe(false);
        expect(result.structured?.message).toBe(input);
      });

      it('should extract confidence from "confidence: N" pattern', () => {
        const input = 'My confidence: 45 in this response';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.confidence).toBe(45);
      });

      it('should extract confidence from "N% confident" pattern', () => {
        const input = 'I am 60% confident that this will work';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.confidence).toBe(60);
      });

      it('should detect ready status from "ready to proceed" text', () => {
        const input = 'I am ready to proceed with confidence: 85';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.confidence).toBe(85);
        expect(result.structured?.ready).toBe(true);
      });

      it('should detect ready status from "ready to create" text', () => {
        const input = 'I am ready to create your action plan. confidence: 90';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.ready).toBe(true);
      });

      it('should detect ready status from "lets proceed" text', () => {
        const input = "Let's proceed! I have enough information. confidence: 82";
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.ready).toBe(true);
      });

      it('should detect not ready from "need more" text', () => {
        const input = 'I need more information about your project. confidence: 85';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.ready).toBe(false); // Even with high confidence, "need more" indicates not ready
      });

      it('should detect not ready from "clarify" text', () => {
        const input = 'Could you clarify what you mean? confidence: 90';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.ready).toBe(false);
      });

      it('should detect not ready from "question" text', () => {
        const input = 'I have a question about the scope. confidence: 85';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.ready).toBe(false);
      });

      it('should clean markdown code block artifacts from message', () => {
        const input = '```json\ninvalid json here\n```';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        // Should have removed the code block markers
        expect(result.structured?.message).not.toContain('```');
      });

      it('should use raw text as message when cleanup results in empty string', () => {
        const input = '{}'; // Invalid JSON (missing required fields), cleanup might empty it
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.message.length).toBeGreaterThan(0);
      });

      it('should not set ready=true when confidence is below threshold', () => {
        const input = 'I am ready to proceed with confidence: 50';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        expect(result.structured?.confidence).toBe(50);
        expect(result.structured?.ready).toBe(false); // Below 80 threshold
      });
    });

    describe('Normalization', () => {
      it('should clamp confidence to 0 minimum', () => {
        const input = '{"confidence": -10, "ready": false, "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(0);
      });

      it('should clamp confidence to 100 maximum', () => {
        const input = '{"confidence": 150, "ready": true, "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(100);
      });

      it('should round confidence to integer', () => {
        const input = '{"confidence": 67.4, "ready": false, "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(67);
      });

      it('should force ready=false when confidence < threshold even if ready=true', () => {
        const input = '{"confidence": 50, "ready": true, "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.ready).toBe(false);
      });

      it('should allow ready=true when confidence >= threshold', () => {
        const input = '{"confidence": 85, "ready": true, "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.ready).toBe(true);
      });

      it('should trim whitespace from message', () => {
        const input = '{"confidence": 50, "ready": false, "message": "  Lots of space  "}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.message).toBe('Lots of space');
      });
    });

    describe('Invalid JSON handling', () => {
      it('should handle JSON missing confidence field', () => {
        const input = '{"ready": false, "message": "Missing confidence"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
        // Falls back to text extraction
      });

      it('should handle JSON missing ready field', () => {
        const input = '{"confidence": 50, "message": "Missing ready"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
      });

      it('should handle JSON missing message field', () => {
        const input = '{"confidence": 50, "ready": false}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
      });

      it('should handle JSON with wrong type for confidence', () => {
        const input = '{"confidence": "high", "ready": false, "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
      });

      it('should handle JSON with wrong type for ready', () => {
        const input = '{"confidence": 50, "ready": "yes", "message": "Test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
      });

      it('should handle JSON with wrong type for message', () => {
        const input = '{"confidence": 50, "ready": false, "message": 123}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
      });

      it('should throw on null input (type safety boundary)', () => {
        // TypeScript prevents null at compile time, but runtime may pass invalid values
        // The function throws rather than masking the bug - this is intentional
        expect(() => parseStructuredOutput(null as unknown as string)).toThrow();
      });

      it('should handle empty string input', () => {
        const result = parseStructuredOutput('');

        expect(result.parseSuccess).toBe(false);
        expect(result.rawText).toBe('');
      });

      it('should handle malformed JSON', () => {
        const input = '{"confidence": 50, "ready": false, "message": "unclosed';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
      });

      it('should handle JSON array instead of object', () => {
        const input = '[50, false, "message"]';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(false);
      });
    });

    describe('Edge cases', () => {
      it('should handle very long messages', () => {
        const longMessage = 'A'.repeat(10000);
        const input = `{"confidence": 50, "ready": false, "message": "${longMessage}"}`;
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.message.length).toBe(10000);
      });

      it('should handle message with escaped quotes', () => {
        const input = '{"confidence": 50, "ready": false, "message": "He said \\"Hello\\""}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.message).toBe('He said "Hello"');
      });

      it('should handle message with backslashes', () => {
        const input = '{"confidence": 50, "ready": false, "message": "Path: C:\\\\Users\\\\test"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.message).toBe('Path: C:\\Users\\test');
      });

      it('should handle nested JSON in message (as string)', () => {
        const input = '{"confidence": 50, "ready": false, "message": "Config: {\\"key\\": \\"value\\"}"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.message).toContain('Config:');
      });

      it('should prefer first valid JSON when multiple present', () => {
        const input = '{"confidence": 40, "ready": false, "message": "First"} {"confidence": 90, "ready": true, "message": "Second"}';
        const result = parseStructuredOutput(input);

        // Strategy 3 or 4 should find the first valid JSON
        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(40); // First one wins
      });

      it('should handle confidence exactly at threshold (80)', () => {
        const input = '{"confidence": 80, "ready": true, "message": "Exactly at threshold"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(80);
        expect(result.structured?.ready).toBe(true);
      });

      it('should handle confidence just below threshold (79)', () => {
        const input = '{"confidence": 79, "ready": true, "message": "Just below threshold"}';
        const result = parseStructuredOutput(input);

        expect(result.parseSuccess).toBe(true);
        expect(result.structured?.confidence).toBe(79);
        expect(result.structured?.ready).toBe(false); // Forced to false
      });
    });
  });

  describe('generateSystemPrompt', () => {
    it('should include agent name in prompt', () => {
      const config: SystemPromptConfig = {
        agentName: 'My Cool Project',
        agentPath: '/path/to/project',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain('My Cool Project');
    });

    it('should include agent path in prompt', () => {
      const config: SystemPromptConfig = {
        agentName: 'Test',
        agentPath: '/Users/test/Projects/MyApp',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain('/Users/test/Projects/MyApp');
    });

    it('should use "this project" when agent name is empty', () => {
      const config: SystemPromptConfig = {
        agentName: '',
        agentPath: '/path',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain('this project');
    });

    it('should include JSON format instructions', () => {
      const config: SystemPromptConfig = {
        agentName: 'Test',
        agentPath: '/path',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain('JSON');
      expect(prompt).toContain('confidence');
      expect(prompt).toContain('ready');
      expect(prompt).toContain('message');
    });

    it('should include confidence threshold', () => {
      const config: SystemPromptConfig = {
        agentName: 'Test',
        agentPath: '/path',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain(String(READY_CONFIDENCE_THRESHOLD));
    });

    it('should include Maestro branding', () => {
      const config: SystemPromptConfig = {
        agentName: 'Test',
        agentPath: '/path',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain('Maestro');
    });

    it('should include directory restriction instructions', () => {
      const config: SystemPromptConfig = {
        agentName: 'Test',
        agentPath: '/specific/path',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain('ONLY create or modify files within this directory');
      expect(prompt).toContain('/specific/path');
    });

    it('should include example responses', () => {
      const config: SystemPromptConfig = {
        agentName: 'Test',
        agentPath: '/path',
      };
      const prompt = generateSystemPrompt(config);

      expect(prompt).toContain('Example Responses');
    });
  });

  describe('formatUserMessage', () => {
    it('should append structured output suffix', () => {
      const message = 'Hello, I want to build a web app';
      const formatted = formatUserMessage(message);

      expect(formatted).toContain(message);
      expect(formatted).toContain(STRUCTURED_OUTPUT_SUFFIX);
    });

    it('should preserve original message', () => {
      const message = 'Test message with special chars: <>&"\'';
      const formatted = formatUserMessage(message);

      expect(formatted.startsWith(message)).toBe(true);
    });

    it('should work with empty message', () => {
      const formatted = formatUserMessage('');

      expect(formatted).toBe(STRUCTURED_OUTPUT_SUFFIX);
    });

    it('should work with multiline message', () => {
      const message = 'Line 1\nLine 2\nLine 3';
      const formatted = formatUserMessage(message);

      expect(formatted).toContain('Line 1\nLine 2\nLine 3');
      expect(formatted).toContain('JSON');
    });
  });

  describe('isReadyToProceed', () => {
    it('should return true when ready=true and confidence >= 80', () => {
      const response: StructuredAgentResponse = {
        confidence: 85,
        ready: true,
        message: 'Ready!',
      };

      expect(isReadyToProceed(response)).toBe(true);
    });

    it('should return false when ready=false even with high confidence', () => {
      const response: StructuredAgentResponse = {
        confidence: 95,
        ready: false,
        message: 'Not ready yet',
      };

      expect(isReadyToProceed(response)).toBe(false);
    });

    it('should return false when confidence < 80 even if ready=true', () => {
      const response: StructuredAgentResponse = {
        confidence: 75,
        ready: true,
        message: 'Should not be ready',
      };

      expect(isReadyToProceed(response)).toBe(false);
    });

    it('should return true when confidence exactly 80 and ready=true', () => {
      const response: StructuredAgentResponse = {
        confidence: 80,
        ready: true,
        message: 'Exactly at threshold',
      };

      expect(isReadyToProceed(response)).toBe(true);
    });

    it('should return false when confidence exactly 79 and ready=true', () => {
      const response: StructuredAgentResponse = {
        confidence: 79,
        ready: true,
        message: 'Just below threshold',
      };

      expect(isReadyToProceed(response)).toBe(false);
    });

    it('should return false when both conditions are false', () => {
      const response: StructuredAgentResponse = {
        confidence: 30,
        ready: false,
        message: 'Not ready',
      };

      expect(isReadyToProceed(response)).toBe(false);
    });

    it('should return true at maximum confidence', () => {
      const response: StructuredAgentResponse = {
        confidence: 100,
        ready: true,
        message: 'Maximum confidence',
      };

      expect(isReadyToProceed(response)).toBe(true);
    });
  });

  describe('getConfidenceColor', () => {
    it('should return red for confidence 0', () => {
      const color = getConfidenceColor(0);
      // Hue 0 is red
      expect(color).toContain('hsl(0');
    });

    it('should return yellow for confidence 50', () => {
      const color = getConfidenceColor(50);
      // Hue 60 is yellow
      expect(color).toContain('hsl(60');
    });

    it('should return green for confidence 100', () => {
      const color = getConfidenceColor(100);
      // Hue 120 is green
      expect(color).toContain('hsl(120');
    });

    it('should return orange for confidence 25', () => {
      const color = getConfidenceColor(25);
      // Hue 30 is orange
      expect(color).toContain('hsl(30');
    });

    it('should return lime-green for confidence 75', () => {
      const color = getConfidenceColor(75);
      // Hue 90 is lime-green
      expect(color).toContain('hsl(90');
    });

    it('should clamp negative values to 0', () => {
      const color = getConfidenceColor(-10);
      expect(color).toContain('hsl(0');
    });

    it('should clamp values above 100 to 100', () => {
      const color = getConfidenceColor(150);
      expect(color).toContain('hsl(120');
    });

    it('should handle decimal values', () => {
      const color = getConfidenceColor(50.5);
      // Should be close to yellow (hue ~60)
      expect(color).toMatch(/hsl\(60\.?\d*, 80%, 45%\)/);
    });

    it('should have consistent saturation and lightness', () => {
      const colors = [0, 25, 50, 75, 100].map(getConfidenceColor);
      colors.forEach((color) => {
        expect(color).toContain('80%'); // Saturation
        expect(color).toContain('45%'); // Lightness
      });
    });

    it('should produce valid HSL format', () => {
      const color = getConfidenceColor(50);
      expect(color).toMatch(/^hsl\(\d+(\.\d+)?, \d+%, \d+%\)$/);
    });
  });

  describe('getInitialQuestion', () => {
    it('should return a non-empty string', () => {
      const question = getInitialQuestion();

      expect(typeof question).toBe('string');
      expect(question.length).toBeGreaterThan(0);
    });

    it('should ask about building or projects', () => {
      const question = getInitialQuestion();
      const lowerQuestion = question.toLowerCase();

      // The initial question should ask about what to build/create/work on
      // It may use various phrasings - check for common project-related words
      const projectKeywords = [
        'build',
        'project',
        'create',
        'working',
        'making',
        'vision',
        'idea',
        'code',
        'develop',
        'design',
        'construct',
        'craft',
        'architect',
        'engineer',
        'endeavor',
        'initiative',
        'mission',
        'goal',
        'plan',
        'concept',
        'dream',
        'agenda',
        'mind',
        'tackle',
        'conjuring',
        'manifest',
        'fabricating',
        'creation',
      ];
      const asksBuildQuestion = projectKeywords.some((kw) => lowerQuestion.includes(kw));
      expect(asksBuildQuestion).toBe(true);
    });

    it('should be a question', () => {
      const question = getInitialQuestion();

      expect(question).toContain('?');
    });
  });

  describe('Integration scenarios', () => {
    it('should handle realistic early conversation response', () => {
      const input = `{"confidence": 25, "ready": false, "message": "Nice to meet you! Let's figure out what you'd like to build.\\n\\nTo get started: What type of project is this? For example:\\n- A coding project (web app, CLI tool, library)?\\n- Research or documentation?\\n- Something else entirely?"}`;

      const result = parseStructuredOutput(input);

      expect(result.parseSuccess).toBe(true);
      expect(result.structured?.confidence).toBe(25);
      expect(result.structured?.ready).toBe(false);
      expect(isReadyToProceed(result.structured!)).toBe(false);
    });

    it('should handle realistic ready-to-proceed response', () => {
      const input = `{"confidence": 92, "ready": true, "message": "I have a clear picture now!\\n\\nYou want to build a React dashboard that:\\n- Connects to a fitness tracker API\\n- Displays daily steps, calories, and workout history\\n- Uses a clean, minimal design with dark mode support\\n- Includes charts for weekly/monthly trends\\n\\nI'm ready to create your action plan. Shall we proceed?"}`;

      const result = parseStructuredOutput(input);

      expect(result.parseSuccess).toBe(true);
      expect(result.structured?.confidence).toBe(92);
      expect(result.structured?.ready).toBe(true);
      expect(isReadyToProceed(result.structured!)).toBe(true);
    });

    it('should handle response wrapped in markdown by mistake', () => {
      const input = `Here's my response:

\`\`\`json
{
  "confidence": 55,
  "ready": false,
  "message": "A React dashboard for tracking fitness metrics - that sounds useful!\\n\\nA couple quick questions:\\n1. What data sources will it pull from? (API, manual entry, fitness tracker?)\\n2. Do you have a specific design or UI style in mind?"
}
\`\`\``;

      const result = parseStructuredOutput(input);

      expect(result.parseSuccess).toBe(true);
      expect(result.structured?.confidence).toBe(55);
      expect(result.structured?.ready).toBe(false);
    });

    it('should handle agent completely ignoring JSON format', () => {
      const input = `I understand you want to build a web application. Let me ask a few questions:

1. What technology stack do you prefer?
2. Is this for personal use or a business?
3. Do you have any design mockups?

I'm about 45% confident I understand your needs so far.`;

      const result = parseStructuredOutput(input);

      expect(result.parseSuccess).toBe(false);
      expect(result.structured?.confidence).toBe(45); // Extracted from text
      expect(result.structured?.ready).toBe(false); // Has questions
      expect(result.structured?.message).toContain('web application');
    });
  });
});
