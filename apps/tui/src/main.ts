// tui: a terminal client for one DPI device.
//   tui <device>[:<session>[:<agent>]]        device from ~/.dpi/network.sqlite (seeded from dpi-network.yaml)
//   tui --url <url> --token <token> [--save <id>]
//   tui mac-mini --new triage                 create a session (in the device's first start dir) and attach
import { parseArgs } from "node:util";
import { DpiClient } from "../../sdk/src/client.ts";
import { isDpiError } from "../../sdk/src/errors.ts";
import { NetworkRegistry } from "../../sdk/src/node/registry.ts";
import { syncConfigToRegistry, tryLoadNetworkConfig } from "../../sdk/src/node/config.ts";
import { App, type DeviceRef } from "./app.ts";
import { t } from "./i18n.ts";

const USAGE = t("main.usage");

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    save: { type: "string" },
    session: { type: "string", short: "s" },
    agent: { type: "string", short: "a" },
    new: { type: "string" },
    cwd: { type: "string" },
    model: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const registry = new NetworkRegistry();
const config = tryLoadNetworkConfig(process.env.INIT_CWD ?? process.cwd());
if (config) syncConfigToRegistry(config, registry);

const url = values.url ?? process.env.DPI_URL;
const [deviceRef = "", sessionRef = values.session, agentRef = values.agent] = (
  positionals[0] ?? (url ? "" : (process.env.DPI_DEVICE ?? ""))
).split(":");

let device: DeviceRef;
if (url) {
  const token = values.token ?? process.env.DPI_TOKEN ?? "";
  if (!token) fail(t("main.needToken"));
  device = { id: values.save ?? "adhoc", name: values.save ?? new URL(url).host, url: url.replace(/\/+$/, ""), token };
} else {
  const known = registry.list().map((d) => d.id);
  if (!deviceRef)
    fail(t("main.noDevice", { usage: USAGE, devices: known.join(", ") || t("main.none") }));
  const row = registry.get(deviceRef);
  if (!row)
    fail(t("main.unknownDevice", { id: deviceRef, devices: known.join(", ") || t("main.noneKnown") }));
  if (!row.token) fail(t("main.noToken", { id: row.id }));
  device = { id: row.id, name: row.name, url: row.url, token: row.token };
}

const client = new DpiClient(device.url, device.token);
const info = await client.device({ timeoutMs: 8000 }).catch((e: unknown) =>
  fail(
    isDpiError(e) && e.code === "unauthorized"
      ? t("main.tokenRejected", { id: device.id, url: device.url })
      : t("main.offline", { id: device.id, url: device.url, message: (e as Error).message }),
  ),
);
if (values.save && url)
  registry.upsert({ id: values.save, name: values.save, url: device.url, kind: "url", source: "ui", token: device.token });

let session = sessionRef;
if (values.new) {
  const cwd = values.cwd ?? (await client.dirs("")).dirs[0]?.path;
  if (!cwd) fail(t("main.noStartDirs", { id: device.id }));
  const modelId = values.model ?? info.defaultModel;
  const model = info.models.find((m) => m.id === modelId);
  if (!model)
    fail(t("main.unknownModel", { id: modelId, models: info.models.map((m) => m.id).join(", ") }));
  const created = await client
    .createSession({ name: values.new, cwd, model: { provider: model.provider, modelId: model.id } })
    .catch((e: Error) => fail(t("main.createFailed", { message: e.message })));
  session = created.id;
}

const app = new App(device, client, info, registry);
await app.open(session, agentRef);
