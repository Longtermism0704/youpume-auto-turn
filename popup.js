/**
 * 有谱么自动翻谱 - popup 逻辑
 *
 * 速度模型：用户设定“整首用时”分钟数，插件读取当前曲谱的可滚动高度，
 * 换算为 px/秒：pxPerSecond = maxScroll / (分钟 * 60)。
 * “快一点/慢一点”在换算基础上乘以系数微调。
 */
(function () {
  'use strict';

  const MSG = {
    PING: 'ys_ping',
    START: 'ys_start',
    PAUSE: 'ys_pause',
    RESUME: 'ys_resume',
    STOP: 'ys_stop',
    SET_PARAMS: 'ys_set_params',
    GET_STATE: 'ys_get_state',
  };

  const el = {
    dur: document.getElementById('dur'),
    durVal: document.getElementById('durVal'),
    speedMs: document.getElementById('speedMs'),
    slower: document.getElementById('slower'),
    faster: document.getElementById('faster'),
    toggle: document.getElementById('toggle'),
    reset: document.getElementById('reset'),
    bar: document.getElementById('bar'),
    status: document.getElementById('status'),
  };

  let tabId = null;
  let playing = false;
  let containerReady = false;
  // 速度倍率（在“整首用时”换算基础上的微调）
  let fineFactor = 1.0;
  const STORAGE_KEY = 'ys_settings';

  // ---------- 与 content script 通信 ----------
  function send(type, extra) {
    return new Promise((resolve) => {
      if (tabId == null) return resolve(null);
      const payload = Object.assign({ type }, extra || {});
      let settled = false;
      try {
        chrome.tabs.sendMessage(tabId, payload, (resp) => {
          settled = true;
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        resolve(null);
      }
      // 兜底超时
      setTimeout(() => { if (!settled) resolve(null); }, 800);
    });
  }

  function fmtPx(pxPerSecond) {
    if (!pxPerSecond || pxPerSecond <= 0) return '—';
    return pxPerSecond.toFixed(1) + ' px/s';
  }

  function computePxPerSecond(info) {
    const minutes = parseFloat(el.dur.value) || 5;
    const totalSeconds = minutes * 60;
    const maxScroll = info && info.found ? info.maxScroll : 0;
    if (maxScroll <= 0) return null;
    return (maxScroll / totalSeconds) * fineFactor;
  }

  async function refreshFromState(st) {
    if (!st) return;
    const info = st.info || {};
    containerReady = !!info.found;
    playing = !!st.playing;
    updateToggleLabel();
    if (info.found) {
      const pct = info.percent != null ? info.percent : 0;
      el.bar.style.width = pct + '%';
      el.status.textContent = containerReady
        ? `进度 ${pct}% · ${playing ? '滚动中' : '已暂停'}`
        : '未找到可滚动曲谱区域';
      el.status.classList.toggle('warn', false);
    }
    const pps = st.pxPerSecond || computePxPerSecond(info);
    el.speedMs.textContent = fmtPx(pps);
  }

  function updateToggleLabel() {
    if (playing) {
      el.toggle.textContent = '暂停';
      el.toggle.classList.remove('btn-primary');
      el.toggle.classList.add('btn-ghost');
    } else {
      el.toggle.textContent = '开始滚动';
      el.toggle.classList.remove('btn-ghost');
      el.toggle.classList.add('btn-primary');
    }
  }

  // ---------- 初始化 ----------
  async function init() {
    // 恢复设置
    try {
      const saved = await new Promise((r) => chrome.storage.local.get([STORAGE_KEY], (o) => r(o[STORAGE_KEY])));
      if (saved) {
        if (typeof saved.dur === 'number') el.dur.value = String(saved.dur);
        if (typeof saved.fineFactor === 'number') fineFactor = saved.fineFactor;
      }
    } catch (e) {}
    syncDurLabel();

    // 当前标签页
    const params = new URLSearchParams(location.search);
    const forcedTabId = params.get('tabId');
    let tab;
    if (forcedTabId) {
      const t = await new Promise((r) => chrome.tabs.get(parseInt(forcedTabId, 10), (x) => r(x)));
      tab = t || null;
    } else {
      const tabs = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
      tab = tabs && tabs[0];
      // 若当前活动 tab 不是 yopu.co，则回退到任一 yopu.co 曲谱 tab
      if (!tab || !/^https?:\/\/(www\.)?yopu\.co\//.test(tab.url || '')) {
        const all = await new Promise((r) => chrome.tabs.query({}, r));
        const yopu = (all || []).filter((t) => /^https?:\/\/(www\.)?yopu\.co\//.test(t.url || ''));
        // 优先曲谱详情页
        tab = yopu.find((t) => /\/view\//.test(t.url || '')) || yopu[0] || tab;
      }
    }
    if (!tab) {
      el.status.textContent = '没有活动标签页';
      return;
    }
    tabId = tab.id;

    // 判断是否是曲谱页面
    const isYopu = /^https?:\/\/(www\.)?yopu\.co\//.test(tab.url || '');
    if (!isYopu) {
      el.status.textContent = '请在 yopu.co 曲谱页面打开本插件';
      el.status.classList.add('warn');
      el.toggle.disabled = true;
      return;
    }

    // 尝试 ping content script（可能需要重载页面）
    let resp = await send(MSG.PING);
    if (!resp) {
      // content script 未就绪（扩展刚装/页面在安装前打开），尝试注入
      await tryInject(tab.id);
      resp = await send(MSG.PING);
    }
    if (resp && resp.ok) {
      containerReady = true;
      const state = await send(MSG.GET_STATE);
      await refreshFromState(state);
      // 应用一次当前参数
      applySpeedToContent();
    } else {
      el.status.textContent = '未连接到页面，请刷新曲谱页后重试';
      el.status.classList.add('warn');
      el.toggle.disabled = true;
    }
  }

  async function tryInject(id) {
    try {
      await new Promise((resolve, reject) => {
        chrome.scripting.executeScript(
          { target: { tabId: id }, files: ['content.js'] },
          (res) => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
            else resolve(res);
          }
        );
      });
    } catch (e) {
      // 忽略
    }
  }

  function syncDurLabel() {
    const v = parseFloat(el.dur.value) || 5;
    el.durVal.textContent = v.toFixed(1);
  }

  async function applySpeedToContent() {
    const st = await send(MSG.GET_STATE);
    const info = st && st.info ? st.info : null;
    const pps = computePxPerSecond(info);
    if (pps != null) {
      await send(MSG.SET_PARAMS, { params: { pxPerSecond: pps } });
      el.speedMs.textContent = fmtPx(pps);
    } else {
      el.speedMs.textContent = '—';
    }
    saveSettings();
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: { dur: parseFloat(el.dur.value) || 5, fineFactor } });
    } catch (e) {}
  }

  // ---------- 交互 ----------
  el.dur.addEventListener('input', () => {
    syncDurLabel();
    applySpeedToContent();
  });

  el.slower.addEventListener('click', () => {
    fineFactor = Math.max(0.25, fineFactor * 0.85);
    applySpeedToContent();
  });
  el.faster.addEventListener('click', () => {
    fineFactor = Math.min(4, fineFactor * 1.18);
    applySpeedToContent();
  });

  el.toggle.addEventListener('click', async () => {
    if (!containerReady) return;
    if (playing) {
      const r = await send(MSG.PAUSE);
      if (r && r.ok) { playing = false; updateToggleLabel(); }
    } else {
      const infoResp = await send(MSG.GET_STATE);
      const info = infoResp && infoResp.info;
      const pps = computePxPerSecond(info);
      const r = await send(MSG.START, { params: pps ? { pxPerSecond: pps } : undefined });
      if (r && r.ok) { playing = true; updateToggleLabel(); }
      else if (r && r.reason === 'no_container') {
        el.status.textContent = '未找到可滚动曲谱区域';
      }
    }
    const st = await send(MSG.GET_STATE);
    refreshFromState(st);
  });

  el.reset.addEventListener('click', async () => {
    await send(MSG.STOP);
    // 回到顶部
    try {
      const tabs = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
      if (tabs && tabs[0]) {
        await new Promise((resolve) => {
          chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: () => {
              const c = document.getElementById('nier-scroll-view');
              if (c) c.scrollTop = 0;
              else window.scrollTo(0, 0);
            },
          }, () => resolve());
        });
      }
    } catch (e) {}
    playing = false;
    updateToggleLabel();
    const st = await send(MSG.GET_STATE);
    refreshFromState(st);
  });

  // 接收 content 推送的进度，更新 UI
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ys_state_update' && msg.state) {
      refreshFromState(msg.state);
    }
  });

  // 打开时周期性刷新
  setInterval(async () => {
    if (tabId == null) return;
    const st = await send(MSG.GET_STATE);
    if (st && st.ok) refreshFromState(st);
  }, 800);

  init();
})();
