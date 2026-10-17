import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { executeNativeComplaint } from "../executor/native.js";
import { additionalWebFixtures } from "./web-fixtures.test-support.js";
import { createWebDriver } from "./web.js";

const fixtures: Array<{
  platform: string;
  link: string;
  html: string;
  form: string;
  receipt: string;
  report?: string;
  popup?: boolean;
  frame?: boolean;
}> = [
  ...additionalWebFixtures,
  {
    platform: "toutiao",
    link: "https://www.toutiao.com/article/123/",
    html: '<div class="detail-report"><i onclick="openForm()">举报</i></div>',
    form: '<label onclick="select()">不实信息</label><button onclick="submit()">确认</button>',
    receipt: "反馈成功",
  },
  {
    platform: "baidu",
    link: "https://baijiahao.baidu.com/s?id=123",
    html: '<span data-testid="report-btn" onclick="openForm()">举报</span>',
    form: '<label onclick="select()">不实信息</label><textarea id="fb_des_content"></textarea><button onclick="submit()">提交反馈</button>',
    receipt: "提交成功",
  },
  {
    platform: "kuaishou",
    link: "https://www.kuaishou.com/short-video/123",
    html: '<span class="item-text" onclick="openForm()">举报</span>',
    form: '<div class="report-item-list-item" onclick="select()">不实信息</div><textarea placeholder="请描述举报理由"></textarea><button onclick="submit()">提交</button>',
    receipt: "提交成功",
  },
];
fixtures.push(
  {
    ...fixtures.find((f) => f.platform === "toutiao")!,
    link: "https://www.toutiao.com/video/123/",
    html: '<button aria-label="更多">更多</button><button onclick="openForm()">举报</button>',
  },
  {
    ...fixtures.find((f) => f.platform === "baidu")!,
    link: "https://haokan.baidu.com/video/123",
    html: '<span onclick="openForm()">举报</span>',
  },
  {
    ...fixtures.find((f) => f.platform === "kuaishou")!,
    link: "https://www.kuaishou.com/new-reco/123",
    html: '<img class="more-img" width="20" height="20"><div class="more-item report" onclick="openForm()">举报</div>',
  },
  {
    ...fixtures.find((f) => f.platform === "zhihu")!,
    link: "https://zhuanlan.zhihu.com/p/456",
    html: '<div class="Post-ActionMenuButton"><button>更多</button></div><button onclick="openForm()">举报</button>',
  },
  {
    ...fixtures.find((f) => f.platform === "sohu")!,
    link: "https://m.sohu.com/a/123_456",
    html: '<div class="navbar-icon">更多</div><a href="REPORT">举报</a>',
  },
  {
    platform: "bilibili",
    link: "https://www.bilibili.com/video/BV123",
    html: '<div class="video-tool-more-reference">更多</div><button onclick="openForm()">稿件举报</button>',
    form: '<label onclick="select()">不实信息</label><textarea></textarea><button onclick="submit()">提交</button>',
    receipt: "提交成功",
    frame: true,
  },
  {
    platform: "sina",
    link: "https://super.sina.cn/shequn/post/detail_123.html",
    report:
      "https://sinanews.sina.cn/activities/feedback.d.html?type=tiezi&dataid=tiezi:123&docId=HB-1-discovery_hot_doc/hot_community-123-tiezi&wapUrl=https://super.sina.cn/shequn/post/detail_123.html",
    html: '<script>var data={"feedback":{"link":"REPORT"}}</script>',
    form: '<form id="error-form" onsubmit="return false"><label for="check-one" onclick="select()">不实信息</label><input id="check-one" type="checkbox"><textarea name="content"></textarea><button type="button" class="submit" onclick="submit()">提交</button></form>',
    receipt: '<div class="layer"><h4>提交成功</h4></div>',
  },
);
it.runIf(Boolean(process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME))(
  "ports the ordinary web forms without duplicate submission",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "web-complaint-"));
    const browser = await chromium.launch({
      executablePath: process.env.OPENCLAW_TEST_SHARED_LOGIN_CHROME,
      headless: true,
      env: { ...process.env, USERPROFILE: userInfo().homedir, HOME: userInfo().homedir },
    });
    try {
      const observed: Array<{
        platform: string;
        state: string;
        submissions: number;
        errors: string[];
      }> = [];
      for (const fixture of fixtures) {
        const context = await browser.newContext();
        const page = await context.newPage();
        let submissions = 0;
        await context.exposeBinding("fixtureSubmitted", () => {
          submissions++;
        });
        await context.route("**/*", (route) => {
          if (route.request().url().includes("get-content-report-type-list")) {
            return route.fulfill({ contentType: "application/json", body: '{"code":0}' });
          }
          const reporting = fixture.report === route.request().url();
          const contents = `${fixture.form.replaceAll('onclick="submit()"', 'onclick="window.submit()"')}<div id="receipt" hidden>${fixture.receipt}</div><script>function select(){window.selected=true}function submit(){if(!window.selected)throw Error('not selected');window.fixtureSubmitted();document.querySelector('#receipt').hidden=false}</script>`;
          return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `${reporting ? "" : fixture.html.replaceAll("REPORT", fixture.report ?? "")}<section id="form" ${reporting ? "" : "hidden"}>${fixture.frame ? `<iframe name="appeal" srcdoc="${contents.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>` : contents}</section><script>function openForm(){document.querySelector('#form').hidden=false}</script>`,
          });
        });
        const errors: string[] = [];
        const outcome = await executeNativeComplaint({
          signal: new AbortController().signal,
          timeoutMs: 30000,
          log: () => {},
          acquire: async () => {
            const driver = createWebDriver({
              page,
              item: {
                ...fixture,
                category: "不实信息",
                reason: "offline fixture reason",
                role: "Personal",
              },
              sessionDir: root,
              release: async () => {},
            });
            const prepare = driver.prepare;
            driver.prepare = async () => {
              try {
                await prepare();
              } catch (error) {
                errors.push(String(error));
                throw error;
              }
            };
            return driver;
          },
        });
        observed.push({ platform: fixture.platform, state: outcome.state, submissions, errors });
        await context.close();
      }
      expect(observed).toEqual(
        fixtures.map(({ platform }) => ({ platform, state: "done", submissions: 1, errors: [] })),
      );
    } finally {
      await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
