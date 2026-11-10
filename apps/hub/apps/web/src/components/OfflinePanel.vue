<script setup lang="ts">
import { computed, ref } from "vue";
import { Copy, RefreshCw, ShieldAlert, WifiOff, Loader } from "lucide-vue-next";
import type { NetworkDevice } from "@sdk/api";
import { hub, message } from "../client/hub";
import { ago, notify } from "../client/store";
import { t } from "../i18n";

const props = defineProps<{ device: NetworkDevice }>();
const busy = ref(false);
const error = ref("");

/** The exact fix for this device's state. Device setup happens in the terminal, never in this UI. */
const fix = computed(() => {
  const d = props.device;
  const config = d.source === "config";
  switch (d.status) {
    case "checking":
      return {
        title: t("offline.checkingTitle", { id: d.id }),
        text: t("offline.checkingText"),
      };
    case "unauthorized":
      return {
        title: d.hasToken
          ? t("offline.rejectedTokenTitle", { id: d.id })
          : t("offline.noTokenTitle", { id: d.id }),
        text: d.hasToken ? t("offline.rejectedTokenText") : t("offline.noTokenText"),
        command:
          config && d.kind !== "url"
            ? `just net register ${d.id}`
            : `just net register ${d.id} --token <token>`,
      };
    case "mismatch":
      return {
        title: t("offline.mismatchTitle", { id: d.id }),
        text: t("offline.mismatchText"),
        command:
          d.kind === "url"
            ? `just net register ${d.id} --token <token>`
            : `just net register ${d.id}`,
      };
    case "incompatible":
      return {
        title: t("offline.incompatibleTitle", { id: d.id }),
        text: t("offline.incompatibleText"),
        command: config ? `just net deploy ${d.id}` : undefined,
      };
    default:
      return {
        title: t("offline.offlineTitle", { id: d.id }),
        text: t("offline.offlineText", { ago: ago(d.lastSeenAt) }),
        command: !config
          ? undefined
          : d.kind === "local"
            ? "just backend run"
            : d.kind === "url"
              ? undefined
              : `just net restart ${d.id}`,
        alt: config && d.kind !== "local" && d.kind !== "url" ? `just net up ${d.id}` : undefined,
      };
  }
});

async function check() {
  busy.value = true;
  error.value = "";
  try {
    const d = await hub.check(props.device.id);
    if (d.status === "online") notify(t("offline.onlineToast", { id: d.id }));
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(t("common.copied"));
  } catch {
    notify(t("common.copyFailed"));
  }
}
</script>

<template>
  <section class="chat-panel offline-panel" :class="device.status" aria-live="polite">
    <div class="chat-empty">
      <Loader v-if="device.status === 'checking'" class="spin" :size="30" />
      <ShieldAlert
        v-else-if="device.status === 'mismatch' || device.status === 'unauthorized'"
        :size="30"
      />
      <WifiOff v-else :size="30" />
      <span class="eyebrow">{{ device.kind.toUpperCase() }} · {{ device.url }}</span>
      <h2>{{ fix.title }}</h2>
      <p>{{ fix.text }}</p>
      <p v-if="device.error" class="hint offline-error">{{ device.error }}</p>
      <div v-if="fix.command" class="offline-command">
        <code>{{ fix.command }}</code>
        <button class="icon-button" :aria-label="t('common.copyCommand')" @click="copy(fix.command)">
          <Copy :size="18" />
        </button>
      </div>
      <p v-if="fix.command" class="hint">{{ t("offline.runHint") }}</p>
      <p v-if="fix.alt" class="hint">
        {{ t("offline.altBefore") }} <code>{{ fix.alt }}</code> {{ t("offline.altAfter") }}
      </p>
      <div class="offline-actions">
        <button class="secondary" :disabled="busy" @click="check()">
          <RefreshCw :size="18" />{{ busy ? t("common.checking") : t("offline.checkNow") }}
        </button>
      </div>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>
