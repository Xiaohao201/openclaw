"""Transparent Playwright proxies that add versioned locator fallback to every platform."""

from .schemas import QueryDescriptor


_HEALABLE_METHODS = frozenset({
    "click", "fill", "hover", "wait_for", "check",
    "inner_text", "input_value", "is_visible", "is_enabled", "is_checked",
})


class HealingLocator:
    def __init__(
        self, manager, platform, scope, page, descriptor, raw_locator,
        transform=(), profile_id=None,
    ):
        self.manager = manager
        self.platform = platform
        self.scope = scope
        self.page = page
        self.descriptor = descriptor
        self.raw = raw_locator
        self.transform = tuple(transform)
        self.profile_id = profile_id

    def _clone(self, raw, transform):
        return HealingLocator(
            self.manager, self.platform, self.scope, self.page,
            self.descriptor, raw, transform, self.profile_id,
        )

    @property
    def first(self):
        return self._clone(self.raw.first, self.transform + (("first", None),))

    @property
    def last(self):
        return self._clone(self.raw.last, self.transform + (("last", None),))

    def nth(self, index):
        return self._clone(self.raw.nth(index), self.transform + (("nth", int(index)),))

    def locator(self, selector, *args, **kwargs):
        return self._clone(
            self.raw.locator(selector, *args, **kwargs),
            self.transform + (("locator", (selector, args, kwargs)),),
        )

    @property
    def content_frame(self):
        return HealingScope(
            self.manager, self.platform, self.raw.content_frame, self.page
        )

    def _apply_transform(self, locator):
        current = locator
        for kind, value in self.transform:
            if kind == "first":
                current = current.first
            elif kind == "last":
                current = current.last
            elif kind == "nth":
                current = current.nth(value)
            elif kind == "locator":
                selector, args, kwargs = value
                current = current.locator(selector, *args, **kwargs)
        return current

    def _invoke(self, method, *args, **kwargs):
        terminal = (
            method == "click"
            and self.manager.is_terminal(self.descriptor, self.platform)
        )
        if terminal:
            self.manager.before_terminal_action(self.platform, self.descriptor)
        try:
            result = getattr(self.raw, method)(*args, **kwargs)
            if terminal:
                self.manager.after_terminal_action(self.platform, attempted=True)
            else:
                self.manager.record_locator_success(
                    self.platform, self.descriptor, self.page, method
                )
            if self.profile_id:
                self.manager.registry.record_result(self.profile_id, True)
            return result
        except Exception as original:
            if terminal:
                self.manager.after_terminal_action(self.platform, attempted=True)
            if self.profile_id:
                self.manager.registry.record_result(
                    self.profile_id, False, str(original)
                )
            repaired, profile_id = self.manager.repair_locator(
                self.platform,
                self.scope,
                self.page,
                self.descriptor,
                method,
                str(original),
            )
            if repaired is None:
                raise
            repaired = self._apply_transform(repaired)
            result = getattr(repaired, method)(*args, **kwargs)
            if profile_id:
                self.manager.registry.record_result(profile_id, True)
            return result

    def count(self):
        count = self.raw.count()
        if count == 0:
            self.manager.record_query(
                self.platform, self.descriptor, "zero_count"
            )
        return count

    def click(self, *args, **kwargs):
        return self._invoke("click", *args, **kwargs)

    def fill(self, *args, **kwargs):
        return self._invoke("fill", *args, **kwargs)

    def hover(self, *args, **kwargs):
        return self._invoke("hover", *args, **kwargs)

    def wait_for(self, *args, **kwargs):
        return self._invoke("wait_for", *args, **kwargs)

    def check(self, *args, **kwargs):
        return self._invoke("check", *args, **kwargs)

    def set_input_files(self, *args, **kwargs):
        # Upload controls and file paths are immutable safety boundaries.
        return self.raw.set_input_files(*args, **kwargs)

    def inner_text(self, *args, **kwargs):
        return self._invoke("inner_text", *args, **kwargs)

    def input_value(self, *args, **kwargs):
        return self._invoke("input_value", *args, **kwargs)

    def is_visible(self, *args, **kwargs):
        return self._invoke("is_visible", *args, **kwargs)

    def is_enabled(self, *args, **kwargs):
        return self._invoke("is_enabled", *args, **kwargs)

    def is_checked(self, *args, **kwargs):
        return self._invoke("is_checked", *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self.raw, name)


class HealingScope:
    def __init__(self, manager, platform, raw, page):
        self.manager = manager
        self.platform = platform
        self.raw = raw
        self.page = page

    def _wrap(self, descriptor, raw_locator):
        active, profile_id = self.manager.active_locator(
            self.platform, self.raw, descriptor
        )
        return HealingLocator(
            self.manager,
            self.platform,
            self.raw,
            self.page,
            descriptor,
            active if active is not None else raw_locator,
            profile_id=profile_id,
        )

    def locator(self, selector, *args, **kwargs):
        descriptor = QueryDescriptor("css", value=str(selector))
        return self._wrap(
            descriptor, self.raw.locator(selector, *args, **kwargs)
        )

    def get_by_text(self, text, *args, **kwargs):
        descriptor = QueryDescriptor(
            "text", value=str(text), exact=kwargs.get("exact", False) is True
        )
        return self._wrap(
            descriptor, self.raw.get_by_text(text, *args, **kwargs)
        )

    def get_by_role(self, role, *args, **kwargs):
        descriptor = QueryDescriptor(
            "role",
            role=str(role),
            name=str(kwargs.get("name", "")),
            exact=kwargs.get("exact", False) is True,
        )
        return self._wrap(
            descriptor, self.raw.get_by_role(role, *args, **kwargs)
        )

    def get_by_label(self, text, *args, **kwargs):
        descriptor = QueryDescriptor(
            "label", value=str(text), exact=kwargs.get("exact", False) is True
        )
        return self._wrap(
            descriptor, self.raw.get_by_label(text, *args, **kwargs)
        )

    def get_by_placeholder(self, text, *args, **kwargs):
        descriptor = QueryDescriptor(
            "placeholder", value=str(text), exact=kwargs.get("exact", False) is True
        )
        return self._wrap(
            descriptor, self.raw.get_by_placeholder(text, *args, **kwargs)
        )

    def __getattr__(self, name):
        return getattr(self.raw, name)


class HealingContext:
    def __init__(self, manager, platform, raw):
        self.manager = manager
        self.platform = platform
        self.raw = raw

    @property
    def pages(self):
        return [self.manager.wrap_page(self.platform, page) for page in self.raw.pages]

    def new_page(self, *args, **kwargs):
        return self.manager.wrap_page(
            self.platform, self.raw.new_page(*args, **kwargs)
        )

    def __getattr__(self, name):
        return getattr(self.raw, name)


class HealingPage(HealingScope):
    def __init__(self, manager, platform, raw):
        super().__init__(manager, platform, raw, raw)
        self._context = HealingContext(manager, platform, raw.context)

    @property
    def context(self):
        return self._context

    def __hash__(self):
        return hash(id(self.raw))

    def __eq__(self, other):
        return isinstance(other, HealingPage) and self.raw is other.raw
