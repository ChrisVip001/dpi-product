<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  Check,
  CircleHelp,
  Info,
  Languages,
  Network,
  PanelLeft,
  PanelRight,
  Plus,
  X,
  Database,
  GitFork,
  Activity,
} from "lucide-vue-next";
import NetworkSidebar from "./components/NetworkSidebar.vue";
import AgentView from "./components/AgentView.vue";
import Inspector from "./components/Inspector.vue";
import OfflinePanel from "./components/OfflinePanel.vue";
import NewSessionDialog from "./components/NewSessionDialog.vue";
import PromptDialog from "./components/PromptDialog.vue";
import ModelPicker from "./components/ModelPicker.vue";
import { LOCALES, LOCALE_NAMES, forced, locale, setLocale, t, type Key, type Locale } from "./i18n";
import {
  attempt,
  boot,
  busy,
  device,
  interrupt,
  network,
  notify,
  online,
  select,
  selected,
  sessionHandle,
  stream,
  streamState,
  treeWidth,
  ui,
  layout,
  showInspector,
  hideInspector,
  panelHotkey,
  toggleTree,
  toggleInspector,
} from "./client/store";

const onlineCount = computed(
  () => network.devices.value.filter((d) => d.status === "online").length,
);
const creatingAgent = ref(false);

/** The help panel's six lessons, as keys, so both languages come from the catalog. */
const HELP_STEPS: { title: Key; body: Key }[] = [
  { title: "help.step1.title", body: "help.step1.body" },
  { title: "help.step2.title", body: "help.step2.body" },
  { title: "help.step3.title", body: "help.step3.body" },
  { title: "help.step4.title", body: "help.step4.body" },
  { title: "help.step5.title", body: "help.step5.body" },
  { title: "help.step6.title", body: "help.step6.body" },
];

async function newAgent() {
  const handle = sessionHandle.value;
  const target = selected.value;
  if (!handle || !target || creatingAgent.value) return;
  creatingAgent.value = true;
  const created = await attempt(() => handle.createAgent({}));
  creatingAgent.value = false;
  if (created) {
    select({ ...target, agentId: created.id });
    notify(t("topbar.newAgentToast"));
  }
}

function openNewSession() {
  ui.dialog = { kind: "new-session", deviceId: selected.value?.deviceId };
}

function keydown(e: KeyboardEvent) {
  const panel = ui.dialog ? undefined : panelHotkey(e);
  if (panel) {
    e.preventDefault();
    return panel === "tree" ? toggleTree() : toggleInspector();
  }
  if (e.key !== "Escape") return;
  if (ui.dialog) {
    ui.dialog = undefined;
    return;
  }
  if (!e.repeat && !e.isComposing && busy.value) {
    e.preventDefault();
    void interrupt();
  }
  ui.drawer = false;
  ui.inspectorOverlay = false;
}

