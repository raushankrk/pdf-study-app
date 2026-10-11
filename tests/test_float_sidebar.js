// ============================================================================
// tests/test_float_sidebar.js
// Regression suite: ONE floating liquid glass sidebar for AI Chat +
// Comments (replaces the old flex #ai-sidebar and the fixed comment overlay
// with its dimming backdrop).
//
// Feature contract:
//   * The PDF canvas NEVER resizes or moves because of the sidebar — the
//     aside is absolutely positioned and takes no flex space.
//   * The sidebar surface is LIQUID GLASS (not plain transparent): frosted
//     translucent card — soft white gradient tint + backdrop blur +
//     saturation, light border, rounded corners, floating shadow.
//   * The card ABSORBS the pointer (pointer-events: auto on the container,
//     no pass-through islands) → clicks / taps / wheel on the card NEVER
//     reach the PDF underneath; annotating the PDF = aim outside the card.
//   * A simple mode switcher shows AI Chat OR Comments, one at a time
//     (body.fs-mode-chat / body.fs-mode-comments).
//   * AI Chat business logic (ai.js) and Comments business logic
//     (annotations.js) stay completely separate — all element IDs preserved.
//   * Open state + mode persist across reloads; old aiSidebarCollapsed
//     settings blobs are mapped on boot.
// ============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');
const AI_JS = path.join(ROOT, 'static', 'js', 'ai.js');
const ANNOTATIONS_JS = path.join(ROOT, 'static', 'js', 'annotations.js');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const DATABASE_JS = path.join(ROOT, 'static', 'js', 'database.js');
const CONFIG_JS = path.join(ROOT, 'static', 'js', 'config.js');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = assert;

// Previously shipped cache-busting strings — the version must keep moving.
const SHIPPED_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13', 'posresume-v14', 'tagrail-v15', 'floatside-v16', 'floatdrag-v17', 'liquidglass-v18', 'floattools-v19', 'ftorient-v20', 'ftsize-v21'];
const CURRENT_VERSION = 'ipadcolor-v22';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Brace-matched function extractor (tolerates nested braces & strings).
function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    if (start === -1) throw new Error(`function ${name} not found`);
    let i = source.indexOf('{', start);
    let depth = 0, inStr = null;
    for (; i < source.length; i++) {
        const c = source[i];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === inStr) inStr = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

// Minimal body classList stub.
function makeBody(initial = []) {
    const set = new Set(initial);
    return {
        classList: {
            add: (...c) => c.forEach(x => set.add(x)),
            remove: (...c) => c.forEach(x => set.delete(x)),
            toggle: (c, f) => {
                if (f === undefined) { set.has(c) ? set.delete(c) : set.add(c); }
                else if (f) set.add(c); else set.delete(c);
            },
            contains: (c) => set.has(c),
        },
    };
}

function makeUiSandbox(bodyClasses = [], opts = {}) {
    const sb = {
        document: { body: makeBody(bodyClasses), getElementById: () => null },
        state: { activeComment: opts.activeComment || { id: null } },
        saveSettings: () => { sb.__saves = (sb.__saves || 0) + 1; },
        closeChatHistory: () => { sb.__historyClosed = true; },
        cancelCommentEdit: () => { sb.__commentCancelled = true; },
        // liquidglass-v18: openFloatSidebar also (re)positions the card. This
        // suite only tests MODE logic (getElementById is null here anyway),
        // so a no-op stub keeps the sandbox minimal.
        applyFloatSidebarPos: () => {},
        console,
    };
    vm.createContext(sb);
    const uiSrc = fs.readFileSync(UI_JS, 'utf8');
    ['toggleAiSidebar', 'getFloatSidebarMode', 'setFloatSidebarMode', 'openFloatSidebar', 'closeFloatSidebar']
        .forEach(fn => vm.runInContext(extractFunction(uiSrc, fn), sb, { filename: `ui.js#${fn}` }));
    return sb;
}

// ===============================================================
console.log('\nSuite 1 — index.html structure');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

