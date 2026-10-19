import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const server = process.env.SERVER_URL ?? "http://localhost:3000";

// Табло раздаёт сервер в зале по адресу /board, API на том же адресе.
export default defineConfig({
  base: "/board/",
  plugins: [react()],
  server: {
    proxy: {
      "^/competitions": server,
      "/socket.io": { target: server, ws: true },
    },
  },
  test: {
    environment: "jsdom",
  },
});
