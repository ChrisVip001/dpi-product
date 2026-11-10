<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  Activity,
  Braces,
  ChevronDown,
  FolderOpen,
  Pencil,
  Server,
  ShieldCheck,
  Wrench,
  PanelRightClose,
  PanelRightOpen,
  Puzzle,
} from "lucide-vue-next";
import { THINKING_LEVELS, type ThinkingLevel } from "@sdk/api";
import type { StateChange } from "@sdk/app-state";
import StateEditor from "./StateEditor.vue";
import TasksPanel from "./TasksPanel.vue";
import RuntimePanel from "./RuntimePanel.vue";
import ExtensionsPanel from "./ExtensionsPanel.vue";
import ContextBar from "./ContextBar.vue";
import { message } from "../client/hub";
import { toolSignature } from "../client/signature";
import { locale, t, type Key } from "../i18n";
import {
  agentHandle,
  agentState,
  attempt,
  busy,
  currentModel,
  detail,
  device,
  deviceFeed,
  hideInspector,
  icon,
  inspectorExpanded,
  json,
  notify,
  number,
  refreshDetail,
  session,
  sessionHandle,
  sessionSummary,
  showInspector,
  tasks,
  ui,
  usage,
  panelKeys,
} from "../client/store";

// Each tool's parameters as a highlighted TypeScript declaration, rebuilt only when the tools change.
const signatures = computed(
  () => new Map(detail.value?.tools.map((tool) => [tool.name, toolSignature(tool.name, tool.parameters)])),
);

const TABS: { id: string; key: Key; icon: unknown }[] = [
  { id: "session", key: "inspector.tab.session", icon: FolderOpen },
  { id: "state", key: "inspector.tab.state", icon: Braces },
  { id: "tasks", key: "inspector.tab.tasks", icon: Activity },
  { id: "tools", key: "inspector.tab.tools", icon: Wrench },
  { id: "extensions", key: "inspector.tab.extensions", icon: Puzzle },
];
const tabs = computed(() => TABS.map((tab) => ({ ...tab, label: t(tab.key) })));

const usageRows = computed(() => [
  { label: t("inspector.usage.input"), tokens: usage.value.input, cost: usage.value.inputCost },
  { label: t("inspector.usage.output"), tokens: usage.value.output, cost: usage.value.outputCost },
  { label: t("inspector.usage.cacheRead"), tokens: usage.value.cacheRead, cost: usage.value.cacheReadCost },
  { label: t("inspector.usage.cacheWrite"), tokens: usage.value.cacheWrite, cost: usage.value.cacheWriteCost },
]);
const background = computed(() => tasks.value.filter((task) => task.background).length);

function configure(
  patch: Parameters<NonNullable<typeof agentHandle.value>["configure"]>[0],
  done?: string,
) {
  void attempt(async () => {
    await agentHandle.value!.configure(patch);
    await refreshDetail();
    if (done) notify(done);
  });
}

function renameSession() {
  const handle = sessionHandle.value;
  if (!handle) return;
  ui.dialog = {
    kind: "prompt",
    title: t("dialog.renameSession.title"),
    label: t("dialog.sessionName.label"),
    value: sessionSummary.value?.name ?? "",
    submit: t("dialog.saveName"),
    run: (name) => handle.rename(name),
  };
}

// ------------------------------------------------------------ App State (device-wide document)

const shared = deviceFeed.sharedState;
const stateDraft = ref("");
const stateBaseline = ref("");
const stateDraftRevision = ref(0);
const stateSaving = ref(false);
const stateError = ref("");
const stateDirty = computed(() => stateDraft.value !== stateBaseline.value);
const stateConflict = computed(
  () => stateDirty.value && shared.value?.revision !== stateDraftRevision.value,
);
function resetStateDraft() {
  stateDraft.value = json(shared.value?.value ?? {});
  stateBaseline.value = stateDraft.value;
  stateDraftRevision.value = shared.value?.revision ?? 0;
  stateError.value = "";
}
watch(shared, () => !stateDirty.value && resetStateDraft(), { immediate: true });

async function editState(change: StateChange) {
  if (stateSaving.value || !agentHandle.value) return;
  stateSaving.value = true;
  stateError.value = "";
  try {
    await agentHandle.value.demo("state", change);
  } catch (e) {
    stateError.value = message(e);
  } finally {
    stateSaving.value = false;
  }
}
async function saveStateJson() {
  if (stateSaving.value || !agentHandle.value) return;
  stateError.value = "";
  stateSaving.value = true;
  try {
    const value = JSON.parse(stateDraft.value);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw Error(t("inspector.stateNotObject"));
    const saved = await agentHandle.value.demo<{ value: unknown; revision: number }>("state", {
      operation: "update",
      path: "",
      value,
      expectedRevision: stateDraftRevision.value,
    });
    stateDraft.value = json(saved.value);
    stateBaseline.value = stateDraft.value;
    stateDraftRevision.value = saved.revision;
    notify(t("inspector.stateSaved"));
  } catch (e) {
    stateError.value = message(e);
  } finally {
    stateSaving.value = false;
  }
}

