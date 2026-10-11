// ============================================================================
// tests/test_liquid_glass.js
// Regression suite: the floating tool sidebar (AI Chat + Comments) was
// REDESIGNED from a 100% transparent pass-through overlay into a LIQUID
// GLASS floating card.
//
// Feature contract:
//   * LIQUID GLASS surface: frosted translucent card — soft white gradient
//     tint + backdrop-filter blur + saturate, hairline light border, rounded
//     corners, floating shadow, inner top highlight. NOT plain transparent.
//   * The card ABSORBS the pointer: pointer-events: auto on the container.
//     Clicks / taps / wheel / pen gestures ON the card NEVER reach the PDF
//     underneath ("click and other action/effect not get pass over this").
//   * @supports fallback: browsers without backdrop-filter get a
//     near-opaque surface — readable text, same blocking behavior.
//   * The right/left panel minimize buttons (.panel-min-btn) sit ABOVE the
//     card (z-index) so they stay clickable even in the docked corner.
//   * Drag engine untouched: grip is still the only drag starter; position
//     still transform-driven; guards in events.js / app.js remain.
//   * Version bumped floatdrag-v17 → liquidglass-v18 everywhere.
// ============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');
const EVENTS_JS = path.join(ROOT, 'static', 'js', 'events.js');
const APP_JS = path.join(ROOT, 'static', 'js', 'app.js');
const UI_JS = path.join(ROOT, 'static', 'js', 'ui.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  \u2713 ${name}`); }
    catch (e) { failed++; console.error(`  \u2717 ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
assert.strictEqual = (a, b, msg) => { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
assert.ok = assert;

// Version chain — liquidglass-v18 must be new (never reuse a shipped string).
const SHIPPED_VERSIONS = ['comment-v9', 'activepdf-v11', 'touchfix-v12', 'panelmin-v13',
    'posresume-v14', 'tagrail-v15', 'floatside-v16', 'floatdrag-v17', 'liquidglass-v18', 'floattools-v19', 'ftorient-v20', 'ftsize-v21'];
const CURRENT_VERSION = 'ipadcolor-v22';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function cssBlockAt(source, selector, fromIndex = -1) {
    const idx = fromIndex === -1 ? source.indexOf(selector + ' {')
                                 : source.lastIndexOf(selector + ' {');
    if (idx === -1) throw new Error(`CSS selector not found: ${selector}`);
    let depth = 0, j = source.indexOf('{', idx);
    for (; j < source.length; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') { depth--; if (depth === 0) break; }
    }
    // Strip comments so prose inside rules cannot trip regex assertions.
    return source.slice(idx, j + 1).replace(/\/\*[\s\S]*?\*\//g, '');
}
function cssBlock(source, selector) { return cssBlockAt(source, selector, -1); }

// ===============================================================
console.log('\nSuite 1 — cache versioning (liquidglass-v18)');
const html = fs.readFileSync(INDEX_HTML, 'utf8');

test('1.1 CSS link carries liquidglass-v18', () => {
    const m = html.match(/style\.css\?v=([\w-]+)/);
    assert(m, 'CSS link version not found');
    assert.strictEqual(m[1], CURRENT_VERSION, `CSS version must be ${CURRENT_VERSION}`);
});

test('1.2 ALL editor script tags carry liquidglass-v18', () => {
    const tags = html.match(/<script src="\/js\/[^"]+\?v=([\w-]+)"><\/script>/g) || [];
    assert(tags.length >= 15, `expected >=15 editor scripts, found ${tags.length}`);
    tags.forEach(t => assert(t.includes(`?v=${CURRENT_VERSION}`), `stale script tag: ${t}`));
});

test('1.3 header chip shows liquidglass-v18 and mentions liquid glass', () => {
    assert(html.includes(`>${CURRENT_VERSION}</span>`), 'version chip');
    assert(/title="[^"]*[Ll]iquid glass[^"]*"/.test(html), 'chip title should describe the liquid glass sidebar');
});

test('1.4 liquidglass-v18 was never shipped before + floatdrag-v17 fully retired', () => {
    assert(!SHIPPED_VERSIONS.includes(CURRENT_VERSION), 'must not reuse a shipped string');
    // The immediately-previous string must be gone from every shipped file.
    ['index.html', 'css/style.css', 'js/ui.js', 'js/app.js', 'js/events.js']
        .forEach(f => {
            const src = fs.readFileSync(path.join(ROOT, 'static', f), 'utf8');
            assert(!src.includes('floatdrag-v17'), `floatdrag-v17 still present in static/${f}`);
        });
});

// ===============================================================
console.log('\nSuite 2 — liquid glass CSS surface');
const css = fs.readFileSync(STYLE_CSS, 'utf8');
const CONTAINER_BLOCK = cssBlock(css, '#float-sidebar');

test('2.1 backdrop-filter blur + saturate (the "liquid" frost)', () => {
    assert(/backdrop-filter:\s*blur\(\d+px\)\s+saturate\(/.test(CONTAINER_BLOCK),
        'container must blur + saturate the backdrop');
    assert(CONTAINER_BLOCK.includes('-webkit-backdrop-filter: blur('),
        'webkit variant for Safari');
    assert(!/backdrop-filter:\s*none/.test(CONTAINER_BLOCK), 'the old "NO glass" rule must be gone');
});

test('2.2 translucent gradient tint + light border + radius + floating shadow', () => {
    assert(/background:\s*linear-gradient\(/.test(CONTAINER_BLOCK), 'gradient tint');
    assert(/rgba\(255,\s*255,\s*255,\s*0\.\d+\)/.test(CONTAINER_BLOCK), 'translucent white layers');
    assert(/border:\s*1px solid rgba\(255,\s*255,\s*255/.test(CONTAINER_BLOCK), 'hairline light border');
    assert(/border-radius:\s*\d+px/.test(CONTAINER_BLOCK), 'rounded card');
    assert(/box-shadow:[^;]*rgba\(15,\s*23,\s*42/.test(CONTAINER_BLOCK), 'floating shadow');
    assert(/inset 0 1px 0 rgba\(255,\s*255,\s*255/.test(CONTAINER_BLOCK), 'inner top highlight');
    assert(!/background:\s*transparent/.test(CONTAINER_BLOCK), 'plain transparent must be gone');
    assert(!/border:\s*none/.test(CONTAINER_BLOCK), 'the old borderless rule must be gone');
});

test('2.3 the card ABSORBS the pointer (pointer-events: auto)', () => {
    assert(CONTAINER_BLOCK.includes('pointer-events: auto'),
        'container must capture every click / tap / wheel over it');
});

test('2.4 @supports fallback for engines without backdrop-filter', () => {
    const m = css.match(/@supports not \(\(backdrop-filter[^{]+\)\s*\{\s*#float-sidebar\s*\{([^}]*)\}/);
    assert(m, 'fallback block missing');
    assert(/rgba\(255,\s*255,\s*255,\s*0\.9\d*\)/.test(m[1]), 'fallback surface must be near-opaque');
});

test('2.5 NO pointer-events: none anywhere in the sidebar CSS section', () => {
    // Slice the whole floating-sidebar section: from its banner comment to
    // the next major section (citation chips). Not a single element inside
    // the card may opt out of the pointer — the card must block as a whole.
    const start = css.indexOf('/* --- Floating Tool Sidebar');
    const end = css.indexOf('/* Citation Buttons in Chat */');
    assert(start !== -1 && end > start, 'sidebar CSS section markers not found');
    const section = css.slice(start, end);
    assert(!section.includes('pointer-events: none'),
        'found a leftover pass-through island inside the glass card');
    // The grip keeps its explicit auto (drag starter documentation).
    assert(cssBlock(css, '#fs-drag-handle').includes('pointer-events: auto'), 'grip still explicit');
});

test('2.6 inner cards are translucent (glass shows through)', () => {
    const composer = cssBlock(css, '.fs-composer-card');
    assert(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.[0-8]\d*\)/.test(composer),
        'composer card must be translucent white');
    const panel = cssBlock(css, '#comment-editor-panel');
    assert(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.[0-8]\d*\)/.test(panel),
        'comment editor card must be translucent white');
    const hint = cssBlock(css, '.fs-hint-card');
    assert(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.[0-8]\d*\)/.test(hint),
        'hint card must be translucent white');
    // The solid-white #f3f4f6 assistant bubble would look pasted-on over glass.
    const bubble = cssBlock(css, '.ai-message.assistant .ai-bubble');
    assert(/rgba\(255,\s*255,\s*255/.test(bubble), 'assistant bubble must be translucent white');
});

test('2.7 .panel-min-btn z-index sits ABOVE the glass card', () => {
    // lastIndexOf: the touch media query ALSO has a .panel-min-btn block
    // (bigger tap target, no z-index) — we want the main definition.
    const btnBlock = cssBlockAt(css, '.panel-min-btn', 1);
    const mz = btnBlock.match(/z-index:\s*(\d+)/);
    assert(mz, 'panel-min-btn z-index missing');
    const sz = CONTAINER_BLOCK.match(/z-index:\s*(\d+)/);
    assert(sz, 'float-sidebar z-index missing');
    assert(parseInt(mz[1], 10) > parseInt(sz[1], 10),
        `panel-min-btn (${mz[1]}) must be above #float-sidebar (${sz[1]}) so the minimize buttons stay clickable`);
    assert(parseInt(mz[1], 10) < 9999, 'must stay below the modals');
});

test('2.8 drag geometry contract untouched (transform-driven card)', () => {
    assert(/height:\s*min\(620px,\s*100%\)/.test(CONTAINER_BLOCK), 'compact card height cap');
    assert(CONTAINER_BLOCK.includes('transform: translate3d(0, 0, 0)'), 'JS-driven transform');
    assert(CONTAINER_BLOCK.includes('will-change: transform'), 'GPU compositing hint');
    assert(/transition:\s*transform/.test(CONTAINER_BLOCK), 'glide transition');
    assert(cssBlock(css, 'body.fs-dragging #float-sidebar').includes('transition: none'),
        '1:1 drag tracking');
});

// ===============================================================
console.log('\nSuite 3 — blocking semantics in JS (guards stay)');
const eventsSrc = fs.readFileSync(EVENTS_JS, 'utf8');
const appSrc = fs.readFileSync(APP_JS, 'utf8');
const uiSrc = fs.readFileSync(UI_JS, 'utf8');

test('3.1 events.js handlePointerDown still bails on the sidebar card', () => {
    const start = eventsSrc.indexOf('function handlePointerDown');
    assert(start !== -1, 'handlePointerDown not found');
    const guard = eventsSrc.slice(start, start + 1400);
    assert(guard.includes("closest('#float-sidebar')"), 'must guard #float-sidebar');
    assert(guard.includes("closest('#comment-editor-panel')"), 'must guard the comment card');
});

test('3.2 app.js touch handlers skip the sidebar card (normal scroll/typing inside)', () => {
    assert(appSrc.includes("if (e.target.closest('#float-sidebar')) return;"),
        'touchstart/touchmove must not intercept inside the card');
    assert(!appSrc.includes('#comment-backdrop'), 'no backdrop references');
});

test('3.3 the grip is still the ONLY drag starter', () => {
    const fnStart = uiSrc.indexOf('function initFloatSidebarDrag');
    assert(fnStart !== -1, 'initFloatSidebarDrag not found');
    const fn = uiSrc.slice(fnStart, uiSrc.indexOf('}', uiSrc.indexOf('addEventListener', fnStart)));
    assert(fn.includes("getElementById('fs-drag-handle')"), 'drag binds to the grip');
    assert(fn.includes("grip.addEventListener('pointerdown', beginFloatSidebarDrag)"),
        'pointerdown handler on the grip');
    assert(!/float-sidebar.*addEventListener\('pointerdown'/.test(uiSrc),
        'the card itself must not start drags');
});

test('3.4 grip keeps touch-action: none (JS owns touch drags)', () => {
    const grip = cssBlock(css, '#fs-drag-handle');
    assert(grip.includes('touch-action: none'), 'no native pan/zoom on the grip');
});

// ===============================================================
console.log('\nSuite 4 — HTML documentation matches the new design');
test('4.1 aside doc block describes the liquid glass card', () => {
    const i = html.indexOf('FLOATING TOOL SIDEBAR');
    const block = html.slice(i, html.indexOf('============== -->', i));
    assert(/LIQUID GLASS/i.test(block), 'doc must say LIQUID GLASS');
    assert(!/FULLY TRANSPARENT/i.test(block), 'doc must not claim full transparency anymore');
    assert(/ABSORBED/i.test(block), 'doc must explain click absorption');
});

test('4.2 empty-state comment no longer promises pass-through', () => {
    const i = html.indexOf('id="fs-comments-empty"');
    const before = html.lastIndexOf('<!--', i);
    const comment = html.slice(before, i);
    assert(!/pointer-events: none/.test(comment), 'stale pass-through doc comment');
    assert(!/pass through/i.test(comment), 'stale pass-through promise');
});

test('4.3 all business element ids still in place', () => {
    ['float-sidebar', 'fs-drag-handle', 'fs-header', 'fs-mode-switch', 'fs-tab-chat',
     'fs-tab-comments', 'fs-chat-actions', 'fs-close', 'fs-body', 'fs-chat-pane',
     'chat-history-drawer', 'chat-list', 'chat-history', 'chat-input', 'send-chat-btn',
     'ai-status', 'fs-composer', 'fs-comment-pane', 'comment-editor-panel',
     'comment-preview-area', 'comment-editor-area', 'comment-markdown-input',
     'comment-edit-button-area', 'fs-comments-empty']
        .forEach(id => assert(html.includes(`id="${id}"`), `missing #${id}`));
});

// ===============================================================
console.log('\n========================================');
console.log(`Total: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
console.log('========================================');
process.exit(failed > 0 ? 1 : 0);
