import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const webRoot = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(webRoot, "../dist/web");

export default defineConfig({
  root: webRoot,
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    outDir,
    emptyOutDir: true,
    minify: "esbuild",
    sourcemap: false,
    target: "es2022",
    cssCodeSplit: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve(webRoot, "workbench.html"),
    },
  },
});
