#!/usr/bin/env node
/**
 * Capypass site layout / accessibility audit.
 *
 *   npm install
 *   npx playwright install chromium      # one time
 *   npm run serve                        # in another shell
 *   npm run audit                        # or: node tools/audit.mjs --url=... --out=...
 *
 * Walks a device matrix and asserts the invariants that the 2026-08-02 mobile
 * polish pass established. Every check is a real measurement taken in a real
 * browser at a real viewport size; none of them trust the stylesheet's
 * intent. Exits non-zero if any check fails, so it can gate a deploy.
 *
 * Flags: --url=<page> --out=<screenshot dir> --shots (also write PNGs)
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const URL_ = arg('url', 'http://localhost:8899/index.html');
const OUT = arg('out', 'docs/audit-shots');
const SHOTS = process.argv.includes('--shots');

/** Real logical viewports, portrait and landscape, narrowest to widest. */
const DEVICES = [
    ['Galaxy Fold (cover)', 280, 653],
    ['iPhone SE / 8', 375, 667],
    ['iPhone 13 mini', 375, 812],
    ['iPhone 15 / 14', 393, 852],
    ['Pixel 8', 412, 915],
    ['iPhone 15 Pro Max', 430, 932],
    ['iPhone SE landscape', 667, 375],
    ['iPhone 15 landscape', 852, 393],
    ['iPhone 15 PM landscape', 932, 430],
    ['iPad mini portrait', 744, 1133],
    ['iPad Pro 11 portrait', 834, 1194],
    ['iPad Pro 11 landscape', 1194, 834],
    ['Laptop', 1440, 900],
    ['Desktop 1080p', 1920, 1080],
    ['Desktop 1440p', 2560, 1440]
];

/** Thresholds, each traceable to a published rule rather than taste. */
const LIMITS = {
    minTapTargetPx: 24,        // WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA
    minBodyContrast: 4.5,      // WCAG 2.1 SC 1.4.3 Contrast (Minimum), AA
    maxStickyChromePct: 25,    // combined fixed header + bottom bar, hard ceiling
    minGroupingRatio: 1.8,     // Gestalt proximity: gap to next block vs gap to own media
    minHeadingStepRatio: 1.15, // adjacent heading levels must be visibly different
    reflowWidthPx: 320         // WCAG 2.2 SC 1.4.10 Reflow
};

/* ------------------------------------------------------------------ *
 * Everything below runs INSIDE the page.
 * ------------------------------------------------------------------ */
