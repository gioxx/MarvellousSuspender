// @ts-check
// Runs inside the hidden offscreen document created by background.js's
// ensureOffscreenDocument(). navigator.getBattery() only exists in a Window context, not in
// the service worker, so this reads it here and relays the charging state back to the
// background via a normal runtime message — the only two-way bridge an offscreen document
// has to the rest of the extension.

navigator.getBattery().then((battery) => {
  const reportStatus = () => {
    chrome.runtime.sendMessage({ action: 'batteryStatus', charging: battery.charging });
  };
  reportStatus();
  battery.onchargingchange = reportStatus;
});