test('1.1 #float-sidebar exists and the old flex #ai-sidebar is gone', () => {
    assert(html.includes('id="float-sidebar"'), 'missing #float-sidebar');
    assert(!html.includes('id="ai-sidebar"'), 'old #ai-sidebar must be removed');
    assert(!html.includes('id="comment-backdrop"'), 'old #comment-backdrop must be removed');
});

test('1.2 #float-sidebar lives INSIDE #workspace-main (overlay, no flex space)', () => {
    const mainStart = html.indexOf('id="workspace-main"');
    const mainEnd = html.indexOf('</main>', mainStart);
    const sidebarStart = html.indexOf('id="float-sidebar"');
    assert(mainStart !== -1 && mainEnd !== -1, '#workspace-main not found');
    assert(sidebarStart > mainStart && sidebarStart < mainEnd,
        '#float-sidebar must be inside #workspace-main (absolute overlay)');
});

test('1.3 mode switcher pills + close button with correct handlers', () => {
    assert(html.includes("onclick=\"setFloatSidebarMode('chat')\""), 'chat pill handler');
    assert(html.includes("onclick=\"setFloatSidebarMode('comments')\""), 'comments pill handler');
    assert(html.includes('id="fs-tab-chat"') && html.includes('id="fs-tab-comments"'), 'pill ids');
    assert(html.includes('id="fs-close"') && html.includes('onclick="closeFloatSidebar()"'), 'close button');
});

test('1.4 AI Chat business DOM fully preserved (ids reused by ai.js)', () => {
    ['chat-history-drawer', 'chat-list', 'chat-history', 'chat-input', 'send-chat-btn', 'ai-status']
        .forEach(id => assert(html.includes(`id="${id}"`), `missing #${id}`));
});

test('1.5 Comments business DOM fully preserved (ids reused by annotations.js)', () => {
    ['comment-editor-panel', 'comment-preview-area', 'comment-editor-area',
     'comment-markdown-input', 'comment-edit-button-area']
        .forEach(id => assert(html.includes(`id="${id}"`), `missing #${id}`));
});

test('1.6 comment panel starts hidden; empty-state hint is its following sibling', () => {
    const panelIdx = html.indexOf('id="comment-editor-panel"');
    const emptyIdx = html.indexOf('id="fs-comments-empty"');
    assert(panelIdx !== -1 && emptyIdx !== -1, 'elements missing');
    assert(emptyIdx > panelIdx, '#fs-comments-empty must come after the panel (sibling selector)');
    assert(/id="comment-editor-panel" class="hidden"/.test(html), 'panel must start .hidden');
});

test('1.7 body defaults: sidebar open in chat mode', () => {
    const m = html.match(/<body[^>]*class="([^"]*)"/);
    assert(m, 'body tag not found');
    const classes = m[1].split(/\s+/);
    assert(classes.includes('fs-mode-chat'), 'body must default to fs-mode-chat');
    assert(classes.includes('float-sidebar-open'), 'body must default to float-sidebar-open');
    assert(!classes.includes('fs-mode-comments'), 'comments mode must not be default');
});

test('1.8 header AI toggle still wired to toggleAiSidebar (Ctrl+/ affordance)', () => {
    assert(html.includes('onclick="toggleAiSidebar()"'), 'header AI button handler');
});

// ===============================================================
console.log('\nSuite 2 — cache versioning');
test('2.1 CSS link bumped to a brand-new version', () => {
    const m = html.match(/style\.css\?v=([\w-]+)/);
    assert(m, 'CSS link version not found');
    assert.strictEqual(m[1], CURRENT_VERSION, `CSS version must be ${CURRENT_VERSION}`);
    assert(!SHIPPED_VERSIONS.includes(m[1]), 'must not reuse a shipped version string');
});

test('2.2 ALL editor script tags carry the new version', () => {
    const tags = html.match(/<script src="\/js\/[^"]+\?v=([\w-]+)"><\/script>/g) || [];
    assert(tags.length >= 15, `expected >=15 editor scripts, found ${tags.length}`);
    tags.forEach(t => assert(t.includes(`?v=${CURRENT_VERSION}`), `stale script tag: ${t}`));
});

test('2.3 version chip shows the new version', () => {
    assert(html.includes(`>${CURRENT_VERSION}</span>`), 'header version chip');
});