// Drag the tree's right edge; the width persists in the hub's ui_state.
function resize(e: PointerEvent) {
  const start = e.clientX;
  const width = treeWidth.value;
  const move = (m: PointerEvent) =>
    (treeWidth.value = Math.max(220, Math.min(560, width + m.clientX - start)));
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function pickLanguage(e: Event) {
  setLocale((e.target as HTMLSelectElement).value as Locale);
}

onMounted(() => {
  document.addEventListener("keydown", keydown);
  void boot();
});
onBeforeUnmount(() => {
  stream.stop();
  document.removeEventListener("keydown", keydown);
});
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <button
          class="icon-button tree-toggle"
          :aria-label="t('topbar.toggleNetwork')"
          :title="t('topbar.networkTitle')"
          @click="ui.drawer = !ui.drawer"
        >
          <PanelLeft :size="19" /></button
        ><img class="brandmark" src="/icons/dpi-product.svg" alt="dpi-product" /><strong
          >dpi-product</strong
        ><span
          class="network-summary"
          :title="t('topbar.onlineOf', { online: onlineCount, total: network.devices.value.length })"
          ><Network :size="16" />{{ t("topbar.onlineOf", { online: onlineCount, total: network.devices.value.length }) }}</span
        >
      </div>
      <div class="top-actions">
        <span class="connection"
          ><i :class="{ online: streamState === 'live' }" />{{
            streamState === "live" ? t("topbar.connected") : t("topbar.reconnecting")
          }}</span
        ><label v-if="!forced" class="language" :title="t('topbar.language')">
          <Languages :size="17" aria-hidden="true" /><select
            :value="locale"
            :aria-label="t('topbar.language')"
            @change="pickLanguage"
          >
            <option v-for="code in LOCALES" :key="code" :value="code">
              {{ LOCALE_NAMES[code] }}
            </option>
          </select></label
        ><button
          class="icon-button"
          :title="t('topbar.howItWorks')"
          :aria-label="t('topbar.howItWorks')"
          @click="ui.dialog = { kind: 'help' }"
        >
          <CircleHelp :size="19" /></button
        ><button
          class="secondary small new-agent-button"
          :disabled="!selected || !online || creatingAgent"
          :title="t('topbar.newAgentTitle')"
          @click="newAgent"
        >
          <Plus :size="18" />{{ t("topbar.newAgent") }}
        </button>
        <button class="primary small" @click="openNewSession">
          <Plus :size="18" />{{ t("topbar.newSession") }}
        </button>
        <button
          class="icon-button inspector-toggle"
          :aria-label="t('topbar.toggleInspector')"
          :title="t('topbar.inspectorTitle')"
          :disabled="!selected || !online"
          @click="ui.inspectorOverlay ? hideInspector() : showInspector()"
        >
          <PanelRight :size="19" />
        </button>
      </div>
    </header>
    <div v-if="ui.error" class="error-banner" role="alert">
      <Info :size="18" /><span>{{ ui.error }}</span
      ><button class="icon-button" :aria-label="t('topbar.dismissError')" @click="ui.error = ''">
        ×
      </button>
    </div>
    <main class="net-workspace" :style="{ '--tree-w': `${treeWidth}px` }">
      <NetworkSidebar />
      <div
        v-if="layout.tree"
        class="tree-resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('topbar.resizeTree')"
        @pointerdown.prevent="resize"
      />
      <div v-if="ui.drawer" class="tree-backdrop" @click="ui.drawer = false" />
      <template v-if="selected && device && online">
        <Inspector />
        <div v-if="ui.inspectorOverlay" class="inspector-backdrop" @click="hideInspector()" />
        <AgentView :key="`${selected.deviceId}/${selected.sessionId}`" />
      </template>
      <OfflinePanel v-else-if="selected && device" :device="device" />
      <section v-else class="welcome">
        <img class="welcome-symbol" src="/icons/dpi-product.svg" alt="dpi-product" />
        <span class="eyebrow">{{ t("welcome.eyebrow") }}</span>
        <h1>{{ t("welcome.title1") }}<br />{{ t("welcome.title2") }}</h1>
        <p>{{ t("welcome.body") }}</p>
        <button class="primary" :disabled="!onlineCount" @click="openNewSession">
          <Plus :size="18" />{{
            network.devices.value.length ? t("welcome.create") : t("welcome.addDevice")
          }}
        </button>
        <div class="welcome-features">
          <span><Database :size="18" />{{ t("welcome.featureSqlite") }}</span
          ><span><GitFork :size="18" />{{ t("welcome.featureFork") }}</span
          ><span><Activity :size="18" />{{ t("welcome.featureWatch") }}</span>
        </div>
      </section>
    </main>

    <NewSessionDialog
      v-if="ui.dialog?.kind === 'new-session'"
      :device-id="ui.dialog.deviceId"
      @close="ui.dialog = undefined"
    />
    <PromptDialog
      v-else-if="ui.dialog?.kind === 'prompt'"
      :dialog="ui.dialog"
      @close="ui.dialog = undefined"
    />
    <ModelPicker v-else-if="ui.dialog?.kind === 'models'" @close="ui.dialog = undefined" />
    <div
      v-else-if="ui.dialog?.kind === 'path'"
      class="modal-backdrop"
      @click.self="ui.dialog = undefined"
    >
      <section
        class="modal path-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="path-title"
      >
        <header>
          <h2 id="path-title">{{ t("path.title") }}</h2>
          <button
            class="icon-button"
            :aria-label="t('path.close')"
            @click="ui.dialog = undefined"
          >
            <X :size="18" />
          </button>
        </header>
        <code class="full-directory">{{ ui.dialog.path }}</code>
        <footer>
          <button class="secondary" @click="ui.dialog = undefined">{{ t("common.close") }}</button>
        </footer>
      </section>
    </div>
    <div
      v-else-if="ui.dialog?.kind === 'help'"
      class="modal-backdrop"
      @click.self="ui.dialog = undefined"
    >
      <section class="modal help-modal">
        <header>
          <div>
            <span class="eyebrow">{{ t("help.eyebrow") }}</span>
            <h2>{{ t("help.title") }}</h2>
          </div>
          <button class="icon-button" :aria-label="t('help.close')" @click="ui.dialog = undefined">
            <X :size="18" />
          </button>
        </header>
        <ol class="learning-list">
          <li v-for="(step, i) in HELP_STEPS" :key="step.title">
            <span>0{{ i + 1 }}</span>
            <div>
              <strong>{{ t(step.title) }}</strong>
              <p>{{ t(step.body) }}</p>
            </div>
          </li>
        </ol>
        <div class="callout">
          <Info :size="18" /><span>{{ t("help.callout") }}</span>
        </div>
      </section>
    </div>
    <Transition name="toast"
      ><div v-if="ui.toast" class="toast" role="status">
        <Check :size="18" />{{ ui.toast }}
      </div></Transition
    >
  </div>
</template>
