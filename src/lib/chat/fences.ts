/**
 * fences.ts — ```chart and ```graph blocks, ported from
 * Simba AI/deploy/index.html with their behaviour intact.
 *
 * `chart` is for categorical data; `graph` is for maths and draws the full
 * four-quadrant plane. The graph compiler is a hand-written shunting-yard:
 * expressions are COMPILED, never evaluated, so model text is never executed.
 *
 * Ported verbatim rather than rewritten, because nearly every line fixes
 * something found the hard way — graphOwn() instead of table[name] (or
 * `constructor` resolves through the prototype chain), graphValidate() (or
 * `2+` silently returns NaN at every sample), tension 0 (a smoothed maths
 * curve is a wrong maths curve), and equalAspect measured off chartArea
 * rather than the wrapper (or circles come out ~9% oval).
 *
 * @ts-nocheck is deliberate: this is JavaScript lifted as-is. Annotating it
 * would mean editing lines whose exact behaviour is the entire point.
 */
// @ts-nocheck
import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);
// applyChartTheme() reads window.Chart, as it did in the browser build.
(window as unknown as { Chart: unknown }).Chart = Chart;

/** Chart.js is a real dependency here, so there is nothing to lazy-load. */
async function ensureChartJs() { return Chart; }

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

        const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'scatter', 'bubble'];
        // Chrome palette only — teal and amber are reserved as content signals.
        const CHART_PALETTE = ['#a78bfa', '#6366f1', '#c4b5fd', '#4f46e5', '#7c3aed', '#818cf8'];
        // These paint one colour per slice rather than one per series.
        const CHART_SLICE_TYPES = ['pie', 'doughnut', 'polarArea'];
        const CHART_MAX_DATASETS = 12;
        const CHART_MAX_POINTS = 2000;

        let _chartJsPromise = null;   // cached so N charts trigger ONE network load
        let _liveCharts = [];

        function applyChartTheme() {
            const C = window.Chart;
            if (!C || C._simbaThemed) return;
            C._simbaThemed = true;
            try {
                C.defaults.font.family = "'Inter', sans-serif";
                C.defaults.font.size = 11;
                C.defaults.color = 'rgba(255,255,255,0.45)';
                C.defaults.borderColor = 'rgba(255,255,255,0.08)';
                if (C.defaults.scale) {
                    if (C.defaults.scale.grid) C.defaults.scale.grid.color = 'rgba(255,255,255,0.08)';
                    if (C.defaults.scale.ticks) C.defaults.scale.ticks.color = 'rgba(255,255,255,0.45)';
                }
                const p = C.defaults.plugins || {};
                if (p.legend && p.legend.labels) {
                    p.legend.labels.color = 'rgba(255,255,255,0.45)';
                    p.legend.labels.boxWidth = 12;
                    p.legend.labels.usePointStyle = true;
                }
                if (p.tooltip) {
                    p.tooltip.backgroundColor = 'rgba(15,23,42,0.95)';
                    p.tooltip.borderColor = 'rgba(255,255,255,0.12)';
                    p.tooltip.borderWidth = 1;
                    p.tooltip.titleColor = '#f1f5f9';
                    p.tooltip.bodyColor = 'rgba(255,255,255,0.78)';
                    p.tooltip.padding = 10;
                    p.tooltip.cornerRadius = 8;
                }
            } catch (e) { /* a theme miss is not worth losing the chart over */ }
        }

        function chartRgba(hex, alpha) {
            const n = parseInt(String(hex).slice(1), 16);
            if (isNaN(n)) return hex;
            return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
        }

        // Cycle the palette only where the model gave us nothing — explicit
        // colours from the config win.
        function paintChartDataset(ds, i, type, isSlice) {
            const base = CHART_PALETTE[i % CHART_PALETTE.length];
            if (isSlice) {
                if (ds.backgroundColor === undefined) {
                    ds.backgroundColor = ds.data.map((_, j) => CHART_PALETTE[j % CHART_PALETTE.length]);
                }
                if (ds.borderColor === undefined) ds.borderColor = 'rgba(15,23,42,0.6)';
                if (ds.borderWidth === undefined) ds.borderWidth = 2;
                return;
            }
            if (type === 'line' || type === 'radar' || type === 'scatter' || type === 'bubble') {
                if (ds.borderColor === undefined) ds.borderColor = base;
                if (ds.backgroundColor === undefined) ds.backgroundColor = chartRgba(base, 0.18);
                if (ds.pointBackgroundColor === undefined) ds.pointBackgroundColor = base;
                if (ds.borderWidth === undefined) ds.borderWidth = 2;
                if (type === 'line' && ds.tension === undefined) ds.tension = 0.35;
                return;
            }
            if (ds.backgroundColor === undefined) ds.backgroundColor = chartRgba(base, 0.72);
            if (ds.borderColor === undefined) ds.borderColor = base;
            if (ds.borderWidth === undefined) ds.borderWidth = 1;
            if (type === 'bar' && ds.borderRadius === undefined) ds.borderRadius = 6;
        }

        function buildChartOptions(opts, type) {
            const o = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
            // The wrapper owns the height, so the canvas must not pick its own.
            o.responsive = true;
            o.maintainAspectRatio = false;
            if (o.animation === undefined) o.animation = { duration: 400, easing: 'easeOutQuart' };
            if (!o.plugins || typeof o.plugins !== 'object' || Array.isArray(o.plugins)) o.plugins = {};
            if (o.plugins.legend === undefined) o.plugins.legend = { display: true, position: 'bottom' };
            return o;
        }

        const GRAPH_SAMPLES = 481;      // odd, so x = 0 is always sampled exactly
        const GRAPH_MAX_FNS = 4;
        const GRAPH_HUGE = 1e6;         // past this a sample is a pole, not a value
        const GRAPH_FN1 = {
            sin: Math.sin, cos: Math.cos, tan: Math.tan,
            asin: Math.asin, acos: Math.acos, atan: Math.atan,
            sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
            sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
            ln: Math.log, log: Math.log10, log2: Math.log2, log10: Math.log10,
            exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
            round: Math.round, sign: Math.sign,
        };
        const GRAPH_FN2 = { pow: Math.pow, atan2: Math.atan2, min: Math.min, max: Math.max, mod: (a, b) => a % b };
        const GRAPH_CONST = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
        const GRAPH_PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, neg: 3, '^': 4 };
        const GRAPH_RIGHT = { '^': 1, neg: 1 };

        // Plain-object lookups inherit from Object.prototype, so "constructor"
        // and "__proto__" would otherwise read as known names.
        function graphOwn(table, name) { return Object.prototype.hasOwnProperty.call(table, name); }
        function graphIsFn(name) { return graphOwn(GRAPH_FN1, name) || graphOwn(GRAPH_FN2, name); }

        // A model writing maths reaches for "y = -2x + 3", "x²", "π" and unicode
        // minus signs. The grammar below understands none of that, and rejecting
        // the fence puts raw JSON on screen — so normalise into the grammar first.
        const GRAPH_SUPERS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
        const GRAPH_LHS_OK = ['y', 'f(x)', 'y(x)', 'g(x)', 'h(x)', 'fx'];

        function graphNormalizeExpr(raw) {
            let s = String(raw == null ? '' : raw).trim();
            if (!s) return '';
            s = s.replace(/\$+/g, '')                                  // $...$ maths delimiters
                .replace(/\\left|\\right|\\,|\\;|\\!/g, '')
                .replace(/\\cdot|\\times/g, '*')
                .replace(/\\div/g, '/')
                .replace(/\\pi/g, 'pi')
                .replace(/\\sqrt/g, 'sqrt')
                .replace(/[−‒–—]/g, '-')           // unicode minus and dashes
                .replace(/[×⋅·]/g, '*')
                .replace(/÷/g, '/')
                .replace(/π/g, 'pi')
                .replace(/√/g, 'sqrt');
            // x² -> x^(2), and x¹² -> x^(12) rather than x^1^2
            s = s.replace(/[⁰¹²³⁴-⁹]+/g, run => {
                let digits = '';
                for (let i = 0; i < run.length; i++) digits += GRAPH_SUPERS[run[i]] || '';
                return digits ? '^(' + digits + ')' : '';
            });
            // "y = -2x + 3" and "f(x) = ..." are functions of x; keep the right side.
            const eq = s.indexOf('=');
            if (eq !== -1) {
                const lhs = s.slice(0, eq).replace(/\s+/g, '').toLowerCase();
                if (GRAPH_LHS_OK.indexOf(lhs) === -1) return '';   // "2y = x" is not ours to rearrange
                s = s.slice(eq + 1);
                if (s.indexOf('=') !== -1) return '';              // y = x = 2 is not an expression
            }
            return s.trim();
        }

        function graphTokenize(src) {
            const s = String(src);
            const out = [];
            let i = 0;
            while (i < s.length) {
                const c = s[i];
                if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
                if ((c >= '0' && c <= '9') || (c === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
                    let j = i;
                    while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.')) j++;
                    const num = parseFloat(s.slice(i, j));
                    if (!isFinite(num)) return null;
                    out.push({ t: 'num', v: num });
                    i = j;
                    continue;
                }
                if (/[A-Za-z_]/.test(c)) {
                    let j = i;
                    while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
                    out.push({ t: 'id', v: s.slice(i, j).toLowerCase() });
                    i = j;
                    continue;
                }
                if ('+-*/^%(),'.indexOf(c) !== -1) { out.push({ t: c }); i++; continue; }
                return null;   // anything outside the grammar kills the whole expression
            }
            return out;
        }

        // "2x", "3sin(x)" and "x(x+1)" are all things a model writes. Insert the
        // multiply it left out — but never between a function name and its "(".
        function graphImplicitMul(toks) {
            const out = [];
            for (let i = 0; i < toks.length; i++) {
                const prev = toks[i - 1];
                const cur = toks[i];
                if (prev) {
                    const prevEnds = prev.t === 'num' || prev.t === ')' || (prev.t === 'id' && !graphIsFn(prev.v));
                    const curStarts = cur.t === 'num' || cur.t === 'id' || cur.t === '(';
                    if (prevEnds && curStarts) out.push({ t: '*' });
                }
                out.push(cur);
            }
            return out;
        }

        function graphCompile(expr) {
            let toks = graphTokenize(expr);
            if (!toks || !toks.length) return null;
            toks = graphImplicitMul(toks);
            const out = [];
            const ops = [];
            let prev = null;
            for (let i = 0; i < toks.length; i++) {
                const tk = toks[i];
                if (tk.t === 'num') out.push(tk);
                else if (tk.t === 'id') {
                    if (graphIsFn(tk.v)) ops.push({ t: 'fn', v: tk.v });
                    else if (tk.v === 'x') out.push({ t: 'x' });
                    else if (graphOwn(GRAPH_CONST, tk.v)) out.push({ t: 'num', v: GRAPH_CONST[tk.v] });
                    else return null;              // unknown name — refuse rather than guess
                } else if (tk.t === ',') {
                    while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
                    if (!ops.length) return null;
                } else if (tk.t === '(') ops.push({ t: '(' });
                else if (tk.t === ')') {
                    while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
                    if (!ops.length) return null;  // unbalanced
                    ops.pop();
                    if (ops.length && ops[ops.length - 1].t === 'fn') out.push(ops.pop());
                } else {
                    const unary = (tk.t === '-' || tk.t === '+')
                        && (!prev || prev.t === '(' || prev.t === ','
                            || (prev.t !== 'num' && prev.t !== 'id' && prev.t !== ')'));
                    if (unary) {
                        if (tk.t === '-') ops.push({ t: 'op', v: 'neg' });
                    } else {
                        while (ops.length) {
                            const top = ops[ops.length - 1];
                            if (top.t !== 'op') break;
                            if (GRAPH_PREC[top.v] > GRAPH_PREC[tk.t]
                                || (GRAPH_PREC[top.v] === GRAPH_PREC[tk.t] && !GRAPH_RIGHT[tk.t])) out.push(ops.pop());
                            else break;
                        }
                        ops.push({ t: 'op', v: tk.t });
                    }
                }
                prev = tk;
            }
            while (ops.length) {
                const o = ops.pop();
                if (o.t === '(') return null;
                out.push(o);
            }
            return graphValidate(out) ? out : null;
        }

        // Walk the RPN counting stack depth. Catches "2+" and "min(x)", which
        // would otherwise compile and then quietly return NaN at every sample —
        // an empty plane reads as a broken app, not as a rejected expression.
        function graphValidate(rpn) {
            if (!rpn.length) return false;
            let depth = 0;
            for (let i = 0; i < rpn.length; i++) {
                const t = rpn[i];
                if (t.t === 'num' || t.t === 'x') { depth++; continue; }
                if (t.t === 'op') {
                    if (t.v === 'neg') { if (depth < 1) return false; continue; }
                    if (depth < 2) return false;
                    depth--;
                    continue;
                }
                if (t.t === 'fn') {
                    if (graphOwn(GRAPH_FN1, t.v)) { if (depth < 1) return false; }
                    else { if (depth < 2) return false; depth--; }
                    continue;
                }
                return false;
            }
            return depth === 1;
        }

        function graphEval(rpn, x) {
            const st = [];
            for (let i = 0; i < rpn.length; i++) {
                const t = rpn[i];
                if (t.t === 'num') { st.push(t.v); continue; }
                if (t.t === 'x') { st.push(x); continue; }
                if (t.t === 'op') {
                    if (t.v === 'neg') {
                        if (!st.length) return NaN;
                        st.push(-st.pop());
                        continue;
                    }
                    if (st.length < 2) return NaN;
                    const b = st.pop(), a = st.pop();
                    st.push(t.v === '+' ? a + b : t.v === '-' ? a - b : t.v === '*' ? a * b
                        : t.v === '/' ? a / b : t.v === '%' ? a % b : Math.pow(a, b));
                    continue;
                }
                const f1 = GRAPH_FN1[t.v];
                if (f1) {
                    if (!st.length) return NaN;
                    st.push(f1(st.pop()));
                } else {
                    if (st.length < 2) return NaN;
                    const b = st.pop(), a = st.pop();
                    st.push(GRAPH_FN2[t.v](a, b));
                }
            }
            return st.length === 1 ? st[0] : NaN;
        }

        function graphNum(v, fallback) {
            const n = typeof v === 'number' ? v : parseFloat(v);
            return isFinite(n) ? n : fallback;
        }

        function graphQuantile(sorted, q) {
            if (!sorted.length) return 0;
            const pos = (sorted.length - 1) * q;
            const lo = Math.floor(pos);
            const hi = Math.min(lo + 1, sorted.length - 1);
            return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
        }

        // Asymptotes would otherwise stretch the window until the interesting
        // part is a flat line on the axis, so fit to the bulk of the samples.
        function graphYWindow(ys) {
            if (!ys.length) return { min: -10, max: 10 };
            const sorted = ys.slice().sort((a, b) => a - b);
            const lo = graphQuantile(sorted, 0.02);
            const hi = graphQuantile(sorted, 0.98);
            const min = sorted[0], max = sorted[sorted.length - 1];
            let span = hi - lo;
            let a, b;
            if (span > 0 && (max - min) > 12 * span) { a = lo; b = hi; }
            else { a = min; b = max; }
            if (a === b) { a -= 1; b += 1; }
            // All four quadrants means the origin is always on screen.
            a = Math.min(a, 0);
            b = Math.max(b, 0);
            const pad = (b - a) * 0.08;
            return { min: a - pad, max: b + pad };
        }

        function graphAxis(min, max, label) {
            return {
                type: 'linear',
                position: 'center',      // this is what puts the axes through the origin
                min: min,
                max: max,
                grid: {
                    color: ctx => (ctx.tick && Math.abs(ctx.tick.value) < 1e-9
                        ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.07)'),
                    lineWidth: ctx => (ctx.tick && Math.abs(ctx.tick.value) < 1e-9 ? 1.4 : 1),
                    drawTicks: false,
                },
                border: { color: 'rgba(255,255,255,0.28)' },
                ticks: {
                    color: 'rgba(255,255,255,0.4)',
                    font: { size: 10 },
                    maxTicksLimit: 11,
                    // The origin label collides with the other axis.
                    callback: v => (Math.abs(v) < 1e-9 ? '' : v),
                },
                title: label ? { display: true, text: label, color: 'rgba(255,255,255,0.35)' } : { display: false },
            };
        }

        // Returns { cfg, meta } or null. Same contract as parseChartConfig:
        // never throws, never evaluates model text as code.
        function parseGraphSpec(src) {
            let spec;
            try { spec = JSON.parse(src); } catch (e) { return null; }
            if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;

            let list = spec.fns !== undefined ? spec.fns : (spec.fn !== undefined ? spec.fn : spec.expressions);
            if (typeof list === 'string') list = [list];
            if (!Array.isArray(list)) list = [];
            list = list.filter(f => typeof f === 'string' && f.trim()).slice(0, GRAPH_MAX_FNS);

            const rawPts = Array.isArray(spec.points) ? spec.points.slice(0, 200) : [];
            const pts = [];
            rawPts.forEach(p => {
                if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) pts.push({ x: +p[0], y: +p[1] });
                else if (p && typeof p === 'object' && isFinite(p.x) && isFinite(p.y)) pts.push({ x: +p.x, y: +p.y });
            });
            if (!list.length && !pts.length) return null;

            let xMin = graphNum(spec.xMin, -10);
            let xMax = graphNum(spec.xMax, 10);
            if (!(xMax > xMin)) { xMin = -10; xMax = 10; }
            if (xMax - xMin > 1e7) return null;
            // The x window must show the origin too, or it is not four quadrants.
            if (!list.length && pts.length) {
                pts.forEach(p => { xMin = Math.min(xMin, p.x); xMax = Math.max(xMax, p.x); });
            }
            xMin = Math.min(xMin, 0);
            xMax = Math.max(xMax, 0);

            const step = (xMax - xMin) / (GRAPH_SAMPLES - 1);
            const datasets = [];
            const finite = [];
            const series = [];
            for (let f = 0; f < list.length; f++) {
                const rpn = graphCompile(graphNormalizeExpr(list[f]));
                if (!rpn) return null;         // one bad expression fails the whole fence
                const data = [];
                for (let i = 0; i < GRAPH_SAMPLES; i++) {
                    const x = xMin + step * i;
                    let y = graphEval(rpn, x);
                    if (typeof y !== 'number' || !isFinite(y) || Math.abs(y) > GRAPH_HUGE) y = null;
                    else finite.push(y);
                    data.push({ x: x, y: y });
                }
                series.push(data);
            }
            pts.forEach(p => finite.push(p.y));

            let yMin = graphNum(spec.yMin, null);
            let yMax = graphNum(spec.yMax, null);
            if (yMin === null || yMax === null || !(yMax > yMin)) {
                const w = graphYWindow(finite);
                yMin = w.min;
                yMax = w.max;
            }

            // Break the line at poles instead of drawing the near-vertical
            // segment that tan(x) or 1/x would otherwise sweep across the plane.
            const bleed = (yMax - yMin) * 3;
            series.forEach((data, f) => {
                data.forEach(p => {
                    if (p.y !== null && (p.y < yMin - bleed || p.y > yMax + bleed)) p.y = null;
                });
                const base = CHART_PALETTE[f % CHART_PALETTE.length];
                datasets.push({
                    label: list[f],
                    data: data,
                    borderColor: base,
                    backgroundColor: base,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHitRadius: 6,
                    tension: 0,          // a smoothed maths curve is a wrong maths curve
                    spanGaps: false,
                });
            });
            if (pts.length) {
                datasets.push({
                    label: typeof spec.pointsLabel === 'string' ? spec.pointsLabel : 'points',
                    data: pts,
                    showLine: false,
                    borderColor: '#c4b5fd',
                    backgroundColor: '#c4b5fd',
                    pointRadius: 4,
                });
            }

            const meta = {
                equalAspect: spec.equalAspect === true,
                xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax,
            };
            const cfg = {
                type: 'line',
                data: { datasets: datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    // Rotation, a sidebar opening, or a tab coming back from
                    // hidden all change the box the square units depend on.
                    onResize: chart => applyGraphAspect(chart, meta),
                    animation: { duration: 400, easing: 'easeOutQuart' },
                    interaction: { mode: 'nearest', intersect: false },
                    scales: {
                        x: graphAxis(xMin, xMax, typeof spec.xLabel === 'string' ? spec.xLabel : ''),
                        y: graphAxis(yMin, yMax, typeof spec.yLabel === 'string' ? spec.yLabel : ''),
                    },
                    plugins: {
                        legend: { display: datasets.length > 1 || !!list.length, position: 'bottom' },
                        title: typeof spec.title === 'string' && spec.title
                            ? { display: true, text: spec.title, color: 'rgba(255,255,255,0.6)' }
                            : { display: false },
                    },
                },
            };
            return { cfg: cfg, meta: meta };
        }

        // Circles and geometry are wrong unless one x unit is one y unit, but the
        // aspect is only knowable once the wrapper has been laid out.
        // Must run *after* construction: the wrapper is not the plot box — the
        // legend, title and tick labels eat into it, and sizing off the wrapper
        // leaves circles visibly out of round. chartArea is the real thing, and
        // it only exists once Chart.js has laid the chart out.
        function applyGraphAspect(inst, meta) {
            if (!inst || !meta || !meta.equalAspect) return;
            if (inst._simbaAspecting) return;      // update() must not re-enter through onResize
            const area = inst.chartArea;
            if (!area) return;
            const w = area.right - area.left;
            const h = area.bottom - area.top;
            // A hidden tab or a not-yet-laid-out container measures zero. Bail
            // now and let onResize below re-apply once the box has a real width.
            if (!(w > 0) || !(h > 0)) return;
            const sx = inst.scales.x;
            const half = ((sx.max - sx.min) / 2) * (h / w);
            if (!isFinite(half) || half <= 0) return;
            const centre = (meta.yMin + meta.yMax) / 2;
            inst.options.scales.y.min = centre - half;
            inst.options.scales.y.max = centre + half;
            inst._simbaAspecting = true;
            try { inst.update('none'); } finally { inst._simbaAspecting = false; }
        }

        function parseChartConfig(src) {
            let cfg;
            try { cfg = JSON.parse(src); } catch (e) { return null; }
            if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
            if (typeof cfg.type !== 'string' || CHART_TYPES.indexOf(cfg.type) === -1) return null;
            const data = cfg.data;
            if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
            if (data.labels !== undefined && !Array.isArray(data.labels)) return null;
            if (!Array.isArray(data.datasets) || data.datasets.length === 0) return null;
            data.datasets = data.datasets.slice(0, CHART_MAX_DATASETS);
            const isSlice = CHART_SLICE_TYPES.indexOf(cfg.type) !== -1;
            for (let i = 0; i < data.datasets.length; i++) {
                const ds = data.datasets[i];
                if (!ds || typeof ds !== 'object' || Array.isArray(ds)) return null;
                if (ds.type !== undefined && CHART_TYPES.indexOf(ds.type) === -1) return null;
                if (!Array.isArray(ds.data)) return null;
                if (ds.data.length > CHART_MAX_POINTS) ds.data = ds.data.slice(0, CHART_MAX_POINTS);
                paintChartDataset(ds, i, ds.type || cfg.type, isSlice);
            }
            cfg.options = buildChartOptions(cfg.options, cfg.type);
            return cfg;
        }

        // Put the original fence back when the chart cannot be drawn — a failed
        // chart degrades to a normal, copyable code block.
        function restoreChartSource(job) {
            try {
                const block = job.block;
                if (!block.isConnected || !block.parentNode) return;
                job.pre.dataset.chartFailed = '1';
                block.parentNode.replaceChild(job.pre, block);
                const code = job.pre.querySelector('code');
                if (code) code.className = 'language-json';
                enhanceCodeBlocks(job.pre.parentNode);
                if (code && window.hljs) hljs.highlightElement(code);
                if (window.lucide) lucide.createIcons();
            } catch (e) { /* nothing left worth doing */ }
        }

        // renderMessages() rebuilds the whole thread, so canvases from the
        // previous pass are detached — their Chart instances would otherwise
        // keep resize observers and animation loops alive forever.
        function destroyDetachedCharts() {
            if (!_liveCharts.length) return;
            _liveCharts = _liveCharts.filter(inst => {
                if (inst && inst.canvas && inst.canvas.isConnected) return true;
                try { inst.destroy(); } catch (e) {}
                return false;
            });
        }

        // Fire-and-forget: the DOM swap is synchronous (so enhanceCodeBlocks and
        // hljs.highlightAll never see a chart <pre>), the drawing is not.
        async function renderCharts(root) {
            const jobs = [];
            try {
                root.querySelectorAll('pre > code.language-chart, pre > code.language-graph').forEach(code => {
                    const pre = code.parentNode;
                    if (!pre || pre.dataset.chartFailed || pre.closest('.chart-block')) return;
                    const isGraph = code.classList.contains('language-graph');
                    const parsed = isGraph ? parseGraphSpec(code.textContent) : parseChartConfig(code.textContent);
                    if (!parsed) {
                        // Malformed or unsupported — leave it on screen as JSON.
                        pre.dataset.chartFailed = '1';
                        code.className = 'language-json';
                        return;
                    }
                    const cfg = isGraph ? parsed.cfg : parsed;
                    const meta = isGraph ? parsed.meta : null;
                    const block = document.createElement('div');
                    // Graphs keep .chart-block so the docx shot collector, the
                    // leak sweep and the glass styling all still see them.
                    block.className = isGraph ? 'chart-block graph-block' : 'chart-block';
                    block.dataset.chartRendered = '1';
                    const wrap = document.createElement('div');
                    wrap.className = 'chart-canvas-wrap';
                    const canvas = document.createElement('canvas');
                    canvas.setAttribute('role', 'img');
                    canvas.setAttribute('aria-label', isGraph ? 'graph of a function' : cfg.type + ' chart');
                    wrap.appendChild(canvas);
                    block.appendChild(wrap);
                    pre.parentNode.replaceChild(block, pre);
                    jobs.push({ pre, block, canvas, cfg, meta });
                });
            } catch (e) { /* fall through with whatever was collected */ }
            if (!jobs.length) return;

            let ChartLib;
            try {
                ChartLib = await ensureChartJs();
            } catch (e) {
                jobs.forEach(restoreChartSource);
                return;
            }
            jobs.forEach(job => {
                // renderMessages() may have wiped the container while the CDN
                // was in flight — never paint into a detached tree.
                if (!job.block.isConnected) return;
                try {
                    const inst = new ChartLib(job.canvas, job.cfg);
                    _liveCharts.push(inst);
                    applyGraphAspect(inst, job.meta);
                } catch (e) {
                    restoreChartSource(job);
                }
            });
        }


/** Entry point: swap every ```chart and ```graph fence for a live canvas. */
export async function renderFences(root: HTMLElement) {
    destroyDetachedCharts();
    await renderCharts(root);
}

export { destroyDetachedCharts };
