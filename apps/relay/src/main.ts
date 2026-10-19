import { loadConfig } from "./config.js";
import { createRelay } from "./server.js";

const config = loadConfig();
const relay = await createRelay(config);
relay.server.listen(config.port, "0.0.0.0", () => {
  console.log(`Ретранслятор слушает порт ${config.port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void relay.close().then(() => process.exit(0)));
}
