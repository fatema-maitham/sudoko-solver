// ocr.js (BEST VERSION: OpenCV warp + grid-line removal + Tesseract per cell)
// Exposes: window.OCR = { openCropAndRead(file) }
// Returns: { grid:number[81], uncertain:boolean[81], conf:number[81] }

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

    // ---------- helpers ----------
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ---------- wait OpenCV ----------
    let cvReadyPromise = null;
    function getCV() {
        if (cvReadyPromise) return cvReadyPromise;
        cvReadyPromise = (async () => {
            // If opencv not included, just return null
            if (!window.cv) return null;

            // If already initialized
            if (window.cv && window.cv.Mat) return window.cv;

            // Wait until runtime initialized (opencv.js sets this callback)
            await new Promise((resolve) => {
                const t0 = performance.now();
                const timer = setInterval(() => {
                    if (window.cv && window.cv.Mat) {
                        clearInterval(timer);
                        resolve();
                    }
                    // fail-safe: after 6s, resolve anyway (fallback path)
                    if (performance.now() - t0 > 6000) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 50);
            });

            return (window.cv && window.cv.Mat) ? window.cv : null;
        })();
        return cvReadyPromise;
    }

    // ---------- Tesseract scheduler ----------
    let schedulerPromise = null;
    async function getScheduler() {
        if (!window.Tesseract) throw new Error("OCR needs internet (Tesseract CDN).");
        if (schedulerPromise) return schedulerPromise;

        schedulerPromise = (async () => {
            const scheduler = Tesseract.createScheduler();
            const workerCount = 2;

            for (let i = 0; i < workerCount; i++) {
                const w = await Tesseract.createWorker();
                await w.loadLanguage("eng");
                await w.initialize("eng");
                await w.setParameters({
                    tessedit_char_whitelist: "123456789",
                    tessedit_pageseg_mode: "10", // single char
                    tessedit_ocr_engine_mode: "1", // LSTM
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

    // ---------- UI (crop modal) ----------
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

    function toCanvasPoint(e, cv) {
        const r = cv.getBoundingClientRect();
        const x = (e.clientX - r.left) * (cv.width / r.width);
        const y = (e.clientY - r.top) * (cv.height / r.height);
        return { x, y };
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

    // ---------- crop math ----------
    function canvasRectToSourceRect() {
        const sx = (rect.x - viewOffX) / viewScale;
        const sy = (rect.y - viewOffY) / viewScale;
        const ss = rect.s / viewScale;

        const x = clamp(sx, 0, sourceW - 1);
        const y = clamp(sy, 0, sourceH - 1);
        const s = clamp(ss, 120, Math.min(sourceW - x, sourceH - y));
        return { x, y, s };
    }

    // ---------- OCR utilities ----------
    function pickBestDigit(data) {
        // best symbol confidence if available
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

    // Sudoku conflicts helper (auto clear weak OCR digits)
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

    // ---------- OpenCV: warp perspective + remove grid lines ----------
    function orderQuad(pts) {
        // pts: [{x,y}*4]
        const sum = pts.map(p => p.x + p.y);
        const diff = pts.map(p => p.x - p.y);

        const tl = pts[sum.indexOf(Math.min(...sum))];
        const br = pts[sum.indexOf(Math.max(...sum))];
        const tr = pts[diff.indexOf(Math.max(...diff))];
        const bl = pts[diff.indexOf(Math.min(...diff))];
        return [tl, tr, br, bl];
    }

    function detectAndWarpGrid(cv, srcCanvas, OUT = 1600) {
        // returns a canvas OUTxOUT, or null if detection fails
        const src = cv.imread(srcCanvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        const blur = new cv.Mat();
        cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

        const bin = new cv.Mat();
        cv.adaptiveThreshold(
            blur, bin,
            255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv.THRESH_BINARY_INV,
            31,
            5
        );

        // strengthen edges
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
        cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel);

        const contours = new cv.MatVector();
        const hierarchy = new cv.Mat();
        cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        let best = null;
        let bestArea = 0;

        for (let i = 0; i < contours.size(); i++) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);
            if (area < 0.15 * src.rows * src.cols) { cnt.delete(); continue; }

            const peri = cv.arcLength(cnt, true);
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

            if (approx.rows === 4 && area > bestArea) {
                bestArea = area;
                best = approx.clone();
            }

            approx.delete();
            cnt.delete();
        }

        if (!best) {
            src.delete(); gray.delete(); blur.delete(); bin.delete(); contours.delete(); hierarchy.delete(); kernel.delete();
            return null;
        }

        // extract 4 points
        const pts = [];
        for (let i = 0; i < 4; i++) {
            const x = best.intPtr(i, 0)[0];
            const y = best.intPtr(i, 0)[1];
            pts.push({ x, y });
        }
        const [tl, tr, br, bl] = orderQuad(pts);

        const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            tl.x, tl.y,
            tr.x, tr.y,
            br.x, br.y,
            bl.x, bl.y
        ]);

        const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
            0, 0,
            OUT - 1, 0,
            OUT - 1, OUT - 1,
            0, OUT - 1
        ]);

        const M = cv.getPerspectiveTransform(srcTri, dstTri);

        const warped = new cv.Mat();
        cv.warpPerspective(src, warped, M, new cv.Size(OUT, OUT), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

        // Now remove grid lines from warped image (helps a lot)
        const wGray = new cv.Mat();
        cv.cvtColor(warped, wGray, cv.COLOR_RGBA2GRAY);

        const wBin = new cv.Mat();
        cv.adaptiveThreshold(wGray, wBin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 5);

        // horizontal lines
        const horiz = wBin.clone();
        const hSize = Math.max(20, Math.floor(OUT / 30));
        const hKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(hSize, 1));
        cv.erode(horiz, horiz, hKernel);
        cv.dilate(horiz, horiz, hKernel);

        // vertical lines
        const vert = wBin.clone();
        const vSize = Math.max(20, Math.floor(OUT / 30));
        const vKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, vSize));
        cv.erode(vert, vert, vKernel);
        cv.dilate(vert, vert, vKernel);

        const gridLines = new cv.Mat();
        cv.add(horiz, vert, gridLines);

        // subtract grid lines from wBin (keep only digits)
        const digitsOnly = new cv.Mat();
        cv.subtract(wBin, gridLines, digitsOnly);

        // light cleanup
        const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        cv.morphologyEx(digitsOnly, digitsOnly, cv.MORPH_OPEN, k2);

        // render digitsOnly to a canvas
        const outCanvas = document.createElement("canvas");
        outCanvas.width = OUT;
        outCanvas.height = OUT;
        cv.imshow(outCanvas, digitsOnly);

        // cleanup mats
        src.delete(); gray.delete(); blur.delete(); bin.delete();
        contours.delete(); hierarchy.delete(); kernel.delete();
        best.delete(); srcTri.delete(); dstTri.delete(); M.delete();
        warped.delete(); wGray.delete(); wBin.delete();
        horiz.delete(); vert.delete(); hKernel.delete(); vKernel.delete();
        gridLines.delete(); digitsOnly.delete(); k2.delete();

        return outCanvas;
    }

    // ---------- MAIN OCR ----------
    async function runGridOCR() {
        const cvLib = await getCV(); // may be null
        const scheduler = await getScheduler();

        // 1) crop selected region from original image -> working canvas
        const { x, y, s } = canvasRectToSourceRect();

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = 1200;
        cropCanvas.height = 1200;
        const cctx = cropCanvas.getContext("2d", { willReadFrequently: true });
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = "high";
        cctx.drawImage(imgBitmap, x, y, s, s, 0, 0, 1200, 1200);

        // 2) If OpenCV available: warp perspective + remove grid lines
        // If detection fails: fallback to plain crop
        const NORM = 1600; // more pixels per cell
        let gridCanvas = cropCanvas;

        if (cvLib) {
            const warped = detectAndWarpGrid(cvLib, cropCanvas, NORM);
            if (warped) gridCanvas = warped;
        }

        const GRID_SIZE = gridCanvas.width; // either 1200 or 1600
        const cellSize = GRID_SIZE / 9;

        const grid = new Array(81).fill(0);
        const conf = new Array(81).fill(0);

        // tuning (safe defaults)
        const CELL_CANVAS = 520;     // big = better
        const PAD = Math.max(10, Math.floor(cellSize * 0.08));
        const ACCEPT = 32;           // stricter = fewer wrong digits (better)
        const UNCERTAIN_BELOW = 88;  // yellow more often so you can fix fast
        const RETRY_BELOW = 70;      // try inverted pass if low
        const CONCURRENCY = 10;

        const tasks = [];

        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;
                tasks.push(async () => {
                    // cell canvas
                    const cellCv = document.createElement("canvas");
                    cellCv.width = CELL_CANVAS;
                    cellCv.height = CELL_CANVAS;
                    const ctx = cellCv.getContext("2d", { willReadFrequently: true });

                    const sx = Math.round(c * cellSize + PAD);
                    const sy = Math.round(r * cellSize + PAD);
                    const sw = Math.round(cellSize - PAD * 2);
                    const sh = Math.round(cellSize - PAD * 2);

                    ctx.fillStyle = "#fff";
                    ctx.fillRect(0, 0, CELL_CANVAS, CELL_CANVAS);
                    ctx.drawImage(gridCanvas, sx, sy, sw, sh, 0, 0, CELL_CANVAS, CELL_CANVAS);

                    // Find ink box quickly (pure JS)
                    const img = ctx.getImageData(0, 0, CELL_CANVAS, CELL_CANVAS);
                    const d = img.data;

                    let minX = CELL_CANVAS, minY = CELL_CANVAS, maxX = -1, maxY = -1;
                    for (let y = 0; y < CELL_CANVAS; y++) {
                        for (let x = 0; x < CELL_CANVAS; x++) {
                            const p = (y * CELL_CANVAS + x) * 4;
                            // treat "dark" as ink
                            const v = (d[p] + d[p + 1] + d[p + 2]) / 3;
                            if (v < 200) {
                                if (x < minX) minX = x;
                                if (y < minY) minY = y;
                                if (x > maxX) maxX = x;
                                if (y > maxY) maxY = y;
                            }
                        }
                    }
                    if (maxX < 0) { grid[i] = 0; conf[i] = 0; return; }

                    // center the tight box onto a clean white canvas
                    const tightCv = document.createElement("canvas");
                    tightCv.width = CELL_CANVAS;
                    tightCv.height = CELL_CANVAS;
                    const tctx = tightCv.getContext("2d", { willReadFrequently: true });
                    tctx.fillStyle = "#fff";
                    tctx.fillRect(0, 0, CELL_CANVAS, CELL_CANVAS);

                    const bw = maxX - minX + 1;
                    const bh = maxY - minY + 1;

                    const scale = Math.min((CELL_CANVAS * 0.78) / bw, (CELL_CANVAS * 0.78) / bh);
                    const dw = bw * scale;
                    const dh = bh * scale;
                    const dx = (CELL_CANVAS - dw) / 2;
                    const dy = (CELL_CANVAS - dh) / 2;

                    tctx.drawImage(cellCv, minX, minY, bw, bh, dx, dy, dw, dh);

                    // OCR pass 1
                    const out1 = await scheduler.addJob("recognize", tightCv);
                    let best = pickBestDigit(out1.data);

                    // OCR pass 2 (invert) if low confidence
                    if (best.conf > 0 && best.conf < RETRY_BELOW) {
                        const inv = document.createElement("canvas");
                        inv.width = CELL_CANVAS;
                        inv.height = CELL_CANVAS;
                        const ictx = inv.getContext("2d", { willReadFrequently: true });
                        ictx.drawImage(tightCv, 0, 0);
                        const im = ictx.getImageData(0, 0, CELL_CANVAS, CELL_CANVAS);
                        const id = im.data;
                        for (let k = 0; k < id.length; k += 4) {
                            id[k] = 255 - id[k];
                            id[k + 1] = 255 - id[k + 1];
                            id[k + 2] = 255 - id[k + 2];
                            id[k + 3] = 255;
                        }
                        ictx.putImageData(im, 0, 0);
                        const out2 = await scheduler.addJob("recognize", inv);
                        const retry = pickBestDigit(out2.data);
                        if ((retry.conf || 0) > (best.conf || 0)) best = retry;
                    }

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

        // Auto-clear conflicts (removes weakest digits if OCR made duplicates)
        const fixed = autoClearConflicts(grid, conf);

        // Uncertain highlight (strong)
        const uncertain = fixed.grid.map((v, i) => v !== 0 && (fixed.conf[i] || 0) < UNCERTAIN_BELOW);

        return { grid: fixed.grid, uncertain, conf: fixed.conf };
    }

    // ---------- public ----------
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
            const useBtn = btnUse();
            const closeBtn = btnClose();
            const m = modal();

            const outsideClick = (e) => { if (e.target === m) cancel(); };

            const cancel = () => {
                cleanup();
                reject(new Error("OCR canceled"));
            };

            const onUse = async () => {
                try {
                    useBtn.disabled = true;
                    useBtn.textContent = "Reading...";
                    const result = await runGridOCR();
                    cleanup();
                    resolve(result);
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            };

            const cleanup = () => {
                useBtn.disabled = false;
                useBtn.textContent = "Use Crop";
                useBtn.onclick = null;
                closeBtn.onclick = null;
                m.removeEventListener("click", outsideClick);
                hideModal();
            };

            // IMPORTANT: use onclick (overwrites old handler, avoids duplicates)
            useBtn.onclick = onUse;
            closeBtn.onclick = cancel;
            m.addEventListener("click", outsideClick);
        });

    }

    return { openCropAndRead };
})();
