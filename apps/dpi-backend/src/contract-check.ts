// Compile-time proof that the device can still render every conversation the runtime reports.
// `pi-durable` 1.5 removed its agent events; the wire is now derived from the conversation view, so the
// mapping in view-wire.ts is what has to keep fitting the SDK contract.
import type { ConversationView } from "@earendil-works/pi-durable";
import type { WireSnapshotEvent, WireViewUpdate } from "../../dpi-sdk/src/api.js";
import { snapshotOf, ViewDiffer } from "./view-wire.js";

export const snapshotFits = (view: ConversationView): WireSnapshotEvent => snapshotOf(view);

/** The differ must only ever produce the two payloads the agent stream can send. */
export const differFits = (
  differ: ViewDiffer,
  view: ConversationView,
): { full: WireSnapshotEvent } | { update: WireViewUpdate } | undefined => differ.next(view);
