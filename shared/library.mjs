export const CURRENT_SCHEMA = 4;
export const THEMES = Object.freeze([
  Object.freeze({ id: 'forest', label: '森林' }),
  Object.freeze({ id: 'sand', label: '暖砂' }),
  Object.freeze({ id: 'slate', label: '雾蓝' }),
  Object.freeze({ id: 'night', label: '夜读' }),
]);
export const THEME_IDS = Object.freeze(THEMES.map(theme => theme.id));
export const DOCUMENT_DRAG_TYPE = 'application/x-paperdesk-document';
