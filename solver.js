// solver.js
// -----------------------------------------------------------------------------
// Sudoku Solver Engine (Constraint Propagation + MRV Backtracking)
// -----------------------------------------------------------------------------
// Exposes:
//   window.Solver = { validate, solve, solveWithSteps }
//
// Design goals:
// - Fast for typical puzzles (uses propagation before guessing)
// - Debuggable (optional step events for UI animation)
// - Safe (validates conflicts and rejects invalid states early)
//
// Techniques implemented:
// 1) Candidate elimination via peers
// 2) Single-candidate placements (a cell has exactly one candidate)
// 3) Only-position placements (within a unit, a digit fits in only one cell)
// 4) Backtracking search (DFS) with MRV heuristic (minimum remaining values)
//
// Terminology:
// - Cell index i: 0..80
// - Unit: one row, one column, or one 3x3 box (9 cells)
// - Peers: all cells sharing row/col/box with a given cell
// -----------------------------------------------------------------------------

window.Solver = (() => {
    const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const idx = (r, c) => r * 9 + c;
    const rowOf = i => Math.floor(i / 9);
    const colOf = i => i % 9;
    const boxOf = i => Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);

    // Precompute peers for each cell to avoid repeated work during solving
    const PEERS = Array.from({ length: 81 }, (_, i) => {
        const r = rowOf(i), c = colOf(i), b = boxOf(i);
        const s = new Set();
        for (let k = 0; k < 9; k++) {
            s.add(idx(r, k));      // row peers
            s.add(idx(k, c));      // column peers
            const br = Math.floor(b / 3) * 3 + Math.floor(k / 3);
            const bc = (b % 3) * 3 + (k % 3);
            s.add(idx(br, bc));    // box peers
        }
        s.delete(i);
        return s;
    });

    // Precompute all units (9 rows + 9 cols + 9 boxes)
    const UNITS = (() => {
        const u = [];
        for (let r = 0; r < 9; r++) u.push(Array.from({ length: 9 }, (_, c) => idx(r, c)));
        for (let c = 0; c < 9; c++) u.push(Array.from({ length: 9 }, (_, r) => idx(r, c)));
        for (let br = 0; br < 3; br++) for (let bc = 0; bc < 3; bc++) {
            const box = [];
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) box.push(idx(br * 3 + r, bc * 3 + c));
            u.push(box);
        }
        return u;
    })();

    // Validate grid for duplicate digits inside any unit
    function validate(grid) {
        const conflicts = new Set();
        for (const unit of UNITS) {
            const seen = new Map(); // digit -> index
            for (const i of unit) {
                const v = grid[i];
                if (!v) continue;
                if (seen.has(v)) { conflicts.add(i); conflicts.add(seen.get(v)); }
                else seen.set(v, i);
            }
        }
        return { ok: conflicts.size === 0, conflicts };
    }

    // Build candidate sets for each cell. Returns null if grid is invalid/impossible.
    function buildCandidates(grid) {
        const v = validate(grid);
        if (!v.ok) return null;

        const cand = Array.from({ length: 81 }, (_, i) =>
            grid[i] ? new Set([grid[i]]) : new Set(DIGITS)
        );

        // Eliminate candidates using fixed digits in peer cells
        for (let i = 0; i < 81; i++) {
            if (!grid[i]) continue;
            const val = grid[i];
            for (const p of PEERS[i]) {
                if (grid[p] !== 0) continue;
                cand[p].delete(val);
                if (cand[p].size === 0) return null;
            }
        }
        return cand;
    }

    // Solved means no zeros + no conflicts
    function solved(grid) {
        for (let i = 0; i < 81; i++) if (grid[i] === 0) return false;
        return validate(grid).ok;
    }

    // Pick next cell using MRV (fewest candidates)
    function pickMRV(grid, cand) {
        let best = -1, bestSize = 10;
        for (let i = 0; i < 81; i++) {
            if (grid[i] !== 0) continue;
            const n = cand[i].size;
            if (n < bestSize) { bestSize = n; best = i; }
        }
        return best;
    }

    // Deep clone state for safe branching in DFS
    function clone(grid, cand) {
        return { grid: grid.slice(), cand: cand.map(s => new Set(s)) };
    }

    // Core solver used by both solve() and solveWithSteps()
    function coreSolve(gridInput, onStep) {
        const grid = gridInput.slice();
        const v = validate(grid);
        if (!v.ok) return { ok: false, error: "Conflicts found.", conflicts: v.conflicts };

        let cand = buildCandidates(grid);
        if (!cand) return { ok: false, error: "Invalid puzzle." };

        // Step callback (optional) for UI animation
        const step = payload => { if (typeof onStep === "function") onStep(payload); };

        // Assign a value to a cell and update peer candidates
        function assign(grid, cand, i, val, reason) {
            grid[i] = val;
            cand[i] = new Set([val]);
            step({ type: "assign", i, val, reason });

            for (const p of PEERS[i]) {
                if (grid[p] !== 0) continue;
                if (cand[p].delete(val) && cand[p].size === 0) return false;
            }
            return true;
        }

        // Constraint propagation loop:
        // - Single-candidate placements
        // - Only-position placements inside each unit
        function propagate(grid, cand) {
            while (true) {
                let changed = false;

                // Single-candidate: a cell has exactly one possible digit
                for (let i = 0; i < 81; i++) {
                    if (grid[i] !== 0) continue;
                    if (cand[i].size === 1) {
                        const val = cand[i].values().next().value;
                        if (!assign(grid, cand, i, val, "single-candidate")) return false;
                        changed = true;
                    }
                }

                // Only-position: within a unit, a digit fits in only one cell
                for (const unit of UNITS) {
                    const pos = new Map(DIGITS.map(d => [d, []]));
                    for (const i of unit) {
                        if (grid[i] !== 0) continue;
                        for (const d of cand[i]) pos.get(d).push(i);
                    }
                    for (const d of DIGITS) {
                        const spots = pos.get(d);
                        if (spots.length === 1) {
                            if (!assign(grid, cand, spots[0], d, "only-position")) return false;
                            changed = true;
                        }
                    }
                }

                if (!changed) break;
            }
            return true;
        }

        if (!propagate(grid, cand)) return { ok: false, error: "Unsolvable puzzle." };
        if (solved(grid)) return { ok: true, grid };

        // Backtracking search with MRV
        function dfs(grid, cand) {
            if (solved(grid)) return grid;

            const cell = pickMRV(grid, cand);
            if (cell === -1) return null;

            step({ type: "focus", i: cell });

            for (const val of [...cand[cell]]) {
                step({ type: "guess", i: cell, val });

                const s = clone(grid, cand);

                if (!assign(s.grid, s.cand, cell, val, "guess")) {
                    step({ type: "backtrack", i: cell, val });
                    step({ type: "unassign", i: cell });
                    continue;
                }

                if (!propagate(s.grid, s.cand)) {
                    step({ type: "backtrack", i: cell, val });
                    step({ type: "unassign", i: cell });
                    continue;
                }

                const res = dfs(s.grid, s.cand);
                if (res) return res;

                step({ type: "backtrack", i: cell, val });
                step({ type: "unassign", i: cell });
            }

            return null;
        }

        const out = dfs(grid, cand);
        if (!out) return { ok: false, error: "No solution found." };
        return { ok: true, grid: out };
    }

    return {
        validate,
        solve: (g) => coreSolve(g, null),
        solveWithSteps: (g, onStep) => coreSolve(g, onStep)
    };
})();
