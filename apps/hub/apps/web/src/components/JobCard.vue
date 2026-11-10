<script setup lang="ts">
// One durable job run, live: its named phases as a stepper, every step each phase took (commands, a subagent's
// tool calls, App State writes, checkpoints), the approval when it waits, and how it is owned.
import { computed, h, type FunctionalComponent } from "vue";
import {
  Bot,
  Braces,
  Check,
  Flag,
  Hand,
  ListChecks,
  LoaderCircle,
  Octagon,
  Repeat,
  ShieldCheck,
  Terminal,
  Workflow,
  Wrench,
  X,
} from "lucide-vue-next";
import { jobRunDone, type JobPhaseRun, type JobRun, type JobStep } from "@sdk/jobs";
import { decide, jobDef, now, openAgent, pending, seconds, stopRun } from "../client/jobs";
import { jobSummary, jobTitle, phaseLabel, phaseSummary } from "../client/jobText";
import { t, type Key } from "../i18n";

const props = defineProps<{ run: JobRun }>();
const def = computed(() => jobDef(props.run.job));
const done = computed(() => jobRunDone(props.run));
const elapsed = computed(() => seconds((props.run.endedAt ?? now.value) - props.run.startedAt));

// The run record carries the device's English words; known jobs and phases speak this client's language.
const title = computed(() => jobTitle(props.run.job, props.run.title));
const label = (phase: JobPhaseRun) => phaseLabel(props.run.job, phase.id, phase.label);
/** The definition's description of a phase, in the reader's language. */
const about = (id: string) => {
  const phase = def.value?.phases.find((p) => p.id === id);
  return phase ? phaseSummary(props.run.job, id, phase.summary) : undefined;
};
const STATUS_KEYS: Record<JobRun["status"], Key> = {
  running: "taskStatus.running",
  waiting: "taskStatus.waiting",
  completed: "taskStatus.completed",
  failed: "taskStatus.failed",
  aborted: "taskStatus.aborted",
  declined: "taskStatus.declined",
};
const statusText = (status: JobRun["status"]) => t(STATUS_KEYS[status]);
const stepIcon = { command: Terminal, tool: Wrench, agent: Bot, state: Braces, approval: ShieldCheck, checkpoint: Flag, note: ListChecks };
const stepTitle = (step: JobStep) =>
  step.kind === "tool" ? t("job.stepToolTitle", { label: step.label }) : step.label;

/** One step: what kind, what ran, how it ended, how long it took. */
const JobStepLine: FunctionalComponent<{ step: JobStep }> = (p) => {
  const step = p.step;
  const label = ["command", "tool", "state"].includes(step.kind)
    ? h("code", { title: stepTitle(step) }, step.label)
    : h("span", { class: "job-step-text" }, step.label);
  const state =
    step.status === "running"
      ? h(LoaderCircle, { size: 15, class: "spin" })
      : step.status === "done"
        ? h(Check, { size: 15 })
        : step.status === "waiting"
          ? h(Hand, { size: 15 })
          : h(X, { size: 15 });
  return [
    h(stepIcon[step.kind], { size: 16, class: "job-step-kind" }),
    label,
    step.kind === "tool" && step.detail ? h("span", { class: "job-step-args", title: step.detail }, step.detail) : null,
    h("span", { class: "job-step-state" }, [state, step.ms !== undefined && step.kind !== "note" ? h("span", seconds(step.ms)) : null]),
  ];
};
JobStepLine.props = ["step"];
const phaseTime = (p: JobPhaseRun) =>
  p.startedAt ? seconds((p.endedAt ?? (p.status === "running" || p.status === "waiting" ? now.value : p.startedAt)) - p.startedAt) : "";
const open = (p: JobPhaseRun) => p.status !== "pending" && p.status !== "skipped";
const inputs = computed(() => Object.entries(props.run.input));
const approvalPhase = computed(() => props.run.phases.find((p) => p.status === "waiting"));
</script>

