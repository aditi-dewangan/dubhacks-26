import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  envDir: "../..", // read the repo-root .env
  server: { port: 5173, host: true },
});
