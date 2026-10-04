import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri expects a fixed port and never falls back to another one, so the dev
// server must fail loudly rather than silently drift to 1421.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Tauri drives the build; Vite should not clear the screen on top of it.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // src-tauri is watched by the Rust side, not by Vite.
      ignored: ["**/src-tauri/**", "**/target/**", "**/.build-tmp/**"],
    },
  },

  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Windows uses the WebView2 (Chromium) engine; other platforms use WebKit.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome110" : "safari14",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/language",
            "@codemirror/commands",
            "@codemirror/search",
            "@codemirror/autocomplete",
            "@codemirror/lang-sql",
          ],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
