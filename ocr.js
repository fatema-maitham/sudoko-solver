// ocr.js
// -----------------------------------------------------------------------------
// OCR Module for Sudoku Photos (Crop + Preprocess + Per-Cell Recognition)
// -----------------------------------------------------------------------------
// Exposes:
//   window.OCR = { openCropAndRead(file) }
//
// Responsibilities:
// - Show a crop modal over the uploaded image
// - Convert the crop area into a normalized square grid (1080x1080)
// - Preprocess for light/blue grids (grayscale + contrast + percentile threshold)
// - Split into 81 cells, clean per cell (grid-line removal + border clear + dilation)
// - Run multiple OCR variants per cell (A/B/C) and keep the highest-confidence digit
// - Drop low-confidence digits that create Sudoku conflicts (sanitizeConflicts)
//
// Notes:
// - Uses Tesseract.js loaded via CDN (internet required)
// - Uses 1 worker for stability/consistency
// -----------------------------------------------------------------------------

window.OCR = (() => {
    // ---- Modal DOM helpers (queried lazily) ----
    const modal = () => document.getElementById("ocrModal");
    const canvasEl = () => document.getElementById("ocrCanvas");
    const btnUse = () => document.getElementById("ocrUse");
    const btnClose = () => document.getElementById("ocrClose");

    // ---- Source image state ----
    let imgBitmap = null;
    let sourceW = 0, sourceH = 0;

    // ---- View transform (image -> canvas placement) ----
    let viewScale = 1;
    let viewOffX = 0, viewOffY = 0;

    // Crop square in canvas coordinates
    let rect = { x: 40, y: 40, s: 300 };
    const HANDLE = 12;

    // Drag state for crop interactions
    let dragMode = null; // "move" or corner key ("nw","ne","sw","se")
    let start = null;

    // Prevent rebinding canvas pointer events
    let bound = false;

    // Cache scheduler creation so we don’t recreate workers repeatedly
    let schedulerPromise = null;

    // Clamp helper for safe bounds
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    // Create and configure Tesseract scheduler (1 worker for stable output)
    async function getScheduler() {
        if (!window.Tesseract) throw new Error("OCR needs internet (Tesseract CDN).");
        if (schedulerPromise) return schedulerPromise;

        schedulerPromise = (async () => {
            const scheduler = Tesseract.createScheduler();

            // 1 worker => less variability and fewer race issues
            for (let i = 0; i < 1; i++) {
                const w = await Tesseract.createWorker();
                await w.loadLanguage("eng");
                await w.initialize("eng");

                // Optimize for single digits only
                await w.setParameters({
                    tessedit_char_whitelist: "123456789",
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

    // Modal visibility helpers
    function showModal() { modal().hidden = false; }
    function hideModal() { modal().hidden = true; }

    // Hit testing for crop square
    function pointInRect(px, py, r) {
        return px >= r.x && px <= r.x + r.s && py >= r.y && py <= r.y + r.s;
    }

    // Detect corner handle hit for resize
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

    // Draw image + crop overlay
    function draw() {
        const cv = canvasEl();
        const ctx = cv.getContext("2d");
        ctx.clearRect(0, 0, cv.width, cv.height);

        // Dark background behind image
        ctx.fillStyle = "#0b1220";
        ctx.fillRect(0, 0, cv.width, cv.height);

        // Draw uploaded image (scaled + centered)
        if (imgBitmap) {
            ctx.drawImage(
                imgBitmap,
                0, 0, sourceW, sourceH,
                viewOffX, viewOffY, sourceW * viewScale, sourceH * viewScale
            );
        }

        // Dim outside crop area
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.beginPath();
        ctx.rect(0, 0, cv.width, cv.height);
        ctx.rect(rect.x, rect.y, rect.s, rect.s);
        ctx.fill("evenodd");
        ctx.restore();

        // Crop border
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(47,107,255,.95)";
        ctx.strokeRect(rect.x, rect.y, rect.s, rect.s);

        // Corner handles
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

    // Convert pointer coordinates to canvas space (handles DPR + CSS scaling)
    function toCanvasPoint(e, cv) {
        const r = cv.getBoundingClientRect();
        const x = (e.clientX - r.left) * (cv.width / r.width);
        const y = (e.clientY - r.top) * (cv.height / r.height);
        return { x, y };
    }

    // Bind pointer events once (drag to move, drag corners to resize)
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

            // Move crop square
            if (dragMode === "move") {
                rect.x = clamp(start.rect.x + dx, 0, cvW - rect.s);
                rect.y = clamp(start.rect.y + dy, 0, cvH - rect.s);
                draw();
                return;
            }

            // Resize crop square from corners (keep it square)
            let s = start.rect.s;
            if (dragMode === "se") s = start.rect.s + Math.max(dx, dy);
            if (dragMode === "nw") s = start.rect.s - Math.max(dx, dy);
            if (dragMode === "ne") s = start.rect.s + Math.max(dx, -dy);
            if (dragMode === "sw") s = start.rect.s + Math.max(-dx, dy);

            s = clamp(s, minS, Math.min(cvW, cvH));

            // Apply corner-specific anchor behavior
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

            // Clamp final position to canvas bounds
            rect.x = clamp(rect.x, 0, cvW - rect.s);
            rect.y = clamp(rect.y, 0, cvH - rect.s);

            draw();
        };

        cv.onpointerup = () => { dragMode = null; start = null; };
    }

    // Public API:
    // - Opens crop modal for an uploaded image file
    // - Runs OCR after user clicks "Use Crop"
    async function openCropAndRead(file) {
        // Decode image efficiently into a bitmap
        imgBitmap = await createImageBitmap(file);
        sourceW = imgBitmap.width;
        sourceH = imgBitmap.height;

        // Size the canvas based on screen width while preserving aspect ratio
        const cv = canvasEl();
        const cssW = Math.min(880, window.innerWidth * 0.94);
        const aspect = sourceH / sourceW;

        // Use devicePixelRatio to keep canvas crisp on Retina displays
        cv.width = Math.round(cssW * devicePixelRatio);
        cv.height = Math.round((cssW * aspect) * devicePixelRatio);

        // Compute how the image is drawn into the canvas (scale + center)
        const cvW = cv.width, cvH = cv.height;
        const scale = Math.min(cvW / sourceW, cvH / sourceH);
        viewScale = scale;

        const drawnW = sourceW * scale;
        const drawnH = sourceH * scale;
        viewOffX = (cvW - drawnW) / 2;
        viewOffY = (cvH - drawnH) / 2;

        // Default crop rectangle: centered and slightly inset
        const s = Math.min(drawnW, drawnH) * 0.86;
        rect = {
            s: Math.max(260, Math.round(s)),
            x: Math.round(viewOffX + (drawnW - s) / 2),
            y: Math.round(viewOffY + (drawnH - s) / 2),
        };

        showModal();
        draw();
        bindCanvasEvents();

        // Wrap the modal flow in a Promise for app.js to await
        return await new Promise((resolve, reject) => {
            const onCancel = () => { cleanup(); reject(new Error("OCR canceled")); };

            const onUse = async () => {
                try {
                    // Disable to prevent double-clicks
                    btnUse().disabled = true;
                    btnUse().textContent = "Reading...";

                    // Yield one frame so UI updates before heavy OCR begins
                    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

                    const grid = await runCellOCR();
                    cleanup();
                    resolve(grid);
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            };

            // Restore modal to default state and remove event handlers
            function cleanup() {
                btnUse().disabled = false;
                btnUse().textContent = "Use Crop";
                btnUse().removeEventListener("click", onUse);
                btnClose().removeEventListener("click", onCancel);
                modal().removeEventListener("click", outsideClick);
                hideModal();
            }

            // Close if user clicks outside the card
            function outsideClick(e) { if (e.target === modal()) onCancel(); }

            btnUse().addEventListener("click", onUse);
            btnClose().addEventListener("click", onCancel);
            modal().addEventListener("click", outsideClick);
        });
    }

    // Convert crop rectangle from canvas-space to source-image coordinates
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
    // These operate on ImageData in-place (mutating), for speed.

    function grayscale(imgData) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const gray = r * 0.299 + g * 0.587 + b * 0.114;
            d[i] = d[i + 1] = d[i + 2] = gray;
            d[i + 3] = 255;
        }
    }

    // Stretch intensity range to improve contrast (helps faint digits)
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

    // Binary threshold: white background + black digits
    function threshold(imgData, t) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = d[i] > t ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
    }

    // Invert black/white (sometimes helps depending on photo)
    function invert(imgData) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const v = 255 - d[i];
            d[i] = d[i + 1] = d[i + 2] = v;
        }
    }

    // Percentile-based threshold:
    // Good for "mostly bright background + light-blue grid" images.
    function percentileThreshold(imgData) {
        const d = imgData.data;
        const vals = [];
        for (let i = 0; i < d.length; i += 4 * 6) vals.push(d[i]); // sample for speed
        vals.sort((a, b) => a - b);

        const p5 = vals[Math.floor(vals.length * 0.05)];
        const p12 = vals[Math.floor(vals.length * 0.12)];
        let t = Math.round((p5 + p12) / 2);
        t = clamp(t, 115, 175);
        return t;
    }

    // Simple dilation on binary image to thicken thin strokes
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

    // Detect blank cells (almost no black pixels after cleaning)
    function isMostlyEmpty(imgData) {
        const d = imgData.data;
        let black = 0;
        const total = d.length / 4;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) black++;
        return (black / total) < 0.010;
    }

    // Remove dominant horizontal/vertical lines and clear borders
    function removeGridLines(imgData, w, h) {
        const d = imgData.data;
        const isBlack = (x, y) => d[(y * w + x) * 4] < 128;
        const setWhite = (x, y) => {
            const p = (y * w + x) * 4;
            d[p] = d[p + 1] = d[p + 2] = 255;
            d[p + 3] = 255;
        };

        // Remove horizontal lines (rows with heavy black coverage)
        for (let y = 0; y < h; y++) {
            let black = 0;
            for (let x = 0; x < w; x++) if (isBlack(x, y)) black++;
            if (black > w * 0.70) {
                for (let x = 0; x < w; x++) setWhite(x, y);
            }
        }

        // Remove vertical lines (columns with heavy black coverage)
        for (let x = 0; x < w; x++) {
            let black = 0;
            for (let y = 0; y < h; y++) if (isBlack(x, y)) black++;
            if (black > h * 0.70) {
                for (let y = 0; y < h; y++) setWhite(x, y);
            }
        }

        // Clear border to kill edge grid artifacts
        const border = Math.max(2, Math.floor(Math.min(w, h) * 0.04));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (x < border || x >= w - border || y < border || y >= h - border) {
                    setWhite(x, y);
                }
            }
        }
    }

    // Extract the best digit and confidence from Tesseract output
    function pickBestDigit(out) {
        const data = out?.data;

        // Prefer symbol-level confidence when available
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

        // Fallback: scan recognized text for any digit 1-9
        const txt = String(data?.text || "").replace(/\s/g, "");
        const m = txt.match(/[1-9]/);
        const conf = typeof data?.confidence === "number" ? data.confidence : 0;
        return { d: m ? Number(m[0]) : 0, conf };
    }

    // If OCR creates conflicts, drop the lowest-confidence digits until valid
    function sanitizeConflicts(grid, conf) {
        if (!window.Solver?.validate) return grid;

        const g = grid.slice();
        for (let safety = 0; safety < 60; safety++) {
            const v = window.Solver.validate(g);
            if (v.ok) return g;

            const conflicted = [...v.conflicts];
            if (!conflicted.length) return g;

            // Remove the least confident conflicted cell first
            conflicted.sort((a, b) => (conf[a] ?? 0) - (conf[b] ?? 0));
            const kill = conflicted[0];
            g[kill] = 0;
            conf[kill] = -1;
        }
        return g;
    }

    // Run OCR for each of the 81 cells based on the current crop rectangle
    async function runCellOCR() {
        const { x, y, s } = canvasRectToSourceRect();

        // Normalize crop to a fixed square resolution (improves OCR consistency)
        const gridCv = document.createElement("canvas");
        gridCv.width = 1080;
        gridCv.height = 1080;

        const gctx = gridCv.getContext("2d", { willReadFrequently: true });
        gctx.drawImage(imgBitmap, x, y, s, s, 0, 0, 1080, 1080);

        // Preprocess whole grid once (cheap win before splitting)
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
        const pad = 22; // avoid grid intersections near edges

        // Reuse one canvas for all cells (performance)
        const cellCv = document.createElement("canvas");
        cellCv.width = 240;
        cellCv.height = 240;
        const cctx = cellCv.getContext("2d", { willReadFrequently: true });

        async function recognizeBestFromCanvas(cv) {
            const out = await scheduler.addJob("recognize", cv);
            return pickBestDigit(out);
        }

        // Process cells row by row
        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;

                // Crop a padded cell region from the normalized grid
                const cx = Math.round(c * cellSize + pad);
                const cy = Math.round(r * cellSize + pad);
                const cw = Math.round(cellSize - pad * 2);
                const ch = Math.round(cellSize - pad * 2);

                cctx.clearRect(0, 0, cellCv.width, cellCv.height);
                cctx.drawImage(gridCv, cx, cy, cw, ch, 0, 0, cellCv.width, cellCv.height);

                // Build a strong per-cell binary image
                const base = cctx.getImageData(0, 0, cellCv.width, cellCv.height);
                grayscale(base);
                autoContrast(base);

                const Tc = percentileThreshold(base);
                threshold(base, Tc);

                // Remove grid lines before checking emptiness
                removeGridLines(base, cellCv.width, cellCv.height);

                // Skip empty cells early
                if (isMostlyEmpty(base)) {
                    grid[i] = 0;
                    conf[i] = 0;
                    continue;
                }

                // Variant A: base + dilation
                dilateBinary(base, cellCv.width, cellCv.height, 1);
                cctx.putImageData(base, 0, 0);
                const bestA = await recognizeBestFromCanvas(cellCv);

                // Variant B: slightly lower threshold (helps very faint digits)
                const b = cctx.getImageData(0, 0, cellCv.width, cellCv.height);
                b.data.set(base.data);
                threshold(b, clamp(Tc - 12, 95, 190));
                removeGridLines(b, cellCv.width, cellCv.height);
                dilateBinary(b, cellCv.width, cellCv.height, 1);
                cctx.putImageData(b, 0, 0);
                const bestB = await recognizeBestFromCanvas(cellCv);

                // Variant C: inverted (sometimes improves contrast for certain photos)
                const cimg = cctx.getImageData(0, 0, cellCv.width, cellCv.height);
                cimg.data.set(base.data);
                invert(cimg);
                removeGridLines(cimg, cellCv.width, cellCv.height);
                cctx.putImageData(cimg, 0, 0);
                const bestC = await recognizeBestFromCanvas(cellCv);

                // Choose the highest-confidence digit from A/B/C
                let best = bestA;
                if (bestB.conf > best.conf) best = bestB;
                if (bestC.conf > best.conf) best = bestC;

                // Confidence cutoff: reject uncertain reads
                if (best.d && best.conf >= 55) {
                    grid[i] = best.d;
                    conf[i] = best.conf;
                } else {
                    grid[i] = 0;
                    conf[i] = best.conf || 0;
                }
            }
        }

        // Remove low-confidence digits that cause Sudoku conflicts
        return sanitizeConflicts(grid, conf);
    }

    // Public API
    return { openCropAndRead }; // <- If your file has extra "is" after this, it will break JS
})();
