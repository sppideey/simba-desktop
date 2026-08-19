/**
 * docx.ts — Word export, ported from Simba AI/deploy/index.html.
 *
 * Converts the RAW MARKDOWN of a message, not scraped DOM text, so headings,
 * nested lists and fenced code survive. Charts are embedded as PNGs composited
 * onto an opaque background first: the chart canvas is transparent and its
 * labels are near-white, which would be invisible on Word's white page.
 *
 * Only run-flags that are actually on are set — passing `bold: false` writes
 * <w:b w:val="false"/>, which overrides Word's built-in Heading style and
 * flattens every heading in the document.
 *
 * @ts-nocheck: lifted as-is from the working browser implementation.
 */
// @ts-nocheck
import * as docxLib from 'docx';

/** docx is a real dependency here, so there is nothing to lazy-load. */
async function ensureDocx() { return docxLib; }

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

        const DOCX_CHART_BG = '#1e1b4b';
        const DOCX_CHART_MAX_W = 600;   // points — page width inside the margins
        const DOCX_CHART_MAX_H = 270;
        const DOCX_CODE_FONT = 'Consolas';
        const DOCX_CODE_FILL = 'F1F1F5';
        function docxInlineTokens(src) {
            const text = String(src == null ? '' : src);
            const out = [];
            let buf = '', bold = false, italic = false, strike = false, i = 0;
            const push = () => {
                if (buf) { out.push({ text: buf, bold: bold, italic: italic, strike: strike, code: false }); buf = ''; }
            };
            while (i < text.length) {
                const c = text[i];
                if (c === '\\' && i + 1 < text.length && '\\`*_[]()#~'.indexOf(text[i + 1]) !== -1) {
                    buf += text[i + 1]; i += 2; continue;
                }
                if (c === '`') {
                    let ticks = 1;
                    while (text[i + ticks] === '`') ticks++;
                    const fence = text.substr(i, ticks);
                    const close = text.indexOf(fence, i + ticks);
                    if (close !== -1) {
                        push();
                        out.push({
                            text: text.slice(i + ticks, close),
                            bold: bold, italic: italic, strike: strike, code: true,
                        });
                        i = close + ticks; continue;
                    }
                    buf += c; i++; continue;
                }
                if (c === '~' && text[i + 1] === '~') {
                    if (strike || docxCanOpen(text, i, '~~')) { push(); strike = !strike; i += 2; continue; }
                    buf += '~~'; i += 2; continue;
                }
                if ((c === '*' || c === '_') && text[i + 1] === c) {
                    if (bold || docxCanOpen(text, i, c + c)) { push(); bold = !bold; i += 2; continue; }
                    buf += c + c; i += 2; continue;
                }
                if (c === '*' || c === '_') {
                    if (italic || docxCanOpen(text, i, c)) { push(); italic = !italic; i++; continue; }
                    buf += c; i++; continue;
                }
                buf += c; i++;
            }
            push();
            return out;
        }

        // An emphasis marker only opens when it is genuinely a delimiter: never
        // mid-identifier (snake_case_name), never with whitespace behind it, and
        // only when a closing marker actually exists further along the line.
        function docxCanOpen(text, i, marker) {
            const next = text[i + marker.length];
            if (next === undefined || next === ' ' || next === '\t') return false;
            if (marker.charAt(0) === '_') {
                const prev = i > 0 ? text.charAt(i - 1) : '';
                if (prev && /[A-Za-z0-9]/.test(prev)) return false;
            }
            return text.indexOf(marker, i + marker.length + 1) !== -1;
        }

        // A URL is dead weight in a flat Word paragraph — keep the label, drop
        // the target. Both patterns are single-pass with no nested quantifiers.
        function docxStripLinks(s) {
            return String(s == null ? '' : s)
                .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
                .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
        }

        // Only ever set a flag that is actually on: docx writes an explicit
        // w:val="false" for a literal false, and that would beat the Heading
        // style's own bold and flatten every heading in the document.
        function docxRuns(D, src, base) {
            const o = base || {};
            const runs = docxInlineTokens(docxStripLinks(src)).map(t => {
                const r = { text: t.text };
                if (t.bold || o.bold) r.bold = true;
                if (t.italic || o.italics) r.italics = true;
                if (t.strike || o.strike) r.strike = true;
                if (t.code) { r.font = DOCX_CODE_FONT; r.color = '6D28D9'; }
                else {
                    if (o.font) r.font = o.font;
                    if (o.color) r.color = o.color;
                }
                return new D.TextRun(r);
            });
            return runs.length ? runs : [new D.TextRun({ text: '' })];
        }

        function docxHeadingLevel(D, n) {
            if (n === 1) return D.HeadingLevel.HEADING_1;
            if (n === 2) return D.HeadingLevel.HEADING_2;
            if (n === 3) return D.HeadingLevel.HEADING_3;
            return D.HeadingLevel.HEADING_4;
        }

        function docxCodeLine(D, text) {
            return new D.Paragraph({
                children: [new D.TextRun({
                    text: String(text).replace(/\t/g, '    ') || ' ',
                    font: DOCX_CODE_FONT, size: 18, color: '272536',
                })],
                shading: { type: D.ShadingType.CLEAR, fill: DOCX_CODE_FILL, color: 'auto' },
                spacing: { before: 0, after: 0, line: 250 },
            });
        }

        // Indent width for a nested list item. Tabs count as two spaces; four
        // levels is far past anything a chat reply produces.
        function docxListLevel(indent) {
            return Math.min(Math.floor(String(indent).replace(/\t/g, '  ').length / 2), 3);
        }

        /* Line-based block walker. Deliberately small — headings, paragraphs,
           the two list flavours, fenced code, blockquotes, rules and charts.
           Anything it does not recognise becomes a plain paragraph with the
           syntax characters stripped, never literal ** or [](…) on the page. */
        function docxBlocksFromMarkdown(D, md, shots) {
            const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
            const children = [];
            const orderedRefs = [];
            let para = [];
            let olRef = null;
            let chartIdx = 0;

            const flushPara = () => {
                if (!para.length) return;
                children.push(new D.Paragraph({
                    children: docxRuns(D, para.join(' ')),
                    spacing: { after: 140 },
                }));
                para = [];
            };

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];

                const fence = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)/);
                if (fence) {
                    flushPara(); olRef = null;
                    const closeRe = new RegExp('^ {0,3}' + fence[1].charAt(0) + '{' + fence[1].length + ',}[ \\t]*$');
                    const lang = (fence[2] || '').toLowerCase();
                    const body = [];
                    i++;
                    while (i < lines.length && !closeRe.test(lines[i])) { body.push(lines[i]); i++; }
                    if (lang === 'chart' || lang === 'graph') {
                        // Picture or nothing — the config JSON is not a document.
                        const img = docxChartParagraph(D, shots && shots[chartIdx]);
                        chartIdx++;
                        if (img) children.push(img);
                        continue;
                    }
                    body.forEach(l => children.push(docxCodeLine(D, l)));
                    if (body.length) children.push(new D.Paragraph({ spacing: { after: 140 } }));
                    continue;
                }

                if (!line.trim()) { flushPara(); olRef = null; continue; }

                if (/^ {0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) { flushPara(); olRef = null; continue; }

                const h = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
                if (h) {
                    flushPara(); olRef = null;
                    children.push(new D.Paragraph({
                        children: docxRuns(D, h[2].replace(/[ \t]+#+[ \t]*$/, '')),
                        heading: docxHeadingLevel(D, h[1].length),
                        spacing: { before: 260, after: 110 },
                    }));
                    continue;
                }

                const q = line.match(/^ {0,3}>[ \t]?(.*)$/);
                if (q) {
                    flushPara(); olRef = null;
                    children.push(new D.Paragraph({
                        children: docxRuns(D, q[1], { italics: true, color: '55506B' }),
                        indent: { left: 360 },
                        spacing: { after: 120 },
                    }));
                    continue;
                }

                const ul = line.match(/^([ \t]*)[-*+][ \t]+(.*)$/);
                if (ul) {
                    flushPara(); olRef = null;
                    children.push(new D.Paragraph({
                        children: docxRuns(D, ul[2]),
                        bullet: { level: docxListLevel(ul[1]) },
                        spacing: { after: 60 },
                    }));
                    continue;
                }

                const ol = line.match(/^([ \t]*)\d{1,9}[.)][ \t]+(.*)$/);
                if (ol) {
                    flushPara();
                    // A fresh reference per list block, so a second list further
                    // down the message restarts at 1 instead of continuing.
                    if (!olRef) { olRef = 'simba-ol-' + orderedRefs.length; orderedRefs.push(olRef); }
                    children.push(new D.Paragraph({
                        children: docxRuns(D, ol[2]),
                        numbering: { reference: olRef, level: docxListLevel(ol[1]) },
                        spacing: { after: 60 },
                    }));
                    continue;
                }

                para.push(line.trim());
            }
            flushPara();
            return { children: children, orderedRefs: orderedRefs };
        }

        function docxChartParagraph(D, shot) {
            if (!shot) return null;   // fence never drew a chart — skip it silently
            try {
                return new D.Paragraph({
                    children: [new D.ImageRun({
                        data: shot.data,
                        transformation: { width: shot.width, height: shot.height },
                    })],
                    alignment: D.AlignmentType.CENTER,
                    spacing: { before: 140, after: 180 },
                });
            } catch (e) { return null; }
        }

        /* ---- charts on screen → PNG bytes ----
           One slot per ```chart fence, in document order, so the Nth fence in
           the markdown lines up with the Nth chart in the DOM. A fence whose
           chart failed to draw still occupies its slot as null — that keeps the
           remaining charts from sliding onto the wrong blocks. */
        function docxCollectChartShots(btn) {
            const shots = [];
            try {
                const wrap = btn && btn.closest ? btn.closest('.ai-msg-wrapper') : null;
                if (!wrap) return shots;
                wrap.querySelectorAll('.chart-block canvas, pre[data-chart-failed]').forEach(el => {
                    shots.push(el.tagName === 'CANVAS' ? docxCanvasShot(el) : null);
                });
            } catch (e) { /* a document without pictures still beats no document */ }
            return shots;
        }

        function docxCanvasShot(canvas) {
            try {
                const w = canvas.width, h = canvas.height;
                if (!w || !h) return null;
                // Chart.js may still be in flight — an empty dark rectangle in
                // the document helps nobody.
                if (!_liveCharts.some(c => c && c.canvas === canvas)) return null;
                const off = document.createElement('canvas');
                off.width = w; off.height = h;
                const ctx = off.getContext('2d');
                if (!ctx) return null;
                ctx.fillStyle = DOCX_CHART_BG;
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(canvas, 0, 0);
                const scale = Math.min(DOCX_CHART_MAX_W / w, DOCX_CHART_MAX_H / h);
                return {
                    data: docxDataUrlToBytes(off.toDataURL('image/png')),
                    width: Math.max(1, Math.round(w * scale)),
                    height: Math.max(1, Math.round(h * scale)),
                };
            } catch (e) { return null; }
        }

        function docxDataUrlToBytes(url) {
            const bin = atob(String(url).slice(String(url).indexOf(',') + 1));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes;
        }

        function docxNumberingConfig(D, refs) {
            return refs.map(ref => ({
                reference: ref,
                levels: [0, 1, 2, 3].map(level => ({
                    level: level,
                    format: D.LevelFormat.DECIMAL,
                    text: '%' + (level + 1) + '.',
                    alignment: D.AlignmentType.LEFT,
                    style: { paragraph: { indent: { left: 420 + level * 360, hanging: 260 } } },
                })),
            }));
        }

        function docxBuildDocument(D, title, blocks) {
            const head = [
                new D.Paragraph({ text: title, heading: D.HeadingLevel.TITLE, spacing: { after: 60 } }),
                new D.Paragraph({
                    children: [new D.TextRun({
                        text: 'Simba AI · ' + new Date().toLocaleDateString(),
                        size: 18, color: '6B6880',
                    })],
                    spacing: { after: 280 },
                }),
            ];
            return new D.Document({
                creator: 'Simba AI',
                title: title,
                numbering: { config: docxNumberingConfig(D, blocks.orderedRefs) },
                // Word is dark-on-white — the app's palette stops at the browser.
                styles: { default: { document: { run: { font: 'Calibri', size: 22, color: '20202A' } } } },
                sections: [{
                    properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
                    children: head.concat(blocks.children),
                }],
            });
        }

        function docxFileName(title) {
            let base = String(title == null ? '' : title).replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (base.length > 60) base = base.slice(0, 60).trim();
            return (base || 'simba-chat') + '.docx';
        }

        // lucide.createIcons() swaps the <i> for an <svg>, so there is no <i>
        function unwrapDocxFences(md) {
            const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
            const out = [];
            for (let i = 0; i < lines.length; i++) {
                const fence = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)/);
                if (fence && (fence[2] || '').toLowerCase() === 'docx') {
                    const closeRe = new RegExp('^ {0,3}' + fence[1].charAt(0) + '{' + fence[1].length + ',}[ \\t]*$');
                    i++;
                    while (i < lines.length && !closeRe.test(lines[i])) { out.push(lines[i]); i++; }
                    continue;
                }
                out.push(lines[i]);
            }
            return out.join('\n');
        }

        function docxCardTitle(md) {
            const lines = String(md || '').split('\n');
            for (let i = 0; i < lines.length; i++) {
                const h = lines[i].match(/^ {0,3}#{1,3}\s+(.+?)\s*#*\s*$/);
                if (h) return h[1].replace(/[*_`]/g, '').trim();
                const t = lines[i].match(/^\s*title:\s*(.+)$/i);
                if (t) return t[1].trim();
            }
            const first = lines.map(l => l.trim()).filter(Boolean)[0] || '';
            return first.slice(0, 60) || 'Document';
        }

/* ------------------------------------------------------------------ API */

export { unwrapDocxFences, docxCardTitle, docxFileName };

/**
 * Build a .docx from one message's markdown and hand it to the user.
 *
 * `host` is the rendered message element; any charts inside it are captured
 * as images so the document carries the picture rather than its JSON.
 */
export async function downloadDocx(markdown: string, title: string, host?: HTMLElement | null) {
    const D = await ensureDocx();
    const shots = host ? docxCollectChartShotsFrom(host) : [];
    const blocks = docxBlocksFromMarkdown(D, unwrapDocxFences(markdown), shots);
    const doc = docxBuildDocument(D, title, blocks);

    const blob = await D.Packer.toBlob(doc);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = docxFileName(title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some engines.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Turn a whole conversation into revision notes.
 *
 * Not a transcript: the questions become headings and the answers become the
 * body, so it reads as a study sheet rather than a chat log. Charts and graphs
 * anywhere on screen are captured as images, so a plotted function arrives in
 * the document as the picture rather than as its JSON.
 */
export async function downloadRevisionNotes(
  messages: Array<{ role: string; content: string }>,
  title: string,
  host?: HTMLElement | null,
) {
  const parts: string[] = [`# ${title}`, ''];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;

    const question = m.content.trim().replace(/\s+/g, ' ');
    const answer = messages[i + 1]?.role === 'assistant' ? messages[i + 1].content : '';
    if (!answer.trim()) continue;

    // A heading has to be a line, not a paragraph — long questions get trimmed
    // for the heading and kept in full underneath.
    const short = question.length > 90 ? `${question.slice(0, 88)}…` : question;
    parts.push(`## ${short}`, '');
    if (question.length > 90) parts.push(`*${question}*`, '');
    parts.push(unwrapDocxFences(answer).trim(), '');
  }

  if (parts.length <= 2) {
    throw new Error('This chat has no answers to write up yet.');
  }

  await downloadDocx(parts.join('\n'), title, host);
}

/** Same collector as the web app, but rooted at an element we already hold. */
function docxCollectChartShotsFrom(host: HTMLElement) {
    const shots = [];
    host.querySelectorAll('.chart-block canvas').forEach((canvas) => {
        const shot = docxCanvasShot(canvas);
        if (shot) shots.push(shot);
    });
    return shots;
}
