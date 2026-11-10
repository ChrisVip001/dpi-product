<script setup lang="ts">
// What the device says about its own health: how long it has been up, how its tools behaved, how many tasks are live and
// what state they are in, how long finished ones took, and the failures the runtime reported. Read from `/v1/runtime`,
// which only touches memory and the open sessions' task records, so polling it is cheap.
import { computed, onUnmounted, ref, watch } from "vue";
import { Gauge } from "lucide-vue-next";
import type { WireRuntime } from "@sdk/api";
import { client, online } from "../client/store";
import { message } from "../client/hub";
import { t } from "../i18n";

const data = ref<WireRuntime>();
const failure = ref("");
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  const device = client.value;
  if (!device || !online.value) {
    data.value = undefined;
    return;
  }
  try {
    data.value = await device.runtime();
    failure.value = "";
  } catch (e) {
    failure.value = t("runtime.error", { message: message(e) });
  }
}

function poll(on: boolean) {
  if (timer) clearInterval(timer);
  timer = on ? setInterval(load, 5000) : undefined;
}

watch([client, online], () => {
  void load();
  poll(!!client.value && online.value);
}, { immediate: true });
onUnmounted(() => poll(false));

/** Milliseconds as something a person reads: 820 ms, 4.2 s, 1m 20s. */
function span(ms: number) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const calls = computed(() => data.value?.counters["pi.tool.calls"] ?? 0);
const failedCalls = computed(() => data.value?.counters["pi.tool.errors"] ?? 0);
const running = computed(() => data.value?.sessions.reduce((n, s) => n + (s.byState.running ?? 0), 0) ?? 0);
const sleeping = computed(() => data.value?.sessions.reduce((n, s) => n + (s.byState.sleeping ?? 0), 0) ?? 0);
const waiting = computed(() => data.value?.sessions.reduce((n, s) => n + (s.byState.waiting ?? 0), 0) ?? 0);
/** The slowest finished task across the open sessions: what a person means by "how long does this take". */
const slowest = computed(() => Math.max(0, ...(data.value?.sessions.map((s) => s.durations.maxMs) ?? [0])));
const average = computed(() => {
  const done = data.value?.sessions.filter((s) => s.durations.count > 0) ?? [];
  const total = done.reduce((sum, s) => sum + s.durations.avgMs * s.durations.count, 0);
  const count = done.reduce((sum, s) => sum + s.durations.count, 0);
  return count ? total / count : 0;
});
</script>

<template>
  <div class="runtime-panel">
    <div class="panel-heading">
      <h2>{{ t("runtime.title") }}</h2>
      <Gauge :size="18" />
    </div>
    <p v-if="failure" class="runtime-error">{{ failure }}</p>
    <p v-else-if="!data" class="task-empty">{{ t("runtime.checking") }}</p>
    <template v-else>
      <div class="runtime-grid">
        <div class="runtime-cell">
          <span>{{ t("runtime.uptime") }}</span>
          <strong>{{ span(data.uptimeMs) }}</strong>
        </div>
        <div class="runtime-cell">
          <span>{{ t("runtime.calls") }}</span>
          <strong>{{ calls }}<em v-if="failedCalls"> · {{ t("runtime.failedCalls", { n: failedCalls }) }}</em></strong>
        </div>
        <div class="runtime-cell">
          <span>{{ t("runtime.tasks") }}</span>
          <strong>{{ t("runtime.taskMix", { running, sleeping, waiting }) }}</strong>
        </div>
        <div class="runtime-cell">
          <span>{{ t("runtime.duration") }}</span>
          <strong>{{ t("runtime.durationValues", { avg: span(average), max: span(slowest) }) }}</strong>
        </div>
      </div>
      <p v-if="data.restarts" class="runtime-note">{{ t("runtime.restarts", { n: data.restarts }) }}</p>
      <p v-if="data.storageFailed" class="runtime-error">{{ t("runtime.storageFailed") }}</p>
      <ul v-if="data.sessions.length" class="runtime-sessions">
        <li v-for="session in data.sessions" :key="session.id">
          <code>#{{ session.id }}</code>
          <span>{{ t("runtime.sessionMix", {
            running: session.byState.running ?? 0,
            sleeping: session.byState.sleeping ?? 0,
            waiting: session.byState.waiting ?? 0,
          }) }}</span>
          <span v-if="session.durations.count">
            {{ t("runtime.sessionDuration", { avg: span(session.durations.avgMs), n: session.durations.count }) }}
          </span>
          <span v-if="session.error" class="runtime-error">{{ session.error }}</span>
        </li>
      </ul>
      <p v-else class="task-empty">{{ t("runtime.empty") }}</p>
    </template>
  </div>
</template>

<style scoped>
.runtime-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}
.runtime-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.runtime-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-2);
}
.runtime-cell span {
  font-size: 11px;
  color: var(--muted);
}
.runtime-cell strong {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.runtime-cell em {
  font-style: normal;
  color: var(--muted);
}
.runtime-sessions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.runtime-sessions li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}
.runtime-note {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.runtime-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger, #c2410c);
}
</style>