function collectMetrics(limits) {
    const root = document.documentElement;
    const px = (v) => parseFloat(v) || 0;

    /* --- contrast helpers (WCAG relative luminance) --- */
    const parseRGB = (s) => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map((n) => parseFloat(n));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1
    });
    const lum = (c) => {
        const f = (v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };
    /** Composite every ancestor background down to an opaque colour. */
    const effectiveBg = (el) => {
        let acc = null;
        for (let n = el; n; n = n.parentElement) {
            const c = parseRGB(getComputedStyle(n).backgroundColor);
            if (!c || c.a === 0) continue;
            acc = acc ? over(acc, c) : c;
            if (acc.a >= 1) break;
        }
        return acc && acc.a >= 1 ? acc : { r: 26, g: 26, b: 46, a: 1 };
    };

    /* --- 1/2. reflow + clipped content --- */
    const clipped = [];
    document.querySelectorAll('body *').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && (b.right > root.clientWidth + 1 || b.left < -1)) {
            clipped.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0]);
        }
    });

    /* --- 3/4. feature-row dead space and grouping ratio --- */
    const rows = [...document.querySelectorAll('.frow')];
    const stacked = rows.length > 0 && getComputedStyle(rows[0]).flexDirection === 'column';
    let maxDead = 0;
    rows.forEach((r) => {
        const copy = r.querySelector('.frow-copy');
        if (!copy) return;
        let bottom = 0;
        [...copy.children].forEach((k) => { bottom = Math.max(bottom, k.getBoundingClientRect().bottom); });
        maxDead = Math.max(maxDead, Math.round(copy.getBoundingClientRect().bottom - bottom));
    });
    let groupingRatio = null;
    if (stacked && rows.length > 1) {
        const own = [], next = [];
        rows.forEach((r, i) => {
            const m = r.querySelector('.frow-media'), c = r.querySelector('.frow-copy');
            if (m && c) own.push(c.getBoundingClientRect().top - m.getBoundingClientRect().bottom);
            if (i < rows.length - 1) {
                const p = r.querySelector('.frow-copy p');
                const nm = rows[i + 1].querySelector('.frow-media');
                if (p && nm) next.push(nm.getBoundingClientRect().top - p.getBoundingClientRect().bottom);
            }
        });
        const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
        groupingRatio = +(avg(next) / avg(own)).toFixed(2);
    }

    /* --- 5. sticky chrome budget --- */
    const navEl = document.querySelector('nav');
    const stickyEl = document.getElementById('stickyCta');
    const navH = navEl ? Math.round(navEl.getBoundingClientRect().height) : 0;
    const stickyH = stickyEl && getComputedStyle(stickyEl).display !== 'none'
        ? Math.round(stickyEl.getBoundingClientRect().height) : 0;
    const chromePct = +(((navH + stickyH) / window.innerHeight) * 100).toFixed(1);

    /* --- 6. tap targets (SC 2.5.8) --- */
    const smallTargets = [];
    document.querySelectorAll('a,button,input,select,[role="tab"],[role="button"]').forEach((el) => {
        const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (b.width === 0 || b.height === 0 || cs.display === 'none' || cs.visibility === 'hidden') return;
        const min = Math.min(b.width, b.height);
        if (min < limits.minTapTargetPx) {
            smallTargets.push(`${(el.textContent || '').trim().slice(0, 24)}=${Math.round(min)}px`);
        }
    });

    /* --- 7. body-text contrast (SC 1.4.3) --- */
    const lowContrast = [];
    document.querySelectorAll('p,li,figcaption,span,strong,b,small,button,a,h1,h2,h3,h4').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) return;
        // Only leaf-ish text: an element whose text comes from a child is
        // measured on that child, so measuring both double-reports.
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return;
        const fg = parseRGB(cs.color);
        if (!fg) return;
        const bg = effectiveBg(el);
        const r = ratio(over(fg, bg), bg);
        const size = px(cs.fontSize);
        const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 3 : limits.minBodyContrast;
        if (r < need) {
            const label = (el.textContent || '').trim().slice(0, 18) || el.tagName;
            lowContrast.push(`"${label}" ${r.toFixed(2)}:1<${need}`);
        }
    });

    /* --- 9. heading hierarchy separation --- */
    const fs = (sel) => {
        const el = document.querySelector(sel);
        return el ? px(getComputedStyle(el).fontSize) : null;
    };
    const h1 = fs('.hero h1'), h2 = fs('.section-title'), h3 = fs('.frow h3');
    const steps = (h1 && h2 && h3)
        ? { h1h2: +(h1 / h2).toFixed(2), h2h3: +(h2 / h3).toFixed(2) }
        : null;

    return {
        vw: root.clientWidth,
        vh: window.innerHeight,
        scrollWidth: root.scrollWidth,
        reflowOk: root.scrollWidth <= root.clientWidth,
        clipped: [...new Set(clipped)],
        stacked,
        maxDead,
        groupingRatio,
        navH, stickyH, chromePct,
        smallTargets: [...new Set(smallTargets)],
        lowContrast: [...new Set(lowContrast)],
        headingSizes: { h1, h2, h3 },
        steps
    };
}

/** Scroll-target clearance: every anchor and heading must land below the nav. */
function checkScrollClearance() {
    const root = document.documentElement;
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    const navBottom = () => {
        const n = document.querySelector('nav');
        return n ? n.getBoundingClientRect().bottom : 0;
    };
    const bad = [];
    document.querySelectorAll('nav .links a[href^="#"]').forEach((a) => {
        const id = a.getAttribute('href');
        const el = document.querySelector(id);
        if (!el) return;
        location.hash = '';
        location.hash = id;
        const first = el.querySelector('.kicker') || el.querySelector('h2') || el;
        if (first.getBoundingClientRect().top < navBottom() - 0.5) bad.push('anchor ' + id);
    });
    document.querySelectorAll('h2, h3').forEach((h, i) => {
        h.scrollIntoView();
        if (h.getBoundingClientRect().top < navBottom() - 0.5) {
            bad.push('heading#' + i + ' "' + h.textContent.trim().slice(0, 22) + '"');
        }
    });
    window.scrollTo(0, 0);
    location.hash = '';
    root.style.scrollBehavior = prev;
    return bad;
}

