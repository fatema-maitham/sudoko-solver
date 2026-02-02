// solver.js
// Exposes: window.Solver = { validate, solve, solveWithSteps }

window.Solver = (() => {
    const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const idx = (r, c) => r * 9 + c;
    const rowOf = i => Math.floor(i / 9);
    const colOf = i => i % 9;
    const boxOf = i => Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);

    const PEERS = Array.from({ length: 81 }, (_, i) => {
        const r = rowOf(i), c = colOf(i), b = boxOf(i);
        const s = new Set();
        for (let k = 0; k < 9; k++) {
            s.add(idx(r, k));
            s.add(idx(k, c));
            const br = Math.floor(b / 3) * 3 + Math.floor(k / 3);
            const bc = (b % 3) * 3 + (k % 3);
            s.add(idx(br, bc));
        }
        s.delete(i);
        return s;
    });

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

    function validate(grid) {
        const conflicts = new Set();
        for (const unit of UNITS) {
            const seen = new Map();
            for (const i of unit) {
                const v = grid[i];
                if (!v) continue;
                if (seen.has(v)) { conflicts.add(i); conflicts.add(seen.get(v)); }
                else seen.set(v, i);
            }
        }
        return { ok: conflicts.size === 0, conflicts };
    }

    function buildCandidates(grid) {
        const v = validate(grid);
        if (!v.ok) return null;

        const cand = Array.from({ length: 81 }, (_, i) =>
            grid[i] ? new Set([grid[i]]) : new Set(DIGITS)
        );

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

    function solved(grid) {
        for (let i = 0; i < 81; i++) if (grid[i] === 0) return false;
        return validate(grid).ok;
    }

    function pickMRV(grid, cand) {
        let best = -1, bestSize = 10;
        for (let i = 0; i < 81; i++) {
            if (grid[i] !== 0) continue;
            const n = cand[i].size;
            if (n < bestSize) { bestSize = n; best = i; }
        }
        return best;
    }

    function clone(grid, cand) {
        return { grid: grid.slice(), cand: cand.map(s => new Set(s)) };
    }

    function coreSolve(gridInput, onStep) {
        const grid = gridInput.slice();
        const v = validate(grid);
        if (!v.ok) return { ok: false, error: "Conflicts found.", conflicts: v.conflicts };

        let cand = buildCandidates(grid);
        if (!cand) return { ok: false, error: "Invalid puzzle." };

        const step = payload => { if (typeof onStep === "function") onStep(payload); };

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

        function propagate(grid, cand) {
            while (true) {
                let changed = false;

                // naked singles
                for (let i = 0; i < 81; i++) {
                    if (grid[i] !== 0) continue;
                    if (cand[i].size === 1) {
                        const val = cand[i].values().next().value;
                        if (!assign(grid, cand, i, val, "naked-single")) return false;
                        changed = true;
                    }
                }

                // hidden singles
                for (const unit of UNITS) {
                    const pos = new Map(DIGITS.map(d => [d, []]));
                    for (const i of unit) {
                        if (grid[i] !== 0) continue;
                        for (const d of cand[i]) pos.get(d).push(i);
                    }
                    for (const d of DIGITS) {
                        const spots = pos.get(d);
                        if (spots.length === 1) {
                            if (!assign(grid, cand, spots[0], d, "hidden-single")) return false;
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

        function dfs(grid, cand) {
            if (solved(grid)) return grid;
            const cell = pickMRV(grid, cand);
            if (cell === -1) return null;

            step({ type: "focus", i: cell });

            for (const val of [...cand[cell]]) {
                step({ type: "guess", i: cell, val });
                const s = clone(grid, cand);

                if (!assign(s.grid, s.cand, cell, val, "guess")) {
                    step({ type: "unassign", i: cell });
                    step({ type: "backtrack", i: cell, val });
                    continue;
                }
                if (!propagate(s.grid, s.cand)) {
                    step({ type: "unassign", i: cell });
                    step({ type: "backtrack", i: cell, val });
                    continue;
                }

                const res = dfs(s.grid, s.cand);
                if (res) return res;

                // show removal when backtracking
                step({ type: "unassign", i: cell });
                step({ type: "backtrack", i: cell, val });
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
