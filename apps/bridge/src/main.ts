// bridge: one public endpoint a chat platform can call, one signed hook per chat on a device.
//   npm start -- --config bridge.yaml
import { createServer } from "node:http";
import { configPath, loadConfig } from "./config.js";
import { bridgeApp } from "./routes.js";

const file = configPath();
const config = loadConfig(file);
const server = createServer(bridgeApp(config));

server.listen(config.listen.port, config.listen.host, () => {
  const chats = Object.entries(config.routes).map(([chat, hook]) => `${chat}→${hook}`);
  console.log(`[bridge] config ${file}`);
  console.log(`[bridge] listening on http://${config.listen.host}:${config.listen.port}${config.listen.path}`);
  console.log(`[bridge] device ${config.device.url}  hooks: ${Object.keys(config.device.hooks).join(", ")}`);
  console.log(`[bridge] state ${config.state.file}`);
  console.log(`[bridge] chats: ${chats.join(", ") || "none — every chat is ignored"}`);
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