// ===============================================================
console.log('\nSuite 3 — ui.js: mode switcher + open/close logic');
test('3.1 toggleAiSidebar toggles float-sidebar-open (not the old class)', () => {
    const sb = makeUiSandbox([]);
    vm.runInContext('toggleAiSidebar()', sb);
    assert(sb.document.body.classList.contains('float-sidebar-open'), 'open after toggle');
    assert(sb.__saves >= 1, 'must persist');
    vm.runInContext('toggleAiSidebar()', sb);
    assert(!sb.document.body.classList.contains('float-sidebar-open'), 'closed after 2nd toggle');
    assert(!sb.document.body.classList.contains('ai-sidebar-collapsed'), 'old class must never appear');
});

test('3.2 setFloatSidebarMode enforces exactly-one mode class', () => {
    const sb = makeUiSandbox(['fs-mode-chat']);
    vm.runInContext(`setFloatSidebarMode('comments')`, sb);
    assert(sb.document.body.classList.contains('fs-mode-comments'), 'comments set');
    assert(!sb.document.body.classList.contains('fs-mode-chat'), 'chat removed');
    vm.runInContext(`setFloatSidebarMode('chat')`, sb);
    assert(sb.document.body.classList.contains('fs-mode-chat') &&
           !sb.document.body.classList.contains('fs-mode-comments'), 'back to chat');
});

test('3.3 setFloatSidebarMode ignores invalid modes', () => {
    const sb = makeUiSandbox(['fs-mode-chat']);
    vm.runInContext(`setFloatSidebarMode('bogus')`, sb);
    assert(sb.document.body.classList.contains('fs-mode-chat'), 'mode unchanged on invalid input');
});

test('3.4 openFloatSidebar opens + switches mode in one call', () => {
    const sb = makeUiSandbox([]);
    vm.runInContext(`openFloatSidebar('comments')`, sb);
    assert(sb.document.body.classList.contains('float-sidebar-open'), 'opened');
    assert(sb.document.body.classList.contains('fs-mode-comments'), 'comments mode set');
});

test('3.5 closeFloatSidebar closes, closes the drawer, cancels an active comment', () => {
    // With an active comment open → cancelCommentEdit must run first.
    const sbA = makeUiSandbox(['float-sidebar-open', 'fs-mode-comments'],
        { activeComment: { id: 'tb_1', mode: 'split' } });
    vm.runInContext('closeFloatSidebar()', sbA);
    assert(sbA.__commentCancelled === true, 'active comment must be cancelled (old panel-X semantics)');
    assert(!sbA.document.body.classList.contains('float-sidebar-open'), 'sidebar closed');

    // With no active comment → must NOT touch comment logic.
    const sbB = makeUiSandbox(['float-sidebar-open'], { activeComment: { id: null } });
    vm.runInContext('closeFloatSidebar()', sbB);
    assert(sbB.__commentCancelled === undefined, 'no comment → no cancel');
    assert(!sbB.document.body.classList.contains('float-sidebar-open'), 'sidebar closed');
    assert(sbB.__historyClosed === true, 'chat history drawer closed too');
});

test('3.6 getFloatSidebarMode defaults to chat', () => {
    const sbA = makeUiSandbox([]);
    assert.strictEqual(vm.runInContext('getFloatSidebarMode()', sbA), 'chat');
    const sbB = makeUiSandbox(['fs-mode-comments']);
    assert.strictEqual(vm.runInContext('getFloatSidebarMode()', sbB), 'comments');
});

// ===============================================================
console.log('\nSuite 4 — annotations.js wiring (comments business logic)');
const annoSrc = fs.readFileSync(ANNOTATIONS_JS, 'utf8');
test('4.1 openCommentSidebar reveals the floating sidebar in comments mode', () => {
    const fn = extractFunction(annoSrc, 'openCommentSidebar');
    assert(fn.includes("openFloatSidebar('comments')"), 'must call openFloatSidebar(\'comments\')');
    assert(fn.includes("classList.remove('hidden')"), 'must un-hide the comment panel');
    assert(!fn.includes('comment-backdrop'), 'no backdrop references may remain');
});