const readOnly = computed(() => detail.value?.config.readOnly === true);
const offeredTools = computed(() => detail.value?.tools.filter((tool) => tool.offered).length ?? 0);
</script>

<template>
  <aside class="inspector" :class="{ collapsed: !inspectorExpanded, overlay: ui.inspectorOverlay }">
    <div v-if="!inspectorExpanded" class="panel-rail" :aria-label="t('inspector.railLabel')">
      <button
        class="icon-button panel-toggle"
        :aria-label="t('inspector.expand')"
        :title="t('inspector.expandTitle', { key: panelKeys.inspector })"
        @click="showInspector()"
      >
        <PanelRightOpen :size="18" />
      </button>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="rail-tab"
        :class="{ active: ui.tab === tab.id }"
        :aria-label="t('inspector.openTab', { tab: tab.label })"
        :title="tab.label"
        @click="showInspector(tab.id)"
      >
        <component :is="tab.icon" :size="20" /><span
          v-if="tab.id === 'tasks' && tasks.length"
          class="count"
          >{{ tasks.length }}</span
        >
      </button>
    </div>
    <template v-else>
      <div class="inspector-tabs" role="tablist" :aria-label="t('inspector.tabsLabel')">
        <button
          v-for="tab in tabs"
          :id="`inspector-tab-${tab.id}`"
          :key="tab.id"
          role="tab"
          aria-controls="inspector-panel"
          :aria-selected="ui.tab === tab.id"
          :class="{ active: ui.tab === tab.id }"
          @click="ui.tab = tab.id"
        >
          <component :is="tab.icon" :size="18" />{{ tab.label
          }}<span v-if="tab.id === 'tasks' && tasks.length" class="count">{{ tasks.length }}</span>
        </button>
        <button
          class="icon-button panel-toggle"
          :aria-label="t('inspector.collapse')"
          :title="t('inspector.collapseTitle', { key: panelKeys.inspector })"
          @click="hideInspector()"
        >
          <PanelRightClose :size="18" />
        </button>
      </div>
      <div
        id="inspector-panel"
        class="inspector-body"
        :class="{ 'session-panel': ui.tab === 'session' }"
        role="tabpanel"
        :aria-labelledby="`inspector-tab-${ui.tab}`"
      >
        <template v-if="ui.tab === 'session'">
          <section class="session-heading">
            <h1>
              <span>{{ sessionSummary?.name ?? t("inspector.loadingSession") }}</span
              ><button
                class="icon-button"
                :title="t('dialog.renameSession.title')"
                :aria-label="t('dialog.renameSession.title')"
                @click="renameSession"
              >
                <Pencil :size="18" />
              </button>
            </h1>
            <button
              class="path cwd-button"
              :title="sessionSummary?.cwd"
              :aria-label="t('inspector.showCwd')"
              @click="ui.dialog = { kind: 'path', path: sessionSummary?.cwd ?? '' }"
            >
              <FolderOpen :size="18" /><span class="cwd-trail" dir="rtl"
                ><bdi dir="ltr">{{ sessionSummary?.cwd }}</bdi></span
              >
            </button>
            <div class="session-status">
              <span class="status-pill" :class="{ working: busy }"
                ><i />{{ busy ? t("view.working") : t("inspector.idle") }}</span
              ><span v-if="background" class="background-pill">{{
                t("inspector.background", { count: background })
              }}</span
              ><span class="saved"><Server :size="18" />{{ device?.id }}</span>
            </div>
          </section>
          <section class="model-section">
            <div class="section-label">
              <span>{{ t("inspector.agentSection") }}</span>
            </div>
            <button class="model-button" @click="ui.dialog = { kind: 'models' }">
              <img :src="icon(agentState.agent.model?.modelId)" alt="" />
              <div>
                <strong>{{
                  currentModel?.name ?? agentState.agent.model?.modelId ?? t("inspector.loading")
                }}</strong
                ><small
                  >{{ currentModel?.tier ?? "" }} /
                  {{ agentState.agent.model?.provider ?? "" }}</small
                >
              </div>
              <ChevronDown :size="18" />
            </button>
            <div class="thinking-row">
              <span>{{ t("inspector.thinking") }}</span
              ><select
                :aria-label="t('inspector.thinkingLevel')"
                :value="agentState.agent.thinkingLevel ?? 'low'"
                @change="
                  configure(
                    { thinkingLevel: ($event.target as HTMLSelectElement).value as ThinkingLevel },
                    t('slash.thinking.done', {
                      level: ($event.target as HTMLSelectElement).value,
                    }),
                  )
                "
              >
                <option v-for="level in THINKING_LEVELS" :key="level">{{ level }}</option>
              </select>
            </div>
            <ContextBar />
            <section class="stats-section" aria-labelledby="stats-title">
              <div class="section-label"><span id="stats-title">{{ t("inspector.stats") }}</span></div>
              <div class="metrics">
                <div
                  :title="t('inspector.totalTokensTitle', { total: usage.tokens.toLocaleString(locale) })"
                >
                  <span>{{ number(usage.tokens) }}</span
                  ><small>{{ t("inspector.totalTokens") }}</small>
                </div>
                <div>
                  <span>${{ usage.cost.toFixed(4) }}</span
                  ><small>{{ t("inspector.agentCost") }}</small>
                </div>
                <div>
                  <span>{{ detail?.tools.length ?? 0 }}</span
                  ><small>{{ t("inspector.toolsCount") }}</small>
                </div>
              </div>
              <table class="usage-breakdown" :aria-label="t('inspector.usageBreakdown')">
                <thead>
                  <tr>
                    <th scope="col">{{ t("inspector.colType") }}</th>
                    <th scope="col">{{ t("inspector.colTokens") }}</th>
                    <th scope="col">{{ t("inspector.colCost") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in usageRows" :key="row.label">
                    <th scope="row">{{ row.label }}</th>
                    <td>{{ row.tokens.toLocaleString(locale) }}</td>
                    <td>${{ row.cost.toFixed(4) }}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </section>
        </template>
        <template v-if="ui.tab === 'state'">
          <div class="panel-heading">
            <h2>{{ t("inspector.appStateTitle") }}</h2>
            <Braces :size="18" />
          </div>
          <p class="hint app-state-description">
            {{ t("inspector.appStateBody", { device: device?.id ?? "" }) }}
          </p>
          <textarea
            v-model="stateDraft"
            class="app-state-json"
            :aria-label="t('inspector.appStateJson')"
            spellcheck="false"
            :disabled="stateSaving || !shared"
            rows="12"
          />
          <div class="state-json-actions">
            <span v-if="stateConflict" class="hint">{{ t("inspector.stateConflict") }}</span>
            <button
              v-if="stateDirty"
              class="secondary"
              :disabled="stateSaving"
              @click="resetStateDraft"
            >
              {{ stateConflict ? t("inspector.loadLatest") : t("inspector.reset") }}
            </button>
            <button
              class="primary small"
              :disabled="!stateDirty || stateSaving || stateConflict"
              @click="saveStateJson"
            >
              {{ stateSaving ? t("inspector.saving") : t("inspector.saveJson") }}
            </button>
          </div>
          <p v-if="stateError" class="message-error" role="alert">{{ stateError }}</p>
          <StateEditor
            :value="shared?.value ?? {}"
            :disabled="stateSaving || stateDirty || !shared"
            @change="editState"
          />
        </template>
        <template v-if="ui.tab === 'tasks'">
          <RuntimePanel />
          <TasksPanel />
        </template>
        <ExtensionsPanel v-if="ui.tab === 'extensions'" />
        <template v-if="ui.tab === 'tools'"
          ><div class="panel-heading">
            <h2>{{ t("inspector.toolsTitle") }}</h2>
            <span class="tag">{{ offeredTools }} / {{ detail?.tools.length ?? 0 }}</span>
          </div>
          <p class="hint">{{ t("inspector.toolsHint") }}</p>
          <div class="hook-card">
            <div>
              <ShieldCheck :size="18" /><strong>{{ t("inspector.readOnly") }}</strong
              ><button
                class="switch"
                role="switch"
                :aria-checked="readOnly"
                :aria-label="t('inspector.readOnly')"
                :class="{ on: readOnly }"
                @click="
                  configure(
                    { readOnly: !readOnly },
                    readOnly ? t('inspector.readOnlyOff') : t('inspector.readOnlyOn'),
                  )
                "
              >
                <span />
              </button>
            </div>
            <p>{{ t("inspector.readOnlyBody") }}</p>
          </div>
          <details
            v-for="tool in detail?.tools"
            :key="tool.name"
            class="tool-row"
            :class="{ disabled: !tool.offered }"
          >
            <summary>
              <Wrench :size="18" /><strong>{{ tool.name }}</strong
              ><span v-if="!tool.offered" class="tag tool-disabled">{{
                t("inspector.toolDisabled")
              }}</span
              ><span class="tag">{{
                tool.replay === "safe" ? t("inspector.replaySafe") : t("inspector.interruptOnCrash")
              }}</span>
            </summary>
            <p>{{ tool.description }}</p>
            <pre
              v-if="tool.parameters"
              class="tool-signature"
              :aria-label="t('inspector.toolSignature', { name: tool.name })"
            ><code><span v-for="(part, i) in signatures.get(tool.name)" :key="i" :class="`tk-${part.kind}`">{{ part.text }}</span></code></pre>
            <small>{{
              tool.replay === "safe" ? t("inspector.replaySafeNote") : t("inspector.replayUnsafeNote")
            }}</small>
          </details></template
        >
      </div>
    </template>
  </aside>
</template>
