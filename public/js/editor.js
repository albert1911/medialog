import { Editor, Node, StarterKit } from './vendor/tiptap.js';

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

// Tags the editor can represent; content using anything else (embeds, tables…) opens in Source
// mode so it isn't silently stripped.
const SUPPORTED = new Set('p br h1 h2 h3 h4 h5 h6 strong b em i u s a ul ol li hr blockquote pre code div'.split(' '));

const isSupported = (html) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.body.querySelectorAll('*')].every((el) => SUPPORTED.has(el.localName)
    && (el.localName !== 'div' || el.className === 'card'));
};

const BUTTONS = [
  { id: 'h2', label: 'H2', title: 'Heading (Ctrl+Alt+2)', active: ['heading', { level: 2 }], run: (c) => c.toggleHeading({ level: 2 }) },
  { id: 'h3', label: 'H3', title: 'Subheading (Ctrl+Alt+3)', active: ['heading', { level: 3 }], run: (c) => c.toggleHeading({ level: 3 }) },
  { id: 'bold', label: 'B', title: 'Bold (Ctrl+B)', cls: 'ed-bold', active: ['bold'], run: (c) => c.toggleBold() },
  { id: 'italic', label: 'I', title: 'Italic (Ctrl+I)', cls: 'ed-italic', active: ['italic'], run: (c) => c.toggleItalic() },
  { id: 'link', label: 'Link', title: 'Link (Ctrl+K)', active: ['link'], run: null },
  { id: 'ul', label: '• List', title: 'Bulleted list (Ctrl+Shift+8)', active: ['bulletList'], run: (c) => c.toggleBulletList() },
  { id: 'ol', label: '1. List', title: 'Numbered list (Ctrl+Shift+7)', active: ['orderedList'], run: (c) => c.toggleOrderedList() },
  { id: 'quote', label: 'Quote', title: 'Quote (Ctrl+Shift+B)', active: ['blockquote'], run: (c) => c.toggleBlockquote() },
  { id: 'hr', label: 'HR', title: 'Divider', run: (c) => c.setHorizontalRule() },
  { id: 'card', label: 'Card', title: 'Card (Ctrl+Alt+C)', active: ['card'], run: (c) => c.toggleWrap('card') },
];

export function editorHTML() {
  const buttons = BUTTONS.map((b) =>
    `<button type="button" class="btn btn-small btn-ghost ${b.cls || ''}" data-action="${b.id}" title="${b.title}">${b.label}</button>`).join('');
  return `<div class="editor-bar" role="toolbar" aria-label="Formatting">${buttons}
    <button type="button" class="btn btn-small btn-ghost editor-source" aria-pressed="false" title="Edit the raw HTML">Source</button></div>
    <div class="rich-editor"></div>`;
}

export function bindEditor(root, textarea) {
  const bar = root.querySelector('.editor-bar');
  const host = root.querySelector('.rich-editor');
  const sourceBtn = bar.querySelector('.editor-source');
  const formatBtns = [...bar.querySelectorAll('[data-action]')];
  let editor = null;
  let sourceMode = false;

  const push = () => {
    const html = editor.isEmpty ? '' : editor.getHTML();
    if (html === textarea.value) return;
    textarea.value = html;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const refresh = () => {
    for (const b of BUTTONS) {
      const el = bar.querySelector(`[data-action="${b.id}"]`);
      el.classList.toggle('is-active', Boolean(editor && !sourceMode && b.active && editor.isActive(...b.active)));
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

  const setMode = (source) => {
    sourceMode = source;
    textarea.hidden = !source;
    host.hidden = source;
    sourceBtn.setAttribute('aria-pressed', String(source));
    formatBtns.forEach((b) => { b.disabled = source; });
    if (!source) editor.commands.setContent(textarea.value, { emitUpdate: false });
    refresh();
  };

  editor = new Editor({
    element: host,
    extensions: [StarterKit.configure({ link: { openOnClick: false }, trailingNode: false }), Card],
    content: textarea.value,
    editorProps: {
      attributes: { class: 'rich-content', 'aria-label': 'Content' },
      handleKeyDown: (_view, e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); editLink(); return true; }
        if (mod && e.altKey && e.code === 'KeyC') { e.preventDefault(); actions.card(); return true; }
        return false;
      },
    },
    onUpdate: push,
    onTransaction: refresh,
  });

  bar.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  bar.addEventListener('click', (e) => {
    if (e.target.closest('.editor-source')) {
      if (sourceMode && !isSupported(textarea.value)
        && !confirm('This HTML uses elements the editor cannot represent (embeds, tables…). Switching will remove them. Continue?')) return;
      setMode(!sourceMode);
      return;
    }
    const id = e.target.closest('[data-action]')?.dataset.action;
    if (id && !sourceMode) actions[id]();
  });

  setMode(textarea.value.trim() !== '' && !isSupported(textarea.value));
}
