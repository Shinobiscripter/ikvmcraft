import { css, FC } from "dreamland/core";
import "./style.css";
import { initDotnet, play, dotnetState } from "./dotnet";
import { loglisteners } from "./dotnet/log";
import { dumpWasmJit, benchMeasure } from "./dotnet/jitbench";
import { downloadFabricMinecraftVersionToOpfs, isMinecraftVersionDownloaded } from "./minecraft";
import { OpfsExplorer } from "./fs";

function LogView(this: FC<{ scrolling: boolean }>) {
	const create = (color: string, log: string) => {
		const el = document.createElement("div");
		el.classList.add("log");
		el.innerText = log;
		el.style.color = color;
		return el;
	};

	this.cx.mount = () => {
		const logroot = this.root as HTMLElement;
		const frag = document.createDocumentFragment();

		loglisteners.push((x) => frag.append(create(x.color, x.log)));
		setInterval(() => {
			if (frag.children.length > 0) {
				logroot.appendChild(frag);
				logroot.scrollTop = logroot.scrollHeight;
			}
		}, 250);
	};

	return (
		<div
			class="component-log"
			style={this.scrolling ? "overflow: auto" : "overflow: hidden"}
		/>
	);
};
LogView.css = `
	min-height: 0;
	flex: 1;
	font-family: var(--font-mono);

	::-webkit-scrollbar {
		width: 10px;
	}
	::-webkit-scrollbar-track {
		background: var(--surface3);
	}
	::-webkit-scrollbar-thumb {
		background: var(--surface6);
	}
`;

function App(this: FC<{}, { canvas: HTMLCanvasElement; fsOpen: boolean; benchRunning: boolean; walkDuringBench: boolean; sampling: boolean }>) {
	this.fsOpen = false;
	this.benchRunning = false;
	this.walkDuringBench = false;
	this.sampling = false;

	this.cx.mount = async () => {
		if (!(await isMinecraftVersionDownloaded("1.16.1-fabric-0.19.3", { verifyHashes: true })))
			await downloadFabricMinecraftVersionToOpfs("1.16.1", { loaderVersion: "0.19.3" });
		else
			console.debug("downlaodead 1.16.1 fabric 0.19.3 already");

		await initDotnet(this.canvas);

		await play("1.16.1-fabric-0.19.3");
	};

	return (
		<div>
			<canvas id="canvas" class="canvas" this={use(this.canvas)} on:contextmenu={(e: Event) => e.preventDefault()} />
			<div class="debug">
				<b>fps: {use(dotnetState.fps)} ({use(dotnetState.fpsAvg).map(x=>x.toFixed(2))})</b>
				<button on:click={() => (globalThis as any).wasm.Module.ccall("perform_thread_dump")}>Thread dump</button>
				<button on:click={() => dumpWasmJit()}>Wasm JIT</button>
				<label style="display: flex; align-items: center; gap: 0.25rem;">
					<input type="checkbox" on:change={(e: any) => (this.walkDuringBench = e.target.checked)} />
					walk
				</label>
				<button
					disabled={use(this.benchRunning)}
					on:click={async () => {
						// button disabled for the whole window; "walk" checkbox => deterministic auto-walk
						this.benchRunning = true;
						try { await benchMeasure(60000, this.walkDuringBench); } finally { this.benchRunning = false; }
					}}
				>Bench 60s</button>
				<button on:click={() => (this.fsOpen = !this.fsOpen)}>Files</button>
				<span>memory: gc {use(dotnetState.gcMemory).map(x=> x.toFixed(0))} · native {use(dotnetState.nativeUsed).map(x=> x.toFixed(0))}+{use(dotnetState.nativeFree).map(x=> x.toFixed(0))}free · wasm {use(dotnetState.wasmMemory).map(x=> (x / (1024 * 1024)).toFixed(0))} · ua {use(dotnetState.uaMemory).map(x=> (x / (1024 * 1024)).toFixed(0))} (mb)</span>
			</div>
			<LogView scrolling={true} />
			<OpfsExplorer open={use(this.fsOpen)} />
		</div>
	)
}
App.style = css`
	:scope {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	:global(.component-log) {
		font-family: monospace;
		flex: 1;
		align-self: stretch;
		background: #eee;
	}

	.debug {
		display: flex;
		gap: 1rem;
	}
`;

document.querySelector("#app")!.replaceWith(<App />);
