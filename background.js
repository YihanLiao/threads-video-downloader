chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url.startsWith("https://www.threads.com")) {
    await chrome.scripting.executeScript({
      files: ["execute.js"],
      target: { tabId: tab.id },
    });
  }
});
