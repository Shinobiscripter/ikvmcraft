// --- benchmark input injector -------------------------------------------------------------------
// Drives a deterministic, repeatable movement path so jiterpreter heat / bailout counters and frame
// time can be sampled over a fixed window. emscripten-glfw listens for keydown/keyup on `document`
// and reads e.code (KeyboardMapping.h), so dispatching synthetic KeyboardEvents drives the game
// exactly like real keys. GLFW tracks press/release state (polled via glfwGetKey each frame), so a
// single keydown "presses" a key until we send keyup — no need to spam repeat events.
//
// Mouse-look is deliberately NOT injected: turning needs movementX/Y under pointer lock, which a
// synthetic event can't acquire (pointer lock requires a real user gesture). Walking forward through
// a superflat world is the deterministic render workload we want — new chunks continuously come into
// view ahead and get meshed (the vertex-consumer / chunk-mesh hot path), without camera variance.
//
// Recommended setup before running: a frozen superflat world at a fixed spawn —
//   /gamerule doDaylightCycle false   /time set day
//   /gamerule doWeatherCycle false    /weather clear
//   /gamerule randomTickSpeed 0       /difficulty peaceful
// The button in the UI disables while this runs and re-enables when done: that is your measurement
// window. Snapshot counters (dumpJiterpHeat / bailout totals) when it disables and again when it
// re-enables, diff, and normalize per-frame.

function benchKey(type: "keydown" | "keyup", code: string, key: string) {
	document.dispatchEvent(new KeyboardEvent(type, { code, key, repeat: false, bubbles: true, cancelable: true }));
}
const benchSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let benchStop: (() => void) | null = null;
export const benchRunning = () => benchStop !== null;

/**
 * Walk the player on a fixed path for `durationMs` (default 60s): sprint forward the whole time,
 * alternating a strafe right/left every 4s so the path covers terrain in more than one direction
 * while staying deterministic. Resolves when finished or when stopBench() is called. Always releases
 * every key it pressed, even on error/stop.
 */
export async function benchWalk(durationMs = 60000): Promise<void> {
	if (benchStop) { console.warn("[bench] already running"); return; }

	let stopped = false;
	benchStop = () => { stopped = true; };
	const start = performance.now();
	const elapsed = () => performance.now() - start;

	// every key we might press; released unconditionally in finally
	const allKeys: [string, string][] = [["KeyW", "w"], ["ControlLeft", "Control"], ["KeyD", "d"], ["KeyA", "a"]];

	console.log(`[bench] walk start: ${durationMs}ms (sprint forward + alternating strafe)`);
	try {
		benchKey("keydown", "ControlLeft", "Control"); // sprint (1.16 default keybind)
		benchKey("keydown", "KeyW", "w");               // forward, held throughout

		let curStrafe: "KeyD" | "KeyA" | null = null;
		while (!stopped && elapsed() < durationMs) {
			// 4s phases: forward-only, +right, forward-only, +left, repeat
			const phase = Math.floor(elapsed() / 4000) % 4;
			const want: "KeyD" | "KeyA" | null = phase === 1 ? "KeyD" : phase === 3 ? "KeyA" : null;
			if (want !== curStrafe) {
				if (curStrafe) benchKey("keyup", curStrafe, curStrafe === "KeyD" ? "d" : "a");
				if (want) benchKey("keydown", want, want === "KeyD" ? "d" : "a");
				curStrafe = want;
			}
			await benchSleep(200); // poll stop/elapsed every 200ms
		}
	} finally {
		for (const [code, key] of allKeys) benchKey("keyup", code, key);
		benchStop = null;
		console.log(`[bench] walk done after ${Math.round(elapsed())}ms`);
	}
}
(globalThis as any).benchWalk = benchWalk;

/** Stop an in-progress benchWalk/benchMeasure early (resolves its promise within ~200ms). */
export function stopBench() { benchStop?.(); }
(globalThis as any).stopBench = stopBench;

