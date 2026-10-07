export type Log = { color: string; log: string };
export let loglisteners: ((log: Log) => void)[] = [];

let logs: string[] = [];
(globalThis as any).logs = logs;

function proxyConsole(name: string, color: string) {
	// @ts-expect-error ts sucks
	const old = console[name].bind(console);
	// @ts-expect-error ts sucks
	console[name] = (...args) => {
		let str;
		try {
			str = args.join(" ");
		} catch {
			str = "<failed to render>";
		}
		old(...args);
		for (const logger of loglisteners) {
			logger({ color, log: str });
		}
		//logs.push(str);
	};
	return old;
}
export const console_error = proxyConsole("error", "var(--error)");
export const console_warn = proxyConsole("warn", "var(--warning)");
export const console_log = proxyConsole("log", "var(--fg)");
export const console_info = proxyConsole("info", "var(--info)");
export const console_debug = proxyConsole("debug", "var(--fg4)");
