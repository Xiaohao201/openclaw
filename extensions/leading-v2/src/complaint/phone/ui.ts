import { XMLParser, XMLValidator } from "fast-xml-parser";
export type PhoneNode = Record<string, string> & { path: string; disabled: string };
export function phoneBounds(node: PhoneNode): [number, number, number, number] | undefined {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.bounds);
  if (!match) {
    return undefined;
  }
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? [left, top, right, bottom] : undefined;
}
export function parsePhoneNodes(xml: string): PhoneNode[] {
  if (
    xml.length > 2000000 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  ) {
    throw new Error("Invalid phone hierarchy");
  }
  const tree: unknown = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: true,
  }).parse(xml);
  const result: PhoneNode[] = [];
  function visit(value: unknown, path: string, disabled: boolean, hidden: boolean) {
    if (!Array.isArray(value)) {
      return;
    }
    value.forEach((entry: unknown, index: number) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const record = entry as Record<string, unknown>;
      const raw = record[":@"];
      const attrs: Record<string, string> = {};
      if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === "string") {
            attrs[key] = value;
          }
        }
      }
      const currentPath = `${path}/${index}`;
      const currentDisabled = disabled || attrs.enabled === "false";
      const currentHidden = hidden || attrs["visible-to-user"] === "false";
      if ("node" in record && attrs.package === "com.xingin.xhs" && !currentHidden) {
        result.push({ ...attrs, path: currentPath, disabled: String(currentDisabled) });
      }
      for (const [key, children] of Object.entries(record)) {
        if (key !== ":@") {
          visit(children, currentPath, currentDisabled, currentHidden);
        }
      }
    });
  }
  visit(tree, "", false, false);
  if (
    result.some((node) =>
      /验证码|安全验证|滑块验证|登录后/.test(`${node.text ?? ""}${node["content-desc"] ?? ""}`),
    )
  ) {
    throw new Error("Phone verification required");
  }
  return result;
}
export function selectPhoneNode(
  nodes: PhoneNode[],
  label: string,
  resource?: string,
): PhoneNode | undefined {
  const matches = nodes.filter(
    (node) =>
      node.text === label ||
      node["content-desc"] === label ||
      (resource && node["resource-id"] === resource),
  );
  const controls = matches
    .filter(
      (node) =>
        !matches.some((parent) => parent !== node && node.path.startsWith(parent.path + "/")),
    )
    .filter((node) => {
      const box = phoneBounds(node);
      return box && box[2] - box[0] >= 24 && box[3] - box[1] >= 24;
    });
  if (controls.length > 1 || controls[0]?.disabled === "true") {
    throw new Error("Ambiguous or disabled phone control");
  }
  return controls[0];
}
