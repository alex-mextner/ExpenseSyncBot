/**
 * Detects a model's own reasoning written into the answer text: English notes about the
 * conversation ("We have a conversation where the user…", "Let's produce final answer.") inside a
 * reply to a Russian question. gpt-oss-120b (then served by Groq) did this on stage (PR #170 QA, 2026-10-15).
 */

/** English words in one passage before it counts as prose, not a name or a short quote. */
const MIN_ENGLISH_PASSAGE_WORDS = 12;
/** Russian words in a row that end an English passage; a name or two inside one does not. */
const RUSSIAN_RUN_WORDS = 3;
/**
 * Distinct meta phrases a passage needs: one ("we need to") is ordinary English — a translation
 * the user asked for — while leaked reasoning talks about the task again and again.
 */
const MIN_META_PHRASES = 2;

/**
 * Phrases a model uses when it talks about the task instead of answering it, as one alternation:
 * matches are counted without overlap, so "we need to check" is one phrase, not two.
 */
const META_PHRASES =
  /\b(?:we have a conversation|the user (?:asks|asked|wants|repeatedly|is asking)|the assistant|we need to|we must|need to (?:answer|correct|produce|call|check|respond)|let'?s (?:produce|answer|craft|compute|check|respond)|let me|i need to|i should|final answer|tool results?)\b/gi;

const CYRILLIC = /[\u0400-\u04ff]/;

/**
 * The user asked for a translation into English or an English answer: English prose is then the
 * answer. Not "перевод"/"переведи в евро": in an expense bot that is a transfer or a conversion.
 */
const ASKS_FOR_ENGLISH =
  /переведи(?:те)?[^.?!\n]{0,40}английск|на английск|по-английски|in english|translate/i;

/**
 * The first English passage of meta-reasoning in `answer`, or null. Only for a question written in
 * Russian: in an English conversation such phrases can be the answer itself. `question` is the
 * agent's input, `"<user name>: <text>"`; only the text decides the language.
 */
export function findReasoningLeak(answer: string, question: string): string | null {
  const questionText = question.replace(/^[^:\n]{1,64}:\s*/, '');
  // Russian = more Cyrillic than Latin letters: an English question may name a Russian category.
  const cyrillicLetters = questionText.match(/[\u0400-\u04ff]/g)?.length ?? 0;
  const latinLetters = questionText.match(/[A-Za-z]/g)?.length ?? 0;
  if (cyrillicLetters <= latinLetters || ASKS_FOR_ENGLISH.test(questionText)) return null;
  // Only visible prose counts: quoted material — <blockquote>/<code>/<pre> blocks and «…», "…",
  // “…” — is what the answer cites (a comment, a merchant), not the model talking about the task.
  // Every step is one linear pass: model output can be long and malformed.
  const unquoted = withoutQuotedBlocks(answer).replace(/«[^«»]*»|"[^"\n]*"|“[^“”]*”/g, ' ');
  // gpt-oss's own channel tokens (harmony format) are never part of an answer — HF_MODEL is
  // configurable and the HF Router can serve that family.
  const channel = unquoted.indexOf('<|channel|>');
  if (channel !== -1) return unquoted.slice(channel);
  const prose = withoutTags(unquoted).replace(/\s+/g, ' ');

  // One linear pass over the words: a passage is the English text between runs of 3+ Russian
  // words, so line breaks and a Russian category name inside reasoning do not split it.
  let passageStart = -1;
  let englishWords = 0;
  let russianRun = 0;
  let lastEnglishEnd = 0;
  const check = (): string | null => {
    if (passageStart === -1 || englishWords < MIN_ENGLISH_PASSAGE_WORDS) return null;
    const passage = prose.slice(passageStart, lastEnglishEnd);
    const phrases = new Set(passage.match(META_PHRASES)?.map((m) => m.toLowerCase())).size;
    return phrases >= MIN_META_PHRASES ? passage.trim() : null;
  };
  for (const word of prose.matchAll(/[A-Za-z\u0400-\u04ff][A-Za-z\u0400-\u04ff'’-]*/g)) {
    if (CYRILLIC.test(word[0])) {
      russianRun++;
      if (russianRun < RUSSIAN_RUN_WORDS) continue;
      const found = check();
      if (found) return found;
      passageStart = -1;
      englishWords = 0;
      continue;
    }
    russianRun = 0;
    if (passageStart === -1) passageStart = word.index;
    englishWords++;
    lastEnglishEnd = word.index + word[0].length;
  }
  return check();
}

/**
 * `text` without the contents of <blockquote>, <code> and <pre> blocks; an unclosed block runs to
 * the end (still streaming). One forward pass: each search starts where the last one stopped.
 */
function withoutQuotedBlocks(text: string): string {
  const opening = /<(blockquote|code|pre)\b[^<>]*>/gi;
  // Case-insensitive closers, built once: lowercasing the text per block would be quadratic and
  // can shift offsets (`İ` lowercases to two code points).
  const closers: Record<string, RegExp> = {
    blockquote: /<\/blockquote>/gi,
    code: /<\/code>/gi,
    pre: /<\/pre>/gi,
  };
  let out = '';
  let from = 0;
  for (let m = opening.exec(text); m; m = opening.exec(text)) {
    out += `${text.slice(from, m.index)} `;
    const closing = closers[(m[1] ?? '').toLowerCase()];
    if (!closing) break;
    closing.lastIndex = opening.lastIndex;
    if (!closing.exec(text)) return out;
    from = closing.lastIndex;
    opening.lastIndex = from;
  }
  return out + text.slice(from);
}

/**
 * `text` with every tag (`<` … the next `>`, no `<` between) removed without a trace, so a tag
 * inside a word keeps the word whole; a `<` or `>` that is not part of a tag becomes a space.
 * A single walk instead of a regex replace (CodeQL js/incomplete-multi-character-sanitization);
 * the result is only counted, never shown or sent. Linear: each index search moves forward only.
 */
function withoutTags(text: string): string {
  let out = '';
  let from = 0;
  let nextOpen = text.indexOf('<');
  let nextClose = text.indexOf('>');
  while (nextOpen !== -1) {
    out += text.slice(from, nextOpen);
    if (nextClose !== -1 && nextClose < nextOpen) nextClose = text.indexOf('>', nextOpen);
    const following = text.indexOf('<', nextOpen + 1);
    if (nextClose !== -1 && (following === -1 || nextClose < following)) {
      from = nextClose + 1; // a tag: dropped
    } else {
      out += ' '; // a lone '<'
      from = nextOpen + 1;
    }
    nextOpen = following;
  }
  return (out + text.slice(from)).replaceAll('>', ' ');
}
