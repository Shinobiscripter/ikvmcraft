import { css, FC } from "dreamland/core";

import tar, { Headers as TarHeaders, Pack } from "tar-stream";
import {
	fromWeb as streamFromWeb,
	toWeb as streamToWeb,
	/* @ts-expect-error streamx-webstream ships no type declarations */
} from "streamx-webstream";

// The File System Access API pickers are non-standard and missing from lib.dom.
declare global {
	function showOpenFilePicker(options?: { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
	function showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
	function showSaveFilePicker(options?: {
		excludeAcceptAllOption?: boolean;
		suggestedName?: string;
		types?: FilePickerAcceptType[];
	}): Promise<FileSystemFileHandle>;
	type FilePickerAcceptType = {
		description?: string;
		accept: Record<string, string | string[]>;
	};
	interface Window {
		showOpenFilePicker?: unknown;
		showDirectoryPicker?: unknown;
		showSaveFilePicker?: unknown;
	}
}

export const PICKERS_UNAVAILABLE =
	!window.showDirectoryPicker || !window.showOpenFilePicker;

export const TAR_TYPES: FilePickerAcceptType[] = [
	{
		description: "TAR archive (.tar)",
		accept: { "application/x-tar": ".tar" },
	},
	{
		description: "GZip compressed TAR archive (.tar.gz)",
		accept: { "application/x-gzip": ".tar.gz", "application/gzip": ".tar.gz" },
	},
];

const rootFolder = await navigator.storage.getDirectory();

async function recursiveGetDirectory(
	dir: FileSystemDirectoryHandle,
	path: string[]
): Promise<FileSystemDirectoryHandle> {
	if (path.length === 0) return dir;
	return recursiveGetDirectory(await dir.getDirectoryHandle(path[0]), path.slice(1));
}

async function copyFile(file: FileSystemFileHandle, to: FileSystemDirectoryHandle) {
	const data = await file.getFile().then((r) => r.stream());
	const handle = await to.getFileHandle(file.name, { create: true });
	const writable = await handle.createWritable();
	await data.pipeTo(writable);
}

async function copyFolder(folder: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle) {
	async function upload(from: FileSystemDirectoryHandle, into: FileSystemDirectoryHandle) {
		// FileSystemDirectoryHandle async iteration lives in lib.dom.asynciterable, not enabled here.
		for await (const [name, entry] of from as any) {
			if (entry.kind === "file") {
				await copyFile(entry as FileSystemFileHandle, into);
			} else {
				const newTo = await into.getDirectoryHandle(name, { create: true });
				await upload(entry as FileSystemDirectoryHandle, newTo);
			}
		}
	}
	const newFolder = await to.getDirectoryHandle(folder.name, { create: true });
	await upload(folder, newFolder);
}

async function createEntry(
	pack: Pack,
	header: TarHeaders,
	file?: ReadableStream<Uint8Array>
) {
	let resolve: () => void = null!;
	let reject: (err: any) => void = null!;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	const entry = pack.entry(header, (err) => {
		if (err) reject(err);
		else resolve();
	});

	if (file) {
		const reader = file.getReader();
		while (true) {
			const { value, done } = await reader.read();
			if (done || !value) break;

			entry.write(value);
		}

		entry.end();
	} else {
		entry.end();
	}

	await promise;
}

export function createTar(
	folder: FileSystemDirectoryHandle,
	callback?: (type: "directory" | "file", name: string) => void
): ReadableStream {
	const archive = tar.pack();

	async function pack(pathPrefix: string, folder: FileSystemDirectoryHandle) {
		// FileSystemDirectoryHandle async iteration lives in lib.dom.asynciterable, not enabled here.
		for await (const [name, entry] of folder as any) {
			if (callback) callback(entry.kind, name);

			if (entry.kind == "file") {
				const file = await (entry as FileSystemFileHandle).getFile();
				const stream = file.stream();

				await createEntry(
					archive,
					{
						name: pathPrefix + name,
						type: entry.kind,
						size: file.size,
					},
					stream
				);
			} else {
				await createEntry(archive, {
					name: pathPrefix + name,
					type: entry.kind,
				});

				await pack(pathPrefix + name + "/", entry as FileSystemDirectoryHandle);
			}
		}
	}
	pack("", folder).then(() => archive.finalize());

	return streamToWeb(archive);
}

export async function extractTar(
	stream: ReadableStream<Uint8Array>,
	folder: FileSystemDirectoryHandle,
	callback?: (type: "directory" | "file", name: string) => void
) {
	const tarInput = streamFromWeb(stream);
	const archive = tar.extract();

	archive.on("entry", async (header, stream, next) => {
		const body: ReadableStream<Uint8Array> = streamToWeb(stream);

		async function consume() {
			const reader = body.getReader();

			while (true) {
				const { done, value } = await reader.read();
				if (done || !value) break;
			}
		}

		const path = header.name.split("/");
		if (path[path.length - 1] === "") path.pop();
		if (path[0] === folder.name) path.shift();
		if (path.length === 0) {
			await consume();
			next();
			return;
		}

		let handle = folder;
		for (const name of path.splice(0, path.length - 1)) {
			handle = await handle.getDirectoryHandle(name, { create: true });
		}

		if (header.type === "directory") {
			await handle.getDirectoryHandle(path[0], { create: true });
			await consume();

			if (callback) callback("directory", path[0]);
		} else if (header.type === "file") {
			const file = await handle.getFileHandle(path[0], { create: true });
			const writable = await file.createWritable();
			await body.pipeTo(writable);

			if (callback) callback("file", path[0]);
		} else {
			await consume();
		}

		next();
	});

	const promise = new Promise<void>((res, rej) => {
		archive.on("finish", () => res());
		archive.on("error", (err) => rej(err));
	});

	tarInput.pipe(archive);
	await promise;
}

type Entry = { name: string; entry: FileSystemHandle };

export function OpfsExplorer(
	this: FC<
		{ open: boolean },
		{
			path: FileSystemDirectoryHandle;
			components: string[];
			entries: Entry[];
			editing: FileSystemFileHandle | null;
			uploading: boolean;
			downloading: boolean;
		}
	>
) {
	this.path = rootFolder;
	this.components = [];
	this.entries = [];
	this.editing = null as FileSystemFileHandle | null;
	this.uploading = false;
	this.downloading = false;

	const refresh = async () => {
		this.components = (await rootFolder.resolve(this.path)) || [];

		const entries: Entry[] = [];
		for await (const [name, entry] of this.path as any) {
			entries.push({ name, entry: entry as FileSystemHandle });
		}
		entries.sort((a, b) => {
			const kind = a.entry.kind.localeCompare(b.entry.kind);
			return kind === 0 ? a.name.localeCompare(b.name) : kind;
		});
		this.entries = entries;
	};

	this.cx.mount = () => {
		// reassigning this.path re-runs refresh, so navigation/upload just set this.path = this.path
		use(this.path).listen(refresh);
		use(this.open).listen((open) => {
			if (open) refresh();
		});
		refresh();
	};

	const goUp = async () => {
		this.editing = null;
		this.path = await recursiveGetDirectory(rootFolder, this.components.slice(0, -1));
	};

	const uploadFile = async () => {
		const files = await showOpenFilePicker({ multiple: true });
		this.uploading = true;
		for (const file of files) await copyFile(file, this.path);
		this.path = this.path;
		this.uploading = false;
	};

	const uploadFolder = async () => {
		const folder = await showDirectoryPicker();
		this.uploading = true;
		await copyFolder(folder, this.path);
		this.path = this.path;
		this.uploading = false;
	};

	const downloadArchive = async () => {
		const dirName = this.components.at(-1) || "ikvmcraft";
		const file = await showSaveFilePicker({
			excludeAcceptAllOption: true,
			suggestedName: dirName + ".tar",
			types: TAR_TYPES,
		});

		this.downloading = true;

		let stream = createTar(this.path, (type, name) => console.log(`tarring ${type} ${name}`));
		if (file.name.endsWith(".gz")) stream = stream.pipeThrough(new CompressionStream("gzip"));

		const fileStream = await file.createWritable();
		await stream.pipeTo(fileStream);

		this.downloading = false;
	};

	const uploadArchive = async () => {
		const files = await showOpenFilePicker({ multiple: true });
		this.uploading = true;
		for (const file of files) {
			let stream = await file.getFile().then((r) => r.stream());
			if (file.name.endsWith(".gz")) stream = stream.pipeThrough(new DecompressionStream("gzip"));
			await extractTar(stream, this.path, (type, name) => console.log(`untarring ${type} ${name}`));
		}
		this.path = this.path;
		this.uploading = false;
	};

	const uploadDisabled = use(this.uploading).map((x) => x || PICKERS_UNAVAILABLE);
	const downloadDisabled = use(this.downloading).map((x) => x || PICKERS_UNAVAILABLE);

	return (
		<div class="fs-explorer" class:open={use(this.open)}>
			<div class="bar">
				{use(this.components).map((c) =>
					c.length > 0 ? (
						<button on:click={goUp} title="Up a level">
							..
						</button>
					) : null
				)}
				<span class="cwd">
					{use(this.components).map((c) => (c.length === 0 ? "/" : "/" + c.join("/")))}
				</span>
				<span class="spacer" />
				<button disabled={uploadDisabled} on:click={uploadFile}>
					Upload File
				</button>
				<button disabled={uploadDisabled} on:click={uploadFolder}>
					Upload Folder
				</button>
				<button disabled={uploadDisabled} on:click={uploadArchive} title="Extract a .tar/.tar.gz here">
					Upload Archive
				</button>
				<button disabled={downloadDisabled} on:click={downloadArchive} title="Download this folder as a .tar/.tar.gz">
					Download Archive
				</button>
				<button on:click={() => (this.open = false)}>Close</button>
			</div>

			{use(this.uploading).map((u) => (u ? <div class="status">Uploading files...</div> : null))}
			{use(this.downloading).map((d) => (d ? <div class="status">Downloading archive...</div> : null))}

			<div class="entries">
				{use(this.entries).map((entries) =>
					entries.map((x) => {
						const isDir = x.entry.kind === "directory";

						const open = () => {
							if (isDir) {
								this.editing = null;
								this.path = x.entry as FileSystemDirectoryHandle;
							} else {
								this.editing = x.entry as FileSystemFileHandle;
							}
						};
						const download = async () => {
							const blob = await (x.entry as FileSystemFileHandle).getFile();
							const url = URL.createObjectURL(blob);
							const a = document.createElement("a");
							a.href = url;
							a.download = x.name;
							a.click();
							await new Promise((r) => setTimeout(r, 100));
							URL.revokeObjectURL(url);
						};
						const remove = async () => {
							if (this.editing?.name === x.name) this.editing = null;
							await this.path.removeEntry(x.name, { recursive: true });
							this.path = this.path;
						};

						return (
							<div class="entry">
								<button class="open" on:click={open}>
									<span class="kind">{isDir ? "dir" : "file"}</span>
									{x.name}
								</button>
								{!isDir ? (
									<button on:click={download} title="Download file">
										download
									</button>
								) : null}
								<button on:click={remove} title="Delete">
									delete
								</button>
							</div>
						);
					})
				)}
			</div>

			{use(this.editing).map((file) => {
				if (!file) return null;

				const area = (<textarea />) as HTMLTextAreaElement;
				area.value = "Loading file...";
				file
					.getFile()
					.then((r) => r.text())
					.then((r) => (area.value = r));

				const save = async () => {
					const writable = await file.createWritable();
					await writable.write(area.value);
					await writable.close();
					this.editing = null;
				};

				return (
					<div class="editor">
						<div class="controls">
							<span class="name">{file.name}</span>
							<span class="spacer" />
							<button on:click={save}>Save</button>
							<button on:click={() => (this.editing = null)}>Close</button>
						</div>
						{area}
					</div>
				);
			})}
		</div>
	);
}
OpfsExplorer.style = css`
	:scope {
		display: none;
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(32rem, 100%);
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem;
		background: #fff;
		border-left: 1px solid #000;
		font-family: monospace;
		overflow: auto;
		z-index: 10;
	}
	:scope.open {
		display: flex;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.bar .cwd {
		font-weight: bold;
		word-break: break-all;
	}
	.spacer {
		flex: 1;
	}

	.status {
		font-style: italic;
	}

	.entries {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-height: 0;
	}
	.entry {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.entry .open {
		flex: 1;
		text-align: left;
		font-family: monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.entry .kind {
		color: #888;
		margin-right: 0.5rem;
	}

	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.editor .controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.editor .name {
		font-weight: bold;
		word-break: break-all;
	}
	.editor textarea {
		min-height: 16rem;
		font-family: monospace;
	}
`;
