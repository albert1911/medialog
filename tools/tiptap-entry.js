// Source for public/js/vendor/tiptap.js (the app has no build step, so the bundle is committed).
// Rebuild: npm i --no-save @tiptap/core @tiptap/starter-kit esbuild &&
//   npx esbuild tools/tiptap-entry.js --bundle --minify --format=esm --outfile=public/js/vendor/tiptap.js
export { Editor, Node } from '@tiptap/core';
export { StarterKit } from '@tiptap/starter-kit';