// --- benchmark measurement harness --------------------------------------------------------------
// Passive: YOU walk the test area for the window; this samples it (no input injection). Brackets the
// window with a heat dump (so you get the abort@ method list before & after) and reports frames, fps,
// ms/frame and per-reason bailout deltas (total + per-frame) — the actionable numbers for A/B'ing a
// runtime change like --jiterpreter-call-continue. The button disables for the whole window = "walk now".
//
// Frame count is emscripten-glfw's swapBuffers() (one bump per presented frame) via a shared-memory
// atomic. CAVEAT: if the scene is under the vsync cap (e.g. a light world at 60fps/6rd), ms/frame is
// vsync-bound, not compute-bound — pick a heavy enough scene (real world / higher render distance) to
// drop below 60 so the metric reflects real frame cost. Bailout deltas are only nonzero on a
// --jiterpreter-count-bailouts build (which itself adds overhead), so read frametime from a clean
// build and bailout deltas from a count-bailouts build — two runs.

// BailoutReason values (jiterpreter-enums.ts)
const BENCH_BAILOUTS: [string, number][] = [
	["Branch", 4], ["BackwardBranch", 5], ["Return", 14], ["Call", 15], ["AllocFailed", 17],
];
const benchFrameCount = (): number => {
	const f = (globalThis as any).wasm?.Module?._emscripten_glfw3_get_frame_count;
	return typeof f === "function" ? f() : NaN;
};
const benchBailout = (reason: number): number => {
	const f = (globalThis as any).wasm?.Module?._mono_jiterp_get_trace_bailout_count;
	return typeof f === "function" ? f(reason) : NaN;
};
// wasm method-JIT counters (need MONO_WASM_JIT_STATS=1). The runtime now exposes ONE generic getter
// (Module._mono_wasm_jit_get_counter(idx)) backed by a gint64 array; this enum mirrors the C WJC_*
// enum in src/mono/mono/mini/mini-wasm.h BY INDEX — KEEP IT IN SYNC (same order, append-only).
// ELAPSED_* are microseconds; BytesGenerated is bytes; everything else is a plain count.
const WJ = {
	Registered: 0, Bailed: 1, Invalid: 2,
	Invoke: 3, Residual: 4, Fastvcall: 5,
	AotRouted: 6, InterpRouted: 7,
	VicHit: 8, VicMiss: 9, VfastHad: 10, VfastNew: 11, VfbThresh: 12, VfbPerm: 13, VsyncWork: 14,
	VpermEh: 15, VpermLdaddr: 16, VpermLcmp: 17, VpermOtherop: 18, VpermOther: 19,
	RefHwm: 20,
	BytesGenerated: 21, ElapsedGeneration: 22, ElapsedInstantiation: 23, CompileAttempts: 24,
	IslandAttempt: 25, IslandCompleted: 26, IslandBudgetExhausted: 27, IslandDepthExceeded: 28,
	IslandBlockedPerm: 29, IslandBlockedCold: 30, PromotedUp: 31, PromotedDown: 32,
	VpermSig: 33, VpermByref: 34, VpermGshared: 35, VpermSync: 36, VpermEhOther: 37, VpermAot: 38,
	VcallAotFast: 39,
	// event-driven blocker waiting: Parked = times a method parked on cold blocker(s) instead of
	// poll-retrying; WaiterWoken = total waiters re-queued when a blocker JITted.
	Parked: 40, WaiterWoken: 41,
	// below-threshold vcall fallback (VfbThresh) split by the target's slot state — cold (slot 0, interp is
	// fine) vs parked (-2, island won't close) vs retry (-3). Parked = the real interp-residual driver.
	VfbCold: 42, VfbParked: 43, VfbRetry: 44,
	// fast-path VOLUME counters (emitted, gated by MONO_WASM_JIT_PROFILE_FAST=1): dispatch paths that
	// otherwise call no counting helper, so we can attribute frame cost. FastInlineAot = INLINE_AOT direct;
	// FastVic = inline f-slot IC hit (JIT->JIT); FastAotic = inline AOT-IC hit (JIT->AOT). 0 unless profiling.
	FastInlineAot: 45, FastVic: 46, FastAotic: 47,
} as const;
// registered = methods JITted (cumulative); invoke = interp->wasm-JIT entries; residual = outbound calls
// from JITted wasm that fell back to interp; fastvcall = virtual calls dispatched DIRECTLY to a JITted
// override's f-slot (gap #3 fast path, no interp).
const BENCH_WASMJIT = [WJ.Registered, WJ.Invoke, WJ.Residual, WJ.Fastvcall] as const;
// granular virtual-dispatch breakdown (mono_wasm_jit_vcall_resolve_fslot): ic hit/miss, fast-path returns
// (override already JITted vs compiled this call), fallback reasons (below threshold/retriable vs perm
// un-JITtable), and sync_thread instantiation work. Isolates the virtual-dispatch bottleneck under RESIDUAL=0.
const BENCH_VCALL = [WJ.VicHit, WJ.VicMiss, WJ.VfastHad, WJ.VfastNew, WJ.VfbThresh, WJ.VfbPerm, WJ.VsyncWork] as const;
// breakdown of the perm-unjittable vcall residual (vfbperm) by WHY the override can't JIT — tells us,
// runtime-weighted, whether to invest in EH codegen (Phase 4) or a specific opcode (e.g. ldaddr).
const BENCH_VPERM = [WJ.VpermAot, WJ.VpermEh, WJ.VpermLdaddr, WJ.VpermLcmp, WJ.VpermSig, WJ.VpermByref, WJ.VpermGshared, WJ.VpermSync, WJ.VpermEhOther, WJ.VpermOtherop, WJ.VpermOther] as const;
// split of the residual by inline-AOT-fastpath routing: aotrouted = ran natively via inline do_jit_call,
// interprouted = fell back to interp_entry/interpretation. shows how much boundary cost the fastpath captures.
const BENCH_AOTROUTE = [WJ.AotRouted, WJ.InterpRouted, WJ.VcallAotFast] as const;
// below-threshold vcall fallback split by target slot state: [cold, parked, retry]. parked>0 => hot methods
// whose islands won't close (interpreted every call) — the interp-residual driver, fixable by island closure.
const BENCH_VFB_SPLIT = [WJ.VfbCold, WJ.VfbParked, WJ.VfbRetry] as const;
// fast-path VOLUME (only nonzero under MONO_WASM_JIT_PROFILE_FAST=1): [inline-aot, f-slot-ic-hit, aot-ic-hit].
// un-confounds cost attribution — these dispatches are otherwise uncounted (pure emitted wasm, no helper).
const BENCH_FAST = [WJ.FastInlineAot, WJ.FastVic, WJ.FastAotic] as const;
const wjCounter = (idx: number): number => {
	const f = (globalThis as any).wasm?.Module?._mono_wasm_jit_get_counter;
	return typeof f === "function" ? f(idx) : NaN;
};

