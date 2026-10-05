const LEGACY_SEPARATOR = '\n\n---\n\n';

// Keep both legacy fields verbatim, including whitespace and existing Markdown.
export function mergeNotes(notesZh = '', notesEn = '') {
  if (!notesZh) return notesEn;
  if (!notesEn) return notesZh;
  return `${notesZh}${LEGACY_SEPARATOR}${notesEn}`;
}

export const MAX_NOTE_LENGTH = 500_000 + LEGACY_SEPARATOR.length;
