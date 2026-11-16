"use strict";
const enabled = document.getElementById("enabled");
const selector = document.getElementById("selector");
const status = document.getElementById("status");
const latest = document.getElementById("latest");
const feedback = document.getElementById("feedback");

async function send(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return chrome.tabs.sendMessage(tab.id, { type });
}
async function refresh() {
  try {
    const result = await send("copilot-fold-status");
    latest.disabled = !result.enabled || result.count === 0;
    status.textContent = result.selectorError || (!result.enabled ? "折りたたみは無効です。" :
      result.count ? `${result.count} 件の回答を検出・${result.collapsed} 件を折りたたみ中` :
      "回答が見つかりません。会話を開いてください。画面構造によっては検出設定の調整が必要です。");
  } catch {
    latest.disabled = true;
    status.textContent = "Copilotのタブで開いてください。導入直後はページを再読み込みしてください。";
  }
}
enabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ enabled: enabled.checked });
  setTimeout(refresh, 150);
});
document.getElementById("save").addEventListener("click", async () => {
  const value = selector.value.trim();
  try { if (value) document.querySelector(value); }
  catch { feedback.textContent = "セレクターの形式を確認してください。"; return; }
  await chrome.storage.local.set({ customSelector: value });
  feedback.textContent = "保存しました。開いているCopilotに反映します。";
  setTimeout(refresh, 150);
});
latest.addEventListener("click", async () => { try { await send("copilot-fold-latest"); await refresh(); } catch { await refresh(); } });
chrome.storage.local.get({ enabled: true, customSelector: "" }).then(settings => {
  enabled.checked = settings.enabled;
  selector.value = settings.customSelector;
  refresh();
});
