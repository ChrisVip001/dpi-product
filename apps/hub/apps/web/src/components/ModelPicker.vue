<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, X } from "lucide-vue-next";
import type { ModelInfo } from "@sdk/api";
import {
  agentHandle,
  agentState,
  attempt,
  device,
  icon,
  models,
  notify,
  number,
  refreshDetail,
} from "../client/store";
import { t } from "../i18n";

const emit = defineEmits<{ close: [] }>();
const search = ref("");
const filtered = computed(() =>
  models.value.filter((m) =>
    `${m.name} ${m.id} ${m.tier}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const isCurrent = (m: ModelInfo) =>
  m.id === agentState.value.agent.model?.modelId &&
  m.provider === agentState.value.agent.model?.provider;

async function choose(m: ModelInfo) {
  const done = await attempt(() =>
    agentHandle.value!.configure({ model: { provider: m.provider, modelId: m.id } }),
  );
  if (done) {
    await refreshDetail();
    notify(t("models.saved"));
    emit("close");
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal model-modal">
      <header>
        <div>
          <span class="eyebrow">{{ t("models.eyebrow", { device: device?.id ?? "" }) }}</span>
          <h2>{{ t("models.title") }}</h2>
        </div>
        <button class="icon-button" :aria-label="t('models.close')" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>
      <input
        v-model="search"
        :placeholder="t('models.search')"
        :aria-label="t('models.searchLabel')"
      />
      <div class="model-list">
        <button
          v-for="m in filtered"
          :key="`${m.provider}/${m.id}`"
          :class="{ selected: isCurrent(m) }"
          @click="choose(m)"
        >
          <img :src="icon(m.id)" alt="" />
          <div>
            <strong>{{ m.name }}</strong
            ><small
              >{{ m.tier }} / {{ m.provider }} /
              {{ t("models.context", { window: number(m.contextWindow) }) }}</small
            >
          </div>
          <Check v-if="isCurrent(m)" :size="18" />
        </button>
      </div>
      <p class="hint">{{ t("models.footnote", { device: device?.id ?? "" }) }}</p>
    </section>
  </div>
</template>
