// Reconstruct the exact pre-bookmark generated format from an empty-bookmark note.
// This is test data only; production never downgrades a formal file.
export function legacyVaultMarkdown(source, version) {
  return source.replace('paperdesk_format: 3', `paperdesk_format: ${version}`)
    .replace('## 页面书签\n\n（暂无页面书签）\n\n', '')
    .replace(/(<!-- paperdesk-state:v1\n)([^\n]*)(\n-->)/, (_all, start, serialized, end) => {
      const state = JSON.parse(serialized); state.version = version; delete state.bookmarks;
      return start + JSON.stringify(state).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') + end;
    });
}
