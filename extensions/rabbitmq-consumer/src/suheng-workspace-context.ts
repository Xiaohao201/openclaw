const SUHENG_WORKSPACE_CONTEXT = `[suheng-workspace]
夙衡工作区完整支持 Unicode 路径：
- 保留用户要求的中文目录名和文件名，不要转拼音、改英文或用哈希名规避；把路径当作不可拆分的值传递。
- 创建和写入文件优先使用 read/write/edit 等文件工具。不要把含中文、空格或引号的路径拼进 python -c、shell 源码或其他内联代码字符串。
- Python 必须通过 argv、环境变量或 UTF-8 JSON 接收路径和中文正文；路径读取采用 pathlib.Path(sys.argv[1])，文本读写显式使用 encoding="utf-8"。
- 生成 Python 源文件时只用 ASCII 单/双/三引号充当语法分隔符；中文引号“”‘’只能作为字符串内容。含引号的中文正文优先放在 UTF-8 JSON/文本数据文件中，不要手工嵌入 Python 字面量。
- 执行生成的 Python 文件前先运行 python -m py_compile；语法检查未通过时先修复，不能把失败归因于中文目录名。
[/suheng-workspace]
`;

const WORKSPACE_OR_ARTIFACT_TARGET =
  /(?:工作区|工作目录|工作文件夹|文件夹|目录|文件|文档|报告|脚本|代码|PPT|PowerPoint|Word|Excel|PDF|HTML|CSV|JSON|workspace|workdir|folder|directory|file|document|report|script|artifact)/iu;

const FILE_CREATION_ACTION =
  /(?:创建|新建|生成|制作|写入|保存|另存|导出|输出|落盘|命名|重命名|create|generate|build|write|save|export|name|rename)/iu;

const PYTHON_OR_QUOTE_SIGNAL = /(?:Python|\.py\b|中文引号|引号|quotation|quote)/iu;

/** Limit the extra guidance to turns that can create workspace artifacts. */
export function shouldInjectSuhengWorkspaceContext(message: string): boolean {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) {
    return false;
  }

  return (
    (FILE_CREATION_ACTION.test(normalizedMessage) &&
      WORKSPACE_OR_ARTIFACT_TARGET.test(normalizedMessage)) ||
    (PYTHON_OR_QUOTE_SIGNAL.test(normalizedMessage) &&
      WORKSPACE_OR_ARTIFACT_TARGET.test(normalizedMessage))
  );
}

/** Stable guidance for Unicode-safe workspace and generated-code handling. */
export function buildSuhengWorkspaceContext(message: string): string {
  return shouldInjectSuhengWorkspaceContext(message) ? SUHENG_WORKSPACE_CONTEXT : "";
}
