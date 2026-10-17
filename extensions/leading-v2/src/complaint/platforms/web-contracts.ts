export type WebContract = {
  menu?: string;
  hover?: boolean;
  entry: string;
  options: string;
  description?: string;
  descriptionLimit?: number;
  submit: string;
  success: string;
  next?: string;
  frame?: string;
  popup?: boolean;
  selected?: string;
};
const success = "text=提交成功";
/** Selectors ported from the legacy platform flows, with no execution at import time. */
export function webContract(platform: string, link: string): WebContract {
  const path = new URL(link).pathname;
  switch (platform) {
    case "xiaohongshu":
      return {
        menu: ".reds-icon.more",
        entry: "text=举报",
        options: "div.list-select-item-option",
        next: "text=下一步",
        description: "textarea.advice-input",
        submit: "text=提交",
        success,
      };
    case "kuaishou":
      return {
        ...(path.startsWith("/new-reco/")
          ? { menu: "(//img[@class='more-img'])[1]", entry: "div.more-item.report" }
          : { entry: "//span[@class='item-text' and text()='举报']" }),
        options: ".report-item-list-item",
        description: "textarea[placeholder*='请描述举报理由']",
        submit: "//button[normalize-space()='提交']",
        success,
      };
    case "bilibili":
      return path.startsWith("/video/")
        ? {
            menu: ".video-tool-more-reference",
            entry: "text=稿件举报",
            frame: 'iframe[name="appeal"]',
            options: "label",
            description: "textarea",
            submit: "text=提交",
            success,
          }
        : {
            menu: ".bili-dyn-more",
            entry: "text=举报",
            options: "span",
            description: "textarea.bili-dyn-report__remark__field",
            submit: "text=确定",
            success,
          };
    case "baidu":
      return {
        entry: path.startsWith("/video/")
          ? "(//span[contains(text(),'举报')])[1]"
          : "span[data-testid='report-btn']",
        options: "label",
        description: "textarea#fb_des_content",
        submit: "text=提交反馈",
        success,
      };
    case "toutiao":
      return {
        ...(path.startsWith("/video/")
          ? {
              menu: "button[aria-label='更多']",
              entry: "//button[contains(text(),'举报')]",
              description: "textarea[placeholder='请描述你遇到的问题']",
            }
          : { entry: ".detail-report i" }),
        options: "label",
        submit: "text=确认",
        success: "text=反馈成功",
      };
    case "zhihu":
      return {
        menu: path.startsWith("/question/")
          ? "(//div[@class='Popover ContentItem-action']//button)[1]"
          : ".Post-ActionMenuButton button",
        entry: "//button[normalize-space()='举报']",
        options: "div",
        description: "textarea[name='customReason']",
        submit: "//button[normalize-space()='提交举报']",
        success,
      };
    case "weibo":
      return {
        menu: "i[title='更多']",
        entry: '//div[@role="button" and .//div[text()="投诉"]]',
        popup: true,
        options: "a",
        description: "textarea[placeholder*='请详细填写']",
        submit: "//a[normalize-space()='提交']",
        success,
      };
    case "netease":
      return {
        entry: "a.post_jubao",
        popup: true,
        options: ".tag_code_list > label",
        description:
          "textarea[placeholder*='更多信息'], textarea[placeholder*='意见'], textarea[maxlength='100']",
        descriptionLimit: 100,
        selected: ".m_radio.checked",
        submit: "//button[normalize-space()='提交'] | //input[@type='submit']",
        success:
          "//*[contains(text(),'提交成功') or contains(text(),'反馈成功') or contains(text(),'您的反馈小编已收到')]",
      };
    case "eastmoney":
    case "tiantianfund":
      return {
        entry:
          platform === "tiantianfund"
            ? "a.graylink[href*='help.eastmoney.com/report_center.html'][href*='reportType=3'][href*='replyid=0']"
            : "a.jubao, a[href*='help.eastmoney.com/report_center.html']",
        popup: true,
        options: ".reportTypeList label.typeText",
        description: ".reportDescription textarea.desTextarea",
        descriptionLimit: 300,
        selected: "input[name='report_art']:checked",
        submit: "#confirmBtn",
        success: "text=您的举报已提交，我们将尽快处理",
      };
    case "tencent":
      return {
        entry: "a.report",
        options:
          "//*[normalize-space()='请选择举报原因']/following-sibling::div[not(.//*[normalize-space()='提交'])]",
        submit: "text=提交",
        success: "text=举报成功",
      };
    case "futu":
      return {
        menu: ".sns-operate-more",
        hover: true,
        entry: "[data-rep-click-Report]",
        options: ".report-dialog .sns-operate-items__item-title",
        selected: ".report-dialog .sns-operate-items__item-selected",
        description: ".sns-operate-input textarea",
        descriptionLimit: 200,
        submit: ".moo-dialog__box--visible .moo-dialog__footer .moo-button:last-child",
        success:
          "//*[contains(text(),'举报已提交') or contains(text(),'举报成功') or contains(text(),'已收到您的举报')]",
      };
    case "sohu":
      return {
        ...(new URL(link).hostname === "m.sohu.com"
          ? { menu: ".navbar-icon", entry: "a[href*='/feedback?'][href*='articleUrl=']:visible" }
          : { entry: "a.report-c[href*='/feedback?']" }),
        popup: true,
        options:
          ".report-content .question-item .reason-label, .report-container .question-item .reason-label",
        selected: ".radio-label.active-radio",
        description: "textarea.statement-input",
        descriptionLimit: 300,
        submit: ".button-submit.can-submit, .feedback-container .submit-button",
        success: "text=感谢反馈！已提交审核处理",
      };
    case "yidianzixun":
      return {
        entry: ".article-report",
        options: ".report-article-form li",
        selected: ".report-article-form li.actived-li",
        submit: ".report-article-form .btn-submit",
        success: "text=举报成功！",
      };
    case "sina":
      return new URL(link).hostname === "super.sina.cn"
        ? {
            entry: "",
            options: "#error-form label[for^='check-']",
            selected: "#error-form input[type='checkbox']:checked",
            description: "#error-form textarea[name='content']",
            descriptionLimit: 140,
            submit: "#error-form button.submit",
            success:
              "//div[contains(@class,'layer') and .//h4[contains(normalize-space(),'提交成功')]]",
          }
        : {
            entry: "",
            options: "form[bbs-node-type='reportForm'] .report-types-list label",
            selected: "input[name='reportType']:checked",
            submit: "form[bbs-node-type='reportForm'] #submit[bbs-node-type='submit']",
            success: "text=提交成功，我们会及时处理您的举报，谢谢！",
          };
    default:
      throw new Error("Unsupported web platform");
  }
}
