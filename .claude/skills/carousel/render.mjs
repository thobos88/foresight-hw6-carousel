// Рендер карусели: slides.html → 01.png…NN.png (1080×1350) + preview.png + check.json.
// Запуск: node render.mjs <slides.html> [папка-вывода]
// Playwright берётся из проекта dk-web-conversion (chromium там уже установлен);
// другой путь — переменная окружения PLAYWRIGHT_MJS. Ничего не устанавливает.
// Код выхода 1, если хоть одна проверка не прошла (PNG всё равно пишутся — чтобы посмотреть).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PW = process.env.PLAYWRIGHT_MJS || '/Users/Yoga/Projects/dk-web-conversion/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);

const src = resolve(process.argv[2] || 'slides.html');
const out = resolve(process.argv[3] || dirname(src));
mkdirSync(out, { recursive: true });

const W = 1080, H = 1350, PAD = 72;
const LIMITS = { titleWords: 6, slideWords: 25, contrast: 4.5 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(pathToFileURL(src).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

const report = await page.evaluate(({ W, H, PAD, LIMITS }) => {
  // --- цвет и контраст (WCAG 2.x) ---
  const parse = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let acc = { r: 0, g: 0, b: 0, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const words = (s) => s.replace(/[«»"“”.,:;!?()]/g, ' ').split(/\s+/).filter((w) => w && !/^[—–\-→·\/]+$/.test(w));

  // --- шрифты с кириллицей реально загружены ---
  const faces = [...document.fonts].filter((f) => f.status === 'loaded');
  const cyr = (fam) => faces.some((f) => f.family.replace(/["']/g, '') === fam && /U\+0?400/i.test(f.unicodeRange));
  const fonts = { Manrope: cyr('Manrope'), Inter: cyr('Inter'), 'JetBrains Mono': cyr('JetBrains Mono') };

  const slides = [...document.querySelectorAll('.slide')].map((s, i) => {
    const sr = s.getBoundingClientRect();
    const problems = [];
    // 1) переполнение: scrollHeight/scrollWidth против clientHeight/clientWidth.
    //    По высоте — у рамки слайда (.frame: всё содержимое влезло между полями) и у блоков
    //    с фиксированной высотой (overflow ≠ visible или атрибут data-fit). Выносные элементы букв
    //    при плотном межстрочном (line-height < 1.3) — не переполнение, их не считаем.
    //    По ширине — у всех блоков: длинное слово, которое не перенеслось, ловится здесь.
    const frame = s.querySelector('.frame');
    for (const el of [frame, ...s.querySelectorAll('.frame *')]) {
      if (!el || el.closest('svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'inline' || cs.display === 'contents') continue;
      const fixed = el === frame || el.hasAttribute('data-fit') || cs.overflowY !== 'visible';
      if (fixed && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1)
        problems.push(`переполнение по высоте: ${el.className || el.tagName} ${el.scrollHeight}>${el.clientHeight}`);
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2)
        problems.push(`переполнение по ширине: ${el.className || el.tagName} ${el.scrollWidth}>${el.clientWidth}`);
    }
    // 2) каждая строка текста — внутри полей 72 px; 3) контраст; 4) строки разных блоков не наезжают.
    //    Строка = прямоугольник текста, обрезанный по высоте до line-height (как её раскладывает CSS).
    const tw = document.createTreeWalker(s, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.textContent.trim() ? 1 : 2 });
    const boxes = []; let minC = 99, minAt = '';
    for (let n; (n = tw.nextNode());) {
      const el = n.parentElement;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const lh = parseFloat(cs.lineHeight);
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const mid = (r.top + r.bottom) / 2, half = Number.isFinite(lh) ? Math.min(r.height, lh) / 2 : r.height / 2;
        const x0 = r.left - sr.left, y0 = mid - half - sr.top, x1 = r.right - sr.left, y1 = mid + half - sr.top;
        if (x0 < PAD - 1 || y0 < PAD - 1 || x1 > W - PAD + 1 || y1 > H - PAD + 1)
          problems.push(`текст за полями: «${n.textContent.trim().slice(0, 30)}» [${Math.round(x0)},${Math.round(y0)},${Math.round(x1)},${Math.round(y1)}]`);
        boxes.push({ el, t: n.textContent.trim().slice(0, 24), x0, y0, x1, y1 });
      }
      const inSvg = !!el.closest('svg');
      const fg = parse(inSvg ? cs.fill : cs.color);
      if (fg) {
        const c = ratio(over({ ...fg, a: fg.a * Number(cs.opacity) }, bgOf(el)), bgOf(el));
        if (c < minC) { minC = c; minAt = n.textContent.trim().slice(0, 30); }
        if (c < LIMITS.contrast) problems.push(`контраст ${c.toFixed(2)} < ${LIMITS.contrast}: «${n.textContent.trim().slice(0, 30)}»`);
      }
    }
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const p = boxes[a], q = boxes[b];
      if (p.el === q.el || p.el.contains(q.el) || q.el.contains(p.el)) continue;
      const ix = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0), iy = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
      if (ix > 2 && iy > 2) problems.push(`тексты наезжают: «${p.t}» и «${q.t}»`);
    }
    // 5) объём текста: заголовок ≤ 6 слов, на слайде ≤ 25 слов (метки, счётчик, подвал не считаются)
    const titleEl = s.querySelector('.title, .hero');
    const titleWords = titleEl ? words(titleEl.innerText).length : 0;
    const slideWords = [...s.querySelectorAll('.w')].reduce((acc, e) => acc + words(e.innerText).length, 0);
    if (titleWords > LIMITS.titleWords) problems.push(`заголовок ${titleWords} слов > ${LIMITS.titleWords}`);
    if (slideWords > LIMITS.slideWords) problems.push(`на слайде ${slideWords} слов > ${LIMITS.slideWords}`);
    return { slide: i + 1, id: s.id, w: Math.round(sr.width), h: Math.round(sr.height), titleWords, slideWords,
      minContrast: Number(minC.toFixed(2)), minContrastText: minAt, problems };
  });
  return { fonts, slides };
}, { W, H, PAD, LIMITS });

// --- PNG по одному на слайд ---
const files = [];
const els = await page.$$('.slide');
for (let i = 0; i < els.length; i++) {
  const f = join(out, String(i + 1).padStart(2, '0') + '.png');
  await els[i].screenshot({ path: f });
  files.push(f);
}

// --- проверка размера готовых PNG (читаем заголовок IHDR) ---
const { readFileSync } = await import('node:fs');
const sizes = files.map((f) => { const b = readFileSync(f); return { file: f, w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; });
const badSize = sizes.filter((s) => s.w !== W || s.h !== H);

// --- лист-превью: все слайды сеткой 4×N ---
const cols = 4, tw = 360, th = 450, gap = 24;
const rows = Math.ceil(files.length / cols);
const sheetW = cols * tw + (cols + 1) * gap, sheetH = rows * th + (rows + 1) * gap;
const sheet = await ctx.newPage();
await sheet.setViewportSize({ width: sheetW, height: sheetH });
// временный html рядом со слайдами: страница с file:// может показать file://-картинки
const tmp = join(out, '.preview.html');
writeFileSync(tmp, `<html><body style="margin:0;background:#05070A;width:${sheetW}px;height:${sheetH}px;display:grid;grid-template-columns:repeat(${cols},${tw}px);gap:${gap}px;padding:${gap}px;box-sizing:border-box">${files.map((f) => `<img src="${pathToFileURL(f).href}" style="width:${tw}px;height:${th}px;border-radius:14px;display:block">`).join('')}</body></html>`);
await sheet.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
await sheet.screenshot({ path: join(out, 'preview.png') });
const { unlinkSync } = await import('node:fs');
unlinkSync(tmp);

await browser.close();

const failed = report.slides.filter((s) => s.problems.length);
const fontsOk = Object.values(report.fonts).every(Boolean);
const result = { date: new Date().toISOString(), source: src, limits: LIMITS, fonts: report.fonts, sizes: sizes.map((s) => `${s.w}x${s.h}`),
  slides: report.slides, ok: !failed.length && !badSize.length && fontsOk };
writeFileSync(join(out, 'check.json'), JSON.stringify(result, null, 2));

for (const s of report.slides)
  console.log(`${String(s.slide).padStart(2, '0')}  ${s.w}×${s.h}  заголовок ${s.titleWords} сл., всего ${s.slideWords} сл., мин. контраст ${s.minContrast}  ${s.problems.length ? 'ОШИБКИ: ' + s.problems.join(' | ') : 'OK'}`);
console.log('шрифты с кириллицей:', JSON.stringify(report.fonts));
console.log('PNG размеры:', badSize.length ? 'ОШИБКА ' + JSON.stringify(badSize) : `все ${W}×${H}`);
console.log(result.ok ? 'ИТОГ: OK' : 'ИТОГ: есть ошибки — см. check.json');
process.exit(result.ok ? 0 : 1);
