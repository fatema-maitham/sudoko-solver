// app.js
// UI wiring + load .txt or image (OCR crop) + solve animation

window.addEventListener("DOMContentLoaded", () => {
    const board = document.getElementById("board");
    const solveBtn = document.getElementById("solveBtn");
    const clearBtn = document.getElementById("clearBtn");
    const loadInput = document.getElementById("loadInput");
    const loadLabel = document.querySelector(".fileBtn");

    const cells = [];
    let active = 0;
    const given = new Array(81).fill(false);

    buildBoard();
    focusCell(0);

    loadLabel?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            loadInput.click();
        }
    });

    solveBtn.addEventListener("click", async () => {
        clearWorkMarks();

        const grid = getGrid();

        // snapshot givens
        for (let i = 0; i < 81; i++) {
            given[i] = grid[i] !== 0;
            cells[i].wrap.classList.toggle("given", given[i]);
            cells[i].wrap.classList.remove("solved");
        }

        const v = window.Solver.validate(grid);
        applyConflicts(v.conflicts);
        if (!v.ok) { flashButton("Fix red cells"); return; }

        disableAll(true);
        await solveAndAnimate(grid);
        disableAll(false);
    });

    clearBtn.addEventListener("click", () => {
        for (let i = 0; i < 81; i++) {
            cells[i].input.value = "";
            given[i] = false;
            cells[i].wrap.classList.remove("conflict", "working", "guess", "backtrack", "solved", "given");
        }
        applyConflicts(new Set());
        focusCell(0);
    });

    loadInput.addEventListener("change", async () => {
        const file = loadInput.files?.[0];
        if (!file) return;

        try {
            clearWorkMarks();
            applyConflicts(new Set());

            if (file.type.startsWith("image/")) {
                setBtnText("Reading...");
                disableAll(true);

                const grid = await window.OCR.openCropAndRead(file);
                fillGrid(grid);
            } else {
                const text = await file.text();
                const grid = string81ToGrid(text);
                fillGrid(grid);
            }

            // mark givens after load
            const gridNow = getGrid();
            for (let i = 0; i < 81; i++) {
                given[i] = gridNow[i] !== 0;
                cells[i].wrap.classList.toggle("given", given[i]);
                cells[i].wrap.classList.remove("solved");
            }

            const v = window.Solver.validate(gridNow);
            applyConflicts(v.conflicts);
            if (!v.ok) flashButton("Fix red cells");
        } catch (e) {
            console.error(e);
            flashButton("Bad file");
        } finally {
            loadInput.value = "";
            setBtnText("Solve");
            disableAll(false);
        }
    });

    function disableAll(dis) {
        solveBtn.disabled = dis;
        clearBtn.disabled = dis;
        loadInput.disabled = dis;
    }

    function setBtnText(t) { solveBtn.textContent = t; }

    function flashButton(text) {
        const old = solveBtn.textContent;
        solveBtn.textContent = text;
        setTimeout(() => solveBtn.textContent = old, 1100);
    }

    function buildBoard() {
        board.innerHTML = "";
        cells.length = 0;

        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;

                const wrap = document.createElement("div");
                wrap.className = "cell";

                const box = Math.floor(r / 3) * 3 + Math.floor(c / 3);
                if (box % 2 === 1) wrap.classList.add("alt");

                if (c % 3 === 0) wrap.classList.add("thickL");
                if (r % 3 === 0) wrap.classList.add("thickT");
                if (c === 8) wrap.classList.add("thickR");
                if (r === 8) wrap.classList.add("thickB");

                const input = document.createElement("input");
                input.inputMode = "numeric";
                input.maxLength = 1;
                input.autocomplete = "off";
                input.spellcheck = false;

                input.addEventListener("focus", () => setActive(i));
                input.addEventListener("keydown", (e) => onKeyDown(e, i));
                input.addEventListener("input", () => onInput(i));

                wrap.appendChild(input);
                board.appendChild(wrap);
                cells.push({ wrap, input });
            }
        }
    }

    function setActive(i) {
        active = i;
        for (let k = 0; k < cells.length; k++) {
            cells[k].wrap.classList.toggle("active", k === i);
        }
    }

    function focusCell(i) {
        setActive(i);
        const el = cells[i].input;
        el.focus();
        el.select();
    }

    function onKeyDown(e, i) {
        const key = e.key;

        if (key === "ArrowLeft") { e.preventDefault(); move(i, 0, -1); return; }
        if (key === "ArrowRight") { e.preventDefault(); move(i, 0, 1); return; }
        if (key === "ArrowUp") { e.preventDefault(); move(i, -1, 0); return; }
        if (key === "ArrowDown") { e.preventDefault(); move(i, 1, 0); return; }

        if (key === "Tab") {
            e.preventDefault();
            focusCell(e.shiftKey ? (i + 80) % 81 : (i + 1) % 81);
            return;
        }

        if (key === "Backspace" || key === "Delete") {
            e.preventDefault();
            cells[i].input.value = "";
            onInput(i);
            return;
        }

        if (key >= "1" && key <= "9") {
            e.preventDefault();
            cells[i].input.value = key;
            onInput(i);
            focusCell((i + 1) % 81);
            return;
        }
    }

    function move(i, dr, dc) {
        const r = Math.floor(i / 9), c = i % 9;
        const nr = Math.max(0, Math.min(8, r + dr));
        const nc = Math.max(0, Math.min(8, c + dc));
        focusCell(nr * 9 + nc);
    }

    function onInput(i) {
        let v = cells[i].input.value.replace(/[^1-9]/g, "");
        if (v.length > 1) v = v[0];
        cells[i].input.value = v;

        cells[i].wrap.classList.remove("solved", "guess", "backtrack", "working");
        given[i] = v !== "";
        cells[i].wrap.classList.toggle("given", given[i]);

        const res = window.Solver.validate(getGrid());
        applyConflicts(res.conflicts);
    }

    function getGrid() {
        const grid = new Array(81).fill(0);
        for (let i = 0; i < 81; i++) {
            const t = cells[i].input.value.trim();
            grid[i] = t ? Number(t) : 0;
        }
        return grid;
    }

    function fillGrid(grid) {
        for (let i = 0; i < 81; i++) {
            const v = grid[i] || 0;
            cells[i].input.value = v ? String(v) : "";
            cells[i].wrap.classList.remove("solved", "guess", "backtrack", "working", "conflict");
        }
        const res = window.Solver.validate(getGrid());
        applyConflicts(res.conflicts);
    }

    function applyConflicts(conflicts) {
        for (const c of cells) c.wrap.classList.remove("conflict");
        for (const i of conflicts) cells[i].wrap.classList.add("conflict");
    }

    function clearWorkMarks() {
        for (const c of cells) c.wrap.classList.remove("working", "guess", "backtrack");
    }

    function string81ToGrid(s) {
        const t = String(s).replace(/\s/g, "");
        if (t.length !== 81) throw new Error("Text file must contain exactly 81 digits (0-9).");
        const grid = new Array(81).fill(0);
        for (let i = 0; i < 81; i++) {
            const ch = t[i];
            if (ch < "0" || ch > "9") throw new Error("Only digits 0-9 allowed.");
            grid[i] = ch === "0" ? 0 : Number(ch);
        }
        return grid;
    }

    async function solveAndAnimate(grid) {
        setBtnText("Solving...");
        clearWorkMarks();

        const steps = [];
        const res = window.Solver.solveWithSteps(grid, (s) => steps.push(s));

        if (!res.ok) {
            flashButton("No solution");
            setBtnText("Solve");
            return;
        }

        let lastFocus = -1;

        // slower so you can SEE backtracking clearly
        const delayMs = 28;

        await new Promise((done) => {
            let k = 0;
            function tick() {
                const start = performance.now();

                // Process a few steps per frame (so UI stays smooth)
                while (k < steps.length && (performance.now() - start) < 5) {
                    const step = steps[k++];

                    if (step.type === "focus") {
                        if (lastFocus !== -1) cells[lastFocus].wrap.classList.remove("working");
                        lastFocus = step.i;
                        cells[step.i].wrap.classList.add("working");
                    }

                    if (step.type === "assign") {
                        // show placement
                        cells[step.i].input.value = String(step.val);
                    }

                    if (step.type === "unassign") {
                        // show removal when backtracking
                        if (!given[step.i]) cells[step.i].input.value = "";
                        cells[step.i].wrap.classList.remove("guess");
                    }

                    if (step.type === "guess") cells[step.i].wrap.classList.add("guess");
                    if (step.type === "backtrack") cells[step.i].wrap.classList.add("backtrack");
                }

                if (k < steps.length) setTimeout(() => requestAnimationFrame(tick), delayMs);
                else done();
            }
            requestAnimationFrame(tick);
        });

        // final paint solved
        const solvedGrid = res.grid;
        for (let i = 0; i < 81; i++) {
            cells[i].input.value = solvedGrid[i] ? String(solvedGrid[i]) : "";
            cells[i].wrap.classList.toggle("given", given[i]);
            cells[i].wrap.classList.toggle("solved", !given[i] && solvedGrid[i] !== 0);
            cells[i].wrap.classList.remove("guess", "backtrack");
        }

        clearWorkMarks();
        setBtnText("Solve");
        focusCell(active);

        const v = window.Solver.validate(getGrid());
        applyConflicts(v.conflicts);
    }
});
