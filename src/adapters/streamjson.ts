// Shared stream-json line classifier.
//
// Each CLI's stream-json shape differs (codebuddy / qoder / gemini all have
// their own event names), and the exact shapes are only verifiable on the
// user's Mac (see MILESTONES.md §8). So this classifier is deliberately
// tolerant: it maps what it recognises and keeps everything else as a
// `message` event with the raw payload — never drops a line, never crashes
// on an unknown shape.
import type { AdapterEventType, UnifiedEvent } from './types.js';

const TYPE_PATTERNS: Array<[RegExp, AdapterEventType]> = [
  [/tool_call|tool_use|function_call|^tool$/i, 'tool_call'],
  [/file_edit|^edit$|^write$|create_file|apply_patch/i, 'file_edit'],
  [/cost|^usage$|token_usage|tokens/i, 'cost'],
  [/message|text|assistant|result|^output$|completion/i, 'message'],
];

export function classifyStreamLine(line: string): UnifiedEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const ts = new Date().toISOString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: 'message', payload: { text: line }, ts };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { type: 'message', payload: { value: parsed }, ts };
  }
  const obj = parsed as Record<string, unknown>;
  const typeField =
    typeof obj.type === 'string'
      ? obj.type
      : typeof obj.event === 'string'
        ? obj.event
        : typeof obj.kind === 'string'
          ? obj.kind
          : null;
  if (typeField) {
    for (const [re, type] of TYPE_PATTERNS) {
      if (re.test(typeField)) return { type, payload: obj, ts };
    }
  }
  // Key-based fallbacks for shapes without a type field.
  if (typeof obj.tool === 'string' || typeof obj.toolName === 'string' || obj.functionCall) {
    return { type: 'tool_call', payload: obj, ts };
  }
  if (obj.usage && typeof obj.usage === 'object') {
    return { type: 'cost', payload: obj, ts };
  }
  return { type: 'message', payload: obj, ts };
}
