import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const server = process.env.SERVER_URL ?? "http://localhost:3000";

// Табло раздаёт сервер в зале по адресу /board/, а ретранслятор на сайте — по адресу /widget/.
// Пути к файлам относительные, поэтому одна сборка работает в обоих местах.
export default defineConfig({
  base: "./",
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