test('4.2 closeCommentSidebar: no backdrop, returns sidebar to chat view', () => {
    const fn = extractFunction(annoSrc, 'closeCommentSidebar');
    assert(!fn.includes('comment-backdrop'), 'backdrop must be gone');
    assert(fn.includes("setFloatSidebarMode('chat')"), 'closing a comment restores the chat pane');
    assert(fn.includes("classList.contains('fs-mode-comments')"), 'only switches when comments pane is active');
    assert(fn.includes("classList.add('hidden')"), 'panel must be hidden again');
});

test('4.3 annotations.js has zero remaining backdrop references', () => {
    assert(!annoSrc.includes('comment-backdrop'), 'stray backdrop reference');
});

// ===============================================================
console.log('\nSuite 5 — interaction guards (annotate while the sidebar is open)');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
test('5.1 handlePointerDown bails on real sidebar UI elements', () => {
    const start = eventsSrc.indexOf('function handlePointerDown');
    assert(start !== -1, 'handlePointerDown not found');
    const guard = eventsSrc.slice(start, start + 1400);
    assert(guard.includes("closest('#float-sidebar')"), 'must guard #float-sidebar');
    assert(guard.includes("closest('#comment-editor-panel')"), 'must still guard the comment card');
});

test('5.2 the old activeComment block-guard is REMOVED (annotate-while-open)', () => {
    const start = eventsSrc.indexOf('function handlePointerDown');
    const guard = eventsSrc.slice(start, start + 1400);
    assert(!guard.includes('state.activeComment && state.activeComment.id'),
        'pointerdown must NOT be blocked while a comment is open');
});

test('5.3 events.js has zero backdrop references', () => {
    assert(!eventsSrc.includes('comment-backdrop'), 'events.js backdrop ref');
});

test('5.4 app.js touch handlers bypass only real sidebar UI (pass-through gaps stay live)', () => {
    assert(appSrc.includes("if (e.target.closest('#float-sidebar')) return;"),
        'touchstart/touchmove must skip actual sidebar UI');
    assert(!appSrc.includes('#comment-backdrop'), 'app.js must not reference the removed backdrop');
});

test('5.5 app.js no longer installs the backdrop click-to-close listener', () => {
    assert(!appSrc.includes("getElementById('comment-backdrop')"), 'backdrop listener must be gone');
});

// ===============================================================
console.log('\nSuite 6 — persistence + boot restore');
const dbSrc = fs.readFileSync(DATABASE_JS, 'utf8');
test('6.1 saveSettings persists floatSidebarOpen + floatSidebarMode', () => {
    assert(dbSrc.includes('floatSidebarOpen: document.body.classList.contains'), 'open state persisted');
    assert(dbSrc.includes("floatSidebarMode: document.body.classList.contains('fs-mode-comments')"), 'mode persisted');
    assert(!dbSrc.includes('aiSidebarCollapsed'), 'old key must not be written anymore');
});

test('6.2 boot restores open state with old-key fallback', () => {
    assert(appSrc.includes('savedData.settings.floatSidebarOpen !== undefined'), 'new key checked first');
    assert(appSrc.includes("!savedData.settings.aiSidebarCollapsed"),
        'old blobs: aiSidebarCollapsed true = closed → open = !collapsed');
});

test('6.3 boot enforces exactly-one mode class', () => {
    assert(appSrc.includes("classList.toggle('fs-mode-comments', savedData.settings.floatSidebarMode === 'comments')"),
        'comments mode from settings');
    assert(appSrc.includes("classList.toggle('fs-mode-chat', savedData.settings.floatSidebarMode !== 'comments')"),
        'chat mode is the fallback');
});

test('6.4 config.js keeps the comment els mapping working', () => {
    const cfg = fs.readFileSync(CONFIG_JS, 'utf8');
    ['commentEditorPanel', 'commentPreviewArea', 'commentEditorArea',
     'commentEditButtonArea', 'commentMarkdownInput'].forEach(k => assert(cfg.includes(`${k}:`), `els.${k} missing`));
});

