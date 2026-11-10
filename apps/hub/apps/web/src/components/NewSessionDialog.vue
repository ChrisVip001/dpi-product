<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Plus, X } from "lucide-vue-next";
import DirBrowser from "./DirBrowser.vue";
import { deviceClient, message } from "../client/hub";
import { network, notify, select } from "../client/store";
import { t } from "../i18n";

const props = defineProps<{ deviceId?: string }>();
const emit = defineEmits<{ close: [] }>();

const devices = computed(() => network.devices.value.filter((d) => d.status === "online"));
const deviceId = ref(
  devices.value.find((d) => d.id === props.deviceId)?.id ?? devices.value[0]?.id ?? "",
);
const device = computed(() => devices.value.find((d) => d.id === deviceId.value));
const models = computed(() => device.value?.info?.models ?? []);
const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
const draft = ref({ name: "", cwd: "", model: "" });
const pending = ref(false);
const error = ref("");

watch(
  device,
  (d) => {
    const fallback =
      d?.info?.models.find((m) => m.id === d.info?.defaultModel) ?? d?.info?.models[0];
    draft.value.model = fallback ? key(fallback) : "";
    draft.value.cwd = "";
  },
  { immediate: true },
);

async function create() {
  if (pending.value || !device.value) return;
  pending.value = true;
  error.value = "";
  try {
    const model = models.value.find((m) => key(m) === draft.value.model);
    if (!model) throw Error(t("newSession.chooseModel"));
    const created = await deviceClient(device.value.id).createSession({
      name: draft.value.name.trim() || t("newSession.defaultName"),
      cwd: draft.value.cwd.trim(),
      model: { provider: model.provider, modelId: model.id },
    });
    const root = created.agents.find((a) => a.kind === "root") ?? created.agents[0];
    select({ deviceId: device.value.id, sessionId: created.id, agentId: root?.id ?? 1 });
    notify(t("newSession.created", { device: device.value.id }));
    emit("close");
  } catch (e) {
    error.value = message(e);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <form class="modal session-modal" @submit.prevent="create">
      <header>
        <div>
          <span class="eyebrow">{{ t("newSession.eyebrow") }}</span>
          <h2>{{ t("newSession.title") }}</h2>
        </div>
        <button
          type="button"
          class="icon-button"
          :aria-label="t('newSession.close')"
          @click="emit('close')"
        >
          <X :size="18" />
        </button>
      </header>
      <p v-if="!devices.length" class="message-error">{{ t("newSession.noDevice") }}</p>
      <template v-else>
        <label
          >{{ t("newSession.device")
          }}<select v-model="deviceId" :aria-label="t('newSession.device')">
            <option v-for="d in devices" :key="d.id" :value="d.id">
              {{ d.id }} · {{ d.info?.hostname ?? d.url }}
            </option>
          </select></label
        >
        <label
          >{{ t("newSession.name")
          }}<input
            v-model="draft.name"
            autofocus
            :placeholder="t('newSession.namePlaceholder')"
            maxlength="100"
        /></label>
        <div class="field">
          <span>{{ t("newSession.workdir", { device: deviceId }) }}</span>
          <DirBrowser v-model="draft.cwd" :device-id="deviceId" />
        </div>
        <label
          >{{ t("newSession.model")
          }}<select v-model="draft.model" :aria-label="t('newSession.modelLabel')">
            <option v-for="m in models" :key="key(m)" :value="key(m)">
              {{ m.tier }} / {{ m.name }}
            </option>
          </select></label
        >
      </template>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="secondary" @click="emit('close')">
          {{ t("common.cancel") }}</button
        ><button class="primary" :disabled="pending || !draft.model || !draft.cwd || !device">
          <Plus :size="18" />{{ pending ? t("newSession.creating") : t("newSession.create") }}
        </button>
      </footer>
    </form>
  </div>
</template>