<template>
  <article
    class="job-run"
    :class="`is-${run.status}`"
    :data-job-run="run.id"
    :aria-label="t('job.runLabel', { title, run: run.run, status: statusText(run.status) })"
  >
    <header class="job-run-head">
      <span class="job-run-icon"><Workflow :size="22" /></span>
      <div class="job-run-titles">
        <div class="job-run-eyebrow">
          <span>{{ t("job.eyebrow") }}</span>
          <span class="job-run-repeat"
            ><Repeat :size="15" />{{ t("job.repeatable", { run: run.run }) }}</span
          >
        </div>
        <h3>{{ title }}</h3>
      </div>
      <span class="job-run-status" :class="run.status"><i />{{ statusText(run.status) }}</span>
    </header>
    <p v-if="def" class="job-run-about">
      {{ jobSummary(run.job, def.summary) }}
    </p>
    <div class="job-run-meta">
      <span>{{ t("job.taskNumber", { id: run.id }) }}</span>
      <span>{{ run.startedBy === "agent" ? t("job.startedByAgent") : t("job.startedByYou") }}</span>
      <span>{{ elapsed }}</span>
      <span v-for="[k, v] in inputs" :key="k" class="job-run-input">{{ k }}={{ v }}</span>
      <span v-if="run.resumed" class="job-run-resumed">{{
        t("job.resumed", { count: run.resumed })
      }}</span>
    </div>

    <ol class="job-stepper" :aria-label="t('job.phases')">
      <li
        v-for="(phase, i) in run.phases"
        :key="phase.id"
        :class="`ph-${phase.status}`"
        :aria-current="run.phase === phase.id && !done ? 'step' : undefined"
      >
        <span class="job-chip"><span class="job-step-dot">
          <Check v-if="phase.status === 'done'" :size="15" />
          <LoaderCircle v-else-if="phase.status === 'running'" :size="15" class="spin" />
          <Hand v-else-if="phase.status === 'waiting'" :size="15" />
          <X v-else-if="['failed', 'aborted'].includes(phase.status)" :size="15" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <span class="job-step-label">{{ label(phase) }}</span>
        <span v-if="phase.progress" class="job-step-progress">{{ phase.progress.done }}/{{ phase.progress.total }}</span></span>
      </li>
    </ol>

    <div class="job-phases">
      <details v-for="(phase, i) in run.phases" :key="phase.id" class="job-phase" :class="`ph-${phase.status}`" :open="open(phase)">
        <summary>
          <span class="job-phase-n">{{ i + 1 }}</span>
          <strong>{{ label(phase) }}</strong>
          <span class="job-phase-summary">{{
            phase.summary ??
            (phase.status === "pending"
              ? about(phase.id)
              : phase.status === "skipped"
                ? t("job.skipped")
                : "")
          }}</span>
          <span class="job-phase-time">{{ phaseTime(phase) }}</span>
        </summary>
        <p v-if="phase.status !== 'done'" class="job-phase-about">
          {{ about(phase.id) }}
        </p>
        <ul v-if="phase.steps.length" class="job-steps">
          <li v-for="step in phase.steps" :key="step.id" :class="[`k-${step.kind}`, `st-${step.status}`]">
            <details v-if="step.detail && step.kind !== 'tool'" :open="step.status === 'error'">
              <summary><JobStepLine :step="step" /></summary>
              <pre>{{ step.detail }}</pre>
            </details>
            <div v-else class="job-step-line"><JobStepLine :step="step" /></div>
            <button
              v-if="step.kind === 'agent' && step.conversationId"
              class="text-button job-step-link"
              @click="openAgent(step.conversationId)"
            >
              {{ t("job.openSubagent", { id: step.conversationId }) }}
            </button>
          </li>
        </ul>
        <p v-else-if="phase.status === 'pending'" class="job-phase-empty">{{ t("job.notStarted") }}</p>
      </details>
    </div>

    <div v-if="run.approval === 'pending'" class="job-approval" role="group" :aria-label="t('job.approvalGroup')">
      <div><ShieldCheck :size="20" /><strong>{{ t("job.approveToContinue") }}</strong></div>
      <p>
        {{
          t("job.approvalBody", {
            summary: (approvalPhase && about(approvalPhase.id)) || t("job.waitingForYou"),
          })
        }}
      </p>
      <div class="job-approval-buttons">
        <button class="primary small" :disabled="!!pending" @click="decide(run, true)"
          ><Check :size="18" />{{ t("job.approveAndContinue") }}</button
        >
        <button class="secondary" :disabled="!!pending" @click="decide(run, false)">
          {{ t("tasks.decline") }}
        </button>
      </div>
    </div>
    <p v-if="run.error && run.status !== 'aborted'" class="message-error">{{ run.error }}</p>

    <footer class="job-run-foot">
      <span
        >{{ run.background ? t("job.backgroundFoot") : t("job.foregroundFoot") }}
        {{ t("job.checkpointFoot") }}</span
      >
      <button v-if="!done" class="secondary danger" :disabled="!!pending" @click="stopRun(run)"
        ><Octagon :size="16" />{{ t("job.stop") }}</button
      >
    </footer>
  </article>
</template>
