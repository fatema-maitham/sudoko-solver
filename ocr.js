// ocr.js (FINAL)
// Exposes: window.OCR = { openCropAndRead(file) }
// Returns: { grid: number[81], uncertain: boolean[81], conf: number[81] }
//
// Key upgrades:
// - Uses Tesseract Scheduler (2 workers) for speed
// - Per-cell OFFSCREEN canvases (no overwrite bug)
// - Strong preprocess: grayscale + contrast + Otsu threshold + border clear
// - Tight digit bounding box + centered render (big accuracy boost)
// - Auto-clears weakest OCR digits if they create Sudoku conflicts
// - uncertain[] highlights medium-confidence digits

window.OCR = (() => {
    const modal = () => document.getElementById("ocrModal");
    const canvasEl = () => document.getElementById("ocrCanvas");
    const btnUse = () => document.getElementById("ocrUse");
    const btnClose = () => document.getElementById("ocrClose");

    let imgBitmap = null;
    let sourceW = 0, sourceH = 0;
    let viewScale = 1;
    let viewOffX = 0, viewOffY = 0;

    // crop rect in CANVAS coords
    let rect = { x: 40, y: 40, s: 300 };
    const HANDLE = 12;

    let dragMode = null;
    let start = null;

    let schedulerPromise = null;

    async function getScheduler() {
        if (!window.Tesseract) throw new Error("OCR needs internet (Tesseract CDN).");
        if (schedulerPromise) return schedulerPromise;

        schedulerPromise = (async () => {
            const scheduler = Tesseract.createScheduler();

            const workerCount = 2; // best balance on most laptops
            for (let i = 0; i < workerCount; i++) {
                const w = await Tesseract.createWorker();
                await w.loadLanguage("eng");
                await w.initialize("eng");

                await w.setParameters({
                    tessedit_char_whitelist: "123456789",
                    tessedit_pageseg_mode: "10",        // single char
                    classify_bln_numeric_mode: "1",
                    user_defined_dpi: "300",
                    preserve_interword_spaces: "0",
                    tessedit_ocr_engine_mode: "1"       // LSTM only
                });

                scheduler.addWorker(w);
            }

            return scheduler;
        })();

        return schedulerPromise;
    }

    function showModal() { modal().hidden = false; }
    function hideModal() { modal().hidden = true; }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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
        ctx.fillStyle = "#0b1220";
        ctx.fillRect(0, 0, cv.width, cv.height);

        if (imgBitmap) {
            ctx.drawImage(
                imgBitmap,
                0, 0, sourceW, sourceH,
                viewOffX, viewOffY, sourceW * viewScale, sourceH * viewScale
            );
        }

        // dark overlay outside rect
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.beginPath();
        ctx.rect(0, 0, cv.width, cv.height);
        ctx.rect(rect.x, rect.y, rect.s, rect.s);
        ctx.fill("evenodd");
        ctx.restore();

        // rect border
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
        viewScale = Math.min(cvW / sourceW, cvH / sourceH);

        const drawnW = sourceW * viewScale;
        const drawnH = sourceH * viewScale;
        viewOffX = (cvW - drawnW) / 2;
        viewOffY = (cvH - drawnH) / 2;

        const s = Math.min(drawnW, drawnH) * 0.86;
        rect = {
            s: Math.max(260, Math.round(s)),
            x: Math.round(viewOffX + (drawnW - s) / 2),
            y: Math.round(viewOffY + (drawnH - s) / 2)
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
                    const result = await runGridOCR();
                    cleanup();
                    resolve(result);
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
        const s = clamp(ss, 120, Math.min(sourceW - x, sourceH - y));
        return { x, y, s };
    }

    // ===== image helpers =====
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

    function otsuThreshold(grayImgData) {
        const d = grayImgData.data;
        const hist = new Array(256).fill(0);
        let total = 0;

        for (let i = 0; i < d.length; i += 4) {
            hist[d[i] | 0]++;
            total++;
        }

        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * hist[t];

        let sumB = 0;
        let wB = 0;
        let varMax = 0;
        let threshold = 180;

        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            const wF = total - wB;
            if (wF === 0) break;

            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;

            const varBetween = wB * wF * (mB - mF) * (mB - mF);
            if (varBetween > varMax) {
                varMax = varBetween;
                threshold = t;
            }
        }
        return threshold;
    }

    function threshold(imgData, t) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = d[i] > t ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
    }

    function clearFrame(imgData, w, h, frame) {
        const d = imgData.data;
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                if (xx < frame || yy < frame || xx >= w - frame || yy >= h - frame) {
                    const p = (yy * w + xx) * 4;
                    d[p] = d[p + 1] = d[p + 2] = 255;
                    d[p + 3] = 255;
                }
            }
        }
    }

    function findInkBox(binaryImgData, w, h) {
        const d = binaryImgData.data;
        let minX = w, minY = h, maxX = -1, maxY = -1;

        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const p = (yy * w + xx) * 4;
                if (d[p] < 128) {
                    if (xx < minX) minX = xx;
                    if (yy < minY) minY = yy;
                    if (xx > maxX) maxX = xx;
                    if (yy > maxY) maxY = yy;
                }
            }
        }

        if (maxX < 0) return null;
        return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    function pickBestDigit(data) {
        // prefer per-symbol confidence if available
        if (Array.isArray(data?.symbols) && data.symbols.length) {
            let best = { d: 0, conf: -1 };
            for (const s of data.symbols) {
                const ch = (s?.text || "").trim();
                if (!/^[1-9]$/.test(ch)) continue;
                const cf = typeof s.confidence === "number" ? s.confidence : 0;
                if (cf > best.conf) best = { d: Number(ch), conf: cf };
            }
            if (best.conf >= 0) return best;
        }

        const txt = String(data?.text || "").replace(/\s/g, "");
        const m = txt.match(/[1-9]/);
        const cf = typeof data?.confidence === "number" ? data.confidence : 0;
        return { d: m ? Number(m[0]) : 0, conf: cf };
    }

    // ===== Sudoku conflicts helper (auto clear weak OCR digits) =====
    function validateConflicts(grid) {
        const conflicts = new Set();
        const idx = (r, c) => r * 9 + c;

        const units = [];
        for (let r = 0; r < 9; r++) units.push(Array.from({ length: 9 }, (_, c) => idx(r, c)));
        for (let c = 0; c < 9; c++) units.push(Array.from({ length: 9 }, (_, r) => idx(r, c)));
        for (let br = 0; br < 3; br++) for (let bc = 0; bc < 3; bc++) {
            const box = [];
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) box.push(idx(br * 3 + r, bc * 3 + c));
            units.push(box);
        }

        for (const unit of units) {
            const seen = new Map();
            for (const i of unit) {
                const v = grid[i];
                if (!v) continue;
                if (seen.has(v)) { conflicts.add(i); conflicts.add(seen.get(v)); }
                else seen.set(v, i);
            }
        }
        return conflicts;
    }

    function autoClearConflicts(grid, conf) {
        const g = grid.slice();
        const c = conf.slice();

        let loops = 0;
        while (loops++ < 200) {
            const conflicts = validateConflicts(g);
            if (conflicts.size === 0) break;

            let worstI = -1;
            let worst = 9999;

            for (const i of conflicts) {
                if (g[i] === 0) continue;
                const ci = c[i] || 0;
                if (ci < worst) { worst = ci; worstI = i; }
            }
            if (worstI === -1) break;

            g[worstI] = 0;
            c[worstI] = 0;
        }

        return { grid: g, conf: c };
    }

    // ===== concurrency helper =====
    async function runWithLimit(tasks, limit) {
        let next = 0;
        const workers = Array.from({ length: limit }, async () => {
            while (true) {
                const i = next++;
                if (i >= tasks.length) break;
                await tasks[i]();
            }
        });
        await Promise.all(workers);
    }

    // ===== MAIN OCR =====
    async function runGridOCR() {
        const { x, y, s } = canvasRectToSourceRect();

        // 1) Crop whole grid to 900x900
        const gridCv = document.createElement("canvas");
        gridCv.width = 900;
        gridCv.height = 900;
        const gctx = gridCv.getContext("2d", { willReadFrequently: true });
        gctx.drawImage(imgBitmap, x, y, s, s, 0, 0, 900, 900);

        const scheduler = await getScheduler();

        const grid = new Array(81).fill(0);
        const conf = new Array(81).fill(0);

        const cellSize = 900 / 9;
        const pad = 6;

        // Tune these 2 numbers if needed:
        const CELL_CANVAS = 360;    // bigger = more accurate, slower
        const ACCEPT = 18;          // higher = fewer wrong digits but more empties
        const CONCURRENCY = 10;     // how many cells preprocess at once

        const tasks = [];

        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;

                tasks.push(async () => {
                    // Each cell has its own canvases (prevents overwrite bug)
                    const cellCv = document.createElement("canvas");
                    cellCv.width = CELL_CANVAS;
                    cellCv.height = CELL_CANVAS;
                    const cctx = cellCv.getContext("2d", { willReadFrequently: true });

                    const tightCv = document.createElement("canvas");
                    tightCv.width = CELL_CANVAS;
                    tightCv.height = CELL_CANVAS;
                    const tctx = tightCv.getContext("2d", { willReadFrequently: true });

                    const cx = Math.round(c * cellSize + pad);
                    const cy = Math.round(r * cellSize + pad);
                    const cw = Math.round(cellSize - pad * 2);
                    const ch = Math.round(cellSize - pad * 2);

                    cctx.clearRect(0, 0, CELL_CANVAS, CELL_CANVAS);
                    cctx.drawImage(gridCv, cx, cy, cw, ch, 0, 0, CELL_CANVAS, CELL_CANVAS);

                    // preprocess
                    let img = cctx.getImageData(0, 0, CELL_CANVAS, CELL_CANVAS);
                    grayscale(img);
                    autoContrast(img);

                    const t = otsuThreshold(img);
                    // bias to keep thin strokes
                    threshold(img, Math.min(235, Math.max(110, t + 10)));

                    // remove grid lines near edges
                    clearFrame(img, CELL_CANVAS, CELL_CANVAS, Math.round(CELL_CANVAS * 0.04));

                    const box = findInkBox(img, CELL_CANVAS, CELL_CANVAS);
                    if (!box) { grid[i] = 0; conf[i] = 0; return; }

                    // tight crop + center
                    cctx.putImageData(img, 0, 0);

                    const expand = Math.round(CELL_CANVAS * 0.05);
                    const bx = clamp(box.x - expand, 0, CELL_CANVAS - 1);
                    const by = clamp(box.y - expand, 0, CELL_CANVAS - 1);
                    const bw = clamp(box.w + expand * 2, 1, CELL_CANVAS - bx);
                    const bh = clamp(box.h + expand * 2, 1, CELL_CANVAS - by);

                    tctx.clearRect(0, 0, CELL_CANVAS, CELL_CANVAS);
                    tctx.fillStyle = "#fff";
                    tctx.fillRect(0, 0, CELL_CANVAS, CELL_CANVAS);

                    const scale = Math.min((CELL_CANVAS * 0.72) / bw, (CELL_CANVAS * 0.72) / bh);
                    const dw = bw * scale;
                    const dh = bh * scale;
                    const dx = (CELL_CANVAS - dw) / 2;
                    const dy = (CELL_CANVAS - dh) / 2;

                    tctx.drawImage(cellCv, bx, by, bw, bh, dx, dy, dw, dh);

                    // OCR on scheduler worker
                    const out = await scheduler.addJob("recognize", tightCv);
                    const best = pickBestDigit(out.data);

                    if (best.d && best.conf >= ACCEPT) {
                        grid[i] = best.d;
                        conf[i] = best.conf;
                    } else {
                        grid[i] = 0;
                        conf[i] = best.conf || 0;
                    }
                });
            }
        }

        await runWithLimit(tasks, CONCURRENCY);

        // Auto-clear conflicts (removes weakest OCR digits until valid)
        const fixed = autoClearConflicts(grid, conf);

        // Mark uncertain digits (yellow)
        const uncertain = fixed.grid.map((v, i) => v !== 0 && (fixed.conf[i] || 0) < 78);

        return { grid: fixed.grid, uncertain, conf: fixed.conf };
    }

    return { openCropAndRead };
})();
