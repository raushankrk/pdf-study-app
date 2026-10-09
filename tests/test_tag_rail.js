// ============================================================================
// tests/test_tag_rail.js
// Regression suite: Tag option per PDF + quick-switch tag rail.
//
// Feature contract:
//   * Every PDF can be tagged/untagged (file ⋮ menu → Tag, row tag badge).
//   * While the left sidebar is collapsed, a narrow rail shows one colored
//     chip per tagged PDF: first 3 letters of the name, per-PDF color.
//   * Tapping a chip opens that PDF in a usable viewport (respecting
//     minimized/locked panes) and resumes its last reading position.
//   * Tags persist across reloads; deleting a doc untags it.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STATE_JS = path.join(ROOT, 'static', 'js', 'state.js');
const PDF_JS = path.join(ROOT, 'static', 'js', 'pdf.js');
const DATABASE_JS = path.join(ROOT, 'static', 'js', 'database.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const FILEMANAGER_JS = path.join(ROOT, 'static', 'js', 'filemanager.js');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = assert;
assert.deepStrictEqual = (a, b, msg) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(msg || `deep mismatch:\n      got:  ${sa}\n      want: ${sb}`);
};

// Previously shipped cache-busting strings — the version must keep moving.
const SHIPPED_CSS_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13', 'posresume-v14', 'ftorient-v20'];

// ---------------------------------------------------------------------------
// DOM stubs
// ---------------------------------------------------------------------------
function makeEl(tag = 'div') {
    const el = {
        tag, children: [], style: {}, dataset: {}, title: '', type: '',
        textContent: '', innerHTML: '',
        _classes: new Set(),
        get className() { return [...this._classes].join(' '); },
        set className(c) { this._classes = new Set(String(c).split(/\s+/).filter(Boolean)); },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener() {},
        getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    };
    el.classList = {
        add: (...c) => c.forEach(x => el._classes.add(x)),
        remove: (...c) => c.forEach(x => el._classes.delete(x)),
        toggle: (c, f) => { if (f === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); } else if (f) el._classes.add(c); else el._classes.delete(c); },
        contains: (c) => el._classes.has(c),
    };
    return el;
}

