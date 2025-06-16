/*
 * The Great Suspender
 * Copyright (C) 2017 Dean Oemcke
 * Available under GNU GENERAL PUBLIC LICENSE v2
 * http://github.com/greatsuspender/thegreatsuspender
 * ლ(ಠ益ಠლ)
*/
(function() {
  'use strict';

  let isFormListenerInitialised = false;
  let isReceivingFormInput = false;
  let isIgnoreForms = false;
  let tempWhitelist = false;

  function formInputListener(event) {
    if (!isReceivingFormInput && !tempWhitelist) {
      if (event.keyCode >= 48 && event.keyCode <= 90 && event.target.tagName) {
        if (
          event.target.tagName.toUpperCase() === 'INPUT' ||
          event.target.tagName.toUpperCase() === 'TEXTAREA' ||
          event.target.tagName.toUpperCase() === 'FORM' ||
          event.target.isContentEditable === true ||
          event.target.type === "application/pdf"
        ) {
          isReceivingFormInput = true;
          if (!isBackgroundConnectable()) {
            return false;
          }
          chrome.runtime.sendMessage(buildReportTabStatePayload());
        }
      }
    }
  }

  function initFormInputListener() {
    if (isFormListenerInitialised) {
      return;
    }
    window.addEventListener('keydown', formInputListener);
    isFormListenerInitialised = true;
  }

  function init() {
    console.log('init');
    //listen for background events

    chrome.runtime.onMessage.addListener(( request, sender, sendResponse ) => {
      console.log('onMessage', request);
      if (request.hasOwnProperty('action')) {
        if (request.action === 'requestInfo') {
          sendResponse(buildReportTabStatePayload());
          return false;
        }
      }

      if (request.hasOwnProperty('scrollPos')) {
        if (request.scrollPos !== '' && request.scrollPos !== '0') {
          document.body.scrollTop = request.scrollPos;
          document.documentElement.scrollTop = request.scrollPos;
        }
      }

      if (request.hasOwnProperty('ignoreForms')) {
        isIgnoreForms = request.ignoreForms;
        if (isIgnoreForms) {
          initFormInputListener();
        }
        isReceivingFormInput = isReceivingFormInput && isIgnoreForms;
      }

      if (request.hasOwnProperty('tempWhitelist')) {
        if (isReceivingFormInput && !request.tempWhitelist) {
          isReceivingFormInput = false;
        }
        tempWhitelist = request.tempWhitelist;
      }

      sendResponse(buildReportTabStatePayload());
      return false;
    });
  }

  function waitForRuntimeReady(retries) {
    console.log('waitForRuntimeReady');
    retries = retries || 0;
    return new Promise((resolve) => resolve(chrome.runtime)).then((chromeRuntime) => {
      if (chromeRuntime) {
        console.log('waitForRuntimeReady ready');
        return Promise.resolve();
      }
      if (retries > 3) {
        console.log('waitForRuntimeReady reject');
        return Promise.reject('Failed waiting for chrome.runtime');
      }
      retries += 1;
      console.log('waitForRuntimeReady retries', retries);
      return new Promise(resolve => setTimeout(resolve, 500)).then(() =>
        waitForRuntimeReady(retries)
      );
    });
  }

  function isBackgroundConnectable() {
    try {
      var port = chrome.runtime.connect();
      if (port) {
        port.disconnect();
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function buildReportTabStatePayload() {
    return {
      action: 'reportTabState',
      status:
        isIgnoreForms && isReceivingFormInput
          ? 'formInput'
          : tempWhitelist
            ? 'tempWhitelist'
            : 'normal',
      scrollPos:
        (document.body || document.documentElement || {}).scrollTop || 0,
    };
  }

  waitForRuntimeReady()
    .then(init)
    .catch(e => {
      console.error(e);
      setTimeout(() => {
        init();
      }, 200);
    });
})();
