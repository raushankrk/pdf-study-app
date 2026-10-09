/**
 * Regression tests: touch-device blank strip above the PDF workspaces.
 *
 * Bug (user screenshot, iPad):
 *   After the single-toolbar refactor removed the per-PDF h-10 toolbars,
 *   a ~57px strip of blank gray space remained ABOVE both PDF A and PDF B
 *   on touch devices (iPad / Android tablets / phones) only.
 *
 * Root cause:
 *   Inside `@media (hover: none), (pointer: coarse)` there were two stale
 *   rules written for the REMOVED per-PDF toolbars, using positional
 *   selectors that silently re-targeted the new first child of the panels
 *   (the 4px page-scrub slider bar):
 *
 *     #left-panel > div:first-child,
 *     #right-panel > div:first-child {
 *         flex-wrap: wrap;
 *         min-height: 48px;         <-- inflated the 4px bar
 *         height: auto !important;  <-- overrode inline height:4px
 *         padding-top: 4px; padding-bottom: 4px;
 *     }
 *     #left-panel > div:first-child button,
 *     #right-panel > div:first-child button { ... }
 *
 *   `height: auto !important` in a stylesheet beats a normal inline style,
 *   so the inline `style="height: 4px"` was overridden and min-height:48px
 *   + padding reserved ~57px above each viewport. Desktops never matched
 *   the media query, which is why the bug appeared only on iPad/tablet.
 *
 * Fix:
 *   Both stale rules were removed. These tests guard against the stale
 *   selectors ever coming back and against ANY rule inflating the slider
 *   bar on touch devices again.
 *
 * Run with:
 *   node tests/test_touch_slider_space.js
 *
 * Exit code is 0 on success, 1 on any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'static', 'index.html');
const STYLE_CSS = path.join(ROOT, 'static', 'css', 'style.css');

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name, msg) {
    passCount++;
    console.log(`  ✓ PASS: ${name}${msg ? ' — ' + msg : ''}`);
}
function fail(name, err) {
    failCount++;
    failures.push({ name, err });
    console.log(`  ✗ FAIL: ${name}${err ? ' — ' + (err.message || err) : ''}`);
}
function test(name, fn) {
    try { fn(); ok(name); }
    catch (err) { fail(name, err); }
}

/** Strip /* ... *​/ comments so explanatory notes don't match selectors. */
function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Extract the inner text of every @media block (balanced braces). */
function extractMediaBlocks(css) {
    const blocks = [];
    const re = /@media[^{]*\{/g;
    let m;
    while ((m = re.exec(css)) !== null) {
        let depth = 1;
        let i = re.lastIndex;
        while (i < css.length && depth > 0) {
            if (css[i] === '{') depth++;
            else if (css[i] === '}') depth--;
            i++;
        }
        blocks.push({ header: m[0].replace('{', '').trim(), body: css.slice(re.lastIndex, i - 1) });
    }
    return blocks;
}

const cssRaw = fs.readFileSync(STYLE_CSS, 'utf8');
const css = stripCssComments(cssRaw);
const html = fs.readFileSync(INDEX_HTML, 'utf8');

console.log('\n== Suite 1: stale positional selectors removed from touch CSS ==');

const STALE_SELECTORS = [
    '#left-panel > div:first-child,',
    '#right-panel > div:first-child,',
    '#left-panel > div:first-child{',
    '#right-panel > div:first-child{',
];

test('touch media block contains no #left/right-panel > div:first-child rule', () => {
    const touchBlocks = extractMediaBlocks(css)
        .filter(b => /\(hover:\s*none\)/.test(b.header) || /\(pointer:\s*coarse\)/.test(b.header));
    assert.ok(touchBlocks.length > 0, 'expected at least one touch media block to exist');
    for (const b of touchBlocks) {
        for (const sel of STALE_SELECTORS) {
            assert.ok(
                !b.body.includes(sel),
                `stale selector "${sel.replace(/,$/, '')}" found in @media ${b.header}`
            );
        }
    }
});

test('whole stylesheet contains no #left/right-panel > div:first-child selector (comments excluded)', () => {
    for (const sel of ['#left-panel > div:first-child', '#right-panel > div:first-child']) {
        assert.ok(!css.includes(sel), `stale selector "${sel}" found outside comments`);
    }
});

test('no stylesheet rule inflates the page-scrub slider bar via min-height', () => {
    // The slider bar is identifiable only structurally (panel first child),
    // so the guard is: the touch blocks must not combine min-height >= 32px
    // with height:auto !important anywhere (the exact bug pattern).
    const touchBlocks = extractMediaBlocks(css)
        .filter(b => /\(hover:\s*none\)/.test(b.header) || /\(pointer:\s*coarse\)/.test(b.header));
    for (const b of touchBlocks) {
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let m;
        while ((m = ruleRe.exec(b.body)) !== null) {
            const decls = m[2];
            const hasMinHeight = /min-height:\s*(\d+)px/.exec(decls);
            const hasAutoImportant = /height:\s*auto\s*!important/.test(decls);
            if (hasMinHeight && hasAutoImportant) {
                const px = parseInt(hasMinHeight[1], 10);
                assert.ok(px < 32,
                    `rule "${m[1].trim().slice(0, 80)}" sets min-height:${px}px + height:auto!important — the blank-strip bug pattern`);
            }
        }
    }
});

test('touch block still keeps its intended rules (tool buttons 40px)', () => {
    const touchBlocks = extractMediaBlocks(css)
        .filter(b => /\(hover:\s*none\)/.test(b.header) || /\(pointer:\s*coarse\)/.test(b.header));
    const joined = touchBlocks.map(b => b.body).join('\n');
    assert.ok(joined.includes('40px'), 'touch tool-button sizing should remain');
});

console.log('\n== Suite 2: slider bar keeps its 4px height ==');

test('slider bar containers keep inline height:4px in index.html', () => {
    for (const side of ['left', 'right']) {
        const re = new RegExp(`<div class="[^"]*"[^>]*>\\s*<input type="range" id="${side}-page-slider"`);
        const m = re.exec(html);
        assert.ok(m, `${side} slider bar div not found before its input`);
        // Grab the opening tag of that div.
        const tagStart = html.lastIndexOf('<div', m.index);
        const tag = html.slice(tagStart, html.indexOf('>', tagStart) + 1);
        assert.ok(/style="height:\s*4px;?"/.test(tag),
            `${side} slider bar inline height must stay 4px, got tag: ${tag.slice(0, 120)}`);
    }
});

test('slider bar is the FIRST child of each panel (so stale selectors would have matched it)', () => {
    // Documents the mechanism of the bug: div:first-child === slider bar now.
    for (const panel of ['left-panel', 'right-panel']) {
        const panelStart = html.indexOf(`id="${panel}"`);
        assert.ok(panelStart !== -1, `#${panel} not found`);
        const afterPanel = html.slice(panelStart, panelStart + 2000);
        const firstChild = /<div class="w-full shrink-0[^"]*"[^>]*style="height:\s*4px;?"/.exec(afterPanel);
        assert.ok(firstChild, `first child of #${panel} is expected to be the 4px slider bar`);
        const idxPanelTag = html.indexOf('>', panelStart);
        const idxSlider = afterPanel.indexOf(firstChild[0]);
        const between = html.slice(idxPanelTag, panelStart + idxSlider);
        assert.ok(!/<(div|section|aside|ul|header)\b/.test(between),
            `#${panel} has an unexpected element before the slider bar — update this test`);
    }
});

test('.page-slider CSS keeps height:4px', () => {
    const m = /\.page-slider\s*\{[^}]*height:\s*4px;/.exec(css);
    assert.ok(m, '.page-slider rule must keep height:4px');
});

console.log('\n== Suite 3: cache busting ==');

test('style.css href cache version was bumped past activepdf-v11', () => {
    const m = /<link rel="stylesheet" href="\/css\/style\.css\?v=([^"]+)"/.exec(html);
    assert.ok(m, 'style.css link not found');
    assert.notStrictEqual(m[1], 'activepdf-v11',
        'CSS version not bumped — iPads would keep the cached blank-strip stylesheet');
});

// ---------------------------------------------------------------
console.log(`\n========================================`);
console.log(`Total: ${passCount + failCount} | PASS: ${passCount} | FAIL: ${failCount}`);
console.log(`========================================`);
if (failCount > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log(`  ✗ ${f.name}`));
    process.exit(1);
}
process.exit(0);