/**
 * Stylesheet integrity.
 *
 * A CSS syntax error does not throw and does not warn: the parser silently
 * discards tokens until it can resynchronise, which eats whole rules. A stray
 * comment terminator from a mis-edited comment did exactly that here,
 * swallowing `.squiggle` and leaving the decorative tile repeating at its
 * intrinsic size across the hero headline. Every layout assertion in this file
 * still passed, because the geometry was fine and only the paint was wrong.
 * So: assert that the rules we depend on actually survived parsing, and that
 * declarations whose ABSENCE is silently destructive are present.
 */
function checkStylesheetIntegrity() {
    const required = [
        ['.squiggle', ['background-repeat', 'background-size', 'background-position']],
        ['.frow-copy', ['flex']],
        ['.sticky-cta', ['position']],
        ['.skip-link', ['position', 'transform']],
        ['.faq-a', ['visibility']]
    ];
    const found = {};
    let ruleCount = 0;
    for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        // Since CSS nesting shipped, a plain CSSStyleRule ALSO exposes a
        // `cssRules` list. It is empty, but an empty CSSRuleList is an object
        // and therefore truthy, so a `if (r.cssRules) recurse; else count;`
        // walk silently counts nothing at all. Count and recurse independently.
        const walk = (list) => {
            for (const r of list) {
                if (r.selectorText && r.style) {
                    ruleCount++;
                    r.selectorText.split(',').map((s) => s.trim()).forEach((sel) => {
                        (found[sel] ||= []).push(r.style);
                    });
                }
                if (r.cssRules && r.cssRules.length) walk(r.cssRules);
            }
        };
        walk(rules);
    }
    const missing = [];
    for (const [sel, props] of required) {
        const decls = found[sel];
        if (!decls) { missing.push(`${sel} (rule absent entirely)`); continue; }
        props.forEach((p) => {
            if (!decls.some((d) => d.getPropertyValue(p))) missing.push(`${sel} { ${p} }`);
        });
    }
    // The decorative tile must never fall back to two-axis repeat.
    const sq = document.querySelector('.squiggle');
    const paint = sq ? getComputedStyle(sq) : null;
    return {
        ruleCount,
        missing,
        squiggleRepeat: paint ? paint.backgroundRepeat : null,
        squiggleSize: paint ? paint.backgroundSize : null
    };
}

/** With reduced motion requested, nothing may still be animating. */
function checkReducedMotion() {
    const moving = [];
    document.querySelectorAll('*').forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.animationName && cs.animationName !== 'none' && cs.animationDuration !== '0s') {
            moving.push(cs.animationName);
        }
    });
    return {
        matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        animating: [...new Set(moving)]
    };
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */
const failures = [];
const fail = (device, msg) => failures.push(`${device}: ${msg}`);

const browser = await chromium.launch();
if (SHOTS) await mkdir(OUT, { recursive: true });

const page = await browser.newPage();
await page.goto(URL_, { waitUntil: 'networkidle' });

console.log(`\nCapypass site audit  —  ${URL_}\n${'='.repeat(78)}`);
const head = ['device', 'viewport', 'reflow', 'clip', 'dead', 'group', 'chrome%', 'tap', 'contrast'];
console.log(head.map((h, i) => h.padEnd([24, 11, 7, 6, 6, 7, 9, 5, 9][i])).join(''));
console.log('-'.repeat(78));

