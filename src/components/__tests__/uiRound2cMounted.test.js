/**
 * ui-2c item 1, MOUNTED: the suggestion editor stays mounted while the user
 * types and while the key registry changes. There is no DOM library in this
 * project, so a minimal DOM (enough for react-dom/client) is installed here,
 * and the MUI components are replaced by plain elements: what is tested is
 * the editor's own state and the key guard, not MUI.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import React from 'react';

// ——— the plain stand-ins for MUI ———
const fields = vi.hoisted(() => new Map());
vi.mock('@mui/material', async () => {
  const ReactLib = await import('react');
  const h = ReactLib.createElement;
  const plain = (tag) => ({ children }) => h(tag, null, children);
  return {
    Box: plain('div'),
    Stack: plain('div'),
    Card: plain('div'),
    CardContent: plain('div'),
    List: plain('ul'),
    ListItem: ({ children, id }) => h('li', { id }, children),
    ListItemText: ({ primary, secondary }) => h('div', null, primary, secondary),
    Typography: plain('span'),
    Chip: ({ label }) => h('span', null, label),
    Alert: ({ children }) => h('div', { role: 'alert' }, children),
    MenuItem: ({ children }) => h('span', null, children),
    Button: ({ children, onClick }) => h('button', { onClick }, children),
    TextField: (props) => {
      if (props.select) return h('div', null, props.children);
      fields.set(props.label, props);
      return h('input', { 'aria-label': props.label, value: props.value, readOnly: true });
    }
  };
});

// ——— a minimal DOM ———
class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
  }

  get firstChild() { return this.childNodes[0] || null; }

  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }

  set textContent(value) {
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  addEventListener() {}

  removeEventListener() {}
}
class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.nodeName = '#text';
    this.data = String(data);
  }

  get nodeValue() { return this.data; }

  set nodeValue(v) { this.data = String(v); }

  get textContent() { return this.data; }

  set textContent(v) { this.data = String(v); }
}
class FakeElement extends FakeNode {
  constructor(doc, tag, ns) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.nodeName = this.tagName;
    this.localName = tag;
    this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
    this.attrs = {};
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }

  removeAttribute(k) { delete this.attrs[k]; }

  hasAttribute(k) { return Object.hasOwn(this.attrs, k); }

  focus() { this.ownerDocument.activeElement = this; }

  blur() {}

  all() { return this.childNodes.flatMap((c) => (c instanceof FakeElement ? [c, ...c.all()] : [])); }
}
const installDom = () => {
  const doc = new FakeNode(null);
  Object.assign(doc, {
    nodeType: 9,
    nodeName: '#document',
    createElement: (tag) => new FakeElement(doc, tag),
    createElementNS: (ns, tag) => new FakeElement(doc, tag, ns),
    createTextNode: (text) => new FakeText(doc, text),
    createComment: (text) => new FakeText(doc, text)
  });
  doc.ownerDocument = null;
  doc.documentElement = doc.appendChild(new FakeElement(doc, 'html'));
  doc.head = doc.documentElement.appendChild(new FakeElement(doc, 'head'));
  doc.body = doc.documentElement.appendChild(new FakeElement(doc, 'body'));
  doc.activeElement = doc.body;
  const win = {
    document: doc,
    navigator: { userAgent: 'node' },
    location: { hash: '' },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    HTMLElement: FakeElement,
    HTMLIFrameElement: class {},
    Node: FakeNode
  };
  doc.defaultView = win;
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', win.navigator);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLIFrameElement', win.HTMLIFrameElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return doc;
};

let doc;
let createRoot;
let act;
let SuggestionsPanel;
let HIDDEN_HEADING_NOTE;
let DRAFT_HIDDEN_NOTE;
let keyGuard;

beforeAll(async () => {
  doc = installDom();
  // react-dom/client decides at load time whether a DOM exists, so it is loaded now
  ({ createRoot } = await import('react-dom/client'));
  ({ act } = await import('react'));
  ({ SuggestionsPanel, HIDDEN_HEADING_NOTE, DRAFT_HIDDEN_NOTE } = await import('../InitialSuggestions'));
  keyGuard = await import('../../services/keyGuard');
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  fields.clear();
  keyGuard.resetKeyRegistry();
});

const SECRET = 'sk-live-ABCDEFGH1234';
const suggest = (heading) => ({
  subjectAnalysis: '', suggestMode: 'json', suggestions: [{ id: 's1', heading, kind: 'topical', reason: '', source: 'ai' }]
});

/** Mount the live Suggestions panel with s1's editor open. */
const mountEditor = async (heading, onEdit = () => ({ ok: true })) => {
  const container = doc.body.appendChild(doc.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(SuggestionsPanel, { suggest: suggest(heading), editable: true, onEdit, editingId: 's1' }));
  });
  const input = () => container.all().find((el) => el.tagName === 'INPUT' && el.getAttribute('aria-label') === 'Search heading');
  const type = (value) => act(async () => { fields.get('Search heading').onChange({ target: { value } }); });
  const unmount = () => act(async () => root.unmount());
  return { container, input, type, unmount };
};

