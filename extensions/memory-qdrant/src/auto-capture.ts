import type { CapturedCategory } from "./types.ts";

// ============================================================================
// Auto-Capture: Trigger Patterns
// ============================================================================

/**
 * Patterns that indicate text worth capturing.
 * Includes both English and Portuguese patterns.
 */
export const MEMORY_TRIGGERS = [
  // Explicit memory requests
  /\b(remember|remind\s+me|don['']?t\s+forget|please\s+remember|note\s+this|save\s+this|log\s+this|track\s+this|remember\s+that|lembra|lembre|guarda|salva|anota|memoriza|memorizar|memoria|não\s+esquece|nao\s+esquece|não\s+esquecer|nao\s+esquecer|por\s+favor\s+lembra|por\s+favor\s+lembre)\b/i,
  // Preferences
  /\b(prefer|prefiro|gosto|não gosto|odeio|adoro|quero|não quero)\b/i,
  /\b(i like|i love|i hate|i prefer|i want|i need)\b/i,
  // Decisions
  /\b(decidimos|decidiu|vamos usar|escolhi|optei)\b/i,
  /\b(decided|will use|going to use|chose|picked)\b/i,
  // Entities (phone, email, names)
  /\+\d{10,}/, // Phone numbers
  /[\w.-]+@[\w.-]+\.\w{2,}/, // Emails
  /\b(meu nome é|me chamo|sou o|sou a)\b/i,
  /\b(my name is|i am called|call me)\b/i,
  // Facts with possessives
  /\b(meu|minha|meus|minhas)\s+\w+\s+(é|são|fica|mora)/i,
  /\b(my|our)\s+\w+\s+(is|are|lives|works)/i,
  // Important qualifiers
  /\b(sempre|nunca|importante|crucial|essencial)\b/i,
  /\b(always|never|important|crucial|essential)\b/i,
  // Timezone and location
  /\b(moro em|trabalho em|fuso horário|timezone)\b/i,
  /\b(i live in|i work at|my timezone)\b/i,
];

/**
 * Patterns that indicate text should NOT be captured.
 */
export const MEMORY_EXCLUSIONS = [
  // System/tool output
  /<[^>]+>/, // XML tags
  /```[\s\S]*?```/, // Code blocks (non-greedy to handle multiple blocks)
  /^\s*[-*]\s+/m, // Markdown lists (likely tool output)
  // Agent confirmations
  /\b(pronto|feito|ok|certo|entendi|anotado)\b.*!?\s*$/i,
  /\b(done|got it|noted|understood|saved)\b.*!?\s*$/i,
  // Questions (don't capture questions, capture answers)
  /\?\s*$/,
  // Very short or very long
  /^.{0,14}$/, // Less than 15 chars
  /^.{501,}$/, // More than 500 chars
];

/**
 * Check if text should be captured as a memory.
 */
export function shouldCapture(text: string): boolean {
  // Check exclusions first (faster)
  for (const pattern of MEMORY_EXCLUSIONS) {
    if (pattern.test(text)) {
      return false;
    }
  }

  // Skip if already contains memory injection
  if (text.includes("<relevant-memories>")) {
    return false;
  }

  // Skip emoji-heavy content (likely agent output)
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }

  // Check if any trigger matches
  for (const pattern of MEMORY_TRIGGERS) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return false;
}

/**
 * Detect memory category based on content.
 */
export function detectCategory(text: string): CapturedCategory {
  const lower = text.toLowerCase();

  if (/prefer|prefiro|gosto|like|love|hate|want|quero|odeio|adoro/i.test(lower)) {
    return "preference";
  }

  if (
    /decidimos|decided|will use|vamos usar|escolhi|chose|projeto|project|feature|roadmap|meta|objetivo/i.test(
      lower,
    )
  ) {
    return "project";
  }

  if (/\+\d{10,}|@[\w.-]+\.\w+|nome é|name is|chamo|called|moro|sou|trabalho/i.test(lower)) {
    return "personal";
  }

  return "other";
}
