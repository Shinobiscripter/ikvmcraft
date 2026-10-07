import { createState } from "dreamland/core";
import type { ModuleAPI, MonoConfig, RuntimeAPI } from "../dotnetdefs";
import { EpxTcpWs } from "../net";

const enum GLBackend {
	Krypton = 0,
	MobileGL = 1,
}

const wasm: ModuleAPI = await eval(`import("/_framework/dotnet.js")`);
const dotnet = wasm.dotnet;
let runtime: RuntimeAPI;
let config: MonoConfig;
let exports: any;

export let dotnetState = createState({ wasmMemory: 0, gcMemory: 0, uaMemory: 0, nativeUsed: 0, nativeFree: 0, fps: 0, fpsAvg: 0 });

export function getDlls(): (readonly [string, string])[] {
	const config = (wasm.dotnet as any).instance.config;
	const resources = [
		...(config.resources?.coreAssembly || []),
		...(config.resources?.assembly || []),
	];
	return resources.map((x) => [x.name, x.virtualPath] as const);
}

export async function initDotnet(canvas: HTMLCanvasElement) {
	// emscripten proxy hackfix number 39847232303
	(globalThis as any).Atomics.waitAsync = undefined;

	(globalThis as any).WebSocket = new Proxy(WebSocket, {
		construct(t, a, n) {
			const url = new URL(a[0]);
			if (url.hostname.startsWith("wisp-"))
				return new EpxTcpWs(url);

			return Reflect.construct(t, a, n);
		},
	});

	console.time("dotnet ");
	//(globalThis as any).GLFW3_DEBUG = true;
	runtime = await dotnet
		.withConfig({ pthreadPoolInitialSize: 16 })
		.withModuleConfig({
			onRuntimeInitialized(Module: any) {
				(globalThis as any).wasm = { Module, FS: Module.FS };
			}
		})
		.withEnvironmentVariable("MONO_SLEEP_ABORT_LIMIT", "20000")
		.withEnvironmentVariable("MONO_GC_PARAMS", "nursery-size=128m")
		//.withEnvironmentVariable("MONO_GC_PARAMS", "nursery-size=131072")

		//.withEnvironmentVariable("MONO_LOG_LEVEL", "debug")
		//.withEnvironmentVariable("MONO_LOG_MASK", "gc")
		//.withEnvironmentVariable("MONO_LOG_MASK", "aot")

		.withEnvironmentVariable("MONO_WASM_JIT_AUTO", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_RESIDUAL", "0")
		.withEnvironmentVariable("MONO_WASM_JIT_VIRTUAL", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_ISLAND", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_INLINE_AOT", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_VCALL_AOT", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_VCALL_INLINE_IC", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_VCALL_AOT_IC", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_AOTCONST", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_EH", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_FINALLY", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_AOT_RESIDUAL", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_LDADDR_VTYPE", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_VTYPE_SCALAR", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_VTYPE_SCALAR_REF", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_STATS", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_NAMES", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_STOREGUARD", "0")
		.withEnvironmentVariable("MONO_WASM_JIT_OBJGUARD", "0")
		.withEnvironmentVariable("MONO_WASM_JIT_PINALL", "0")
		.withEnvironmentVariable("MONO_WASM_JIT_OUTARG", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_VCALL_WAYS", "4")
		.withEnvironmentVariable("MONO_WASM_JIT_VCALL_AOT_WAYS", "4")
		.withEnvironmentVariable("MONO_WASM_JIT_SP_GLOBAL", "1")
		//.withEnvironmentVariable("MONO_WASM_JIT_WATCH", "method_3479")
		//.withEnvironmentVariable("MONO_WASM_JIT_METHOD", "...")
		//.withEnvironmentVariable("MONO_WASM_JIT_NO_METHOD", "...")
		//.withEnvironmentVariable("MONO_WASM_JIT_REFDIAG", "...")
		.withEnvironmentVariable("MONO_WASM_JIT_VERBOSE", "0")
		.withEnvironmentVariable("MONO_WASM_JIT_PROFILE_FAST", "0")
		.withEnvironmentVariable("MONO_WASM_JIT_ARITY", "0")

		.withEnvironmentVariable("MONO_WASM_JIT_OPT", "inline,consprop,copyprop,deadce,branch,alias-analysis,cfold,loop")
		.withEnvironmentVariable("MONO_WASM_JIT_THRESHOLD", "500")
		.withEnvironmentVariable("MONO_WASM_JIT_ISLAND_BUDGET", "192")
		.withEnvironmentVariable("MONO_WASM_JIT_PROMOTION_DRAIN", "8")
		.withEnvironmentVariable("MONO_WASM_JIT_ISLAND_COLD_DIV", "4")
		.withEnvironmentVariable("MONO_WASM_JIT_PROMOTED_COLD_DIV", "16")
		.withEnvironmentVariable("MONO_WASM_JIT_PROMOTED_ROOT_UNCOLD_DEPTH", "8")
		.withEnvironmentVariable("MONO_WASM_JIT_BLOCK_FORCE", "4")
		.withEnvironmentVariable("MONO_WASM_JIT_BLOCK_PROMOTE", "4")
		.withEnvironmentVariable("MONO_WASM_JIT_ISLAND_DEPTH", "24")
		.withEnvironmentVariable("MONO_WASM_JIT_ENTRY_PROMOTE", "96")
		.withEnvironmentVariable("MONO_WASM_JIT_RESIDUAL_PERM", "1")
		.withEnvironmentVariable("MONO_WASM_JIT_RESIDUAL_COLD", "0")
		.withEnvironmentVariable("MONO_WASM_JIT_HOT_ROOT", "1")

		//.withEnvironmentVariable("MONO_GC_DEBUG", "no-managed-allocator") // TODO is this needed
		//.withEnvironmentVariable("IKVM_FROMCLASS_TRACE", "1")
		//.withEnvironmentVariable("IKVM_UNSAFE_OFFSET_TRACE", "1")
		.withRuntimeOptions([

			// accept smaller traces earlier
			`--jiterpreter-minimum-trace-value=${10}`,
			`--jiterpreter-minimum-trace-hit-count=${1000}`,
			`--jiterpreter-back-branch-boost=${980}`, // make sure this is below trace hit count
			`--jiterpreter-minimum-distance-between-traces=${3}`,
			`--jiterpreter-trace-monitoring-period=${500}`,
			`--jiterpreter-trace-monitoring-max-average-penalty=${75}`,

			// increase jit function limits
			`--jiterpreter-wasm-bytes-limit=${64 * 1024 * 1024}`,
			`--jiterpreter-max-module-size=${64 * 1024 - 1}`,
			`--jiterpreter-table-size=${32 * 1024}`,
			`--jiterpreter-aot-table-size=${32 * 1024}`,

			// print jit stats
			`--jiterpreter-stats-enabled`,
			`--jiterpreter-count-bailouts`,
			`--jiterpreter-estimate-heat`,

			//`--jiterpreter-direct-jit-calls=false`,

			//`--no-jiterpreter-jit-call-enabled`,
			//`--no-jiterpreter-interp-entry-enabled`,

			//`--no-jiterpreter-traces-enabled`
		])
		.create();


	config = runtime.getConfig();
	exports = await runtime.getAssemblyExports(config.mainAssemblyName!);


	(runtime.Module as any).canvas = canvas;

	(globalThis as any).wasm = {
		Module: runtime.Module,
		FS: (runtime.Module as any).FS,
		dotnet,
		runtime,
		config,
		exports,
		canvas,
	};
	console.debug("PreInit...");
	await runtime.runMain();
	await exports.IkvmWasm.PreInit(GLBackend.Krypton, location.href, getDlls().map((x) => `${x[0]}|${x[1]}`), [["org.lwjgl.util.Debug", "true"], ["org.lwjgl.util.DebugLoader", "true"], ["java.awt.headless", "true"]]);
	console.debug("dotnet initialized");
	console.timeEnd("dotnet ");
}

export async function play(version: string) {
	setInterval(async () => {
		let mod = (globalThis as any).wasm.Module;
		dotnetState.wasmMemory = mod.wasmMemory.buffer.byteLength;
		dotnetState.nativeUsed = mod._ikvm_native_used_mb?.() ?? 0;
		dotnetState.nativeFree = mod._ikvm_native_free_mb?.() ?? 0;
		let { bytes: uaMemory } = await performance.measureUserAgentSpecificMemory();
		dotnetState.uaMemory = uaMemory;
	}, 5000);

	exports.IkvmWasm.WatchMemoryUsage(5000, (live: number) => {
		dotnetState.gcMemory = live;
		return false;
	});

	let framecounts = [];
	let lastframecount = 0;
	setInterval(() => {
		let framecount = (globalThis as any).wasm.Module._emscripten_glfw3_get_frame_count();
		dotnetState.fps = framecount - lastframecount;
		framecounts.push(dotnetState.fps);
		lastframecount = framecount;

		if (framecounts.length > 10)
			framecounts.shift();

		dotnetState.fpsAvg = framecounts.reduce((acc, x) => acc + x, 0) / framecounts.length;
	}, 1000);

	console.debug("Run...");
	await exports.IkvmWasm.Run(version);
	console.debug("Exited");
}
