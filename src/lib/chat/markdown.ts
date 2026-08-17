/**
 * markdown.ts — assistant markdown, maths and code, ported from
 * Simba AI/deploy/index.html:2180 with its behaviour intact.
 *
 * KaTeX is called directly rather than through its auto-render DOM scan, for
 * two reasons that both still apply here:
 *
 *   1. marked destroys the delimiters before any DOM exists. In CommonMark a
 *      backslash before ASCII punctuation is an escape, so \( \) \[ \] parse
 *      down to bare ( ) [ ] — the markers are gone before KaTeX could see
 *      them. Maths spans are therefore lifted out to placeholders before
 *      parsing and rendered back in afterwards.
 *   2. A DOM scan cannot tell "$5 and $10 each" from an equation, and rendered
 *      exactly that as maths when it was tried.
 *
 * One deliberate change from the web app: the result is run through DOMPurify.
 * A desktop app has filesystem and shell reach, and chat content is persisted,
 * so an injected payload would re-fire on every launch.
 */

import { marked } from 'marked';
import katex from 'katex';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

/**
 * Arms are tried in order at each $, widest evidence first.
 *   1-3  $$…$$, \[…\], \(…\)  — unambiguous display/inline forms
 *   4    tight inline, no space just inside the dollars: "$x^2$"
 *   5    spaced, but carrying a TeX character (\ ^ _ { }): "$ \alpha $"
 *   6    spaced and plain, e.g. "$ a = 2 $", which the model writes
 *        constantly. Capped at 60 chars and refused outright if the span
 *        holds any 3-letter word — that is what stops "$5 and a case costs
 *        $10" being eaten as an equation, since real maths spells its words
 *        as TeX commands and matches arm 5 first.
 */
const MATH_SPAN =
  /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:[^\s$][^$\n]*[^\s$]|[^\s$])\$|\$[^$\n]*[\\^_{}][^$\n]*\$|\$(?![^$\n]*[A-Za-z]{3})[^$\n]{1,60}\$/g;

/** Fenced and inline code are copied through untouched: a $ in a code sample
    is a dollar sign, not an equation. */
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/g;

function mathDelimiters(span: string) {
  if (span.startsWith('$$')) return { tex: span.slice(2, -2), display: true };
  if (span.startsWith('\\[')) return { tex: span.slice(2, -2), display: true };
  if (span.startsWith('\\(')) return { tex: span.slice(2, -2), display: false };
  return { tex: span.slice(1, -1), display: false };
}

export function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markdown + maths, as sanitised HTML. */
export function renderMarkdown(src: string): string {
  const stash: string[] = [];
  const hide = (chunk: string) =>
    chunk.replace(MATH_SPAN, (m) => {
      stash.push(m);
      return `@@SIMBAMATH${stash.length - 1}@@`;
    });

  // Walk the source in code / not-code stretches, masking only the prose ones,
  // so marked still sees its fences exactly as written.
  const text = String(src ?? '');
  let masked = '';
  let last = 0;
  let code: RegExpExecArray | null;
  CODE_SPAN.lastIndex = 0;
  while ((code = CODE_SPAN.exec(text)) !== null) {
    masked += hide(text.slice(last, code.index)) + code[0];
    last = code.index + code[0].length;
  }
  masked += hide(text.slice(last));

  const html = (marked.parse(masked) as string).replace(
    /@@SIMBAMATH(\d+)@@/g,
    (whole, i) => {
      const span = stash[Number(i)];
      if (span === undefined) return whole;
      const parts = mathDelimiters(span);
      try {
        // A malformed expression stays as plain TeX rather than painting a
        // red error string into the chat.
        return katex.renderToString(parts.tex, {
          displayMode: parts.display,
          throwOnError: false,
        });
      } catch {
        return escapeHtml(span);
      }
    },
  );

  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mstyle', 'mspace', 'mtext', 'munderover', 'munder', 'mover', 'mtable', 'mtr', 'mtd'],
    ADD_ATTR: ['aria-hidden', 'xmlns', 'encoding', 'displaystyle', 'scriptlevel', 'mathvariant', 'stretchy', 'style'],
  });
}

/**
 * Highlight code and wrap each block in a header carrying the language and a
 * copy button. Runs after the HTML is in the DOM, never during streaming —
 * a half-arrived fence would be highlighted as the wrong language.
 */
export function enhanceCodeBlocks(root: HTMLElement, onCopy: (text: string) => void) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.code-block')) return;

    const codeEl = pre.querySelector('code');
    let lang = 'code';
    if (codeEl) {
      const m = (codeEl.className || '').match(/language-([\w+#.-]+)/i);
      if (m) lang = m[1];
      try {
        hljs.highlightElement(codeEl as HTMLElement);
      } catch {
        /* an unknown language tag is not worth failing the whole message over */
      }
    }

    const block = document.createElement('div');
    block.className = 'code-block';

    const head = document.createElement('div');
    head.className = 'code-head';

    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang;

    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'flex items-center gap-1.5 text-[11.5px] text-muted-foreground px-2 py-1 rounded-md transition-colors hover:bg-accent hover:text-foreground';
    button.textContent = 'Copy';
    button.addEventListener('click', () => {
      onCopy(pre.innerText);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1400);
    });

    head.append(label, button);
    pre.parentNode?.insertBefore(block, pre);
    block.append(head, pre);
  });
}
