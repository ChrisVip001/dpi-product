<script setup lang="ts">
import { computed } from "vue";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderOpen,
  GitFork,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Archive,
} from "lucide-vue-next";
import DeviceIcon from "./DeviceIcon.vue";
import type { TreeNode } from "@sdk/models";
import { ago } from "../client/store";
import { t } from "../i18n";

const props = defineProps<{
  node: TreeNode;
  depth: number;
  open: boolean;
  selected: boolean;
  focused: boolean;
  online: boolean;
}>();
const emit = defineEmits<{ toggle: []; activate: []; action: [name: string] }>();

const hasChildren = computed(() => props.node.children.length > 0);
const device = computed(() => (props.node.type === "device" ? props.node.device : undefined));
const session = computed(() => (props.node.type === "session" ? props.node.session : undefined));
const agent = computed(() => (props.node.type === "agent" ? props.node.agent : undefined));
const background = computed(() =>
  session.value
    ? session.value.agents.reduce((n, a) => n + a.background, 0)
    : (agent.value?.background ?? 0),
);
const busy = computed(() => session.value?.busy || agent.value?.busy);
const statusText = computed(() => {
  const d = device.value;
  if (!d) return "";
  const count = d.tree?.sessions.length ?? 0;
  switch (d.status) {
    case "online":
      return t(count === 1 ? "tree.sessionOne" : "tree.sessionMany", { count });
    case "checking":
      return t("tree.checking");
    case "unauthorized":
      return d.hasToken ? t("tree.tokenRejected") : t("tree.noToken");
    case "mismatch":
      return t("tree.identityChanged");
    case "incompatible":
      return t("tree.incompatible");
    default:
      return t("tree.offlineSince", { ago: ago(d.lastSeenAt) });
  }
});
const dot = computed(() => {
  const s = device.value?.status;
  return s === "online" ? "on" : s === "checking" ? "chk" : s === "offline" ? "off" : "err";
});
const label = computed(() => device.value?.id ?? session.value?.name ?? agent.value?.name ?? "");
const title = computed(() => {
  if (device.value)
    return `${device.value.name} · ${device.value.url}${device.value.error ? `\n${device.value.error}` : ""}`;
  if (session.value) return `${session.value.name}\n${session.value.cwd}`;
  const a = agent.value!;
  return a.kind === "fork"
    ? t("tree.forkOf", { parent: a.parentId ?? "?", entry: a.forkedAt ?? "?" })
    : a.kind === "subagent"
      ? t("tree.subagentOwned", { owner: a.ownerAgentId ?? "?" })
      : t("tree.rootAgent");
});
</script>

<template>
  <div
    class="tree-row"
    :class="[node.type, { sel: selected, focus: focused, stale: node.stale }]"
    :style="{ '--depth': depth }"
    role="treeitem"
    :aria-level="depth + 1"
    :aria-expanded="hasChildren ? open : undefined"
    :aria-selected="selected"
    :data-key="node.key"
    :title="title"
    @click="emit('activate')"
  >
    <button
      v-if="hasChildren"
      class="chev"
      tabindex="-1"
      :aria-label="open ? t('tree.collapse', { name: label }) : t('tree.expand', { name: label })"
      @click.stop="emit('toggle')"
    >
      <ChevronDown v-if="open" :size="16" /><ChevronRight v-else :size="16" />
    </button>
    <span v-else class="chev" />
    <template v-if="device">
      <i class="dot" :class="dot" />
      <DeviceIcon :device="device" :size="16" />
      <b class="name">{{ label }}</b>
      <span class="badge">{{ device.kind }}</span>
      <span class="meta" :class="{ err: dot === 'err' }">{{ statusText }}</span>
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="t('tree.newSessionOn', { name: label })"
          :title="t('tree.newSessionOnTitle')"
          @click="emit('action', 'new-session')"
        >
          <Plus :size="16" /></button
        ><button
          class="icon-button"
          :aria-label="t('tree.check', { name: label })"
          :title="t('tree.checkTitle')"
          @click="emit('action', 'check')"
        >
          <RefreshCw :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="session">
      <FolderOpen class="ico" :size="16" />
      <b class="name">{{ label }}</b>
      <span class="path">…/{{ session.cwd.split("/").filter(Boolean).at(-1) }}</span>
      <i v-if="busy" class="dot work" :title="t('tree.working')" />
      <span v-if="background" class="bg-count" :title="t('tree.backgroundTasks', { count: background })"
        ><i class="dot bg" />{{ t("tree.backgroundShort", { count: background }) }}</span
      >
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="t('tree.newAgentIn', { name: label })"
          :title="t('tree.newAgentInTitle')"
          @click="emit('action', 'new-agent')"
        >
          <Plus :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!online"
          :aria-label="t('tree.renameSession', { name: label })"
          :title="t('tree.renameSessionTitle')"
          @click="emit('action', 'rename')"
        >
          <Pencil :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!online"
          :aria-label="t('tree.archiveSession', { name: label })"
          :title="t('tree.archiveSessionTitle')"
          @click="emit('action', 'archive')"
        >
          <Archive :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="agent">
      <GitFork v-if="agent.kind === 'fork'" class="ico" :size="16" />
      <CornerDownRight v-else-if="agent.kind === 'subagent'" class="ico" :size="16" />
      <MessageSquare v-else class="ico root" :size="16" />
      <span class="name">{{ label }}</span>
      <span v-if="agent.kind === 'fork' && agent.forkedAt !== undefined" class="meta"
        >@ #{{ agent.forkedAt }}</span
      >
      <i v-if="busy" class="dot work" :title="t('tree.working')" />
      <span v-if="background" class="bg-count" :title="t('tree.backgroundTasks', { count: background })"
        ><i class="dot bg" />{{ background }}</span
      >
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="t('tree.renameAgent', { name: label })"
          :title="t('tree.renameAgentTitle')"
          @click="emit('action', 'rename')"
        >
          <Pencil :size="16" />
        </button>
      </span>
    </template>
  </div>
</template>