for (const [name, w, h] of DEVICES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const m = await page.evaluate(collectMetrics, LIMITS);

    if (!m.reflowOk) fail(name, `horizontal scroll: scrollWidth ${m.scrollWidth} > ${m.vw} (WCAG 1.4.10)`);
    if (m.clipped.length) fail(name, `content outside viewport: ${m.clipped.join(', ')}`);
    if (m.maxDead > 0) fail(name, `${m.maxDead}px dead space inside a feature row's copy block`);
    if (m.stacked && m.groupingRatio !== null && m.groupingRatio < LIMITS.minGroupingRatio) {
        fail(name, `grouping ratio ${m.groupingRatio} < ${LIMITS.minGroupingRatio} (image reads as detached from its copy)`);
    }
    if (m.chromePct > LIMITS.maxStickyChromePct) fail(name, `sticky chrome ${m.chromePct}% of viewport height`);
    if (m.smallTargets.length) fail(name, `tap targets under ${LIMITS.minTapTargetPx}px: ${m.smallTargets.join(', ')} (WCAG 2.2 SC 2.5.8)`);
    if (m.lowContrast.length) fail(name, `contrast below AA: ${m.lowContrast.join(', ')} (WCAG 1.4.3)`);
    if (m.steps && (m.steps.h1h2 < LIMITS.minHeadingStepRatio || m.steps.h2h3 < LIMITS.minHeadingStepRatio)) {
        fail(name, `heading hierarchy collapsed: h1/h2=${m.steps.h1h2}, h2/h3=${m.steps.h2h3}`);
    }

    const cells = [
        name.padEnd(24),
        `${m.vw}x${m.vh}`.padEnd(11),
        (m.reflowOk ? 'ok' : 'FAIL').padEnd(7),
        (m.clipped.length ? 'FAIL' : 'ok').padEnd(6),
        (m.maxDead === 0 ? 'ok' : String(m.maxDead)).padEnd(6),
        String(m.groupingRatio ?? '-').padEnd(7),
        String(m.chromePct).padEnd(9),
        (m.smallTargets.length ? 'FAIL' : 'ok').padEnd(5),
        (m.lowContrast.length ? 'FAIL' : 'ok').padEnd(9)
    ];
    console.log(cells.join(''));

    if (SHOTS) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        await page.screenshot({ path: `${OUT}/${slug}-${w}x${h}.png`, fullPage: false });
    }
}

/* Scroll clearance and reduced motion are viewport-independent behaviours. */
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(150);
const clearance = await page.evaluate(checkScrollClearance);
if (clearance.length) fail('scroll clearance', `targets land under the fixed nav: ${clearance.join(', ')}`);
console.log('-'.repeat(78));
console.log(`scroll-target clearance under fixed nav : ${clearance.length ? 'FAIL -> ' + clearance.join(', ') : 'ok'}`);

const css = await page.evaluate(checkStylesheetIntegrity);
if (css.missing.length) fail('stylesheet', `rules/declarations lost to a parse error: ${css.missing.join(', ')}`);
if (css.squiggleRepeat && css.squiggleRepeat !== 'repeat-x') {
    fail('stylesheet', `.squiggle background-repeat is "${css.squiggleRepeat}", expected repeat-x (tile will paint over the text)`);
}
if (css.squiggleSize && css.squiggleSize === 'auto') {
    fail('stylesheet', '.squiggle background-size is auto (tile paints at intrinsic size across the headline)');
}
console.log(`stylesheet parsed intact (${css.ruleCount} rules)     : ${css.missing.length || css.squiggleRepeat !== 'repeat-x' ? 'FAIL' : 'ok'}`);

const rm = await browser.newContext({ reducedMotion: 'reduce' });
const rmPage = await rm.newPage();
await rmPage.goto(URL_, { waitUntil: 'networkidle' });
const motion = await rmPage.evaluate(checkReducedMotion);
if (!motion.matches) fail('reduced motion', 'emulation did not apply');
if (motion.animating.length) fail('reduced motion', `still animating: ${motion.animating.join(', ')}`);
if (motion.scrollBehavior === 'smooth') fail('reduced motion', 'scroll-behavior is still smooth');
console.log(`prefers-reduced-motion honoured        : ${motion.animating.length || motion.scrollBehavior === 'smooth' ? 'FAIL' : 'ok'}`);
await rm.close();

/* WCAG 1.4.10 Reflow: 320 CSS px with no horizontal scroll. */
await page.setViewportSize({ width: LIMITS.reflowWidthPx, height: 800 });
await page.waitForTimeout(150);
const reflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth
}));
if (reflow.sw > reflow.cw) fail('reflow@320', `scrollWidth ${reflow.sw} > ${reflow.cw}`);
console.log(`WCAG 1.4.10 reflow at ${LIMITS.reflowWidthPx}px             : ${reflow.sw > reflow.cw ? 'FAIL' : 'ok'}`);

await browser.close();

console.log('='.repeat(78));
if (failures.length) {
    console.log(`\n${failures.length} FAILURE(S):`);
    failures.forEach((f) => console.log('  x ' + f));
    process.exit(1);
}
console.log(`\nAll checks passed across ${DEVICES.length} viewports.\n`);
