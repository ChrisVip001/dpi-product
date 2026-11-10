<script setup lang="ts">
import { Activity, Braces, Check, GitFork, Info, Layers, Wrench } from "lucide-vue-next";
import type { TranscriptItem, ToolCallView } from "@sdk/transcript";
import { markdown } from "../client/markdown";
import { json } from "../client/store";
import { runByCall, runById } from "../client/jobs";
import JobCard from "./JobCard.vue";
import { t } from "../i18n";

defineProps<{ item: TranscriptItem }>();
const emit = defineEmits<{ fork: [entryId: number] }>();
const statusLabel = (call: ToolCallView) =>
  call.status === "error"
    ? t("entry.statusError")
    : call.status === "done"
      ? t("entry.statusDone")
      : call.status === "running"
        ? t("taskStatus.running")
        : call.status;
const entryClass = (item: TranscriptItem) =>
  item.kind === "user"
    ? "pi-user"
    : item.kind === "assistant"
      ? item.streaming
        ? "live-generation"
        : "pi-assistant"
      : item.kind === "tool-result"
        ? "pi-tool-result"
        : item.kind === "tool"
          ? "live-tool-entry"
          : item.entryKind.replaceAll(".", "-");
</script>

<template>
  <article class="entry" :class="entryClass(item)">
    <template v-if="item.kind === 'user'"
      ><div class="message-label">
        {{ t("entry.you") }} <span>#{{ item.id }}</span>
      </div>
      <div class="user-message">{{ item.text }}</div></template
    >
    <template v-else-if="item.kind === 'assistant'"
      ><div class="message-label">
        {{ t("view.agentLabel") }}
        <span v-if="item.streaming" class="streaming">{{ t("view.working") }}</span
        ><span v-else>#{{ item.id }}</span
        ><button
          v-if="!item.streaming"
          class="fork-button"
          :aria-label="t('entry.forkAt', { id: item.id })"
          :title="t('entry.forkTitle')"
          @click="emit('fork', item.id as number)"
        >
          <GitFork :size="18" />{{ t("entry.fork") }}
        </button>
      </div>
      <template v-for="(b, j) in item.blocks" :key="j"
        ><div v-if="b.type === 'text'" class="markdown" v-html="markdown(b.text)" />
        <details v-else-if="b.type === 'thinking'" class="thinking">
          <summary>{{ t("inspector.thinking") }}</summary>
          <div>{{ b.text }}</div>
        </details>
        <details
          v-else
          class="tool-call"
          :class="{ failed: b.call.status === 'error' }"
          :data-call-id="b.call.callId"
        >
          <summary>
            <Info v-if="b.call.status === 'error'" :size="18" />
            <Check v-else-if="b.call.status === 'done'" :size="18" />
            <Activity v-else-if="b.call.status === 'running'" :size="18" />
            <Wrench v-else :size="18" /><strong>{{ b.call.name }}</strong
            ><code>{{ json(b.call.args)?.slice(0, 90) }}</code>
            <span class="tool-status">{{ statusLabel(b.call) }}</span>
          </summary>
          <div class="tool-section-label">{{ t("entry.input") }}</div>
          <pre>{{ json(b.call.args) }}</pre>
          <template v-if="b.call.result !== undefined">
            <div class="tool-section-label">
              <span>{{ t("entry.result") }}</span>
              <button
                v-if="b.call.resultEntryId !== undefined"
                class="fork-button"
                :aria-label="t('entry.forkAt', { id: b.call.resultEntryId })"
                :title="t('entry.forkAfterResult')"
                @click="emit('fork', b.call.resultEntryId!)"
              >
                <GitFork :size="18" />{{ t("entry.fork") }}
              </button>
            </div>
            <pre>{{ b.call.result }}</pre>
          </template>
          <template v-else-if="b.call.output">
            <div class="tool-section-label">{{ t("entry.liveOutput") }}</div>
            <pre>{{ b.call.output }}</pre>
          </template>
        </details>
        <JobCard
          v-if="b.type === 'tool' && b.call.name === 'run_durable_job' && runByCall(b.call.callId)"
          :run="runByCall(b.call.callId)!"
        /></template
      >
      <div v-if="item.streaming && !item.blocks.length" class="typing"><i /><i /><i /></div>
      <div v-if="item.error" class="message-error">{{ item.error }}</div></template
    >
    <template v-else-if="item.kind === 'tool-result'"
      ><details class="tool-result" :class="{ failed: item.isError }">
        <summary>
          <Check v-if="!item.isError" :size="18" /><Info v-else :size="18" /><strong>{{
            item.name
          }}</strong
          ><span>{{ item.isError ? t("entry.error") : t("entry.resultTag") }}</span
          ><button
            class="fork-button"
            :aria-label="t('entry.forkAt', { id: item.id })"
            @click.prevent="emit('fork', item.id)"
          >
            <GitFork :size="18" />{{ t("entry.fork") }}
          </button>
        </summary>
        <pre>{{ item.text }}</pre>
      </details></template
    >
    <div v-else-if="item.kind === 'tool'" class="live-tool">
      <div>
        <Activity :size="18" /><strong>{{ item.call.name }}</strong
        ><span>{{ statusLabel(item.call) }}</span>
      </div>
      <pre v-if="item.call.output">{{ item.call.output }}</pre>
      <JobCard
        v-if="item.call.name === 'run_durable_job' && runByCall(item.call.callId)"
        :run="runByCall(item.call.callId)!"
      />
    </div>
    <JobCard
      v-else-if="item.entryKind === 'demo.job' && runById((item.data as { taskId: number }).taskId)"
      :run="runById((item.data as { taskId: number }).taskId)!"
    />
    <template v-else
      ><div class="event-line">
        <Braces v-if="item.entryKind === 'demo.state-change'" :size="18" /><Layers
          v-else
          :size="18"
        /><span>{{ item.text }}</span
        ><button
          class="fork-button"
          :aria-label="t('entry.forkAt', { id: item.id })"
          @click="emit('fork', item.id)"
        >
          <GitFork :size="18" />{{ t("entry.fork") }}
        </button>
      </div>
      <details v-if="item.note" class="raw">
        <summary>{{ t("entry.contextNote") }}</summary>
        <pre>{{ item.note }}</pre>
      </details></template
    >
  </article>
</template>
