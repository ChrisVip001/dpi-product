<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Activity,
  Bot,
  Clock3,
  Layers,
  Octagon,
  Play,
  Repeat,
  ShieldCheck,
  Workflow,
  Wrench,
} from "lucide-vue-next";
import type { TaskNode, TaskOutcome } from "@sdk/api";
import { jobRunDone, type JobRun } from "@sdk/jobs";
import { message } from "../client/hub";
import { agentHandle, sessionHandle, tasks } from "../client/store";
import { decide, jobDef, jobDefs, jobRuns, openAgent, pending, revealRun, startJob } from "../client/jobs";
import { inputHelp, jobSummary, jobTitle, phaseLabel } from "../client/jobText";
import { t, type Key } from "../i18n";

const error = ref("");
const stopping = ref(false);
const recent = ref<TaskOutcome[]>([]);
const inspection = ref<unknown>();

const STATUS_KEYS: Record<string, Key> = {
  running: "taskStatus.running",
  waiting: "taskStatus.waiting",
  completed: "taskStatus.completed",
  aborted: "taskStatus.aborted",
  declined: "taskStatus.declined",
  failed: "taskStatus.failed",
  pending: "taskStatus.pending",
  completing: "taskStatus.completing",
  terminal: "taskStatus.terminal",
};
const status = (value: string) => {
  const key = STATUS_KEYS[value];
  return key ? t(key) : value;
};

/** The newest run of each job, for its row in the list. */
const latest = computed(() => new Map(jobDefs.value.map((d) => [d.id, jobRuns.value.find((r) => r.job === d.id)])));

/** The device describes its jobs in English; this list shows them in the reader's language. */
const jobs = computed(() =>
  jobDefs.value.map((def) => ({
    def,
    title: jobTitle(def.id, def.title),
    summary: jobSummary(def.id, def.summary),
    phases: def.phases.map((phase) => ({
      ...phase,
      label: phaseLabel(def.id, phase.id, phase.label),
    })),
    inputs: def.inputs.map((input) => ({
      ...input,
      description: inputHelp(def.id, input.name, input.description),
    })),
  })),
);

/** The phase a run is sitting in, named in the reader's language. */
const runPhaseLabel = (run: JobRun) => {
  const phase = run.phases.find((p) => p.id === run.phase);
  return phase ? phaseLabel(run.job, phase.id, phase.label) : "";
};

/** The device labels a job task "Change watch #3": translate the job name, keep the run number. */
const jobTaskName = (job: string, label?: string) => {
  const def = jobDef(job);
  const title = jobTitle(job, def?.title ?? label ?? job);
  const run = def && label?.startsWith(def.title) ? label.slice(def.title.length).trim() : "";
  return /^#\d+$/.test(run) ? `${title} ${run}` : title;
};

// ------------------------------------------------------------------ the live task tree

