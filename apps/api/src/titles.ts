/**
 * A suggested title for a clip, taken from the clip's own words. This is a plain rule, not a model: of the sentences in the clip it
 * picks the one that reads most like a headline (a question, a hook such as "Here's why", a number, strong wording, a sensible
 * length), cleans it up and shortens it. It never makes up words that were not said.
 */
const MAX_TITLE_CHARS = 70;
export const HOOK_START = /^(?:here(?:'s| is)|what if|the truth is|you need to|let me show you|most people|this is why|imagine|stop|never|why|how to|how i|the secret|the biggest|nobody|everyone|did you know|listen|if you|\d+ (?:ways|things|reasons|tips|mistakes|steps|rules))\b/i;
const EMPHATIC = /\b(?:amazing|best|breakthrough|critical|essential|powerful|unbelievable|surprising|incredible|never|always|huge|secret|biggest|worst|mistake|truth)\b/i;
const NUMBER = /\b\d+(?:[.,]\d+)?(?:%|x)?\b/;
/** Spoken filler that is not worth keeping at the start of a title ("So, the thing is..."). */
export const LEADING_FILLER = /^(?:(?:and|but|so|well|um+|uh+|er|yeah|yes|okay|ok|right|like|then|also|because|or|now|anyway|basically|actually)\b[,.]?\s+)+/i;

const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length;

function sentenceScore(sentence: string, position: number): number {
  const trimmed = sentence.replace(LEADING_FILLER, '');
  let score = 0;
  if (/\?$/.test(trimmed)) score += 3;
  if (HOOK_START.test(trimmed)) score += 3;
  if (NUMBER.test(trimmed)) score += 2;
  if (EMPHATIC.test(trimmed)) score += 2;
  if (trimmed.length >= 25 && trimmed.length <= 90) score += 1;
  if (trimmed.length > 140) score -= 2;
  if (trimmed.length < 15) score -= 2;
  if (position === 0) score += 1; // all else equal, the opening of the clip says what it is about
  return score;
}

function shorten(text: string): string {
  if (text.length <= MAX_TITLE_CHARS) return text;
  const cut = text.slice(0, MAX_TITLE_CHARS + 1);
  const lastSpace = cut.lastIndexOf(' ');
  const head = (lastSpace > MAX_TITLE_CHARS * 0.5 ? cut.slice(0, lastSpace) : text.slice(0, MAX_TITLE_CHARS)).replace(/[\s,;:–—-]+$/, '');
  return `${head}…`;
}

/** The title for the words of a clip, or null when there is nothing to base one on. */
export function suggestTitle(texts: string[]): string | null {
  const sentences = texts.join(' ').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter((sentence) => wordsIn(sentence.replace(LEADING_FILLER, '')) >= 3);
  if (!sentences.length) return null;
  let best = 0; let bestScore = Number.NEGATIVE_INFINITY;
  sentences.forEach((sentence, index) => { const score = sentenceScore(sentence, index); if (score > bestScore) { best = index; bestScore = score; } });
  let title = sentences[best].replace(LEADING_FILLER, '').replace(/[.…]+$/, '').trim();
  if (!title) return null;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return shorten(title);
}
