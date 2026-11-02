// Source for public/js/vendor/tiptap.js (the app has no build step, so the bundle is committed).
// Rebuild: npm i --no-save @tiptap/core @tiptap/pm @tiptap/starter-kit @tiptap/extension-text-align esbuild &&
//   npx esbuild tools/tiptap-entry.js --bundle --minify --format=esm --outfile=public/js/vendor/tiptap.js
export { Editor, Extension, Node } from '@tiptap/core';
export { Plugin, PluginKey } from '@tiptap/pm/state';
export { Decoration, DecorationSet } from '@tiptap/pm/view';
export { StarterKit } from '@tiptap/starter-kit';
export { TextAlign } from '@tiptap/extension-text-align';
