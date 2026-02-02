// ocr.js (FINAL FINAL)
// Goal: stable + high accuracy OCR for Sudoku photos with light/blue grids.
// Exposes: window.OCR = { openCropAndRead(file) }
//
// Key upgrades vs basic OCR:
// - More stable results: 1 worker (deterministic-ish)
// - Strong preprocessing: grayscale + contrast + percentile threshold
// - Per-cell cleanup: remove grid lines + clear borders + dilate digits
// - Multi-variant per cell (A/B/C) and pick best confidence
// - Sanitizes conflicts by dropping lowest-confidence digits

window.OCR = (() => {
    const modal = () => document.getElementById("ocrModal");
    const canvasEl = () => document.getElementById("ocrCanvas");
    const btnUse = () => document.getElementById("ocrUse");
    const btnClose = () => document.getElementById("ocrClose");

    let imgBitmap = null;
    let sourceW = 0, sourceH = 0;
    let viewScale = 1;
    let viewOffX = 0, viewOffY = 0;

    // crop square in canvas coords
    let rect = { x: 40, y: 40, s: 300 };
    const HANDLE = 12;

    let dragMode = null;
    let start = null;

    let bound = false;
    let schedulerPromise = null;

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    async function getScheduler() {
        if (!window.Tesseract) throw new Error("OCR needs internet (Tesseract CDN).");
        if (schedulerPromise) return schedulerPromise;

        schedulerPromise = (async () => {
            const scheduler = Tesseract.createScheduler();

            // 1 worker => more stable, less random variability
            for (let i = 0; i < 1; i++) {
                const w = await Tesseract.createWorker();
                await w.loadLanguage("eng");
                await w.initialize("eng");
                await w.setParameters({
                    tessedit_char_whitelist: "123456789",
                    // Tesseract v5 param name is "tessedit_pageseg_mode"
                    tessedit_pageseg_mode: "10", // SINGLE_CHAR
                    classify_bln_numeric_mode: "1",
                    user_defined_dpi: "300",
                    preserve_interword_spaces: "0",
                });
                scheduler.addWorker(w);
            }

            return scheduler;
        })();

        return schedulerPromise;
    }

    function showModal() { modal().hidden = false; }
    function hideModal() { modal().hidden = true; }

    function pointInRect(px, py, r) {
        return px >= r.x && px <= r.x + r.s && py >= r.y && py <= r.y + r.s;
    }

    function hitHandle(px, py, r) {
        const corners = [
            { k: "nw", x: r.x, y: r.y },
            { k: "ne", x: r.x + r.s, y: r.y },
            { k: "sw", x: r.x, y: r.y + r.s },
            { k: "se", x: r.x + r.s, y: r.y + r.s },
        ];
        for (const c of corners) {
            const dx = px - c.x, dy = py - c.y;
            if (dx * dx + dy * dy <= HANDLE * HANDLE) return c.k;
        }
        return null;
    }

    function draw() {
        const cv = canvasEl();
        const ctx = cv.getContext("2d");
        ctx.clearRect(0, 0, cv.width, cv.height);

        // dark background
        ctx.fillStyle = "#0b1220";
        ctx.fillRect(0, 0, cv.width, cv.height);

        if (imgBitmap) {
            ctx.drawImage(
                imgBitmap,
                0, 0, sourceW, sourceH,
                viewOffX, viewOffY, sourceW * viewScale, sourceH * viewScale
            );
        }

        // darken outside crop
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.beginPath();
        ctx.rect(0, 0, cv.width, cv.height);
        ctx.rect(rect.x, rect.y, rect.s, rect.s);
        ctx.fill("evenodd");
        ctx.restore();

        // crop stroke
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(47,107,255,.95)";
        ctx.strokeRect(rect.x, rect.y, rect.s, rect.s);

        // handles
        const corners = [
            { x: rect.x, y: rect.y },
            { x: rect.x + rect.s, y: rect.y },
            { x: rect.x, y: rect.y + rect.s },
            { x: rect.x + rect.s, y: rect.y + rect.s },
        ];
        ctx.fillStyle = "#ffffff";
        for (const p of corners) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, HANDLE, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "rgba(47,107,255,.95)";
            ctx.stroke();
        }
    }

    function toCanvasPoint(e, cv) {
        const r = cv.getBoundingClientRect();
        const x = (e.clientX - r.left) * (cv.width / r.width);
        const y = (e.clientY - r.top) * (cv.height / r.height);
        return { x, y };
    }

    function bindCanvasEvents() {
        if (bound) return;
        bound = true;

        const cv = canvasEl();

        cv.onpointerdown = (e) => {
            cv.setPointerCapture(e.pointerId);
            const p = toCanvasPoint(e, cv);

            const h = hitHandle(p.x, p.y, rect);
            if (h) { dragMode = h; start = { ...p, rect: { ...rect } }; return; }

            if (pointInRect(p.x, p.y, rect)) {
                dragMode = "move";
                start = { ...p, rect: { ...rect } };
                return;
            }

            dragMode = null;
            start = null;
        };

        cv.onpointermove = (e) => {
            if (!dragMode || !start) return;
            const p = toCanvasPoint(e, cv);
            const dx = p.x - start.x;
            const dy = p.y - start.y;

            const cvW = cv.width, cvH = cv.height;
            const minS = 180;

            if (dragMode === "move") {
                rect.x = clamp(start.rect.x + dx, 0, cvW - rect.s);
                rect.y = clamp(start.rect.y + dy, 0, cvH - rect.s);
                draw();
                return;
            }

            let s = start.rect.s;
            if (dragMode === "se") s = start.rect.s + Math.max(dx, dy);
            if (dragMode === "nw") s = start.rect.s - Math.max(dx, dy);
            if (dragMode === "ne") s = start.rect.s + Math.max(dx, -dy);
            if (dragMode === "sw") s = start.rect.s + Math.max(-dx, dy);

            s = clamp(s, minS, Math.min(cvW, cvH));

            if (dragMode === "se") {
                rect.s = s;
            } else if (dragMode === "nw") {
                rect.s = s;
                rect.x = start.rect.x + (start.rect.s - s);
                rect.y = start.rect.y + (start.rect.s - s);
            } else if (dragMode === "ne") {
                rect.s = s;
                rect.x = start.rect.x;
                rect.y = start.rect.y + (start.rect.s - s);
            } else if (dragMode === "sw") {
                rect.s = s;
                rect.x = start.rect.x + (start.rect.s - s);
                rect.y = start.rect.y;
            }

            rect.x = clamp(rect.x, 0, cvW - rect.s);
            rect.y = clamp(rect.y, 0, cvH - rect.s);

            draw();
        };

        cv.onpointerup = () => { dragMode = null; start = null; };
    }

    async function openCropAndRead(file) {
        imgBitmap = await createImageBitmap(file);
        sourceW = imgBitmap.width;
        sourceH = imgBitmap.height;

        const cv = canvasEl();
        const cssW = Math.min(880, window.innerWidth * 0.94);
        const aspect = sourceH / sourceW;

        cv.width = Math.round(cssW * devicePixelRatio);
        cv.height = Math.round((cssW * aspect) * devicePixelRatio);

        const cvW = cv.width, cvH = cv.height;
        const scale = Math.min(cvW / sourceW, cvH / sourceH);
        viewScale = scale;

        const drawnW = sourceW * scale;
        const drawnH = sourceH * scale;
        viewOffX = (cvW - drawnW) / 2;
        viewOffY = (cvH - drawnH) / 2;

        const s = Math.min(drawnW, drawnH) * 0.86;
        rect = {
            s: Math.max(260, Math.round(s)),
            x: Math.round(viewOffX + (drawnW - s) / 2),
            y: Math.round(viewOffY + (drawnH - s) / 2),
        };

        showModal();
        draw();
        bindCanvasEvents();

        return await new Promise((resolve, reject) => {
            const onCancel = () => { cleanup(); reject(new Error("OCR canceled")); };

            const onUse = async () => {
                try {
                    btnUse().disabled = true;
                    btnUse().textContent = "Reading...";
                    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

                    const grid = await runCellOCR();
                    cleanup();
                    resolve(grid);
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            };

            function cleanup() {
                btnUse().disabled = false;
                btnUse().textContent = "Use Crop";
                btnUse().removeEventListener("click", onUse);
                btnClose().removeEventListener("click", onCancel);
                modal().removeEventListener("click", outsideClick);
                hideModal();
            }

            function outsideClick(e) { if (e.target === modal()) onCancel(); }

            btnUse().addEventListener("click", onUse);
            btnClose().addEventListener("click", onCancel);
            modal().addEventListener("click", outsideClick);
        });
    }

    function canvasRectToSourceRect() {
        const sx = (rect.x - viewOffX) / viewScale;
        const sy = (rect.y - viewOffY) / viewScale;
        const ss = rect.s / viewScale;

        const x = clamp(sx, 0, sourceW - 1);
        const y = clamp(sy, 0, sourceH - 1);
        const s = clamp(ss, 100, Math.min(sourceW - x, sourceH - y));
        return { x, y, s };
    }

    // ===== Image helpers =====

    function grayscale(imgData) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const gray = r * 0.299 + g * 0.587 + b * 0.114;
            d[i] = d[i + 1] = d[i + 2] = gray;
            d[i + 3] = 255;
        }
    }

    function autoContrast(imgData) {
        const d = imgData.data;
        let min = 255, max = 0;
        for (let i = 0; i < d.length; i += 4) {
            const v = d[i];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const range = Math.max(1, max - min);
        for (let i = 0; i < d.length; i += 4) {
            const v = (d[i] - min) * (255 / range);
            d[i] = d[i + 1] = d[i + 2] = v;
        }
    }

    function threshold(imgData, t) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = d[i] > t ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
    }

    function invert(imgData) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = 255 - d[i];
            d[i] = d[i + 1] = d[i + 2] = v;
        }
    }

    // Percentile threshold: better for "mostly white + light-blue grid"
    function percentileThreshold(imgData) {
        const d = imgData.data;
        const vals = [];
        for (let i = 0; i < d.length; i += 4 * 6) vals.push(d[i]); // sample
        vals.sort((a, b) => a - b);

        const p5 = vals[Math.floor(vals.length * 0.05)];
        const p12 = vals[Math.floor(vals.length * 0.12)];
        let t = Math.round((p5 + p12) / 2);
        t = clamp(t, 115, 175);
        return t;
    }

    function dilateBinary(imgData, w, h, iters = 1) {
        const d = imgData.data;
        const copy = new Uint8ClampedArray(d.length);

        for (let iter = 0; iter < iters; iter++) {
            copy.set(d);
            const isBlack = (p) => copy[p] < 128;

            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const p = (y * w + x) * 4;
                    if (isBlack(p)) continue;

                    let nearBlack = false;
                    for (let dy = -1; dy <= 1 && !nearBlack; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const q = ((y + dy) * w + (x + dx)) * 4;
                            if (isBlack(q)) { nearBlack = true; break; }
                        }
                    }
                    if (nearBlack) d[p] = d[p + 1] = d[p + 2] = 0;
                }
            }
        }
    }

    function isMostlyEmpty(imgData) {
        const d = imgData.data;
        let black = 0;
        const total = d.length / 4;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) black++;
        return (black / total) < 0.010;
    }

    // BIG accuracy boost: remove grid lines and clear borders (per cell)
    function removeGridLines(imgData, w, h) {
        const d = imgData.data;
        const isBlack = (x, y) => d[(y * w + x) * 4] < 128;
        const setWhite = (x, y) => {
            const p = (y * w + x) * 4;
            d[p] = d[p + 1] = d[p + 2] = 255;
            d[p + 3] = 255;
        };

        // remove horizontal lines
        for (let y = 0; y < h; y++) {
            let black = 0;
            for (let x = 0; x < w; x++) if (isBlack(x, y)) black++;
            if (black > w * 0.70) {
                for (let x = 0; x < w; x++) setWhite(x, y);
            }
        }

        // remove vertical lines
        for (let x = 0; x < w; x++) {
            let black = 0;
            for (let y = 0; y < h; y++) if (isBlack(x, y)) black++;
            if (black > h * 0.70) {
                for (let y = 0; y < h; y++) setWhite(x, y);
            }
        }

        // clear border (kills edge grid)
        const border = Math.max(2, Math.floor(Math.min(w, h) * 0.04));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (x < border || x >= w - border || y < border || y >= h - border) {
                    setWhite(x, y);
                }
            }
        }
    }

    function pickBestDigit(out) {
        const data = out?.data;

        // symbols is best when available
        if (Array.isArray(data?.symbols) && data.symbols.length) {
            let best = { d: 0, conf: -1 };
            for (const s of data.symbols) {
                const ch = (s?.text || "").trim();
                if (!/^[1-9]$/.test(ch)) continue;
                const conf = typeof s.confidence === "number" ? s.confidence : 0;
                if (conf > best.conf) best = { d: Number(ch), conf };
            }
            if (best.conf >= 0) return best;
        }

        // fallback
        const txt = String(data?.text || "").replace(/\s/g, "");
        const m = txt.match(/[1-9]/);
        const conf = typeof data?.confidence === "number" ? data.confidence : 0;
        return { d: m ? Number(m[0]) : 0, conf };
    }

    function sanitizeConflicts(grid, conf) {
        if (!window.Solver?.validate) return grid;

        const g = grid.slice();
        for (let safety = 0; safety < 60; safety++) {
            const v = window.Solver.validate(g);
            if (v.ok) return g;

            const conflicted = [...v.conflicts];
            if (!conflicted.length) return g;

            conflicted.sort((a, b) => (conf[a] ?? 0) - (conf[b] ?? 0));
            const kill = conflicted[0];
            g[kill] = 0;
            conf[kill] = -1;
        }
        return g;
    }

    async function runCellOCR() {
        const { x, y, s } = canvasRectToSourceRect();

        // normalize grid to fixed resolution
        const gridCv = document.createElement("canvas");
        gridCv.width = 1080;
        gridCv.height = 1080;

        const gctx = gridCv.getContext("2d", { willReadFrequently: true });
        gctx.drawImage(imgBitmap, x, y, s, s, 0, 0, 1080, 1080);

        // preprocess whole grid
        const gridData = gctx.getImageData(0, 0, 1080, 1080);
        grayscale(gridData);
        autoContrast(gridData);

        const Tg = percentileThreshold(gridData);
        threshold(gridData, Tg);
        gctx.putImageData(gridData, 0, 0);

        const scheduler = await getScheduler();
        const grid = new Array(81).fill(0);
        const conf = new Array(81).fill(0);

        const cellSize = 1080 / 9;
        const pad = 22; // slightly bigger to avoid grid intersections

        const cellCv = document.createElement("canvas");
        cellCv.width = 240;
        cellCv.height = 240;
        const cctx = cellCv.getContext("2d", { willReadFrequently: true });

        async function recognizeBestFromCanvas(cv) {
            const out = await scheduler.addJob("recognize", cv);
            return pickBestDigit(out);
        }

        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;

                const cx = Math.round(c * cellSize + pad);
                const cy = Math.round(r * cellSize + pad);
                const cw = Math.round(cellSize - pad * 2);
                const ch = Math.round(cellSize - pad * 2);

                cctx.clearRect(0, 0, cellCv.width, cellCv.height);
                cctx.drawImage(gridCv, cx, cy, cw, ch, 0, 0, cellCv.width, cellCv.height);

                // per-cell adaptive threshold
                const base = cctx.getImageData(0, 0, cellCv.width, cellCv.height);
                grayscale(base);
                autoContrast(base);

                const Tc = percentileThreshold(base);
                threshold(base, Tc);

                // remove grid lines BEFORE empty check
                removeGridLines(base, cellCv.width, cellCv.height);

                if (isMostlyEmpty(base)) {
                    grid[i] = 0;
                    conf[i] = 0;
                    continue;
                }

                // A: base
                dilateBinary(base, cellCv.width, cellCv.height, 1);
                cctx.putImageData(base, 0, 0);
                const bestA = await recognizeBestFromCanvas(cellCv);

                // B: slightly lower threshold (helps faint digits)
                const b = cctx.getImageData(0, 0, cellCv.width, cellCv.height);
                b.data.set(base.data);
                threshold(b, clamp(Tc - 12, 95, 190));
                removeGridLines(b, cellCv.width, cellCv.height);
                dilateBinary(b, cellCv.width, cellCv.height, 1);
                cctx.putImageData(b, 0, 0);
                const bestB = await recognizeBestFromCanvas(cellCv);

                // C: inverted
                const cimg = cctx.getImageData(0, 0, cellCv.width, cellCv.height);
                cimg.data.set(base.data);
                invert(cimg);
                removeGridLines(cimg, cellCv.width, cellCv.height);
                cctx.putImageData(cimg, 0, 0);
                const bestC = await recognizeBestFromCanvas(cellCv);

                // pick best confidence
                let best = bestA;
                if (bestB.conf > best.conf) best = bestB;
                if (bestC.conf > best.conf) best = bestC;

                // confidence cutoff
                if (best.d && best.conf >= 55) {
                    grid[i] = best.d;
                    conf[i] = best.conf;
                } else {
                    grid[i] = 0;
                    conf[i] = best.conf || 0;
                }
            }
        }

        return sanitizeConflicts(grid, conf);
    }

    return { openCropAndRead };
})();