// ===============================================================
console.log('\nSuite 7 — CSS contract (liquid glass + pointer blocking)');
const css = fs.readFileSync(STYLE_CSS, 'utf8');
function cssBlock(selector) {
    const idx = css.indexOf(selector);
    if (idx === -1) throw new Error(`CSS selector not found: ${selector}`);
    let i = css.indexOf('{', idx), depth = 0;
    for (; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(idx, i + 1); }
    }
    throw new Error(`unbalanced block for ${selector}`);
}

test('7.1 #float-sidebar: absolute overlay with a LIQUID GLASS surface', () => {
    const b = cssBlock('#float-sidebar {');
    assert(b.includes('position: absolute'), 'must be absolutely positioned (no flex space)');
    assert(/backdrop-filter:\s*blur\(/.test(b), 'must have backdrop blur (liquid glass)');
    assert(/saturate\(/.test(b), 'must saturate the backdrop (liquid glass)');
    assert(b.includes('-webkit-backdrop-filter: blur('), 'webkit variant for Safari');
    assert(/background:\s*linear-gradient/.test(b), 'translucent gradient tint');
    assert(/rgba\(/.test(b), 'translucent rgba layers');
    assert(b.includes('border-radius'), 'rounded glass card');
    assert(b.includes('box-shadow'), 'floating card shadow');
    assert(!/background:\s*transparent/.test(b), 'must NOT be plain transparent anymore');
});

test('7.2 #float-sidebar ABSORBS the pointer (no pass-through)', () => {
    const b = cssBlock('#float-sidebar {');
    assert(b.includes('pointer-events: auto'), 'container must capture the pointer');
});

test('7.3 visibility + pane switching driven by body classes', () => {
    assert(css.includes('body.float-sidebar-open #float-sidebar { display: flex; }'), 'open rule');
    assert(css.includes('body.fs-mode-chat #fs-chat-pane { display: flex; }'), 'chat pane rule');
    assert(css.includes('body.fs-mode-comments #fs-comment-pane { display: flex; }'), 'comments pane rule');
    assert(css.includes('body.fs-mode-comments #fs-chat-actions { display: none; }'), 'chat-only actions hidden in comments mode');
});

test('7.4 comment panel: editor card inside the pane; real .hidden hide', () => {
    const hidden = cssBlock('#comment-editor-panel.hidden {');
    assert(hidden.includes('display: none'), 'hidden class must really hide (in-flow element)');
});

test('7.5 comments empty state only shows while the panel is hidden', () => {
    assert(css.includes('#comment-editor-panel.hidden ~ #fs-comments-empty { display: flex; }'),
        'sibling-visibility rule');
});

test('7.6 @supports fallback for browsers without backdrop-filter', () => {
    assert(css.includes('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))'),
        'fallback block must exist');
    const idx = css.indexOf('@supports not ((backdrop-filter: blur(1px))');
    const block = css.slice(idx, idx + 260);
    assert(/rgba\(255,\s*255,\s*255,\s*0\.9/.test(block), 'fallback surface must be near-opaque');
});

test('7.7 old sidebar/backdrop CSS is fully removed', () => {
    assert(!css.includes('#ai-sidebar'), 'old #ai-sidebar rules remain');
    assert(!css.includes('ai-sidebar-collapsed'), 'old collapse class rules remain');
    assert(!css.includes('#comment-backdrop'), 'old backdrop rules remain');
});

test('7.8 toggle button affordance + touch tap targets', () => {
    assert(css.includes('body:not(.float-sidebar-open) .toggle-ai-btn { opacity: 0.7; }'),
        'dimmed AI toggle when sidebar closed');
    assert(/\.fs-tab \{ padding: 8px 14px/.test(css), 'touch: bigger pills');
    assert(/#fs-header-actions button \{ width: 36px; height: 36px/.test(css), 'touch: bigger header buttons');
});

test('7.9 chat-history drawer clips inside its pane (no leak over the PDF)', () => {
    // Caught LIVE: the drawer slides via translateX(-100%); without
    // overflow:hidden on the pane it rendered over the PDF while "closed".
    const paneBlock = cssBlock('#fs-chat-pane,');
    assert(paneBlock.includes('overflow: hidden'), 'pane must clip the sliding drawer');
});

// ===============================================================
console.log('\n========================================');
console.log(`Total: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
console.log('========================================');
process.exit(failed > 0 ? 1 : 0);