/**
 * Measure a fixed window while you manually walk the test area. Snapshots heat at start and end, then
 * reports frames / fps / ms/frame and per-reason bailout deltas. Resolves after `durationMs` or when
 * stopBench() is called.
 */
export async function benchMeasure(durationMs = 60000, walk = false): Promise<void> {
	if (benchStop) { console.warn("[bench] already running"); return; }
	let stopped = false;
	benchStop = () => { stopped = true; };

	const f0 = benchFrameCount();
	const b0 = BENCH_BAILOUTS.map(([, r]) => benchBailout(r));
	const wj0 = BENCH_WASMJIT.map(wjCounter);
	const wjv0 = BENCH_VCALL.map(wjCounter);
	const wjp0 = BENCH_VPERM.map(wjCounter);
	const wja0 = BENCH_AOTROUTE.map(wjCounter);
	const wjfb0 = BENCH_VFB_SPLIT.map(wjCounter);
	const wjf0 = BENCH_FAST.map(wjCounter);
	// compile-time accounting: [gen µs, instantiate µs, bytes, attempts]
	const wjt0 = [WJ.ElapsedGeneration, WJ.ElapsedInstantiation, WJ.BytesGenerated, WJ.CompileAttempts].map(wjCounter);
	// island outcomes: [attempt, completed, budgetExhausted, depthExceeded, blockedPerm, blockedCold, promotedUp, promotedDown, parked, waiterWoken]
	const wji0 = [WJ.IslandAttempt, WJ.IslandCompleted, WJ.IslandBudgetExhausted, WJ.IslandDepthExceeded, WJ.IslandBlockedPerm, WJ.IslandBlockedCold, WJ.PromotedUp, WJ.PromotedDown, WJ.Parked, WJ.WaiterWoken].map(wjCounter);
	// reset the per-window hot entry-edge counters so the END-of-window dump reflects just this window
	(globalThis as any).wasm?.Module?._mono_wasm_jit_snapshot?.();
	const t0 = performance.now();

	console.log(`[bench] measure START — ${walk ? "auto-walking (deterministic)" : "walk the test area now"} for ${(durationMs / 1000).toFixed(0)}s. heat snapshot A:`);
	dumpJiterpHeat(60);

	// when walk=true, drive a deterministic path (sprint forward + alternating strafe every 4s) inside
	// the sampling loop so off/on runs traverse identically. all keys released in finally.
	const walkKeys: [string, string][] = [["KeyW", "w"], ["ControlLeft", "Control"], ["KeyD", "d"], ["KeyA", "a"]];
	const end = t0 + durationMs;
	try {
		if (walk) {
			benchKey("keydown", "ControlLeft", "Control"); // sprint (1.16 default)
			benchKey("keydown", "KeyW", "w");               // forward, held throughout
		}
		let curStrafe: "KeyD" | "KeyA" | null = null;
		while (!stopped && performance.now() < end) {
			if (walk) {
				// 4s phases: forward-only, +right, forward-only, +left, repeat
				const phase = Math.floor((performance.now() - t0) / 4000) % 4;
				const want: "KeyD" | "KeyA" | null = phase === 1 ? "KeyD" : phase === 3 ? "KeyA" : null;
				if (want !== curStrafe) {
					if (curStrafe) benchKey("keyup", curStrafe, curStrafe === "KeyD" ? "d" : "a");
					if (want) benchKey("keydown", want, want === "KeyD" ? "d" : "a");
					curStrafe = want;
				}
			}
			await benchSleep(200);
		}
	} finally {
		if (walk) for (const [code, key] of walkKeys) benchKey("keyup", code, key);
	}

	const t1 = performance.now();
	const f1 = benchFrameCount();
	const b1 = BENCH_BAILOUTS.map(([, r]) => benchBailout(r));
	const wj1 = BENCH_WASMJIT.map(wjCounter);
	const wjv1 = BENCH_VCALL.map(wjCounter);
	const wjp1 = BENCH_VPERM.map(wjCounter);
	const wja1 = BENCH_AOTROUTE.map(wjCounter);
	const wjfb1 = BENCH_VFB_SPLIT.map(wjCounter);
	const wjf1 = BENCH_FAST.map(wjCounter);
	const wjt1 = [WJ.ElapsedGeneration, WJ.ElapsedInstantiation, WJ.BytesGenerated, WJ.CompileAttempts].map(wjCounter);
	const wji1 = [WJ.IslandAttempt, WJ.IslandCompleted, WJ.IslandBudgetExhausted, WJ.IslandDepthExceeded, WJ.IslandBlockedPerm, WJ.IslandBlockedCold, WJ.PromotedUp, WJ.PromotedDown, WJ.Parked, WJ.WaiterWoken].map(wjCounter);
	benchStop = null;

	console.log(`[bench] measure END. heat snapshot B:`);
	dumpJiterpHeat(60);
	// island diagnostics: top blocking callees (what to make jittable to grow islands) + the per-window
	// hot interp->JIT entry edges (the boundary the transition storm crosses).
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_blockers?.(40);
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_hot_edges?.(40);

	const wall = t1 - t0;
	const frames = f1 - f0;
	const out: string[] = [];
	out.push(`=== bench summary — ${(wall / 1000).toFixed(1)}s window ===`);
	if (Number.isFinite(frames) && frames > 0)
		out.push(`frames ${frames}   fps ${(frames / (wall / 1000)).toFixed(1)}   ms/frame ${(wall / frames).toFixed(2)}`);
	else
		out.push(`frames: unavailable — rebuild emscripten-glfw with the frame-counter patch (Module._emscripten_glfw3_get_frame_count missing)`);

	if (Number.isFinite(b0[0])) {
		out.push(`bailouts over window (Δtotal / per-frame):`);
		for (let i = 0; i < BENCH_BAILOUTS.length; i++) {
			const d = b1[i] - b0[i];
			const perFrame = frames > 0 ? (d / frames).toFixed(1) : "?";
			out.push(`  ${BENCH_BAILOUTS[i][0].padEnd(16)} ${Math.round(d).toLocaleString().padStart(16)}   ${perFrame}/frame`);
		}
	} else {
		out.push(`bailout deltas: unavailable — run with --jiterpreter-count-bailouts`);
	}

	if (Number.isFinite(wj0[0])) {
		const [reg0, inv0, res0, fvc0] = wj0, [reg1, inv1, res1, fvc1] = wj1;
		const perFrame = (d: number) => frames > 0 ? (d / frames).toFixed(1) : "?";
		out.push(`wasm-jit over window (Δ): registered +${reg1 - reg0} (total ${reg1})  invoked +${(inv1 - inv0).toLocaleString()} (${perFrame(inv1 - inv0)}/frame)  residual +${(res1 - res0).toLocaleString()} (${perFrame(res1 - res0)}/frame)  fastvcall +${(fvc1 - fvc0).toLocaleString()} (${perFrame(fvc1 - fvc0)}/frame)`);
		// compile time (Δ): generation/instantiation are microseconds in the counter; show ms. attempts = emits.
		const dGenMs = (wjt1[0] - wjt0[0]) / 1000, dInstMs = (wjt1[1] - wjt0[1]) / 1000, dBytes = wjt1[2] - wjt0[2], dAtt = wjt1[3] - wjt0[3];
		const dReg = reg1 - reg0;
		out.push(`  compile (Δ): ${dGenMs.toFixed(1)}ms gen + ${dInstMs.toFixed(1)}ms instantiate over ${dAtt} attempts → +${dReg} registered, +${(dBytes / 1024).toFixed(1)}kb (${dReg > 0 ? (dBytes / dReg / 1024).toFixed(2) : "?"}kb/method, ${dReg > 0 ? ((dGenMs + dInstMs) / dReg).toFixed(2) : "?"}ms/method)`);
		// island outcomes (Δ): why islands fail dispatches which heuristic lever is the fix (see plan Part 5).
		const di = wji1.map((v, i) => v - wji0[i]);
		const [iAtt, iDone, iBudget, iDepth, iPerm, iCold, iUp, iDown, iParked, iWoken] = di;
		out.push(`  islands (Δ): ${iAtt} attempts → ${iDone} completed (${iAtt > 0 ? (100 * iDone / iAtt).toFixed(0) : "?"}%); blocked perm ${iPerm} / cold ${iCold} / budget ${iBudget} / depth ${iDepth}; pulled-in down ${iDown}, up ${iUp}; parked ${iParked}, waiters woken ${iWoken}`);
		if (Number.isFinite(wja0[0])) {
			// residual routing: how much of the residual ran natively via the inline do_jit_call AOT fastpath
			// (aot-native) vs fell back to interp_entry/interpretation (interpreted). % of routed residual.
			const da = wja1[0] - wja0[0], di = wja1[1] - wja0[1], tr = da + di;
			const dvaf = wja1[2] - wja0[2];   // vcalls that took the fast AOT dispatch (MONO_WASM_JIT_VCALL_AOT) — bypass the residual entirely
			const rpct = (n: number) => tr > 0 ? `${(100 * n / tr).toFixed(1)}%` : "?";
			out.push(`  residual routing (Δ, /frame): aot-native ${perFrame(da)} (${rpct(da)})  interpreted ${perFrame(di)} (${rpct(di)})  vcall-aot-fast ${perFrame(dvaf)} (${(dvaf / 1000).toFixed(0)}k total)`);
		}
		if (Number.isFinite(wjv0[0])) {
			// vcall breakdown: [vichit, vicmiss, vfasthad, vfastnew, vfbthresh, vfbperm, vsyncwork]
			const dv = wjv1.map((v, i) => v - wjv0[i]);
			const [vih, vim, vfh, vfn, vbt, vbp, vsw] = dv;
			const tot = vih + vim; // total vcalls = ic hits + ic misses
			const pct = (n: number) => tot > 0 ? `${(100 * n / tot).toFixed(1)}%` : "?";
			out.push(`  vcall breakdown (Δ, /frame): total ${tot.toLocaleString()} (${perFrame(tot)})  ic_hit ${perFrame(vih)} (${pct(vih)})  ic_miss ${perFrame(vim)} (${pct(vim)})`);
			out.push(`    fast: already-JITted ${perFrame(vfh)} (${pct(vfh)})  compiled-now ${perFrame(vfn)} (${pct(vfn)})   fallback: below-threshold ${perFrame(vbt)} (${pct(vbt)})  perm-unjittable ${perFrame(vbp)} (${pct(vbp)})   sync-instantiated ${perFrame(vsw)}`);
			// below-threshold fallback split by target slot state: cold (interp acceptable) vs PARKED (crossed
			// thresh but island won't close = interpreted every call, the real interp-residual driver) vs retry.
			const dfb = wjfb1.map((v, i) => v - wjfb0[i]);
			const [fbc, fbp, fbr] = dfb;
			const bpct = (n: number) => vbt > 0 ? `${(100 * n / vbt).toFixed(1)}%` : "?";
			out.push(`      below-threshold split (/frame, % of below-thresh): cold ${perFrame(fbc)} (${bpct(fbc)})  PARKED ${perFrame(fbp)} (${bpct(fbp)})  retry ${perFrame(fbr)} (${bpct(fbr)})`);
			if (Number.isFinite(wjp0[0])) {
				// perm-unjittable residual by reason: [aot, eh, ldaddr, lcompare, sig, byref, gshared, sync, eh-other, other-opcode, other]
				const dp = wjp1.map((v, i) => v - wjp0[i]);
				const [paot, peh, pld, plc, psig, pbyref, pgsh, psync, pehx, pop, pot] = dp;
				const ppct = (n: number) => vbp > 0 ? `${(100 * n / vbp).toFixed(1)}%` : "?";
				out.push(`    perm-residual by reason (/frame, % of perm): aot-backed ${perFrame(paot)} (${ppct(paot)})  EH ${perFrame(peh)} (${ppct(peh)})  ldaddr ${perFrame(pld)} (${ppct(pld)})  lcompare ${perFrame(plc)} (${ppct(plc)})  sig ${perFrame(psig)} (${ppct(psig)})  byref ${perFrame(pbyref)} (${ppct(pbyref)})  gshared ${perFrame(pgsh)} (${ppct(pgsh)})  sync ${perFrame(psync)} (${ppct(psync)})  eh-other ${perFrame(pehx)} (${ppct(pehx)})  other-opcode ${perFrame(pop)} (${ppct(pop)})  other ${perFrame(pot)} (${ppct(pot)})`);
			}
		}
		// fast-path VOLUME (nonzero only under MONO_WASM_JIT_PROFILE_FAST=1): these dispatches call no
		// counting helper, so without this they are invisible and frame-cost attribution vs residuals is
		// confounded. inline-aot = INLINE_AOT direct AOT call; f-slot-ic-hit = JIT->JIT; aot-ic-hit = JIT->AOT.
		const df = wjf1.map((v, i) => v - wjf0[i]);
		if (df.some((v) => v !== 0))
			out.push(`  fast-path volume (Δ, /frame): inline-aot ${perFrame(df[0])}  f-slot-ic-hit ${perFrame(df[1])}  aot-ic-hit ${perFrame(df[2])}`);
		else
			out.push(`  fast-path volume: not profiled (set MONO_WASM_JIT_PROFILE_FAST=1 to count inline-aot / f-slot-ic / aot-ic dispatches)`);
	} else {
		out.push(`wasm-jit deltas: unavailable — set MONO_WASM_JIT_STATS=1`);
	}

	console.log(out.join("\n"));
}
(globalThis as any).benchMeasure = benchMeasure;

