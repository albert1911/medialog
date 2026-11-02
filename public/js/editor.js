import { iconSVG } from './icons.js';
import { Decoration, DecorationSet, Editor, Extension, Node, Plugin, PluginKey, StarterKit, TextAlign } from './vendor/tiptap.js';

// A rich-text editor (Tiptap) for the entry's content. The stored value stays HTML: the editor
// keeps the form's <textarea name="content"> in sync, and "Source" swaps back to that textarea.
// Markdown shortcuts work while typing (## heading, - list, > quote, --- divider, **bold**, *italic*).

const Card = Node.create({
  name: 'card',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'div.card' }],
  renderHTML: () => ['div', { class: 'card' }, 0],
});

// Obsidian-style folding: a chevron on each top-level heading hides everything below it up to the
// next heading of the same or a higher level. Fold state lives in the editor only, never in the HTML.
const foldKey = new PluginKey('headingFold');

const Fold = Extension.create({
  name: 'headingFold',
  addProseMirrorPlugins: () => [new Plugin({
    key: foldKey,
    state: {
      init: () => [],
      apply(tr, folded) {
        const toggled = tr.getMeta(foldKey);
        const mapped = tr.docChanged ? folded.map((pos) => tr.mapping.map(pos)) : folded;
        const valid = mapped.filter((pos) => tr.doc.nodeAt(pos)?.type.name === 'heading');
        if (toggled === undefined) return valid;
        return valid.includes(toggled) ? valid.filter((pos) => pos !== toggled) : [...valid, toggled];
      },
    },
    props: {
      decorations(state) {
        const folded = foldKey.getState(state);
        const decos = [];
        let hideUntil = null; // level of the folded heading whose body is being hidden
        state.doc.forEach((node, pos) => {
          const isHeading = node.type.name === 'heading';
          if (hideUntil !== null && !(isHeading && node.attrs.level <= hideUntil)) {
            if (node.type.name !== 'horizontalRule') decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'fold-hidden' }));
            return;
          }
          hideUntil = null;
          if (!isHeading) return;
          const isFolded = folded.includes(pos);
          if (isFolded) hideUntil = node.attrs.level;
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: isFolded ? 'is-folded' : '' }));
          decos.push(Decoration.widget(pos + node.nodeSize - 1, (view) => {
            const btn = document.createElement('span');
            btn.className = 'fold-toggle';
            btn.contentEditable = 'false';
            btn.title = isFolded ? 'Expand section' : 'Collapse section';
            btn.addEventListener('mousedown', (e) => {
              e.preventDefault();
              view.dispatch(view.state.tr.setMeta(foldKey, pos));
            });
            return btn;
          }, { side: 1, key: `fold-${pos}-${isFolded}` }));
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  })],
});

const BUTTONS = [
  { id: 'h2', label: 'H2', title: 'Heading (Ctrl+Alt+2)', active: ['heading', { level: 2 }], run: (c) => c.toggleHeading({ level: 2 }) },
  { id: 'h3', label: 'H3', title: 'Subheading (Ctrl+Alt+3)', active: ['heading', { level: 3 }], run: (c) => c.toggleHeading({ level: 3 }) },
  { id: 'bold', icon: 'bold', title: 'Bold (Ctrl+B)', cls: 'ed-bold', active: ['bold'], run: (c) => c.toggleBold() },
  { id: 'italic', icon: 'italic', title: 'Italic (Ctrl+I)', cls: 'ed-italic', active: ['italic'], run: (c) => c.toggleItalic() },
  { id: 'underline', icon: 'underline', title: 'Underline (Ctrl+U)', cls: 'ed-underline', active: ['underline'], run: (c) => c.toggleUnderline() },
  { id: 'link', icon: 'link', title: 'Link (Ctrl+K)', active: ['link'], run: null },
  { id: 'ul', icon: 'ul', title: 'Bulleted list (Ctrl+Shift+8)', active: ['bulletList'], run: (c) => c.toggleBulletList() },
  { id: 'ol', icon: 'ol', title: 'Numbered list (Ctrl+Shift+7)', active: ['orderedList'], run: (c) => c.toggleOrderedList() },
  { id: 'quote', icon: 'quote', title: 'Quote (Ctrl+Shift+B)', active: ['blockquote'], run: (c) => c.toggleBlockquote() },
  { id: 'left', icon: 'left', title: 'Align left (Ctrl+Shift+L)', active: [{ textAlign: 'left' }], run: (c) => c.setTextAlign('left') },
  { id: 'center', icon: 'center', title: 'Align center (Ctrl+Shift+E)', active: [{ textAlign: 'center' }], run: (c) => c.setTextAlign('center') },
  { id: 'right', icon: 'right', title: 'Align right (Ctrl+Shift+R)', active: [{ textAlign: 'right' }], run: (c) => c.setTextAlign('right') },
  { id: 'hr', icon: 'hr', title: 'Divider', run: (c) => c.setHorizontalRule() },
  { id: 'card', icon: 'card', title: 'Card (Ctrl+Alt+C)', active: ['card'], run: (c) => c.toggleWrap('card') },
];

