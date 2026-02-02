// ocr.js
// Exposes: window.OCR = { openCropAndRead(file) }
// Flow: upload image -> crop modal -> OCR each cell -> returns grid[81]

window.OCR = (() => {
    const modal = () => document.getElementById("ocrModal");
    const canvasEl = () => document.getElementById("ocrCanvas");
    const btnUse = () => document.getElementById("ocrUse");
    const btnClose = () => document.getElementById("ocrClose");

    let imgBitmap = null;           // ImageBitmap
    let sourceW = 0, sourceH = 0;   // source size
    let viewScale = 1;              // source -> canvas scale
    let viewOffX = 0, viewOffY = 0; // letterbox offsets

    // crop rect in CANVAS coords
    let rect = { x: 40, y: 40, s: 300 };
    const HANDLE = 12;

    let dragMode = null; // "move" | "nw" | "ne" | "sw" | "se"
    let start = null;

    // Create ONE worker for speed
    let workerPromise = null;

    async function getWorker() {
        if (!window.Tesseract) throw new Error("OCR needs internet (Tesseract CDN).");
        if (workerPromise) return workerPromise;

        workerPromise = (async () => {
            const w = await Tesseract.createWorker();
            await w.loadLanguage("eng");
            await w.initialize("eng");

            // IMPORTANT: make OCR behave like "one digit per image"
            await w.setParameters({
                tessedit_char_whitelist: "123456789",
                tessedit_pageseg_mode: "10",       // PSM 10 = SINGLE_CHAR
                classify_bln_numeric_mode: "1",
                user_defined_dpi: "300",
                preserve_interword_spaces: "0",
            });

            return w;
        })();

        return workerPromise;
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

        // overlay outside crop
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.beginPath();
        ctx.rect(0, 0, cv.width, cv.height);
        ctx.rect(rect.x, rect.y, rect.s, rect.s);
        ctx.fill("evenodd");
        ctx.restore();

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
            if (h) {
                dragMode = h;
                start = { ...p, rect: { ...rect } };
                return;
            }

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
            const minS = 140;

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

        cv.onpointerup = () => {
            dragMode = null;
            start = null;
        };
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
            s: Math.max(220, Math.round(s)),
            x: Math.round(viewOffX + (drawnW - s) / 2),
            y: Math.round(viewOffY + (drawnH - s) / 2)
        };

        showModal();
        draw();
        bindCanvasEvents();

        return await new Promise((resolve, reject) => {
            const onCancel = () => {
                cleanup();
                reject(new Error("OCR canceled"));
            };

            const onUse = async () => {
                try {
                    btnUse().disabled = true;
                    btnUse().textContent = "Reading...";

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

            function outsideClick(e) {
                if (e.target === modal()) onCancel();
            }

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
        const s = clamp(ss, 80, Math.min(sourceW - x, sourceH - y));
        return { x, y, s };
    }

    // --------- Image preprocessing helpers ---------

    function grayscale(imgData) {
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const gray = r * 0.299 + g * 0.587 + b * 0.114;
            d[i] = d[i + 1] = d[i + 2] = gray;
            d[i + 3] = 255;
        }
    }

    // simple contrast stretch
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

    // Remove strong vertical/horizontal grid lines from a binary image
    function removeGridLinesBinary(imgData, w, h) {
        const d = imgData.data;
        const isBlack = (i) => d[i] < 128;

        // columns
        const colBlack = new Uint16Array(w);
        for (let x = 0; x < w; x++) {
            let cnt = 0;
            for (let y = 0; y < h; y++) {
                const p = (y * w + x) * 4;
                if (isBlack(p)) cnt++;
            }
            colBlack[x] = cnt;
        }

        // rows
        const rowBlack = new Uint16Array(h);
        for (let y = 0; y < h; y++) {
            let cnt = 0;
            for (let x = 0; x < w; x++) {
                const p = (y * w + x) * 4;
                if (isBlack(p)) cnt++;
            }
            rowBlack[y] = cnt;
        }

        // if a column/row is "too black", it's probably a grid line
        const colLine = x => colBlack[x] > h * 0.70;
        const rowLine = y => rowBlack[y] > w * 0.70;

        // erase in a small band around detected lines
        const band = 2;

        for (let x = 0; x < w; x++) {
            if (!colLine(x)) continue;
            for (let dx = -band; dx <= band; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= w) continue;
                for (let y = 0; y < h; y++) {
                    const p = (y * w + xx) * 4;
                    d[p] = d[p + 1] = d[p + 2] = 255;
                }
            }
        }

        for (let y = 0; y < h; y++) {
            if (!rowLine(y)) continue;
            for (let dy = -band; dy <= band; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let x = 0; x < w; x++) {
                    const p = (yy * w + x) * 4;
                    d[p] = d[p + 1] = d[p + 2] = 255;
                }
            }
        }
    }

    // estimate if cell is mostly empty (binary)
    function isMostlyEmpty(imgData) {
        const d = imgData.data;
        let black = 0;
        const total = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i] < 128) black++;
        }
        return (black / total) < 0.010; // <1% ink -> empty
    }

    // Extract best digit + confidence from tesseract output
    function pickBestDigit(data) {
        // Prefer symbols array if available
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

        // fallback: parse text
        const txt = String(data?.text || "").replace(/\s/g, "");
        const m = txt.match(/[1-9]/);
        const conf = typeof data?.confidence === "number" ? data.confidence : 0;
        return { d: m ? Number(m[0]) : 0, conf };
    }

    // If OCR made conflicts, blank the lowest-confidence conflicted cells
    function sanitizeConflicts(grid, conf) {
        if (!window.Solver?.validate) return grid;

        let g = grid.slice();
        for (let safety = 0; safety < 40; safety++) {
            const v = window.Solver.validate(g);
            if (v.ok) return g;

            const conflicted = [...v.conflicts];
            if (!conflicted.length) return g;

            // choose conflicted cell with lowest confidence, blank it
            conflicted.sort((a, b) => (conf[a] ?? 0) - (conf[b] ?? 0));
            const kill = conflicted[0];
            g[kill] = 0;
            conf[kill] = -1;
        }
        return g;
    }

    async function runCellOCR() {
        const { x, y, s } = canvasRectToSourceRect();

        // Square grid canvas
        const gridCv = document.createElement("canvas");
        gridCv.width = 900;
        gridCv.height = 900;
        const gctx = gridCv.getContext("2d", { willReadFrequently: true });

        gctx.drawImage(imgBitmap, x, y, s, s, 0, 0, 900, 900);

        // preprocess whole grid: grayscale -> contrast -> threshold -> remove lines
        const gridData = gctx.getImageData(0, 0, 900, 900);
        grayscale(gridData);
        autoContrast(gridData);

        // dynamic threshold: based on average brightness
        let sum = 0;
        const d = gridData.data;
        for (let i = 0; i < d.length; i += 4) sum += d[i];
        const avg = sum / (d.length / 4);
        const t = clamp(avg * 0.90, 110, 200);

        threshold(gridData, t);
        removeGridLinesBinary(gridData, 900, 900);

        gctx.putImageData(gridData, 0, 0);

        const worker = await getWorker();
        const grid = new Array(81).fill(0);
        const conf = new Array(81).fill(0);

        const cellSize = 900 / 9;

        // bigger pad reduces line artifacts
        const pad = 14;

        // cell canvas
        const cellCv = document.createElement("canvas");
        cellCv.width = 160;
        cellCv.height = 160;
        const cctx = cellCv.getContext("2d", { willReadFrequently: true });

        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;

                const cx = Math.round(c * cellSize + pad);
                const cy = Math.round(r * cellSize + pad);
                const cw = Math.round(cellSize - pad * 2);
                const ch = Math.round(cellSize - pad * 2);

                // draw cell region scaled up
                cctx.clearRect(0, 0, cellCv.width, cellCv.height);
                cctx.drawImage(gridCv, cx, cy, cw, ch, 0, 0, cellCv.width, cellCv.height);

                // binarize cell again (tighter), helps shaky photos
                const cd = cctx.getImageData(0, 0, cellCv.width, cellCv.height);
                // small contrast + threshold
                grayscale(cd);
                autoContrast(cd);
                threshold(cd, 155);

                // if empty, skip OCR
                if (isMostlyEmpty(cd)) {
                    grid[i] = 0;
                    conf[i] = 0;
                    continue;
                }

                // remove tiny border noise: wipe a small frame
                const frame = 6;
                const dd = cd.data;
                const w = cellCv.width, h = cellCv.height;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        if (x < frame || y < frame || x >= w - frame || y >= h - frame) {
                            const p = (y * w + x) * 4;
                            dd[p] = dd[p + 1] = dd[p + 2] = 255;
                        }
                    }
                }

                cctx.putImageData(cd, 0, 0);

                // OCR twice: normal + inverted, pick best confidence
                const out1 = await worker.recognize(cellCv);
                const best1 = pickBestDigit(out1.data);

                // inverted pass (sometimes digits are light on dark)
                const cd2 = cctx.getImageData(0, 0, w, h);
                invert(cd2);
                cctx.putImageData(cd2, 0, 0);

                const out2 = await worker.recognize(cellCv);
                const best2 = pickBestDigit(out2.data);

                // restore (not required, but cleaner)
                invert(cd2);
                cctx.putImageData(cd2, 0, 0);

                const best = (best2.conf > best1.conf) ? best2 : best1;

                // STRICT confidence cutoff (prevents random wrong digits)
                if (best.d && best.conf >= 70) {
                    grid[i] = best.d;
                    conf[i] = best.conf;
                } else {
                    grid[i] = 0;
                    conf[i] = best.conf || 0;
                }
            }
        }

        // If OCR created conflicts, blank lowest-confidence conflicted cells
        const cleaned = sanitizeConflicts(grid, conf);
        return cleaned;
    }

    return { openCropAndRead };
})();
