"""Strict, in-memory browser fixtures. No browser process or network is used.

These model the adapter's page contract, not the current third-party website.
Unknown selectors are absent; forms, choices, and receipts are stateful.
"""

from contextlib import contextmanager
from dataclasses import dataclass, field
from types import SimpleNamespace


def text_key(value):
    return ("text", value)


def role_key(role, name):
    return ("role", role, name)


@dataclass
class Element:
    text: str = ""
    stage: int = 0
    action: object = None
    attrs: dict = field(default_factory=dict)
    checked: bool = False
    enabled: bool = True
    visible: bool = True
    children: dict = field(default_factory=dict)
    frame: object = None


class Locator:
    def __init__(self, page, key, elements):
        self.page, self.key, self.elements = page, key, elements

    @property
    def first(self):
        return self.nth(0)

    @property
    def last(self):
        return Locator(self.page, self.key, self.elements[-1:])

    def nth(self, index):
        return Locator(self.page, self.key, self.elements[index:index + 1])

    def count(self):
        return len(self.elements)

    def all(self):
        return [self.nth(index) for index in range(self.count())]

    def node(self):
        if not self.elements:
            raise RuntimeError(f"Missing fixture element: {self.key}")
        return self.elements[0]

    def wait_for(self, state="visible", **kwargs):
        node = self.node()
        if node.stage > self.page.state.stage:
            raise RuntimeError(f"Element used before opening form: {self.key}")
        if state == "visible" and not node.visible:
            raise RuntimeError(f"Hidden element: {self.key}")
        return self

    def is_visible(self):
        return bool(self.elements and self.node().visible and
                    self.node().stage <= self.page.state.stage)

    def is_enabled(self):
        return self.node().enabled

    def inner_text(self, **kwargs):
        self.wait_for()
        return self.node().text

    def all_inner_texts(self):
        return [node.text for node in self.elements]

    all_text_contents = all_inner_texts

    def click(self, **kwargs):
        self.wait_for()
        if not self.is_enabled():
            raise RuntimeError(f"Disabled element: {self.key}")
        self.page.state.events.append(("click", self.key))
        if self.node().action:
            self.node().action()

    def hover(self, **kwargs):
        self.wait_for()
        self.page.state.events.append(("hover", self.key))

    def fill(self, value, **kwargs):
        self.wait_for()
        self.page.fields[self.key] = value
        self.page.state.events.append(("fill", self.key))

    def select_option(self, value):
        self.fill(value)

    def check(self, **kwargs):
        self.wait_for()
        self.node().checked = True

    def is_checked(self):
        return self.node().checked

    def get_attribute(self, name):
        return self.node().attrs.get(name)

    def locator(self, key):
        return Locator(self.page, key, self.node().children.get(key, []))

    @property
    def content_frame(self):
        self.wait_for()
        if self.node().frame is None:
            raise RuntimeError("Fixture has no frame")
        return self.node().frame

    def evaluate(self, script):
        if script in ("element => element.click()", "el => el.click()",
                      "(element) => element.click()"):
            self.click()
            return None
        raise AssertionError(f"Unexpected element script: {script}")

    def evaluate_all(self, script):
        if script == "els => els.map(el => el.content || '')":
            return [node.attrs.get("content", "") for node in self.elements]
        raise AssertionError(f"Unexpected list script: {script}")


class Page:
    def __init__(self, state=None):
        self.state = state or SimpleNamespace(
            stage=0, submissions=0, receipt=True, events=[])
        self.nodes = {}
        self.fields = {}
        self.url = "about:blank"
        self.page_title = ""
        self.closed = False
        self.context = SimpleNamespace(pages=[self])
        self.popup = None
        self.redirects = {}
        self.scripts = {}
        self.html = "<html></html>"

    def add(self, key, text="", **kwargs):
        node = Element(text=text, **kwargs)
        self.nodes[key] = [node]
        return node

    def locator(self, key):
        return Locator(self, key, self.nodes.get(key, []))

    def get_by_text(self, value, **kwargs):
        return self.locator(text_key(value))

    def get_by_role(self, role, name, **kwargs):
        return self.locator(role_key(role, name))

    def wait_for_selector(self, key, **kwargs):
        return self.locator(key).wait_for(**kwargs)

    def goto(self, url, **kwargs):
        self.url = self.redirects.get(url, url)
        self.state.events.append(("goto", self.url))
        if "/blank/report_news.shtml" in url or "/activities/feedback.d.html" in url:
            self.state.stage = 1

    def wait_for_timeout(self, milliseconds):
        pass

    def wait_for_load_state(self, *args, **kwargs):
        pass

    def wait_for_function(self, script, **kwargs):
        if script not in self.scripts or not self.evaluate(script):
            raise RuntimeError(f"Missing readiness script fixture: {script}")

    def evaluate(self, script, *args):
        if script not in self.scripts:
            raise AssertionError(f"Unexpected page script: {script}")
        value = self.scripts[script]
        return value() if callable(value) else value

    def content(self):
        return self.html

    def title(self):
        return self.page_title

    def close(self):
        self.closed = True

    def is_closed(self):
        return self.closed

    @contextmanager
    def expect_popup(self):
        if self.popup is None:
            raise RuntimeError("No popup fixture")
        yield SimpleNamespace(value=self.popup)

    def open_form(self):
        self.state.stage = 1
        if self.popup:
            self.context.pages.append(self.popup)

    def choose(self):
        self.state.stage = 2

    def submit(self):
        if self.state.stage != 2:
            raise RuntimeError("Submit before choosing a reason")
        self.state.submissions += 1
        self.state.stage = 3

    def receipt(self, selector):
        node = self.add(selector, "receipt", stage=3)
        # Receipt is only visible after a simulated submit, and can be withheld.
        node.visible = self.state.receipt
