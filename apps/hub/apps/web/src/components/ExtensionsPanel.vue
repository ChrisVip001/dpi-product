<script setup lang="ts">
// Custom harness extensions for the selected agent: a switch per extension, and for system-prompts a checklist of
// built-in prompts. A change edits the agent's stored selection, so the next request runs with it.
import { ref, shallowRef, watch } from "vue";
import { Puzzle } from "lucide-vue-next";
import type { AgentExtensions } from "@sdk/api";
import { agentHandle, agentState, attempt, online, refreshDetail } from "../client/store";
import { t } from "../i18n";

const data = shallowRef<AgentExtensions>();
const busy = ref(false);

async function load() {
  const handle = agentHandle.value;
  if (!handle || !online.value) return void (data.value = undefined);
  data.value = (await handle.extensions().catch(() => undefined)) ?? data.value;
}
// Reload on a new selection, and when the agent's stored extension selection changes from any client.
watch([agentHandle, online, () => JSON.stringify(agentState.value.agent.extensions ?? null)], load, { immediate: true });

async function set(patch: { name: string; enabled: boolean } | { prompt: string; enabled: boolean }) {
  const handle = agentHandle.value;
  if (!handle || busy.value) return;
  busy.value = true;
  try {
    const next = await attempt(() => handle.setExtension(patch));
    if (next) data.value = next;
    void refreshDetail();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="extensions-panel">
    <div class="panel-heading">
      <h2>{{ t("extensions.title") }}</h2>
      <Puzzle :size="18" />
    </div>
    <p class="hint">{{ t("extensions.hint") }}</p>
    <p v-if="!data" class="task-empty">{{ t("extensions.loading") }}</p>
    <article
      v-for="ext in data?.extensions ?? []"
      :key="ext.name"
      class="ext-card"
      :class="{ on: ext.enabled }"
      :data-extension="ext.name"
    >
      <div class="ext-head">
        <div>
          <strong>{{ ext.title }}</strong>
          <code>{{ ext.name }}</code>
        </div>
        <button
          class="switch"
          role="switch"
          :class="{ on: ext.enabled }"
          :aria-checked="ext.enabled"
          :aria-label="ext.title"
          :disabled="busy"
          @click="set({ name: ext.name, enabled: !ext.enabled })"
        >
          <span />
        </button>
      </div>
      <p>{{ ext.description }}</p>
      <ul v-if="ext.prompts" class="ext-prompts" :class="{ off: !ext.enabled }">
        <li v-for="p in ext.prompts" :key="p.id">
          <label>
            <input
              type="checkbox"
              :checked="p.enabled"
              :disabled="busy"
              @change="set({ prompt: p.id, enabled: ($event.target as HTMLInputElement).checked })"
            />
            <code>{{ p.id }}</code>
          </label>
          <span>{{ p.description }}</span>
          <details>
            <summary>{{ t("extensions.viewPrompt") }}</summary>
            <pre>{{ p.text }}</pre>
          </details>
        </li>
      </ul>
    </article>
  </div>
</template>
