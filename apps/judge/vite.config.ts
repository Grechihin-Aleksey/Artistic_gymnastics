import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const server = process.env.SERVER_URL ?? "http://localhost:3000";

// Страницы раздаёт сервер в зале по адресу /judge, API на том же адресе.
export default defineConfig({
  base: "/judge/",
  plugins: [react()],
  server: {
    proxy: {
      "^/(competitions|performances|marks|me|judges)": server,
      "/socket.io": { target: server, ws: true },
    },
  },
  test: {
    environment: "jsdom",
  },
});
