"""Pure result and error models shared by browser and queue layers."""

from dataclasses import dataclass
from enum import Enum


class FlowStatus(str, Enum):
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    MANUAL_REQUIRED = "MANUAL_REQUIRED"
    UNKNOWN_SUBMIT_RESULT = "UNKNOWN_SUBMIT_RESULT"


class ErrorCode(str, Enum):
    NONE = "NONE"
    PAGE_NOT_FOUND = "PAGE_NOT_FOUND"
    TRANSIENT = "TRANSIENT"
    BROWSER_CLOSED = "BROWSER_CLOSED"
    LOGIN_REQUIRED = "LOGIN_REQUIRED"
    CAPTCHA_REQUIRED = "CAPTCHA_REQUIRED"
    MATERIAL_REQUIRED = "MATERIAL_REQUIRED"
    LOCATOR_NOT_FOUND = "LOCATOR_NOT_FOUND"
    LOCATOR_AMBIGUOUS = "LOCATOR_AMBIGUOUS"
    FORM_VALIDATION_FAILED = "FORM_VALIDATION_FAILED"
    SUBMIT_CONTRACT_CHANGED = "SUBMIT_CONTRACT_CHANGED"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class FlowResult:
    status: FlowStatus
    error_code: ErrorCode = ErrorCode.NONE
    step: str = ""
    retryable: bool = False
    healable: bool = False
    message: str = ""
    evidence_id: str = ""

    @property
    def success(self):
        return self.status == FlowStatus.SUCCEEDED

    @classmethod
    def succeeded(cls, message=""):
        return cls(FlowStatus.SUCCEEDED, message=message)

    @classmethod
    def from_legacy(cls, succeeded, message="", step=""):
        if succeeded:
            return cls.succeeded(message)
        lowered = str(message or "").lower()
        if not step:
            if "入口" in lowered:
                step = "OPEN_REPORT_ENTRY"
            elif "原因" in lowered or "类别" in lowered:
                step = "SELECT_REASON"
            elif "描述" in lowered or "说明" in lowered:
                step = "FILL_DESCRIPTION"
            elif "上传" in lowered or "图片" in lowered:
                step = "PREPARE_UPLOAD"
            elif "提交" in lowered:
                step = "FINAL_SUBMIT"
        if any(marker in lowered for marker in ("未找到页面", "内容不存在", "页面不存在")):
            return cls(
                FlowStatus.SUCCEEDED,
                ErrorCode.PAGE_NOT_FOUND,
                step=step,
                message=message,
            )
        if any(marker in lowered for marker in ("未登录", "登录状态", "必须先登录", "账号登录")):
            return cls(
                FlowStatus.MANUAL_REQUIRED,
                ErrorCode.LOGIN_REQUIRED,
                step=step,
                message=message,
            )
        if any(marker in lowered for marker in ("验证码", "安全验证", "滑块", "风控")):
            return cls(
                FlowStatus.MANUAL_REQUIRED,
                ErrorCode.CAPTCHA_REQUIRED,
                step=step,
                message=message,
            )
        if any(marker in lowered for marker in ("实名", "证明材料", "营业执照", "授权书", "人工")):
            return cls(
                FlowStatus.MANUAL_REQUIRED,
                ErrorCode.MATERIAL_REQUIRED,
                step=step,
                message=message,
            )
        if any(marker in lowered for marker in ("重复提交保护", "提交结果未知", "unknown_submit")):
            return cls(
                FlowStatus.UNKNOWN_SUBMIT_RESULT,
                ErrorCode.SUBMIT_CONTRACT_CHANGED,
                step=step,
                message=message,
            )
        if "未找到匹配" in lowered and any(
                marker in lowered for marker in ("原因", "类别")):
            return cls(
                FlowStatus.FAILED,
                ErrorCode.FORM_VALIDATION_FAILED,
                step=step,
                message=message,
            )
        if any(marker in lowered for marker in ("未找到", "选择失败", "定位", "selector")):
            return cls(
                FlowStatus.FAILED,
                ErrorCode.LOCATOR_NOT_FOUND,
                step=step,
                healable=True,
                message=message,
            )
        if any(marker in lowered for marker in ("超时", "timeout", "连接", "temporar")):
            return cls(
                FlowStatus.FAILED,
                ErrorCode.TRANSIENT,
                step=step,
                retryable=True,
                message=message,
            )
        return cls(
            FlowStatus.FAILED,
            ErrorCode.UNKNOWN,
            step=step,
            message=message,
        )
