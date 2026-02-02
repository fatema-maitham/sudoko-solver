// app.js
// -----------------------------------------------------------------------------
// UI Controller / Glue Code
// -----------------------------------------------------------------------------
// Responsibilities:
// - Build the 9x9 board UI (inputs + borders)
// - Handle user input (keyboard navigation, typing, clearing)
// - Load puzzles from .txt (81 digits) or images (OCR flow)
// - Validate live and highlight conflicts
// - Run the solver and animate its step-by-step process
//
// Notes:
// - Solver logic lives in solver.js (window.Solver)
// - OCR logic + crop modal lives in ocr.js (window.OCR)
// - This file keeps UI concerns only (separation of concerns).
// -----------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
    // Cache DOM nodes once (avoid repeated queries)
    const board = document.getElementById("board");
    const solveBtn = document.getElementById("solveBtn");
    const clearBtn = document.getElementById("clearBtn");
    const loadInput = document.getElementById("loadInput");
    const loadLabel = document.querySelector(".fileBtn");

    // 81 cell objects: { wrap: <div.cell>, input: <input> }
    const cells = [];

    // Index of the currently "active" cell (0..80)
    let active = 0;

    // Tracks which digits are considered "given" (original clues).
    // Used to prevent clearing during backtracking animation + color styling.
    const given = new Array(81).fill(false);

    // Build the UI grid and focus the first cell
    buildBoard();
    focusCell(0);

    // Accessibility: allow opening the hidden file picker via keyboard on the label
    loadLabel?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            loadInput.click();
        }
    });

    // Solve workflow:
    // 1) Clear temporary animation markers
    // 2) Snapshot givens (clues)
    // 3) Validate input (highlight conflicts)
    // 4) If valid, disable UI and animate solving steps
    solveBtn.addEventListener("click", async () => {
        clearWorkMarks();

        const grid = getGrid();

        // Snapshot givens so we can style them and protect them during animation
        for (let i = 0; i < 81; i++) {
            given[i] = grid[i] !== 0;
            cells[i].wrap.classList.toggle("given", given[i]);
            cells[i].wrap.classList.remove("solved");
        }

        // Validate before attempting solve (fail fast)
        const v = window.Solver.validate(grid);
        applyConflicts(v.conflicts);
        if (!v.ok) { flashButton("Fix red cells"); return; }

        // Prevent edits while solver animates
        disableAll(true);
        await solveAndAnimate(grid);
        disableAll(false);
    });

    // Clear workflow:
    // Reset all inputs and remove all visual state classes
    clearBtn.addEventListener("click", () => {
        for (let i = 0; i < 81; i++) {
            cells[i].input.value = "";
            given[i] = false;
            cells[i].wrap.classList.remove("conflict", "working", "guess", "backtrack", "solved", "given");
        }
        applyConflicts(new Set());
        focusCell(0);
    });

    // Load workflow:
    // - If image: open OCR crop modal and read grid
    // - If text: parse as 81 digits
    // - Fill the grid then validate
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

            // After loading, mark givens (clues) based on what was loaded
            const gridNow = getGrid();
            for (let i = 0; i < 81; i++) {
                given[i] = gridNow[i] !== 0;
                cells[i].wrap.classList.toggle("given", given[i]);
                cells[i].wrap.classList.remove("solved");
            }

            // Validate loaded puzzle and highlight any conflicts
            const v = window.Solver.validate(gridNow);
            applyConflicts(v.conflicts);
            if (!v.ok) flashButton("Fix red cells");
        } catch (e) {
            // Log for debugging, show user-friendly feedback
            console.error(e);
            flashButton("Bad file");
        } finally {
            // Reset input so the same file can be chosen again
            loadInput.value = "";
            setBtnText("Solve");
            disableAll(false);
        }
    });

    // Disable/enable all interactive controls during OCR/solving
    function disableAll(dis) {
        solveBtn.disabled = dis;
        clearBtn.disabled = dis;
        loadInput.disabled = dis;
    }

    // Keep a single source of truth for solve button text
    function setBtnText(t) { solveBtn.textContent = t; }

    // Temporary feedback on the solve button (non-blocking)
    function flashButton(text) {
        const old = solveBtn.textContent;
        solveBtn.textContent = text;
        setTimeout(() => solveBtn.textContent = old, 1100);
    }

    // Build the 9x9 board:
    // - Create wrapper divs with thick borders for 3x3 boxes
    // - Add alternate shading per box
    // - Attach input handlers for navigation + validation
    function buildBoard() {
        board.innerHTML = "";
        cells.length = 0;

        for (let r = 0; r < 9; r++) {
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;

                const wrap = document.createElement("div");
                wrap.className = "cell";

                // Alternate background per 3x3 box (improves readability)
                const box = Math.floor(r / 3) * 3 + Math.floor(c / 3);
                if (box % 2 === 1) wrap.classList.add("alt");

                // Thick borders for 3x3 boundaries
                if (c % 3 === 0) wrap.classList.add("thickL");
                if (r % 3 === 0) wrap.classList.add("thickT");
                if (c === 8) wrap.classList.add("thickR");
                if (r === 8) wrap.classList.add("thickB");

                const input = document.createElement("input");
                input.inputMode = "numeric";
                input.maxLength = 1;
                input.autocomplete = "off";
                input.spellcheck = false;

                // Keep active cell synced with focus
                input.addEventListener("focus", () => setActive(i));

                // Keyboard navigation + digit entry
                input.addEventListener("keydown", (e) => onKeyDown(e, i));

                // Sanitize input and validate on every change
                input.addEventListener("input", () => onInput(i));

                wrap.appendChild(input);
                board.appendChild(wrap);
                cells.push({ wrap, input });
            }
        }
    }

    // Mark one cell as active for styling (blue border)
    function setActive(i) {
        active = i;
        for (let k = 0; k < cells.length; k++) {
            cells[k].wrap.classList.toggle("active", k === i);
        }
    }

    // Focus a cell and select its value (fast typing flow)
    function focusCell(i) {
        setActive(i);
        const el = cells[i].input;
        el.focus();
        el.select();
    }

    // Keyboard handling:
    // - Arrow keys move
    // - Tab cycles cells (supports Shift+Tab)
    // - Backspace/Delete clears
    // - 1-9 types and auto-advances
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

    // Move focus by row/col deltas while clamping to grid bounds
    function move(i, dr, dc) {
        const r = Math.floor(i / 9), c = i % 9;
        const nr = Math.max(0, Math.min(8, r + dr));
        const nc = Math.max(0, Math.min(8, c + dc));
        focusCell(nr * 9 + nc);
    }

    // Sanitize input to a single digit 1-9, update given state,
    // clear solver marks, then validate and highlight conflicts.
    function onInput(i) {
        let v = cells[i].input.value.replace(/[^1-9]/g, "");
        if (v.length > 1) v = v[0];
        cells[i].input.value = v;

        // Reset computed/animation states if user edits
        cells[i].wrap.classList.remove("solved", "guess", "backtrack", "working");

        // Treat any non-empty cell as a "given" for UI purposes until solve begins
        given[i] = v !== "";
        cells[i].wrap.classList.toggle("given", given[i]);

        const res = window.Solver.validate(getGrid());
        applyConflicts(res.conflicts);
    }

    // Read the board into a numeric array (0 = empty)
    function getGrid() {
        const grid = new Array(81).fill(0);
        for (let i = 0; i < 81; i++) {
            const t = cells[i].input.value.trim();
            grid[i] = t ? Number(t) : 0;
        }
        return grid;
    }

    // Write a numeric grid into the UI (used by load + final solved paint)
    function fillGrid(grid) {
        for (let i = 0; i < 81; i++) {
            const v = grid[i] || 0;
            cells[i].input.value = v ? String(v) : "";
            cells[i].wrap.classList.remove("solved", "guess", "backtrack", "working", "conflict");
        }
        const res = window.Solver.validate(getGrid());
        applyConflicts(res.conflicts);
    }

    // Apply conflict class based on a set of indices
    function applyConflicts(conflicts) {
        for (const c of cells) c.wrap.classList.remove("conflict");
        for (const i of conflicts) cells[i].wrap.classList.add("conflict");
    }

    // Remove only transient solve-animation classes
    function clearWorkMarks() {
        for (const c of cells) c.wrap.classList.remove("working", "guess", "backtrack");
    }

    // Parse a text puzzle format: 81 digits (0-9), ignoring whitespace
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

    // Solve with recorded steps, then animate steps in the UI.
    // Uses small slices of work per frame to keep UI responsive.
    async function solveAndAnimate(grid) {
        setBtnText("Solving...");
        clearWorkMarks();

        // Collect solver events so we can animate them later
        const steps = [];
        const res = window.Solver.solveWithSteps(grid, (s) => steps.push(s));

        if (!res.ok) {
            flashButton("No solution");
            setBtnText("Solve");
            return;
        }

        let lastFocus = -1;

        // Delay between animation frames (slower = more visible backtracking)
        const delayMs = 28;

        await new Promise((done) => {
            let k = 0;

            function tick() {
                const start = performance.now();

                // Time-slice: process a few steps per frame (keeps FPS smooth)
                while (k < steps.length && (performance.now() - start) < 5) {
                    const step = steps[k++];

                    if (step.type === "focus") {
                        if (lastFocus !== -1) cells[lastFocus].wrap.classList.remove("working");
                        lastFocus = step.i;
                        cells[step.i].wrap.classList.add("working");
                    }

                    if (step.type === "assign") {
                        // Show placement (value set by solver)
                        cells[step.i].input.value = String(step.val);
                    }

                    if (step.type === "unassign") {
                        // Show removal during backtracking (don’t erase original clues)
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

        // Final paint:
        // Ensure all digits are present and apply solved/given styling
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

        // Safety: revalidate after solve (should be clean)
        const v = window.Solver.validate(getGrid());
        applyConflicts(v.conflicts);
    }
});
