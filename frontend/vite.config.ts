import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// host proxy prefix -> upstream origin. followRedirects is enabled on every
// route so 3xx responses are resolved against the upstream (e.g. fabricmc's
// intermediary stub 302s to .../0.0.0/...) instead of being handed to the
// browser, which would resolve the relative Location against the dev origin
// and fetch the SPA index.html back.
const PROXY_TARGETS: Record<string, string> = {
	"/proxy/meta": "https://meta.prismlauncher.org",
	"/proxy/piston-meta": "https://piston-meta.mojang.com",
	"/proxy/piston-data": "https://piston-data.mojang.com",
	"/proxy/launcher": "https://launcher.mojang.com",
	"/proxy/resources": "https://resources.download.minecraft.net",
	"/proxy/libraries": "https://libraries.minecraft.net",
	"/proxy/maven-central": "https://repo1.maven.org",
	"/proxy/maven-central-alt": "https://repo.maven.apache.org",
	"/proxy/maven-fabricmc": "https://maven.fabricmc.net",
};

const proxy = Object.fromEntries(
	Object.entries(PROXY_TARGETS).map(([prefix, target]) => [
		prefix,
		{
			target,
			changeOrigin: true,
			followRedirects: true,
			rewrite: (path: string) => path.slice(prefix.length),
		},
	]),
);

export default defineConfig({
	plugins: [basicSsl()],
	build: {
		target: "es2022",
	},
	resolve: {
		alias: {
			// tar-stream pulls in node's "fs" (e.g. fs.constants); stub it for the browser.
			fs: "rollup-plugin-node-polyfills/polyfills/empty",
		},
	},
	server: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
		proxy,
		port: 5021,
		strictPort: true,
		host: true,
		allowedHosts: ["nyatop.internal.hgci.org", "100.64.0.10"]
	},
});