export function editorHTML() {
  const buttons = BUTTONS.map((b) =>
    `<button type="button" class="btn btn-small btn-ghost ${b.cls || ''}" data-action="${b.id}" title="${b.title}" aria-label="${b.title}">${b.icon ? iconSVG(b.icon) : b.label}</button>`).join('');
  return `<div class="editor-bar" role="toolbar" aria-label="Formatting">${buttons}</div>
    <div class="rich-editor"></div>`;
}

// Keeps the caret about a third of the way down the scrolling container while typing, so long
// content never needs manual scrolling.
function followCaret(editor, bar) {
  if (!editor.view.hasFocus()) return;
  const scroller = bar.closest('.container') || document.scrollingElement;
  const { head } = editor.state.selection;
  const caret = editor.view.coordsAtPos(head);
  const box = scroller === document.scrollingElement
    ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
  const top = Math.max(box.top, 0) + bar.offsetHeight;
  const target = top + (Math.min(box.bottom, innerHeight) - top) * 0.33;
  const delta = caret.bottom - target;
  if (Math.abs(delta) > 4) scroller.scrollBy({ top: delta });
}

export function bindEditor(root, textarea) {
  const bar = root.querySelector('.editor-bar');
  const host = root.querySelector('.rich-editor');
  let editor = null;

  const push = () => {
    const html = editor.isEmpty ? '' : editor.getHTML();
    if (html === textarea.value) return;
    textarea.value = html;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const refresh = () => {
    for (const b of BUTTONS) {
      const el = bar.querySelector(`[data-action="${b.id}"]`);
      el.classList.toggle('is-active', Boolean(editor && b.active && editor.isActive(...b.active)));
    }
  };

  const editLink = () => {
    const current = editor.getAttributes('link').href || 'https://';
    const url = prompt('Link URL (empty removes the link)', current);
    if (url === null) return;
    const chain = editor.chain().focus().extendMarkRange('link');
    (url.trim() ? chain.setLink({ href: url.trim() }) : chain.unsetLink()).run();
  };

  const actions = {
    link: editLink,
    ...Object.fromEntries(BUTTONS.filter((b) => b.run).map((b) => [b.id, () => b.run(editor.chain().focus()).run()])),
  };

  editor = new Editor({
    element: host,
    extensions: [StarterKit.configure({ link: { openOnClick: false }, trailingNode: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }), Card, Fold],
    content: textarea.value,
    editorProps: {
      attributes: { class: 'rich-content', 'aria-label': 'Content' },
      handleKeyDown: (_view, e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); editLink(); return true; }
        if (mod && e.altKey && e.code === 'KeyC') { e.preventDefault(); actions.card(); return true; }
        if (e.key.startsWith('Arrow') || e.key.startsWith('Page')) requestAnimationFrame(() => followCaret(editor, bar));
        return false;
      },
    },
    onUpdate: () => { push(); followCaret(editor, bar); },
    onTransaction: refresh,
  });

  bar.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  bar.addEventListener('click', (e) => {
    const id = e.target.closest('[data-action]')?.dataset.action;
    if (id) actions[id]();
  });
  refresh();
}