function makeSandbox(initial = {}) {
    const elsById = {};
    const stateStub = Object.assign({
        documents: initial.documents || {},
        taggedDocIds: initial.taggedDocIds || [],
        view: {
            left: Object.assign({ docId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }, initial.left),
            right: Object.assign({ docId: null, pageNum: 1, scale: 1.5, scrollTop: 0, locked: false }, initial.right),
        },
        lastActiveSide: 'left',
        fileSelection: { docIds: new Set(), folderIds: new Set() },
    }, initial.extra || {});

    const documentStub = {
        _els: elsById,
        getElementById: (id) => elsById[id] || null,
        createElement: (tag) => makeEl(tag),
        querySelectorAll: () => [],
        body: { appendChild: () => {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
    };
    if (initial.ids) Object.keys(initial.ids).forEach(id => { elsById[id] = initial.ids[id]; });

    const sandbox = {
        state: stateStub,
        document: documentStub,
        window: { addEventListener: () => {} },
        console,
        saveSettings: () => { sandbox.__saves = (sandbox.__saves || 0) + 1; },
        renderDocList: () => { sandbox.__docListRenders = (sandbox.__docListRenders || 0) + 1; },
        escapeHtml: (s) => String(s),
        showModal: () => {},
        pushRecentDoc: () => {},
        setActiveDocument: () => {},
        ROOT_FOLDER_ID: 'root',
        MAX_RECENT_DOCS: 10,
        __opened: [],
    };
    vm.createContext(sandbox);
    return sandbox;
}

function loadFileManager(sb) {
    const src = fs.readFileSync(FILEMANAGER_JS, 'utf8');
    vm.runInContext(src, sb, { filename: 'filemanager.js' });
}
function makeDoc(id, name, pages = 5) {
    return { id, name: name || `${id}.pdf`, pageCount: pages, pageIds: [], favorite: false, fileSize: 100 };
}

// ===============================================================
console.log('\nSuite 1 — index.html structure + wiring');
const html = fs.readFileSync(INDEX_HTML, 'utf8');
const fmSrc = fs.readFileSync(FILEMANAGER_JS, 'utf8');
const pdfSrc = fs.readFileSync(PDF_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const dbSrc = fs.readFileSync(DATABASE_JS, 'utf8');
const uiSrc = fs.readFileSync(UI_JS, 'utf8');
const css = fs.readFileSync(STYLE_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments

test('1.1 #tag-rail exists exactly once, after the left sidebar', () => {
    assert.strictEqual((html.split('id="tag-rail"').length - 1), 1, '#tag-rail must exist exactly once');
    const sidebarEnd = html.indexOf('</aside>', html.indexOf('id="left-sidebar"'));
    const railPos = html.indexOf('id="tag-rail"');
    const workspace = html.indexOf('id="workspace-main"');
    assert.ok(railPos > sidebarEnd && railPos < workspace,
        'rail must sit between #left-sidebar and the workspace (flex sibling)');
});

test('1.2 Cache-busting version bumped past every previously-shipped string', () => {
    const m = /style\.css\?v=([^"]+)"/.exec(html);
    assert(m, 'style.css has a cache-busting version param');
    assert.ok(!SHIPPED_CSS_VERSIONS.includes(m[1]),
        `version must move past all shipped strings (got ${m[1]})`);
});

test('1.3 pdf.js renderDocList re-renders the tag rail', () => {
    assert.ok(/if \(typeof renderTagRail === 'function'\) renderTagRail\(\);/.test(pdfSrc),
        'renderDocList hook present so every doc event refreshes the rail');
});

// ===============================================================
console.log('\nSuite 2 — state init + persistence wiring');

test('2.1 state.taggedDocIds starts as an empty array', () => {
    const sb = { console, window: {}, document: { createElement: () => ({ getContext: () => ({}) }) } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(STATE_JS, 'utf8'), sb, { filename: 'state.js' });
    const st = vm.runInContext('state', sb); // const is context-scoped
    assert.deepStrictEqual(st.taggedDocIds, [], 'taggedDocIds: []');
});

test('2.2 saveSettings persists taggedDocIds (filtered to existing docs)', () => {
    assert.ok(/taggedDocIds:\s*\(Array\.isArray\(state\.taggedDocIds\)/.test(dbSrc),
        'settings payload includes taggedDocIds');
    assert.ok(/\.filter\(id => state\.documents\[id\]\)/.test(dbSrc),
        'payload filters deleted docs');
});

test('2.3 boot restores taggedDocIds and drops deleted docs', () => {
    assert.ok(/settings\.taggedDocIds/.test(appSrc), 'boot reads settings.taggedDocIds');
    assert.ok(/state\.taggedDocIds = savedData\.settings\.taggedDocIds\.filter\(id => state\.documents\[id\]\)/.test(appSrc),
        'boot filters to existing docs');
});

test('2.4 deleting a doc untags it; clearAllData resets tags', () => {
    assert.ok(/state\.taggedDocIds = state\.taggedDocIds\.filter\(x => x !== id\);/.test(fmSrc),
        '_deleteDocumentRecord untags');
    assert.ok(/state\.taggedDocIds = \[\];/.test(uiSrc), 'clearAllData resets taggedDocIds');
});

// ===============================================================
console.log('\nSuite 3 — tag helpers (isDocTagged / docTagColor / docTagShort / toggleDocTag)');

test('3.1 docTagShort: first 3 letters, uppercase, safe fallback', () => {
    const sb = makeSandbox();
    loadFileManager(sb);
    assert.strictEqual(sb.docTagShort('report.pdf'), 'REP');
    assert.strictEqual(sb.docTagShort('AI Survey 2024.pdf'), 'AI ');
    assert.strictEqual(sb.docTagShort('  ab.pdf'), 'AB.', 'trim then slice keeps literal 3 chars');
    assert.strictEqual(sb.docTagShort(''), 'PDF');
    assert.strictEqual(sb.docTagShort(null), 'PDF');
});

test('3.2 docTagColor: deterministic, palette-bound, distinct ids get colors', () => {
    const sb = makeSandbox();
    loadFileManager(sb);
    const palette = vm.runInContext('TAG_CHIP_COLORS', sb);
    assert.ok(palette.length >= 8, 'palette has enough distinct colors');
    const c1 = sb.docTagColor('doc_aaa');
    assert.strictEqual(c1, sb.docTagColor('doc_aaa'), 'same id -> same color (stable)');
    assert.ok(palette.includes(c1), 'color comes from the palette');
    // Several different ids must not all collapse onto one color.
    const colors = new Set(['doc_a', 'doc_b', 'doc_c', 'doc_d', 'doc_e', 'doc_f'].map(sb.docTagColor));
    assert.ok(colors.size >= 3, 'ids spread across the palette');
});

test('3.3 toggleDocTag: tags, untags, persists, re-renders; ignores unknown docs', () => {
    const sb = makeSandbox({ documents: { d1: makeDoc('d1', 'alpha.pdf') } });
    loadFileManager(sb);
    sb.toggleDocTag('d1');
    assert.deepStrictEqual(sb.state.taggedDocIds, ['d1'], 'tagged');
    assert.strictEqual(sb.__saves >= 1, true, 'settings persisted');
    assert.ok(sb.__docListRenders >= 1, 'explorer + rail re-rendered');
    sb.toggleDocTag('d1');
    assert.deepStrictEqual(sb.state.taggedDocIds, [], 'untagged');
    const before = sb.state.taggedDocIds.length;
    sb.toggleDocTag('missing');                 // no such doc — no-op
    assert.strictEqual(sb.state.taggedDocIds.length, before, 'unknown doc ignored');
});

test('3.4 isDocTagged reflects membership', () => {
    const sb = makeSandbox({ documents: { d1: makeDoc('d1') }, taggedDocIds: ['d1'] });
    loadFileManager(sb);
    assert.strictEqual(sb.isDocTagged('d1'), true);
    assert.strictEqual(sb.isDocTagged('nope'), false);
});

// ===============================================================
console.log('\nSuite 4 — renderTagRail chips');

test('4.1 empty: hint icon only, no chips, tooltip explains how to tag', () => {
    const rail = makeEl('aside');
    const sb = makeSandbox({ ids: { 'tag-rail': rail } });
    loadFileManager(sb);
    sb.renderTagRail();
    assert.strictEqual(rail.children.length, 1, 'only the pin/hint head');
    assert.ok(rail.children[0].className.includes('tag-rail-head'), 'head is the pin icon');
    assert.ok(/Tag a PDF/.test(rail.title), 'tooltip teaches how to tag');
});

test('4.2 chips: one per tagged doc, first-3-letters, per-doc color, tooltip', () => {
    const rail = makeEl('aside');
    const sb = makeSandbox({
        ids: { 'tag-rail': rail },
        documents: {
            d1: makeDoc('d1', 'alpha-report.pdf'),
            d2: makeDoc('d2', 'survey.pdf'),
        },
        taggedDocIds: ['d1', 'd2'],
    });
    loadFileManager(sb);
    sb.renderTagRail();
    const chips = rail.children.filter(c => c.className.includes('tag-chip'));
    assert.strictEqual(chips.length, 2, 'two chips');
    assert.strictEqual(chips[0].textContent, 'ALP', 'first 3 letters of alpha-report.pdf');
    assert.strictEqual(chips[1].textContent, 'SUR', 'first 3 letters of survey.pdf');
    assert.ok(/#[0-9a-f]{6}/i.test(chips[0].style.background), 'chip has a background color');
    assert.ok(/alpha-report\.pdf/.test(chips[0].title), 'tooltip shows full name');
    assert.ok(chips[0].dataset.docId === 'd1', 'chip carries docId');
});

test('4.3 active ring: chips of PDFs open in a viewport are marked', () => {
    const rail = makeEl('aside');
    const sb = makeSandbox({
        ids: { 'tag-rail': rail },
        documents: { d1: makeDoc('d1', 'a.pdf'), d2: makeDoc('d2', 'b.pdf') },
        taggedDocIds: ['d1', 'd2'],
        left: { docId: 'd1' },
    });
    loadFileManager(sb);
    sb.renderTagRail();
    const chips = rail.children.filter(c => c.className.includes('tag-chip'));
    assert.ok(chips[0].classList.contains('tag-chip-active'), 'open doc ringed');
    assert.ok(!chips[1].classList.contains('tag-chip-active'), 'closed doc not ringed');
});

test('4.4 tapping a chip opens that PDF (openDocumentSmart routing + resume)', () => {
    const rail = makeEl('aside');
    const sb = makeSandbox({
        ids: { 'tag-rail': rail },
        documents: { d1: makeDoc('d1', 'a.pdf'), d2: makeDoc('d2', 'b.pdf') },
        taggedDocIds: ['d1', 'd2'],
    });
    loadFileManager(sb);
    // Replace the real openDocumentSmart binding with a recorder.
    vm.runInContext('openDocumentSmart = (id) => { __opened.push(id); }', sb);
    sb.renderTagRail();
    const chips = rail.children.filter(c => c.className.includes('tag-chip'));
    chips[1].onclick();
    assert.deepStrictEqual(sb.__opened, ['d2'], 'chip tap routed to openDocumentSmart');
});

test('4.5 deleted docs disappear from the rail without touching the tag list', () => {
    const rail = makeEl('aside');
    const sb = makeSandbox({
        ids: { 'tag-rail': rail },
        documents: { d1: makeDoc('d1', 'a.pdf') }, // d2 deleted from disk
        taggedDocIds: ['d1', 'd2'],
    });
    loadFileManager(sb);
    sb.renderTagRail();
    const chips = rail.children.filter(c => c.className.includes('tag-chip'));
    assert.strictEqual(chips.length, 1, 'only existing docs get chips');
    assert.strictEqual(chips[0].dataset.docId, 'd1');
});

test('4.6 color collision resolution: two colliding ids still render distinct chips', () => {
    const rail = makeEl('aside');
    const sb = makeSandbox({
        ids: { 'tag-rail': rail },
        documents: { d1: makeDoc('d1', 'a.pdf'), d2: makeDoc('d2', 'b.pdf') },
        taggedDocIds: ['d1', 'd2'],
    });
    loadFileManager(sb);
    // Force BOTH ids onto the same palette color to simulate a hash collision.
    vm.runInContext('docTagColor = () => TAG_CHIP_COLORS[0];', sb);
    sb.renderTagRail();
    const chips = rail.children.filter(c => c.className.includes('tag-chip'));
    assert.strictEqual(chips.length, 2);
    const bg1 = chips[0].style.background, bg2 = chips[1].style.background;
    assert.ok(bg1 !== bg2, `chips must be visually distinct (got ${bg1} vs ${bg2})`);
    const palette = vm.runInContext('TAG_CHIP_COLORS', sb);
    assert.ok(palette.includes(bg2), 'shifted color still comes from the palette');
});

// ===============================================================
console.log('\nSuite 5 — context menu + row badge + CSS wiring');

test('5.1 context menu has a Tag/Untag item wired to toggleDocTag', () => {
    assert.ok(/data-action="tag"><i class="fa-solid fa-tag"><\/i> \$\{isDocTagged\(docId\) \? 'Untag' : 'Tag'\}/.test(fmSrc),
        'menu item label flips with tag state');
    assert.ok(/action === 'tag'\) toggleDocTag\(docId\);/.test(fmSrc), 'menu handler wires toggleDocTag');
});

test('5.2 file rows show a tag badge (click to untag) only when tagged', () => {
    assert.ok(/isDocTagged\(doc\.id\)/.test(fmSrc), 'row badge gated on tag state');
    assert.ok(/Tagged — click to untag/.test(fmSrc), 'badge tooltip present');
    assert.ok(/tree-tag/.test(fmSrc) && /\.tree-tag \{ color: #2563eb; \}/.test(css),
        'badge class + CSS hook present');
});

test('5.3 CSS: rail hidden by default, visible only when sidebar collapsed', () => {
    assert.ok(/#tag-rail \{[^}]*display:\s*none/.test(css), 'rail display:none by default');
    assert.ok(/body\.left-sidebar-collapsed #tag-rail \{ display:\s*flex;?\s*\}/.test(css),
        'rail becomes flex under body.left-sidebar-collapsed');
});

test('5.4 CSS: touch devices get bigger chips (40px) and a wider rail', () => {
    // Extract every touch media block via brace matching, then check the rules inside.
    const blocks = [];
    const re = /@media \(hover: none\), \(pointer: coarse\) \{/g;
    let m;
    while ((m = re.exec(css)) !== null) {
        let depth = 1, i = re.lastIndex;
        for (; i < css.length && depth > 0; i++) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') depth--;
        }
        blocks.push(css.slice(re.lastIndex, i - 1));
    }
    assert.ok(blocks.length >= 1, 'at least one touch media block exists');
    const touch = blocks.join('\n');
    assert.ok(/#tag-rail \{ width: 52px; \}/.test(touch), 'rail widened on touch');
    assert.ok(/\.tag-chip \{[^}]*width:\s*40px[^}]*height:\s*40px/s.test(touch),
        'chips 40px tap targets on touch');
});

// ===============================================================
console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