/**
 * Dump the hottest jiterpreter trace entry points
 * A hot method showing jit<eps (few/no compiled entry points) is one the jiterpreter couldn't
 * trace — i.e. an interpreter-time / inlining target.
 */
export function dumpJiterpHeat(top = 60): void {
	(globalThis as any).wasm?.Module._dump_jiterp_trace_heat(top);
	(globalThis as any).wasm.runtime.INTERNAL.jiterpreter_dump_stats(false);
}
(globalThis as any).dumpJiterpHeat = dumpJiterpHeat;

/**
 * Dump wasm method-JIT counters (analog of dumpJiterpHeat for the native wasm JIT tier): how many
 * methods were JITted (registered) vs bailed/invalid, how many interp->wasm entries happened, and how
 * many outbound calls fell back to the interpreter (residual). Needs MONO_WASM_JIT_STATS=1 (set above).
 */
export function dumpWasmJit(): void {
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_stats?.();
}
(globalThis as any).dumpWasmJit = dumpWasmJit;

/**
 * Dump the residual-callee ring buffer (last <=128 outbound interp-residual calls). Call this AFTER a
 * crash (e.g. the mode-1 recursive-finish) to name the residual whose interp_entry triggered it — the
 * culprit is among the last entries. Needs MONO_WASM_JIT_STATS=1.
 */
export function dumpResidualRing(): void {
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_residual_ring?.();
}
(globalThis as any).dumpResidualRing = dumpResidualRing;
