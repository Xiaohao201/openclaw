"""UI tree matching for XHS: merge ancestor labels, never unrelated controls."""
import re
import xml.etree.ElementTree as ET


class PhoneFailure(Exception):
    pass


def bounds(node):
    match = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if not match:
        return None
    left, top, right, bottom = map(int, match.groups())
    return (left, top, right, bottom) if right > left and bottom > top else None


def parse_nodes(xml, package):
    if len(xml) > 2_000_000 or '<!DOCTYPE' in xml or '<!ENTITY' in xml:
        raise PhoneFailure('手机界面数据无效。')
    result = []

    def visit(element, path=(), disabled=False, hidden=False):
        disabled = disabled or element.get('enabled') == 'false'
        hidden = hidden or element.get('visible-to-user') == 'false'
        if element.tag == 'node' and element.get('package') == package and not hidden:
            result.append(dict(element.attrib, _path=path, _disabled=disabled))
        for index, child in enumerate(element):
            visit(child, (*path, index), disabled, hidden)

    visit(ET.fromstring(xml))
    texts = [text for node in result for text in
             (node.get('text', ''), node.get('content-desc', ''))]
    if any(any(marker in text for marker in ('验证码', '安全验证', '滑块验证', '登录后'))
           for text in texts):
        raise PhoneFailure('手机需要登录或安全验证，请人工完成。')
    return result


def select_node(nodes, label, resource_id=None):
    matches = [node for node in nodes if
               (label in (node.get('text'), node.get('content-desc')) or
                (resource_id and node.get('resource-id') == resource_id))]
    # A button and its text child represent one target. Two sibling buttons do not.
    matches = [node for node in matches if not any(
        other is not node and '_path' in other and '_path' in node
        and len(other['_path']) < len(node['_path'])
        and node['_path'][:len(other['_path'])] == other['_path']
        for other in matches)]
    visible = []
    for node in matches:
        box = bounds(node)
        if box and box[2] - box[0] >= 24 and box[3] - box[1] >= 24:
            visible.append(node)
    if len(visible) > 1:
        raise PhoneFailure('手机界面存在多个独立选项：' + label[:80])
    if not visible:
        return None
    node = visible[0]
    if node.get('_disabled') or node.get('enabled') == 'false':
        raise PhoneFailure('手机选项不可用：' + label[:80])
    return node
