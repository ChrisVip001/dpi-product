// Job definitions arrive from the device in English: title, summary, phase names and input help are part of the
// wire, not of this client. The words on screen are still ours, so the jobs we ship are translated by id and
// anything a device adds later keeps the device's own text instead of showing a bare key.
import { t, type Key } from "../i18n";
import { catalog } from "../i18n/catalog";

const camel = (id: string) => id.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/** A translated word when the catalog knows this id, else what the device sent. */
const pick = (key: string, fallback: string) =>
  key in catalog.en ? t(key as Key) : fallback;

export const jobTitle = (job: string, fallback: string) => pick(`jobdef.${camel(job)}.title`, fallback);

export const jobSummary = (job: string, fallback: string) =>
  pick(`jobdef.${camel(job)}.summary`, fallback);

export const phaseLabel = (job: string, phase: string, fallback: string) =>
  pick(`jobdef.${camel(job)}.phase.${phase}.label`, fallback);

export const phaseSummary = (job: string, phase: string, fallback: string) =>
  pick(`jobdef.${camel(job)}.phase.${phase}.summary`, fallback);

export const inputHelp = (job: string, input: string, fallback: string) =>
  pick(`jobdef.${camel(job)}.input.${camel(input)}`, fallback);
