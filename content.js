/**
 * 有谱么自动翻谱 - content script (MV3)
 *
 * 需求：在 yopu.co 曲谱查看页（如 /view/xxxx）自动向下滚动翻谱，
 * 支持调速（以“整首用时”为标尺）与暂停/继续。
 *
 * 滚动容器：站点是 Svelte 应用，曲谱滚动在 #nier-scroll-view（overflow-y:auto）。
 * 为容错，自动探测：优先固定 id，其次找页面中最大的可滚动元素，最后回退到 window/文档。
 */
(function () {
  'use strict';

  // 防止重复注入
  if (window.__youpuAutoScrollInjected) {
    return;
  }
  window.__youpuAutoScrollInjected = true;

  const CONTAINER_ID = 'nier-scroll-view';
  const MSG = {
    PING: 'ys_ping',
    START: 'ys_start',
    PAUSE: 'ys_pause',
    RESUME: 'ys_resume',
    STOP: 'ys_stop',
    SET_PARAMS: 'ys_set_params',
    GET_STATE: 'ys_get_state',
  };

  const state = {
    running: false, // 调度循环是否在跑
    playing: false, // 是否真正在滚动（暂停时为 false）
    container: null,
    timerId: null,
    timerRunning: false,
    lastTs: 0,
    // 速度：像素/秒。由 popup 根据“整首秒数”计算后下发。
    pxPerSecond: 40,
    // 每次调度后据此判断是否到达底部
    reachedBottom: false,
  };

  // ---------- 容器探测 ----------
  function isScrollable(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const oy = style.overflowY;
    if (oy !== 'auto' && oy !== 'scroll') return false;
    return el.scrollHeight > el.clientHeight + 20;
  }

  function findContainer() {
    // 1. 固定 id
    const byId = document.getElementById(CONTAINER_ID);
    if (byId && byId.scrollHeight > byId.clientHeight + 20) {
      return byId;
    }
    // 2. 最大的可滚动元素
    let best = null;
    let bestRange = 0;
    const all = document.querySelectorAll('div, main, section');
    for (const el of all) {
      if (!isScrollable(el)) continue;
      const range = el.scrollHeight - el.clientHeight;
      if (range > bestRange) {
        bestRange = range;
        best = el;
      }
    }
    if (best) return best;
    // 3. 回退到文档滚动
    if (document.documentElement.scrollHeight > window.innerHeight + 20) {
      return document.scrollingElement || document.documentElement;
    }
    return null;
  }

  function containerInfo() {
    const el = state.container || findContainer();
    if (!el) {
      return { found: false };
    }
    const isDoc = el === document.scrollingElement || el === document.documentElement;
    const scrollTop = isDoc ? window.scrollY : el.scrollTop;
    const clientHeight = isDoc ? window.innerHeight : el.clientHeight;
    const scrollHeight = isDoc ? document.documentElement.scrollHeight : el.scrollHeight;
    return {
      found: true,
      id: el.id || '',
      isDoc,
      scrollTop,
      clientHeight,
      scrollHeight,
      maxScroll: Math.max(0, scrollHeight - clientHeight),
      percent: scrollHeight > clientHeight
        ? Math.min(100, Math.round((scrollTop / (scrollHeight - clientHeight)) * 100))
        : 100,
    };
  }

  function setScrollTop(el, value) {
    const isDoc = el === document.scrollingElement || el === document.documentElement;
    if (isDoc) {
      window.scrollTo(0, value);
    } else {
      el.scrollTop = value;
    }
  }

  function getScrollTop(el) {
    const isDoc = el === document.scrollingElement || el === document.documentElement;
    return isDoc ? window.scrollY : el.scrollTop;
  }

  function getMaxScroll(el) {
    const isDoc = el === document.scrollingElement || el === document.documentElement;
    const sh = isDoc ? document.documentElement.scrollHeight : el.scrollHeight;
    const ch = isDoc ? window.innerHeight : el.clientHeight;
    return Math.max(0, sh - ch);
  }

  // ---------- 滚动引擎 ----------
  // 关键：Chrome 会冻结后台标签页的 setInterval / requestAnimationFrame。
  // 用户点击 popup「开始」后 popup 关闭，曲谱页回到前台没问题；但为稳健（popup 预览、
  // 标签短暂失焦、切窗口），这里用 Web Worker 的定时器驱动：worker 计时器在后台标签页
  // 不被冻结。worker 通过 Blob 创建，postMessage 周期性驱动主线程滚动。
  const TICK_MS = 50;
  let worker = null;
  let workerStartedAt = 0;

  function createWorker() {
    if (worker) return worker;
    try {
      const src =
        'var t=null;' +
        'onmessage=function(e){' +
        '  if(e.data.cmd==="start"){ if(t)clearInterval(t); t=setInterval(function(){postMessage("tick");},'+TICK_MS+'); }' +
        '  else if(e.data.cmd==="stop"){ if(t){clearInterval(t);t=null;} }' +
        '};';
      const blob = new Blob([src], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      worker.onmessage = function (e) {
        if (e.data === 'tick') doTick();
      };
    } catch (err) {
      // Worker 不可用时退回 setInterval
      worker = null;
    }
    return worker;
  }

  function doTick() {
    if (!state.playing || !state.container) {
      stopTimer();
      return;
    }
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (!state.lastTs) state.lastTs = now;
    let dt = (now - state.lastTs) / 1000;
    state.lastTs = now;
    // 限制单次推进上限，避免异常间隔导致瞬移
    if (dt > 0.5) dt = 0.5;

    const el = state.container;
    const max = getMaxScroll(el);
    const cur = getScrollTop(el);

    if (cur >= max - 0.5) {
      state.reachedBottom = true;
      state.playing = false;
      state.running = false;
      stopTimer();
      broadcastState();
      return;
    }

    let next = cur + state.pxPerSecond * dt;
    if (next > max) next = max;
    setScrollTop(el, next);
  }

  function startTimer() {
    if (state.timerRunning) return;
    state.timerRunning = true;
    state.lastTs = 0;
    const w = createWorker();
    if (w) {
      w.postMessage({ cmd: 'start' });
    } else {
      state.timerId = setInterval(doTick, TICK_MS);
    }
  }

  function stopTimer() {
    state.timerRunning = false;
    state.lastTs = 0;
    if (worker) {
      try { worker.postMessage({ cmd: 'stop' }); } catch (e) {}
    }
    if (state.timerId != null) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function ensureContainer() {
    const el = findContainer();
    state.container = el;
    return el;
  }

  function start() {
    const el = ensureContainer();
    if (!el) {
      return { ok: false, reason: 'no_container' };
    }
    if (state.playing) {
      return { ok: true, already: true, info: containerInfo() };
    }
    if (state.reachedBottom || getScrollTop(el) >= getMaxScroll(el) - 0.5) {
      // 已在底部，从头开始
      setScrollTop(el, 0);
      state.reachedBottom = false;
    }
    state.running = true;
    state.playing = true;
    state.lastTs = 0;
    startTimer();
    broadcastState();
    return { ok: true, info: containerInfo() };
  }

  function pause() {
    state.playing = false;
    stopTimer();
    broadcastState();
    return { ok: true, info: containerInfo() };
  }

  function stop() {
    state.playing = false;
    state.running = false;
    state.reachedBottom = false;
    stopTimer();
    broadcastState();
    return { ok: true, info: containerInfo() };
  }

  function setParams(p) {
    if (p && typeof p.pxPerSecond === 'number' && p.pxPerSecond > 0) {
      state.pxPerSecond = p.pxPerSecond;
      persistSpeed(state.pxPerSecond);
    }
    return { ok: true, pxPerSecond: state.pxPerSecond, info: containerInfo() };
  }

  function getState() {
    return {
      ok: true,
      playing: state.playing,
      running: state.running,
      pxPerSecond: state.pxPerSecond,
      info: containerInfo(),
    };
  }

  // 统一用 chrome.storage.local 持久化速度
  function persistSpeed(pps) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ ys_pxPerSecond: pps });
      }
    } catch (e) {}
  }

  // 尝试恢复上次速度（chrome.storage.local，兼容旧版 localStorage 值）
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['ys_pxPerSecond'], function (o) {
        const saved = parseFloat(o && o.ys_pxPerSecond);
        if (!isNaN(saved) && saved > 0) state.pxPerSecond = saved;
      });
    } else {
      const saved = parseFloat(localStorage.getItem('ys_pxPerSecond') || '');
      if (!isNaN(saved) && saved > 0) state.pxPerSecond = saved;
    }
  } catch (e) {}

  // ---------- 状态广播（供 popup 实时刷新进度）----------
  function broadcastState() {
    // 轻量：通过 runtime 消息通知可能的 popup 刷新进度
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
      const ret = chrome.runtime.sendMessage({ type: 'ys_state_update', state: getState() });
      // 新版 Chrome 返回 Promise、旧版返回 undefined；仅在支持时挂 catch，避免报错
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (e) {}
  }

  // 扩展是否仍存活（卸载/重载后 chrome.runtime.id 会变为 undefined），用于自停幽灵轮询
  function extensionAlive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  // 定期（滚动时）推送进度；扩展已卸载则自动停止
  const progressTimer = setInterval(() => {
    if (!extensionAlive()) { clearInterval(progressTimer); return; }
    if (state.playing) broadcastState();
  }, 500);

  // SPA 切换曲谱时（URL 变化）重置容器与滚动状态，避免沿用上一首的容器；扩展已卸载则自动停止
  (function watchRouteChange() {
    let lastUrl = location.href;
    const routeTimer = setInterval(() => {
      if (!extensionAlive()) { clearInterval(routeTimer); return; }
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        state.container = null;
        state.playing = false;
        state.running = false;
        state.reachedBottom = false;
        stopTimer();
      }
    }, 800);
  })();

  // ---------- 消息处理 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) {
      sendResponse({ ok: false });
      return;
    }
    switch (msg.type) {
      case MSG.PING:
        sendResponse({ ok: true, info: containerInfo(), playing: state.playing });
        break;
      case MSG.START:
        if (msg.params) setParams(msg.params);
        sendResponse(start());
        break;
      case MSG.PAUSE:
        sendResponse(pause());
        break;
      case MSG.RESUME:
        sendResponse(start());
        break;
      case MSG.STOP:
        sendResponse(stop());
        break;
      case MSG.SET_PARAMS:
        sendResponse(setParams(msg.params));
        break;
      case MSG.GET_STATE:
        sendResponse(getState());
        break;
      default:
        sendResponse({ ok: false, reason: 'unknown_msg' });
    }
    // 同步返回，无需保持 channel 打开
    return false;
  });

  // 快捷键：空格 暂停/继续（仅当已开始且不在输入框时）
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!state.running && !state.playing) return;
    e.preventDefault();
    if (state.playing) pause();
    else start();
  }, true);

  // 暴露给调试
  window.__youpuAutoScroll = { start, pause, stop, setParams, getState, containerInfo };
})();
