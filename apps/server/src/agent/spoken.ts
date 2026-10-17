const MAX_SPOKEN_CHARACTERS = 300;

/** Make model and fallback replies readable aloud without changing their meaning. */
export function cleanSpokenReply(value: string): string {
  const cleaned = value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(^|\s)[-*+]\s+/g, "$1")
    .replace(/[`*_~>#]/g, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= MAX_SPOKEN_CHARACTERS) return cleaned;
  const limit = MAX_SPOKEN_CHARACTERS - 1;
  const boundary = cleaned.lastIndexOf(" ", limit);
  return `${cleaned.slice(0, boundary > 0 ? boundary : limit).trimEnd()}…`;
}
