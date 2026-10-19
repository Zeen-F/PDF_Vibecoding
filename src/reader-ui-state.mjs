// Focus mode changes visibility only. It never mutates saved panel preferences,
// document selection, draft contents, or the normal save queues.
export function readingPanels({ library, notes, navigation }, focused = false) {
  return { library: Boolean(library) && !focused, notes: Boolean(notes) && !focused,
    navigation: Boolean(navigation) && !focused };
}
