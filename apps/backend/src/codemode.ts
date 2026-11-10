// Multi-step work the model writes as one script, run in a sandbox, replayable after a restart.
//
// A prompt that needs eight reads costs eight round trips, and a crash in the middle restarts the whole plan. Code mode
// turns that into one tool call: the model writes `const rows = await Promise.all(paths.map((p) => tools.read({ path: p })))`
// and the harness runs it, journaling every nested result so a restart resumes the script instead of repeating it.
//
// It is opt-in (`DPI_CODEMODE=on`), because it adds a tool with a wide reach and pulls in a QuickJS wasm runtime. The
// module is imported lazily for the same reason: a device that does not use it never loads either.

import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

export type Codemode = ReturnType<typeof createCodemode>;

export function createCodemode() {
  // A worker thread per script keeps a spinning one off the event loop, which is why the Node sandbox is the default.
  const sandbox = new CodemodeSandbox();
  return {
    sandbox,
    extension: createCodemodeExtension({ sandbox }),
    close: () => sandbox.close(),
  };
}