type Row = { task: TaskNode & { effectiveBackground: boolean }; depth: number };
const rows = computed<Row[]>(() => {
  const all = tasks.value;
  const ids = new Set(all.map((task) => task.id));
  const children = new Map<number | undefined, typeof all>();
  for (const task of all) {
    const parent = task.owner !== undefined && ids.has(task.owner) ? task.owner : undefined;
    children.set(parent, [...(children.get(parent) ?? []), task]);
  }
  const out: Row[] = [];
  const walk = (parent: number | undefined, depth: number) => {
    for (const task of (children.get(parent) ?? []).sort((a, b) => a.id - b.id)) {
      out.push({ task, depth });
      walk(task.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
});
const kindOf = (task: TaskNode): { icon: unknown; name: string; what: string } =>
  task.kind === "pi.tool"
    ? {
        icon: Wrench,
        name: task.label ?? t("taskKind.tool"),
        what: t("taskKind.toolWhat"),
      }
    : task.kind === "pi.generation"
      ? { icon: Bot, name: t("taskKind.generation"), what: t("taskKind.generationWhat") }
      : task.kind === "pi.compaction"
        ? { icon: Layers, name: t("taskKind.compaction"), what: t("taskKind.compactionWhat") }
        : task.kind.startsWith("demo.job.")
          ? {
              icon: Workflow,
              name: jobTaskName(task.kind.slice(9), task.label),
              what: t("taskKind.jobWhat"),
            }
          : task.kind === "demo.job-approval"
            ? { icon: ShieldCheck, name: t("taskKind.approval"), what: t("taskKind.approvalWhat") }
            : { icon: Activity, name: task.label ?? task.kind, what: task.kind };
const phaseOf = (task: TaskNode) => {
  if (!task.state.phase) return "";
  if (task.kind.startsWith("demo.job.")) {
    const job = jobDef(task.kind.slice(9));
    const phase = job?.phases.find((p) => p.id === task.state.phase);
    return phase ? phaseLabel(task.kind.slice(9), phase.id, phase.label) : task.state.phase;
  }
  return task.state.phase;
};

async function stopAll() {
  if (stopping.value || !agentHandle.value) return;
  stopping.value = true;
  error.value = "";
  try {
    await agentHandle.value.abort(true);
  } catch (e) {
    error.value = message(e);
  } finally {
    stopping.value = false;
  }
}

// Recent outcomes and recovery inspection are read on demand, not streamed.
async function loadRuntime(e: Event) {
  const handle = sessionHandle.value;
  if (!(e.target as HTMLDetailsElement).open || !handle) return;
  try {
    const [r, i] = await Promise.all([handle.tasks("terminal", 40), handle.inspect()]);
    recent.value = r;
    inspection.value = i;
  } catch (err) {
    error.value = message(err);
  }
}
const outcomes = computed(() =>
  recent.value
    .filter((task) => task.state.status === "terminal")
    .slice(-12)
    .reverse(),
);
</script>

<template>
  <div class="tasks-panel">
    <div class="panel-heading">
      <h2>{{ t("tasks.title") }}</h2>
      <span class="tag">{{ t("tasks.active", { count: tasks.length }) }}</span>
    </div>
    <p v-if="error" class="message-error" role="alert">{{ error }}</p>

    <section class="task-section" :aria-label="t('tasks.jobsSection')">
      <h3><Repeat :size="18" />{{ t("tasks.jobsSection") }}</h3>
      <p class="hint">{{ t("tasks.jobsHint") }}</p>
      <p v-if="!jobDefs.length" class="task-empty">{{ t("tasks.noJobs") }}</p>
      <article v-for="job in jobs" :key="job.def.id" class="job-def" :data-job="job.def.id">
        <div class="job-def-head">
          <Workflow :size="18" />
          <strong>{{ job.title }}</strong>
          <span v-if="job.def.approval" class="tag">{{ t("tasks.needsApproval") }}</span>
          <span class="tag">{{ t("tasks.duration", { seconds: job.def.seconds }) }}</span>
        </div>
        <p>{{ job.summary }}</p>
        <ol class="job-chain" :aria-label="t('tasks.phasesLabel', { title: job.title })">
          <li v-for="(phase, i) in job.phases" :key="phase.id" :title="phase.summary">
            <span>{{ i + 1 }}</span>{{ phase.label }}<Repeat v-if="phase.kind === 'repeat'" :size="13" /><ShieldCheck
              v-if="phase.kind === 'approval'"
              :size="13"
            />
          </li>
        </ol>
        <div class="job-def-meta">
          <code v-for="input in job.inputs" :key="input.name" :title="input.description">{{ input.name }}={{ input.default }}</code>
          <code :title="t('tasks.resultPathTitle', { path: job.def.resultPath })">→ {{ job.def.resultPath }}</code>
        </div>
        <div v-if="latest.get(job.def.id)" class="job-def-last">
          <span
            >{{ t("tasks.lastRun", { run: latest.get(job.def.id)!.run }) }}
            <strong>{{ status(latest.get(job.def.id)!.status) }}</strong
            ><template v-if="!jobRunDone(latest.get(job.def.id)!)">
              {{
                t("tasks.lastRunIn", {
                  phase: runPhaseLabel(latest.get(job.def.id)!),
                })
              }}</template
            ></span
          >
          <button class="text-button" @click="revealRun(latest.get(job.def.id)!.id)">
            {{ t("tasks.showInChat") }}</button
          >
          <template v-if="latest.get(job.def.id)!.approval === 'pending'">
            <button class="primary small" :disabled="!!pending" @click="decide(latest.get(job.def.id)!, true)">
              {{ t("tasks.approve") }}</button
            ><button class="secondary" :disabled="!!pending" @click="decide(latest.get(job.def.id)!, false)">
              {{ t("tasks.decline") }}
            </button>
          </template>
        </div>
        <button class="secondary job-def-run" :disabled="!!pending || !agentHandle" @click="startJob(job.def)">
          <Play :size="16" />{{ t("tasks.run", { title: job.title }) }}
        </button>
      </article>
    </section>

    <section class="task-section" :aria-label="t('tasks.activitySection')">
      <div class="panel-heading">
        <h3>{{ t("tasks.activitySection") }}</h3>
        <Activity :size="18" />
      </div>
      <p class="hint">{{ t("tasks.activityHint") }}</p>
      <p v-if="!rows.length" class="task-empty">{{ t("tasks.nothingRunning") }}</p>
      <ul v-else class="task-tree">
        <li
          v-for="{ task, depth } in rows"
          :key="task.id"
          class="task-row"
          :style="{ '--depth': depth }"
          :data-task-kind="task.kind"
        >
          <component :is="kindOf(task).icon" :size="16" />
          <strong>{{ kindOf(task).name }}</strong>
          <span class="tag">{{ status(task.state.status) }}</span>
          <span v-if="phaseOf(task)" class="task-phase">{{ phaseOf(task) }}</span>
          <small>{{
            t(task.effectiveBackground ? "tasks.taskMetaBackground" : "tasks.taskMeta", {
              id: task.id,
              what: kindOf(task).what,
              agent: task.conversationId,
            })
          }}</small>
          <button v-for="cid in task.conversations" :key="cid" class="text-button" @click="openAgent(cid)">
            {{ t("tasks.openAgent", { id: cid }) }}
          </button>
        </li>
      </ul>
      <p class="hint">{{ t("tasks.interruptHint") }}</p>
      <button class="secondary danger" :disabled="!tasks.length || stopping" @click="stopAll">
        <Octagon :size="18" />{{ t("tasks.stopAll") }}
      </button>
    </section>

    <details class="raw task-section" @toggle="loadRuntime">
      <summary><Clock3 :size="18" />{{ t("tasks.runtime") }}</summary>
      <p class="hint">{{ t("tasks.runtimeHint") }}</p>
      <details v-for="task in outcomes" :key="task.id" class="raw">
        <summary>
          {{ task.kind }} #{{ task.id }}<span>{{ status(task.state.outcome?.status ?? task.state.status) }}</span>
        </summary>
        <pre>{{ JSON.stringify(task.state.outcome, null, 2) }}</pre>
      </details>
      <details class="raw">
        <summary>{{ t("tasks.recovery") }}</summary>
        <pre>{{ JSON.stringify(inspection, null, 2) }}</pre>
      </details>
    </details>
  </div>
</template>
