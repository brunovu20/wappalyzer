
(function () {
  function isChrome() {
    return (typeof chrome !== 'undefined'
				&& window.navigator.userAgent.match(/Chrom(?:e|ium)\/([0-9\.]+)/));
  }

  let browserProxy;
  if (isChrome()) {
    browserProxy = chrome;
  } else {
    browserProxy = browser;
  }

  const MIN_FF_MAJOR_VERSION = 51;

  const requiredBrowserApis = [
    browserProxy.webNavigation,
    browserProxy.tabs,
    browserProxy.webRequest,
    browserProxy.runtime,
  ];
  let areListenersRegistered = false;
  const secBefore = 2000;
  const secAfter = 5000;
  const secBetweenDupAssets = 10e3;
  const minVidSize = 500e3;
  const maxVidSize = 25e6;
  const maxContentRange = 25e6;
  const videoExtensions = [
    'af', '3gp', 'asf', 'avchd', 'avi', 'cam', 'dsh', 'flv', 'm1v', 'm2v',
    'fla', 'flr', 'sol', 'm4v', 'mkv', 'wrap', 'mng', 'mov', 'mpeg', 'mpg',
    'mpe', 'mp4', 'mxf', 'nsv', 'ogg', 'rm', 'svi', 'smi', 'wmv', 'webm',
  ];
  const extensionsReg = new RegExp(`\\.${videoExtensions.join('$|\\.')}$`);
  const videoContentTypesPrefixes = ['binary/octet-stream', 'video/', 'flv-application/', 'media'];

  const bannedContentTypes = ['video/mp2t', 'video/f4m', 'video/f4f'];
  const bannedFiletypes = ['ts'];
  const bannedFiletypesReg = new RegExp(`\\.${bannedFiletypes.join('$|\\.')}$`);
  const whitelistReqTypes = ['object', 'xmlhttprequest', 'other'];

  const topVideoAssetDomains = [
    '2mdn.net',
    'adap.tv',
    'adnxs.com',
    'adsrvr.org',
    'btrll.com',
    'celtra.com',
    'flashtalking.com',
    'flite.com',
    'innovid.com',
    'jivox.com',
    'mixpo.com',
    'nytimes.com',
    'playwire.com',
    'selectmedia.asia',
    'serving-sys.com',
    'solvemedia.com',
    'spotible.com',
    'teads.tv',
    'tribalfusion.com',
    'tubemogul.com',
    'videologygroup.com',
    'washingtonpost.com',
  ];

  const robotsTxtAllows = wappalyzer.robotsTxtAllows.bind(wappalyzer);
  if (!String.prototype.endsWith) {
    String.prototype.endsWith = function (searchString, position) {
      const subjectString = this.toString();
      if (typeof position !== 'number' || !isFinite(position)
				|| Math.floor(position) !== position || position > subjectString.length) {
        position = subjectString.length;
      }
      position -= searchString.length;
      const lastIndex = subjectString.indexOf(searchString, position);
      return lastIndex !== -1 && lastIndex === position;
    };
  }

  function getFrame(getFrameDetails, callback) {
    if (typeof chrome !== 'undefined') {
      chrome.webNavigation.getFrame(getFrameDetails, callback);
    } else if (typeof browser !== 'undefined') {
      const gettingFrame = browser.webNavigation.getFrame(getFrameDetails);
      gettingFrame.then(callback);
    }
  }

  function ifBrowserValid(callback, elseCallback) {
    if (isChrome()) {
      callback();
    } else if (typeof browser !== 'undefined') {
      try {
        const gettingInfo = browser.runtime.getBrowserInfo();
        gettingInfo.then((browserInfo) => {
          const browserVersion = parseInt(browserInfo.version.split('.')[0]);

          if (browserInfo.name === 'Firefox'
						&& browserVersion >= MIN_FF_MAJOR_VERSION) {
            callback();
          } else {
            elseCallback();
          }
        });
      } catch (err) {
        elseCallback();
      }
    } else {
      elseCallback();
    }
  }

  function ifTrackingEnabled(details, ifCallback, elseCallback) {
    const fullIfCallback = function () {
      allowedByRobotsTxt(details, ifCallback, elseCallback);
    };

    browser.storage.local.get('tracking').then((item) => {
      if (item.hasOwnProperty('tracking')) {
        if (item.tracking) {
          fullIfCallback();
        } else {
          elseCallback();
        }
      } else {
        fullIfCallback();
      }
    });
  }

  function allowedByRobotsTxt(details, ifCallback, elseCallback) {
    if (details.url && !details.url.startsWith('chrome://')) {
      robotsTxtAllows(details.url).then(ifCallback, elseCallback);
    } else {
      elseCallback();
    }
  }

  function isPixelRequest(request) {
    return (request.type === 'image' || request.responseStatus === 204)
				&& request.size <= 1000;
  }

  function isVpaidOrVastRequest(request) {
    const lowerCaseUrl = request.url.toLowerCase();
    return lowerCaseUrl.indexOf('vpaid') !== -1 || lowerCaseUrl.indexOf('vast') !== -1;
  }

  function hasValidRequestType(request) {
    return whitelistReqTypes.indexOf(request.type) >= 0;
  }

  function stripQueryParams(url) {
    return url.split('?', 1)[0];
  }

  function parseHostnameFromUrl(url) {
    const parser = document.createElement('a');
    parser.href = url;
    return parser.hostname;
  }

  function hasDomain(url, domain) {
    return parseHostnameFromUrl(url).endsWith(domain);
  }

  function findHeader(headers, key) {
    let header;
    for (let i = 0; i < headers.length; i += 1) {
      header = headers[i];
      if (header.name.toLowerCase() === key) {
        return header;
      }
    }
    return null;
  }

  function validVideoType(vtype) {
    const goodType = videoContentTypesPrefixes.some(prefix => vtype.indexOf(prefix) === 0);
    return goodType;
  }

  function assetMsgKey(assetReq) {
    const url = stripQueryParams(assetReq.url);
    const key = `${assetReq.frameId}-${url}`;
    return key;
  }

  const PageNetworkTrafficCollector = function (tabId) {
    this.tabId = tabId;
    this.displayAdFound = false;
    this.requests = {};
    this.msgsBeingSent = {};
    this.assetsSeen = {};
    this.allRedirects = {};
  };

  var globalPageContainer = {
    collectors: {},
    dyingCollectors: {},

    cleanupCollector(tabId) {
      if (tabId in this.collectors) {
        delete globalPageContainer.collectors[tabId];
      }
    },

    onNewNavigation(details) {
      const tabId = details.tabId;
      this.cleanupCollector(tabId);

      ifTrackingEnabled(
        details,
        () => {
          if (!areListenersRegistered) {
            registerListeners();
          }
          this.collectors[tabId] = new PageNetworkTrafficCollector(tabId);
        },
        () => {
          if (areListenersRegistered) {
            unregisterListeners();
          }
        },
      );
    },

    onNavigationCommitted(details) {

    },

    onNavigationCompleted(details) {

    },

    onTabClose(tabId, closeInfo) {
      this.cleanupCollector(tabId);
      delete this.collectors[tabId];
    },

    onDisplayAdFound(tabId) {
      this.collectors[tabId].displayAdFound = true;
    },

    getRandId() {
      return String(Math.floor(Math.random() * 1e9));
    },

    getCollector(tabId) {
      if (this.collectors.hasOwnProperty(tabId)) {
        return this.collectors[tabId];
      }
      return null;
    },

    forwardCall(details, collectorMemberFunction) {
      const collector = this.getCollector(details.tabId);
      if (collector !== null) {
        collectorMemberFunction.apply(collector, [details]);
      }
    },
  };

  PageNetworkTrafficCollector.prototype.sendLogMessageToTabConsole = function () {
    const logMessage = Array.from(arguments).join(' ');
    const message = { message: logMessage, event: 'console-log-message' };
    browserProxy.tabs.sendMessage(this.tabId, message);
  };

  PageNetworkTrafficCollector.prototype.sendToTab = function (assetReq, reqs, curPageUrl, adTrackingEvent) {
    const msg = {};
    msg.assets = [];
    msg.requests = [];
    msg.event_data = {};
    msg.event = adTrackingEvent;
    if (adTrackingEvent === 'new-video-ad') {
      msg.requests = reqs;
      msg.requests.sort((reqA, reqB) => reqA.requestTimestamp - reqB.requestTimestamp);
      if (assetReq) {
        msg.assets = [assetReq];
      }
    } else if (adTrackingEvent === 'new-invalid-video-ad') {
      msg.requests = reqs.map(request => parseHostnameFromUrl(request.url));
      msg.assets = [{

        url: parseHostnameFromUrl(assetReq.url),

        contentType: assetReq.contentType,
        size: assetReq.size,
      }];
    }
    msg.origUrl = curPageUrl;
    msg.displayAdFound = this.displayAdFound;

    browserProxy.tabs.sendMessage(this.tabId, msg);
  };

  PageNetworkTrafficCollector.prototype.getRedirKey = function (url, frameId) {
    return `${url}:${frameId}`;
  };

  PageNetworkTrafficCollector.prototype.seenBefore = function (request) {
    const oldTime = this.assetsSeen[assetMsgKey(request)];
    if (oldTime && (request.requestTimestamp - oldTime < secBetweenDupAssets)) {
      return true;
    }
    return false;
  };

  PageNetworkTrafficCollector.prototype.recordSeenAsset = function (request) {
    this.assetsSeen[assetMsgKey(request)] = request.requestTimestamp;
  };

  PageNetworkTrafficCollector.prototype.onBeforeRequest = function (details) {
    const req = {
      url: details.url,
      type: details.type,
      httpMethod: details.method,
      frameId: details.frameId,
      parentFrameId: details.parentFrameId,
      requestTimestamp: details.timeStamp,
    };
    this.requests[details.requestId] = req;
  };

  PageNetworkTrafficCollector.prototype.onSendHeaders = function (details) {
    let request,
      header;
    request = this.requests[details.requestId];
    header = request && findHeader(details.requestHeaders, 'x-requested-with');
    if (header && header.value.toLowerCase().indexOf('flash') > -1) {
      request.from_flash = true;
    }
  };

  PageNetworkTrafficCollector.prototype.onHeadersReceived = function (details) {
    const getFrameDetails = {
      tabId: details.tabId,
      processId: null,
      frameId: details.frameId,
    };
    const pageNetworkTrafficController = this;
    getFrame(getFrameDetails, (frameDetails) => {
      if (frameDetails && frameDetails.url) {
        pageNetworkTrafficController._onHeadersReceived(details, frameDetails);
      }
    });
  };

  PageNetworkTrafficCollector.prototype._onHeadersReceived = function (details, frameDetails) {
    let contentSize,
      contentRange;

    const request = this.requests[details.requestId];
    if (request) {
      const redirParent = this.allRedirects[this.getRedirKey(details.url, details.frameId)];
      let header = request && findHeader(details.responseHeaders, 'content-type');
      const contentType = header && header.value.toLowerCase();

      if (contentType) {
        request.contentType = contentType;
      }
      header = request && findHeader(details.responseHeaders, 'content-length');
      contentSize = header && header.value;
      if (contentSize) {
        request.size = request.size || 0;
        request.size += parseInt(contentSize);
      }
      header = request && findHeader(details.responseHeaders, 'content-range');
      contentRange = header && header.value;
      if (contentRange) {
        request.contentRange = parseInt(contentRange.split('/')[1]);
      }

      let frameUrl = null;
      if (frameDetails && frameDetails.url) {
        frameUrl = frameDetails.url;
      }
      if (!this.bannedRequest(request)
				&& (this.isVideoReq(frameUrl, request) || (redirParent && redirParent.isVideo))) {
        request.isVideo = true;
      }
    }
  };

  PageNetworkTrafficCollector.prototype.onBeforeRedirect = function (details) {
    const request = this.requests[details.requestId];
    if (request) {
      if (request.redirects) {
        request.redirects.push(details.redirectUrl);
      } else {
        request.redirects = [details.redirectUrl];
      }
      this.allRedirects[this.getRedirKey(details.redirectUrl, details.frameId)] = request;
    }
  };

  PageNetworkTrafficCollector.prototype.isYoutubeMastheadRequest = function (url) {
    const re = /video_masthead/;
    return this.hasYoutubeDomain(url) && re.test(url);
  };
  PageNetworkTrafficCollector.prototype.isYoutubeVideoRequest = function (srcUrl, destUrl) {
    if (!this.hasYoutubeDomain(srcUrl)) {
      return false;
    }

    const re = /https?:\/\/r.*?\.googlevideo\.com\/videoplayback\?/;
    return re.test(destUrl);
  };
  PageNetworkTrafficCollector.prototype.processResponse = function (requestDetails, frameDetails) {
    let request;
    if (requestDetails) {
      request = this.requests[requestDetails.requestId];
      if (request) {
        request.responseStatus = requestDetails.statusCode;
        request.responseTimestamp = requestDetails.timeStamp;

        let frameUrl = null;
        if (frameDetails && frameDetails.url) {
          frameUrl = frameDetails.url;
        }

        let requestUrl = null;
        if (request.url) {
          requestUrl = request.url;
        }

        if (this.isYoutubeAdReq(frameUrl, requestUrl)) {
          const destVideoId = this.parseYoutubeVideoIdFromUrl(requestUrl);
          const srcVideoId = this.parseYoutubeVideoIdFromUrl(frameUrl);
          if (srcVideoId && destVideoId) {
            request.isYoutubeAd = true;
            request.isVideo = true;
            request.rawSrcUrl = frameUrl;
            request.rawDestUrl = requestUrl;
            request.url = `https://www.youtube.com/watch?v=${this.parseYoutubeVideoIdFromUrl(requestUrl)}`;
          }
        } else if (!this.bannedRequest(request)
						&& (this.isVideo || this.isVideoReq(frameUrl, request))) {
          request.isVideo = true;
        }

        if (request.isVideo) {
          const msgKey = assetMsgKey(request);
          this.msgsBeingSent[msgKey] = request;
          if (!this.seenBefore(request)) {
            this.sendMsgWhenQuiet(msgKey);
          }
          this.recordSeenAsset(request);
        }
      }
    }
  };

  PageNetworkTrafficCollector.prototype.onResponseStarted = function (responseDetails) {
    if (responseDetails.frameId < 0) {
      responseDetails.frameId = 99999;
    }
    const getFrameDetails = {
      tabId: responseDetails.tabId,
      processId: null,
      frameId: responseDetails.frameId,
    };
    const pageNetworkTrafficController = this;
    getFrame(getFrameDetails, (frameDetails) => {
      if (frameDetails && frameDetails.url) {
        pageNetworkTrafficController.processResponse(responseDetails, frameDetails);
      }
    });
  };

  PageNetworkTrafficCollector.prototype.hasBannedFiletype = function (request) {
    const url = stripQueryParams(request.url);
    if (bannedFiletypesReg.exec(url)) {
      return true;
    }
    return false;
  };

  PageNetworkTrafficCollector.prototype.checkContentHeaders = function (request) {
    if (request.contentType && validVideoType(request.contentType)) {
      return true;
    }
    return false;
  };

  PageNetworkTrafficCollector.prototype.checkUrlExtension = function (request) {
    const url = stripQueryParams(request.url);
    if (extensionsReg.exec(url)) {
      return true;
    }
    return false;
  };

  PageNetworkTrafficCollector.prototype.isVideoReq = function (srcUrl, request) {
    if (this.isYoutubeVideoRequest(srcUrl, request.url)) {
      return false;
    }
    return this.checkUrlExtension(request) || this.checkContentHeaders(request);
  };
  PageNetworkTrafficCollector.prototype.hasYoutubeDomain = function (url) {
    const hostname = parseHostnameFromUrl(url);
    if (hostname === 'www.youtube.com') {
      return true;
    }
    return false;
  };
  PageNetworkTrafficCollector.prototype.parseYoutubeVideoIdFromUrl = function (url) {
    let re = /^https?:\/\/www\.youtube\.com\/get_video_info.*(?:\?|&)video_id=(.*?)(?:$|&)/;
    let match = re.exec(url);
    if (match && match.length > 1) {
      return match[1];
    }

    re = /^https?:\/\/www\.youtube\.com\/embed\/(.*?)(?:$|\?)/;
    match = re.exec(url);
    if (match && match.length > 1) {
      return match[1];
    }

    re = /^https?:\/\/www\.youtube\.com\/watch.*(\?|&)v=([^&]*)/;
    match = re.exec(url);
    if (match && match.length > 1) {
      return match[1];
    }
    return null;
  };

  PageNetworkTrafficCollector.prototype.isYoutubeGetVideoInfoReq = function (url) {
    const re = /^https?:\/\/www\.youtube\.com\/get_video_info\?/;
    return re.test(url);
  };
  PageNetworkTrafficCollector.prototype.isYoutubeAdReq = function (srcUrl, destUrl) {
    if (!this.hasYoutubeDomain(srcUrl)
			|| !this.isYoutubeGetVideoInfoReq(destUrl)) {
      return false;
    }
    if (this.parseYoutubeVideoIdFromUrl(srcUrl)
			=== this.parseYoutubeVideoIdFromUrl(destUrl)
			&& !this.isYoutubeMastheadRequest(destUrl)) {
      return false;
    }
    return true;
  };

  PageNetworkTrafficCollector.prototype.bannedRequest = function (request) {
    return this.bannedVideoType(request) || this.hasBannedFiletype(request) || this.bannedVideoSize(request);
  };

  PageNetworkTrafficCollector.prototype.bannedVideoType = function (request) {
    let badType = false;
    if (request.contentType) {
      badType = bannedContentTypes.some(prefix => request.contentType.indexOf(prefix) >= 0);
    }
    return badType;
  };

  PageNetworkTrafficCollector.prototype.bannedVideoSize = function (request) {
    if (request.size !== null) {
      if (request.size < minVidSize || request.size > maxVidSize || request.contentRange > maxContentRange) {
        return true;
      }
    }
    return false;
  };

  PageNetworkTrafficCollector.prototype.grabTagReqs = function (tabRequests, assetRequest) {
    let minTimestamp,
      maxTimestamp;
    minTimestamp = assetRequest.requestTimestamp - secBefore;
    maxTimestamp = assetRequest.requestTimestamp + secAfter;

    const filteredRequests = tabRequests.filter(request => (request.requestTimestamp > minTimestamp
				&& request.requestTimestamp < maxTimestamp
				&& request.frameId === assetRequest.frameId
				&& request.url !== assetRequest.url
				&& (hasValidRequestType(request)
				|| isPixelRequest(request))));

    return filteredRequests;
  };

  PageNetworkTrafficCollector.prototype.isValidVideoAd = function (assetRequest, tagRequests) {
    const hasVpaidOrVastRequest = tagRequests.some(tagRequest => isVpaidOrVastRequest(tagRequest));

    if (assetRequest.isYoutubeAd) {
      return true;
    }
    if (hasVpaidOrVastRequest) {
      return true;
    }
    const hasTopVideoAssetDomain = topVideoAssetDomains.some(assetDomain => hasDomain(assetRequest.url, assetDomain));

    return hasTopVideoAssetDomain;
  };

  PageNetworkTrafficCollector.prototype.sendMsgWhenQuiet = function (msgKey) {
    let _this = this,
      origPageUrl,
      msgAssetReq;
    msgAssetReq = this.msgsBeingSent[msgKey];
    browserProxy.tabs.get(this.tabId, (tab) => { origPageUrl = tab.url; });

    setTimeout(() => {
      const rawRequests = [];
      if (globalPageContainer.collectors[_this.tabId] === _this) {
        for (const reqId in _this.requests) {
          rawRequests.push(_this.requests[reqId]);
        }
        const tagReqs = _this.grabTagReqs(rawRequests, msgAssetReq);

        if (_this.isValidVideoAd(msgAssetReq, tagReqs)) {
          _this.sendToTab(msgAssetReq, tagReqs, origPageUrl, 'new-video-ad');
        } else {
          _this.sendToTab(msgAssetReq, tagReqs, origPageUrl, 'new-invalid-video-ad');
        }
      } else {

      }
      delete _this.msgsBeingSent[msgKey];
    }, secAfter + secBefore);
  };

  PageNetworkTrafficCollector.prototype.existingMessage = function (candidateRequest) {
    const frameMsg = this.msgsBeingSent[candidateRequest.frameId];
    if (frameMsg) {
      return frameMsg;
    }
    return null;
  };

  function onBeforeRequestListener(details) {
    globalPageContainer.forwardCall(details, PageNetworkTrafficCollector.prototype.onBeforeRequest);
  }

  function onSendHeadersListener(details) {
    globalPageContainer.forwardCall(details, PageNetworkTrafficCollector.prototype.onSendHeaders);
  }

  function onHeadersReceivedListener(details) {
    globalPageContainer.forwardCall(details, PageNetworkTrafficCollector.prototype.onHeadersReceived);
  }

  function onBeforeRedirectListener(details) {
    globalPageContainer.forwardCall(details, PageNetworkTrafficCollector.prototype.onBeforeRedirect);
  }

  function onResponseStartedListener(details) {
    globalPageContainer.forwardCall(details, PageNetworkTrafficCollector.prototype.onResponseStarted);
  }

  function onCommittedListener(details) {
    if (details.frameId === 0) {
      globalPageContainer.onNavigationCommitted(details);
    }
  }

  function onCompletedListener(details) {
    if (details.frameId === 0) {
      globalPageContainer.onNavigationCompleted(details);
    }
  }

  function onRemovedListener(tabId, closeInfo) {
    globalPageContainer.onTabClose(tabId, closeInfo);
  }

  function onMessageListener(message, sender, sendResponse) {
    if (message.event === 'new-ad' && message.data.event === 'ad') {
      const tabId = sender.tab.id;
      if (tabId) {
        globalPageContainer.onDisplayAdFound(tabId);
      }
    }
  }

  function registerListeners() {
    browserProxy.webRequest.onBeforeRequest.addListener(
      onBeforeRequestListener,
      { urls: ['http://*/*', 'https://*/*'] },
      [],
    );

    browserProxy.webRequest.onSendHeaders.addListener(
      onSendHeadersListener,
      { urls: ['http://*/*', 'https://*/*'] },
      ['requestHeaders'],
    );

    browserProxy.webRequest.onHeadersReceived.addListener(
      onHeadersReceivedListener,
      { urls: ['http://*/*', 'https://*/*'] },
      ['responseHeaders'],
    );

    browserProxy.webRequest.onBeforeRedirect.addListener(
      onBeforeRedirectListener,
      { urls: ['http://*/*', 'https://*/*'] },
      [],
    );

    browserProxy.webRequest.onResponseStarted.addListener(
      onResponseStartedListener,
      { urls: ['http://*/*', 'https://*/*'] },
      ['responseHeaders'],
    );

    browserProxy.webNavigation.onCommitted.addListener(onCommittedListener);
    browserProxy.webNavigation.onCompleted.addListener(onCompletedListener);
    browserProxy.tabs.onRemoved.addListener(onRemovedListener);
    browserProxy.runtime.onMessage.addListener(onMessageListener);

    areListenersRegistered = true;
  }

  function unregisterListeners() {
    browserProxy.webRequest.onBeforeRequest.removeListener(
      onBeforeRequestListener,
    );

    browserProxy.webRequest.onSendHeaders.removeListener(
      onSendHeadersListener,
    );

    browserProxy.webRequest.onHeadersReceived.removeListener(
      onHeadersReceivedListener,
    );

    browserProxy.webRequest.onBeforeRedirect.removeListener(
      onBeforeRedirectListener,
    );

    browserProxy.webRequest.onResponseStarted.removeListener(
      onResponseStartedListener,
    );

    browserProxy.webNavigation.onCommitted.removeListener(onCommittedListener);
    browserProxy.webNavigation.onCompleted.removeListener(onCompletedListener);
    browserProxy.tabs.onRemoved.removeListener(onRemovedListener);
    browserProxy.runtime.onMessage.removeListener(onMessageListener);

    areListenersRegistered = false;
  }

  function areRequiredBrowserApisAvailable() {
    return requiredBrowserApis.every(api => typeof api !== 'undefined');
  }

  if (areRequiredBrowserApisAvailable()) {
    ifBrowserValid(
      () => {
        browserProxy.webNavigation.onBeforeNavigate.addListener(
          (details) => {
            if (details.frameId === 0) {
              globalPageContainer.onNewNavigation(details);
            }
          },
          {
            url: [{ urlMatches: 'http://*/*' }, { urlMatches: 'https://*/*' }],
          },
        );
      }, () => {

      },
    );
  }

  browserProxy.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request === 'is_browser_valid') {
      ifBrowserValid(
        sendResponse({ browser_valid: true }),
        sendResponse({ browser_valid: false }),
      );
    }
  });

  browserProxy.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request === 'is_tracking_enabled') {
      ifTrackingEnabled(
        sender.tab,
        () => {
          try { sendResponse({ tracking_enabled: true }); } catch (err) {}
        },
        () => {
          try { sendResponse({ tracking_enabled: false }); } catch (err) {}
        },
      );
    }
    return true;
  });
}());
