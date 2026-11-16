(() => {
  "use strict";
  const DEFAULT_SELECTORS = [
    '[role="article"][aria-labelledby^="copilot-message-"]',
    '[data-content="ai-message"]',
    '[data-testid="ai-message-item"]',
    '[data-testid="ai-message"]',
    '[data-testid="assistant-message"]',
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]'
  ];
  const CLOSED = "data-copilot-fold-closed";
  const USER = '[data-content="user-message"], [data-message-author-role="user"], [data-role="user"], [role="article"][aria-labelledby^="user-message-"]';
  const records = new Map();
  const pending = new Set();
  const dirtyPreviews = new Set();
  let enabled = true;
  let selector = DEFAULT_SELECTORS.join(",");
  let customSelector = "";
  let selectorError = "";
  let latest = null;
  let active = null;
  let timer = null;
  let serial = 0;
  let observer;

  function configureSelector(value) {
    customSelector = typeof value === "string" ? value.trim() : "";
    selectorError = "";
    selector = DEFAULT_SELECTORS.join(",");
    if (!customSelector) return;
    try {
      document.querySelector(customSelector);
      selector = customSelector;
    } catch {
      selectorError = "検出セレクターの形式が正しくありません。標準設定を使用しています。";
    }
  }

  function safeMatch(node) {
    return node instanceof Element && node.matches(selector) &&
      !node.matches("html, body, main, form, input, textarea, button, [contenteditable='true']") &&
      !node.closest(".copilot-fold-toggle") &&
      !node.matches(USER) && !node.querySelector(USER) &&
      !node.querySelector("textarea, [contenteditable='true']");
  }

  function setOpen(node, open) {
    const record = records.get(node);
    if (!record) return;
    node.setAttribute(CLOSED, String(!open));
    record.button.setAttribute("aria-expanded", String(open));
    record.arrow.textContent = open ? "▾" : "▸";
  }

  function activate(node, keepPosition = false) {
    const anchor = records.get(node)?.button;
    const before = keepPosition && anchor ? anchor.getBoundingClientRect().top : null;
    if (active && active !== node) setOpen(active, false);
    active = node;
    if (node) setOpen(node, true);
    // Compensate inside the actual scrolling ancestor, including nested chat panels.
    if (before !== null && anchor.isConnected) {
      const delta = anchor.getBoundingClientRect().top - before;
      if (delta) {
        let parent = anchor.parentElement;
        while (parent && parent !== document.scrollingElement) {
          if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
            parent.scrollTop += delta;
            return;
          }
          parent = parent.parentElement;
        }
        document.scrollingElement.scrollTop += delta;
      }
    }
  }

  function updatePreview(node) {
    const record = records.get(node);
    if (!record) return;
    // Read only a short prefix; do not traverse long answers on every streamed token.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(text) {
        return text.parentElement.closest("script, style, button, [aria-hidden='true'], [id^='copilot-message-'][id$='-title']")
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let text = "";
    while (text.length < 100 && walker.nextNode()) text += walker.currentNode.textContent.slice(0, 100 - text.length) + " ";
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 90) || "クリックして回答を表示";
    if (record.preview.textContent !== preview) record.preview.textContent = preview;
  }

  function attach(node) {
    if (records.has(node) || !node.parentElement) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copilot-fold-toggle";
    const arrow = document.createElement("span");
    arrow.className = "copilot-fold-arrow";
    arrow.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "copilot-fold-label";
    label.textContent = "Copilot の回答";
    const preview = document.createElement("span");
    preview.className = "copilot-fold-preview";
    button.append(arrow, label, preview);
    const originalId = node.getAttribute("id");
    if (!originalId) node.id = `copilot-fold-answer-${++serial}`;
    button.setAttribute("aria-controls", node.id);
    records.set(node, { button, arrow, preview, originalId, originalClosed: node.getAttribute(CLOSED) });
    node.before(button);
    setOpen(node, false);
    updatePreview(node);
  }

  function detach(node) {
    const record = records.get(node);
    if (!record) return;
    record.button.remove();
    if (record.originalClosed === null) node.removeAttribute(CLOSED);
    else node.setAttribute(CLOSED, record.originalClosed);
    if (record.originalId === null) node.removeAttribute("id");
    records.delete(node);
    if (active === node) active = null;
  }

  function discover(root) {
    if (!(root instanceof Element) && root !== document) return;
    const matches = [...root.querySelectorAll(selector)];
    if (root instanceof Element && root.matches(selector)) matches.unshift(root);
    for (const node of matches) {
      if (!safeMatch(node)) continue;
      let parent = node.parentElement;
      let nested = false;
      while (parent) {
        if (records.has(parent) || safeMatch(parent)) { nested = true; break; }
        parent = parent.parentElement;
      }
      if (nested) continue;
      // A response wrapper may arrive after its inner content.
      for (const known of records.keys()) if (known !== node && node.contains(known)) detach(known);
      attach(node);
    }
  }

  function flush() {
    timer = null;
    if (!enabled) { pending.clear(); dirtyPreviews.clear(); return; }
    // Disconnect during our own writes to avoid observer feedback loops.
    observer.disconnect();
    try {
      for (const node of records.keys()) {
        // Avoid traversing every hidden response subtree on each streamed update.
        if (!node.isConnected || !node.matches(selector) || node.matches(USER)) detach(node);
      }
      for (const root of pending) if (root === document || root.isConnected) discover(root);
      pending.clear();
      let newest = null;
      for (const [node, record] of records) {
        // Tabster inserts focus sentinels beside articles. Moving the button on
        // every insertion fights its observer and can move a pressed control.
        if (record.button.parentElement !== node.parentElement ||
            !(record.button.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          node.before(record.button);
        }
        if (!newest || (newest.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) newest = node;
      }
      if (newest !== latest) {
        // Prepending older history must not steal the user's selected answer.
        const isNewer = !latest?.isConnected || !records.has(latest) ||
          (latest.compareDocumentPosition(newest) & Node.DOCUMENT_POSITION_FOLLOWING);
        latest = newest;
        if (newest && isNewer) activate(newest);
      }
      // Hidden history can hydrate after we attach. Refresh only responses whose
      // content changed, without rendering them or scanning unrelated answers.
      for (const node of dirtyPreviews) if (node.isConnected) updatePreview(node);
      dirtyPreviews.clear();
    } finally { observe(); }
  }

  function schedule(root) {
    if (root) pending.add(root);
    if (timer === null) timer = setTimeout(flush, 100);
  }

  function observe() {
    if (enabled) observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["data-content", "data-testid", "data-message-author-role", "data-role", "role", "aria-labelledby"]
    });
  }

  function reset(settings) {
    observer.disconnect();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending.clear();
    dirtyPreviews.clear();
    for (const node of records.keys()) detach(node);
    latest = active = null;
    enabled = settings.enabled !== false;
    configureSelector(settings.customSelector);
    if (enabled) { pending.add(document); flush(); }
  }

  observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      let element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (element?.closest(".copilot-fold-toggle")) continue;
      while (element) {
        if (records.has(element)) { dirtyPreviews.add(element); break; }
        element = element.parentElement;
      }
      if (mutation.type === "attributes") pending.add(mutation.target);
      else if (mutation.type === "childList") {
        for (const added of mutation.addedNodes) if (added instanceof Element) pending.add(added);
      }
    }
    schedule();
  });

  // Capture before the site's React/Tabster handlers. Native button activation
  // still supports Enter/Space and clicks on the label, arrow, or preview.
  window.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest(".copilot-fold-toggle") : null;
    if (!enabled || !button) return;
    const node = document.getElementById(button.getAttribute("aria-controls"));
    if (!node || records.get(node)?.button !== button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (active === node) { setOpen(node, false); active = null; }
    else activate(node, true);
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "copilot-fold-status") sendResponse({
      enabled, count: records.size, collapsed: [...records.keys()].filter(n => n !== active).length,
      selectorError, customSelector
    });
    if (message.type === "copilot-fold-latest" && latest) activate(latest, true);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !("enabled" in changes || "customSelector" in changes)) return;
    chrome.storage.local.get({ enabled: true, customSelector: "" }).then(reset);
  });
  chrome.storage.local.get({ enabled: true, customSelector: "" }).then(reset);
})();
