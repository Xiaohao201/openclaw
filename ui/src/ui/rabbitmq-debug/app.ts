import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../icons.js";
import { renderChat } from "../views/chat.js";
import {
  createDebugHistoryId,
  loadDatabaseSkills,
  runDebugTurn,
  type DebugDatabaseSkill,
  type DebugTraceItem,
  type DebugUsage,
} from "./transport.js";

type DebugView = "chat" | "skills";

function createSessionId(): string {
  return `rabbitmq-debug-${crypto.randomUUID()}`;
}

function chatMessage(role: "user" | "assistant", text: string): Record<string, unknown> {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function traceStatusLabel(status: DebugTraceItem["status"]): string {
  return status === "failed" ? "失败" : status === "running" ? "进行中" : "完成";
}

@customElement("suheng-rabbitmq-debug-app")
export class SuhengRabbitMqDebugApp extends LitElement {
  @state() private view: DebugView = "chat";
  @state() private userId = "local-user";
  @state() private sessionId = createSessionId();
  @state() private messages: unknown[] = [];
  @state() private draft = "";
  @state() private sending = false;
  @state() private error: string | null = null;
  @state() private skills: DebugDatabaseSkill[] = [];
  @state() private selectedSkillIds: number[] = [];
  @state() private skillsLoading = false;
  @state() private skillsStatus = "输入实际用户 ID 后读取该用户在数据库中的已启用 Skills。";
  @state() private trace: DebugTraceItem[] = [];
  @state() private usage: DebugUsage | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.refreshSkills();
  }

  private newSession(): void {
    this.sessionId = createSessionId();
    this.messages = [];
    this.trace = [];
    this.usage = null;
    this.error = null;
    this.draft = "";
  }

  private async refreshSkills(): Promise<void> {
    this.skillsLoading = true;
    this.skillsStatus = "正在读取数据库 Skills…";
    this.error = null;
    try {
      this.skills = await loadDatabaseSkills(this.userId);
      const visible = new Set(this.skills.map((skill) => skill.id));
      this.selectedSkillIds = this.selectedSkillIds.filter((id) => visible.has(id));
      this.skillsStatus = `已读取 ${this.skills.length} 个已启用 Skills；提示词正文仅在服务端使用。`;
    } catch (error) {
      this.skills = [];
      this.selectedSkillIds = [];
      this.skillsStatus = error instanceof Error ? error.message : "数据库 Skills 暂时无法读取";
    } finally {
      this.skillsLoading = false;
    }
  }

  private toggleSkill(id: number): void {
    this.selectedSkillIds = this.selectedSkillIds.includes(id)
      ? this.selectedSkillIds.filter((value) => value !== id)
      : [...this.selectedSkillIds, id].slice(0, 20);
  }

  private async send(): Promise<void> {
    const message = this.draft.trim();
    if (!message || this.sending) {
      return;
    }
    this.draft = "";
    this.error = null;
    this.sending = true;
    this.trace = [];
    this.usage = null;
    this.messages = [...this.messages, chatMessage("user", message)];
    try {
      const result = await runDebugTurn({
        historyId: createDebugHistoryId((target) => crypto.getRandomValues(target)),
        message,
        sessionId: this.sessionId,
        userId: this.userId,
        skillIds: this.selectedSkillIds,
      });
      this.messages = [...this.messages, chatMessage("assistant", result.response)];
      this.trace = result.trace;
      this.usage = result.usage ?? null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "本地测试请求失败";
    } finally {
      this.sending = false;
    }
  }

  private renderNavigation() {
    return html`
      <aside class="suheng-debug-nav" aria-label="本地测试导航">
        <div class="suheng-debug-brand">
          <span class="suheng-debug-brand__mark">衡</span>
          <span><strong>夙衡</strong><small>RabbitMQ 本地测试</small></span>
        </div>
        <nav class="suheng-debug-nav__items">
          <button
            class=${this.view === "chat" ? "active" : ""}
            type="button"
            @click=${() => (this.view = "chat")}
          >
            ${icons.messageSquare}<span>对话测试</span>
          </button>
          <button
            class=${this.view === "skills" ? "active" : ""}
            type="button"
            @click=${() => (this.view = "skills")}
          >
            ${icons.spark}<span>数据库 Skills</span>
          </button>
        </nav>
        <div class="suheng-debug-identity">
          <label for="suheng-debug-user">用户 ID</label>
          <input
            id="suheng-debug-user"
            maxlength="128"
            .value=${this.userId}
            @input=${(event: Event) => {
              this.userId = (event.target as HTMLInputElement).value;
              this.selectedSkillIds = [];
            }}
          />
          <button type="button" @click=${() => void this.refreshSkills()}>重新读取 Skills</button>
        </div>
      </aside>
    `;
  }

  private renderTrace() {
    return html`
      <aside class="suheng-debug-trace card" aria-label="本轮工作过程">
        <div class="suheng-debug-panel-head">
          <div>
            <span class="eyebrow">本轮执行</span>
            <h2>工作过程</h2>
          </div>
          <span class="pill">${this.trace.length} 步</span>
        </div>
        ${this.usage
          ? html`<section class="suheng-debug-usage" aria-label="本轮 Token 用量">
              <div class="suheng-debug-usage__head">
                <strong>本轮 Token</strong>
                <span>${this.usage.calls} 次模型调用</span>
              </div>
              <div class="suheng-debug-usage__grid">
                <span>输入 <strong>${this.usage.inputTokens}</strong></span>
                <span>输出 <strong>${this.usage.outputTokens}</strong></span>
                <span>缓存读取 <strong>${this.usage.cacheReadTokens}</strong></span>
                <span>缓存写入 <strong>${this.usage.cacheWriteTokens}</strong></span>
                <span>总计 <strong>${this.usage.totalTokens}</strong></span>
              </div>
              ${this.usage.models.length
                ? html`<small
                    >${this.usage.models
                      .map(
                        (model) =>
                          `${model.provider ?? "?"}/${model.model ?? "?"} · ${model.calls} 次 · 输入 ${model.inputTokens} · 输出 ${model.outputTokens} · 总计 ${model.totalTokens}`,
                      )
                      .join("；")}</small
                  >`
                : nothing}
            </section>`
          : nothing}
        ${this.sending
          ? html`<div class="suheng-debug-empty">夙衡正在处理请求…</div>`
          : this.trace.length === 0
            ? html`<div class="suheng-debug-empty">发送消息后，这里显示真实执行步骤。</div>`
            : html`<ol class="suheng-debug-trace-list">
                ${this.trace.map(
                  (item) => html`<li class=${item.status}>
                    <span class="suheng-debug-trace-dot"></span>
                    <div>
                      <div class="suheng-debug-trace-title">
                        <strong>${item.summary}</strong>
                        <span>${traceStatusLabel(item.status)}</span>
                      </div>
                      <small>
                        ${item.durationMs === undefined ? nothing : `${item.durationMs} ms`}
                        ${item.repeatCount && item.repeatCount > 1
                          ? ` · ${item.repeatCount} 次`
                          : nothing}
                      </small>
                      ${item.narrative.length
                        ? html`<details>
                            <summary>查看事实依据</summary>
                            ${item.narrative.map((line) => html`<p>${line}</p>`)}
                          </details>`
                        : nothing}
                      ${item.toolName || item.input || item.output
                        ? html`<div class="suheng-debug-tool-result">
                            ${item.toolName
                              ? html`<div class="suheng-debug-tool-name">
                                  <span>工具</span><code>${item.toolName}</code>
                                </div>`
                              : nothing}
                            ${item.input
                              ? html`<section>
                                  <strong>调用参数</strong>
                                  <pre>${item.input}</pre>
                                </section>`
                              : nothing}
                            ${item.output
                              ? html`<section>
                                  <strong>返回结果</strong>
                                  <pre>${item.output}</pre>
                                </section>`
                              : nothing}
                          </div>`
                        : nothing}
                    </div>
                  </li>`,
                )}
              </ol>`}
      </aside>
    `;
  }

  private renderChatView() {
    return html`
      <div class="suheng-debug-chat-grid">
        ${renderChat({
          sessionKey: this.sessionId,
          onSessionKeyChange: () => {},
          thinkingLevel: null,
          showThinking: false,
          showToolCalls: false,
          loading: false,
          sending: this.sending,
          messages: this.messages,
          toolMessages: [],
          streamSegments: [],
          stream: null,
          streamStartedAt: null,
          draft: this.draft,
          queue: [],
          connected: true,
          canSend: !this.sending && Boolean(this.userId.trim()),
          disabledReason: null,
          error: this.error,
          sessions: null,
          focusMode: false,
          onRefresh: () => {},
          onToggleFocusMode: () => {},
          getDraft: () => this.draft,
          onDraftChange: (next) => (this.draft = next),
          onRequestUpdate: () => this.requestUpdate(),
          onSend: () => void this.send(),
          onQueueRemove: () => {},
          onNewSession: () => this.newSession(),
          agentsList: null,
          currentAgentId: `rabbitmq-${this.userId.trim() || "local-user"}`,
          onAgentChange: () => {},
          assistantName: "夙衡",
          assistantAvatar: null,
        })}
        ${this.renderTrace()}
      </div>
    `;
  }

  private renderSkillsView() {
    return html`
      <section class="suheng-debug-skills card">
        <div class="suheng-debug-panel-head">
          <div>
            <span class="eyebrow">MySQL · skills</span>
            <h1>数据库 Skills</h1>
            <p>仅显示当前用户拥有且已启用的技能；内容正文不会发送到浏览器。</p>
          </div>
          <button
            class="btn"
            type="button"
            ?disabled=${this.skillsLoading}
            @click=${() => void this.refreshSkills()}
          >
            ${this.skillsLoading ? "读取中…" : "刷新"}
          </button>
        </div>
        <div class="callout">${this.skillsStatus}</div>
        <div class="suheng-debug-skill-grid">
          ${this.skills.length === 0
            ? html`<div class="suheng-debug-empty">当前用户没有可用的数据库 Skills。</div>`
            : this.skills.map(
                (skill) => html`<button
                  class="suheng-debug-skill ${this.selectedSkillIds.includes(skill.id)
                    ? "selected"
                    : ""}"
                  type="button"
                  role="checkbox"
                  aria-checked=${this.selectedSkillIds.includes(skill.id)}
                  @click=${() => this.toggleSkill(skill.id)}
                >
                  <span class="suheng-debug-skill__icon">${icons.spark}</span>
                  <strong>${skill.name}</strong>
                  <p>${skill.description || "暂无说明"}</p>
                  <small>skill_id: ${skill.id}</small>
                </button>`,
              )}
        </div>
      </section>
    `;
  }

  render() {
    const selectedNames = this.skills
      .filter((skill) => this.selectedSkillIds.includes(skill.id))
      .map((skill) => skill.name);
    return html`
      <div class="suheng-debug-shell">
        ${this.renderNavigation()}
        <header class="suheng-debug-topbar">
          <div>
            <strong>${this.view === "chat" ? "对话测试" : "数据库 Skills"}</strong>
            <span>真实 RabbitMQ 处理链路 · history_test</span>
          </div>
          <div class="suheng-debug-topbar__meta">
            ${selectedNames.length
              ? html`<span class="pill" title=${selectedNames.join("、")}
                  >${selectedNames.length} 个 Skills 已启用</span
                >`
              : html`<span class="pill">未启用 Skills</span>`}
            <code>${this.sessionId}</code>
          </div>
        </header>
        <main class="suheng-debug-content">
          ${this.view === "chat" ? this.renderChatView() : this.renderSkillsView()}
        </main>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "suheng-rabbitmq-debug-app": SuhengRabbitMqDebugApp;
  }
}