describe('[ui-2c item 1] the editor guards the ACTUAL draft while it stays mounted', () => {
  it('the reviewer\'s scenario: open, append " — History", then the key is stored → the input no longer contains it', async () => {
    const editor = await mountEditor(SECRET);
    expect(editor.input().value).toBe(SECRET); // no key known yet: the heading is ordinary text
    await editor.type(`${SECRET} — History`);
    expect(editor.input().value).toBe(`${SECRET} — History`);
    // Settings saves a key equal to the original heading while the editor is mounted
    await act(async () => { keyGuard.setStoredKeys([SECRET]); });
    expect(editor.input().value).not.toContain(SECRET);
    expect(editor.input().value).toBe(''); // EMPTY, never the replacement text
    expect(editor.input().value).not.toBe(keyGuard.HIDDEN_TEXT);
    expect(editor.container.textContent).toContain(HIDDEN_HEADING_NOTE);
    expect(editor.container.textContent).not.toContain(SECRET);
    // The emptied draft stays empty even after the key is removed again
    await act(async () => { keyGuard.setStoredKeys([]); });
    expect(editor.input().value).toBe('');
    await editor.unmount();
  });

  it('typing a key into the draft empties it at once', async () => {
    await act(async () => { keyGuard.setStoredKeys([SECRET]); });
    const editor = await mountEditor('Cats');
    expect(editor.input().value).toBe('Cats');
    await editor.type(`Cats ${SECRET}`);
    expect(editor.input().value).toBe('');
    expect(editor.container.textContent).toContain(DRAFT_HIDDEN_NOTE);
    expect(editor.container.textContent).not.toContain(SECRET);
    await editor.unmount();
  });

  it('Apply after the draft was emptied sends no key and no replacement text', async () => {
    const sent = [];
    const editor = await mountEditor(SECRET, (edit) => { sent.push(edit); return { ok: false, error: 'Enter a heading.' }; });
    await editor.type(`${SECRET} — History`);
    await act(async () => { keyGuard.setStoredKeys([SECRET]); });
    const apply = editor.container.all().find((el) => el.tagName === 'BUTTON' && el.textContent === 'Apply');
    expect(apply).toBeTruthy();
    // The Button stand-in passes onClick through; React keeps it in its props
    const propsKey = Object.keys(apply).find((k) => k.startsWith('__reactProps'));
    await act(async () => { apply[propsKey].onClick(); });
    expect(sent).toHaveLength(1);
    expect(sent[0].heading).toBe('');
    await editor.unmount();
  });

  it('control: an ordinary typed draft is kept', async () => {
    await act(async () => { keyGuard.setStoredKeys(['an-unrelated-key-123']); });
    const editor = await mountEditor('Cats');
    await editor.type('Cats — History');
    expect(editor.input().value).toBe('Cats — History');
    await editor.unmount();
  });
});
