// ==UserScript==
// @name         giWiFi 校园网自动认证
// @namespace    local.gi-wifi.auto-login
// @version      1.1.0
// @description  在 giWiFi/gportal 认证页面自动填写并提交校园网账号
// @author       https://github.com/yss161
// @match        http://你的校园网认证ip/gportal/web/login*
// @match        http://你的校园网认证ip/*
// @match        https://你的校园网认证ip/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /*
   * 上方的match更化成自己的校园网认证地址
   * 下方填写用户名和密码(记得把提示的文本删掉)
   */
  const DEFAULT_CONFIG = {
    username: '用户名填在这里',
    password: '密码填在这里',

    // 当前页面的固定选择器；一般不需要修改。
    usernameSelector: '#loginForm input[name="user_account"]',
    passwordSelector: '#loginForm input[name="user_password"]',
    submitSelector: '#btn_login',

    // 是否打开页面后自动提交。验证码存在时会自动停止提交。
    autoSubmit: true,
    submitDelayMs: 350,

    // 认证成功后关闭提示框，并尝试关闭当前浏览器窗口。
    autoCloseAfterAuth: true,
    closeDelayMs: 800,
    authTimeoutMs: 30000
  };
  const PENDING_AUTH_KEY = 'giwifiPendingAuth';

  const SELECTORS = {
    username: [
      '#loginForm input[name="user_account"]',
      'input[name="username"]',
      'input[name="userName"]',
      'input[name="user"]',
      'input[name="account"]',
      'input[name="loginName"]',
      'input[id="username"]',
      'input[id="userName"]',
      'input[id="account"]',
      'input[id="loginName"]',
      'input[autocomplete="username"]',
      'input[type="text"]',
      'input:not([type])'
    ],
    password: [
      '#loginForm input[name="user_password"]',
      'input[type="password"]',
      'input[name="password"]',
      'input[name="passwd"]',
      'input[name="pwd"]',
      'input[id="password"]',
      'input[id="passwd"]',
      'input[id="pwd"]',
      'input[autocomplete="current-password"]'
    ],
    submit: [
      '#btn_login',
      'button[type="submit"]',
      'input[type="submit"]',
      'button[id*="login" i]',
      'button[name*="login" i]',
      'input[id*="login" i]',
      'input[name*="login" i]',
      'button[class*="login" i]',
      'a[id*="login" i]',
      'button',
      'input[type="button"]'
    ]
  };

  let config = loadConfig();
  let attemptInProgress = false;
  let observer;
  let authMonitorTimer;
  let authTimeoutTimer;
  let authStartedAt = 0;
  let authStartUrl = '';
  let closeScheduled = false;
  let authDialogWasSeen = false;

  function loadConfig() {
    const stored = typeof GM_getValue === 'function'
      ? GM_getValue('giwifiConfig', {})
      : {};
    return { ...DEFAULT_CONFIG, ...(stored || {}) };
  }

  function saveConfig(nextConfig) {
    config = { ...DEFAULT_CONFIG, ...nextConfig };
    if (typeof GM_setValue === 'function') {
      GM_setValue('giwifiConfig', config);
    }
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;

    GM_registerMenuCommand('设置 giWiFi 账号', () => {
      const username = window.prompt('校园网账号：', config.username || '');
      if (username === null) return;

      const password = window.prompt('校园网密码：', config.password || '');
      if (password === null) return;

      saveConfig({ ...config, username, password });
      window.alert('账号信息已保存，刷新页面后生效。');
    });

    GM_registerMenuCommand(
      config.autoSubmit ? '关闭自动提交' : '开启自动提交',
      () => {
        saveConfig({ ...config, autoSubmit: !config.autoSubmit });
        window.alert(`自动提交已${config.autoSubmit ? '开启' : '关闭'}，刷新页面后生效。`);
      }
    );

    GM_registerMenuCommand(
      config.autoCloseAfterAuth ? '关闭认证后自动关窗' : '开启认证后自动关窗',
      () => {
        saveConfig({ ...config, autoCloseAfterAuth: !config.autoCloseAfterAuth });
        window.alert(
          `认证后自动关窗已${config.autoCloseAfterAuth ? '开启' : '关闭'}，刷新页面后生效。`
        );
      }
    );

    GM_registerMenuCommand('清除已保存的账号信息', () => {
      if (!window.confirm('确定清除已保存的校园网账号和密码吗？')) return;
      saveConfig({ ...config, username: '', password: '' });
      window.alert('账号信息已清除。');
    });
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  }

  function firstMatch(selectors, root = document) {
    for (const selector of selectors) {
      try {
        const match = root.querySelector(selector);
        if (isVisible(match)) return match;
      } catch {
        // 忽略用户配置中的无效选择器，继续尝试默认选择器。
      }
    }
    return null;
  }

  function findUsernameInput() {
    return firstMatch([
      config.usernameSelector,
      ...SELECTORS.username
    ].filter(Boolean));
  }

  function findPasswordInput() {
    return firstMatch([
      config.passwordSelector,
      ...SELECTORS.password
    ].filter(Boolean));
  }

  function findSubmitButton(form, passwordInput) {
    const configured = config.submitSelector
      ? firstMatch([config.submitSelector], form || document)
      : null;
    if (configured) return configured;

    const nearby = firstMatch(SELECTORS.submit, form || document);
    if (nearby) return nearby;

    if (passwordInput) {
      const formElement = passwordInput.form;
      if (formElement) {
        return firstMatch(SELECTORS.submit, formElement);
      }
    }

    return null;
  }

  function setInputValue(input, value) {
    if (!input) return;

    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function hasCaptcha() {
    const captchaInput = document.querySelector([
      'input[name*="captcha" i]',
      'input[name*="verify" i]',
      'input[name*="code" i]',
      'input[id*="captcha" i]',
      'input[id*="verify" i]',
      'input[id*="code" i]'
    ].join(','));

    if (captchaInput && isVisible(captchaInput)) return true;

    const pageText = document.body?.innerText || '';
    return /验证码|图形码|校验码|captcha/i.test(pageText)
      && Boolean(document.querySelector('img[src*="captcha" i], img[src*="verify" i]'));
  }

  function isLoginPath(url = window.location.href) {
    try {
      const parsed = new URL(url, window.location.href);
      return /\/gportal\/web\/login(?:\/|$)/i.test(parsed.pathname);
    } catch {
      return /\/gportal\/web\/login(?:\/|$)/i.test(String(url));
    }
  }

  function hasAuthFailureSignal(pageText) {
    return /认证失败|登录失败|认证不成功|密码错误|账号或密码错误|authentication failed|login failed/i
      .test(pageText);
  }

  function hasAuthSuccessSignal(pageText) {
    return /认证成功|登录成功|认证通过|上网成功|联网成功|连接成功|已连接|authentication successful|login successful/i
      .test(pageText);
  }

  function hasPendingAuthentication() {
    try {
      const pending = JSON.parse(sessionStorage.getItem(PENDING_AUTH_KEY) || 'null');
      if (!pending || !Number.isFinite(pending.startedAt)) return null;
      if (Date.now() - pending.startedAt > Math.max(
        5000,
        Number(config.authTimeoutMs) || 30000
      )) {
        sessionStorage.removeItem(PENDING_AUTH_KEY);
        return null;
      }
      return pending;
    } catch {
      return null;
    }
  }

  function rememberPendingAuthentication() {
    try {
      sessionStorage.setItem(PENDING_AUTH_KEY, JSON.stringify({
        startedAt: authStartedAt,
        startUrl: authStartUrl
      }));
    } catch {
      // 某些隐私模式会禁用 sessionStorage，仍继续使用当前页面监控。
    }
  }

  function forgetPendingAuthentication() {
    try {
      sessionStorage.removeItem(PENDING_AUTH_KEY);
    } catch {
      // 忽略不可用的 sessionStorage。
    }
  }

  function authenticationSucceeded() {
    if (!authStartedAt || Date.now() - authStartedAt < 1000) return false;

    const pageText = document.body?.innerText || '';
    if (hasAuthFailureSignal(pageText)) return false;
    if (hasAuthSuccessSignal(pageText)) return true;

    // 成功后通常会跳离 /gportal/web/login；这也覆盖认证后跳转到门户首页的版本。
    return window.location.href !== authStartUrl && !isLoginPath(window.location.href);
  }

  function findAuthenticationDialog() {
    const dialogSelectors = [
      '[role="dialog"]',
      '.aui_state',
      '.aui_dialog',
      '.artDialog',
      '.art-dialog',
      '.layui-layer'
    ];
    const dialogs = document.querySelectorAll(dialogSelectors.join(','));
    for (const dialog of dialogs) {
      const text = dialog.innerText || '';
      if (isVisible(dialog) && /认证中|请勿关闭当前页面|秒后关闭/.test(text)) {
        return dialog;
      }
    }
    return null;
  }

  function closeAuthenticationDialog() {
    const dialog = findAuthenticationDialog();
    if (!dialog) return;

    const closeButton = dialog.querySelector(
      '[title*="关闭"], [aria-label*="关闭"], .aui_close, .artDialog_close, .layui-layer-close'
    );
    if (closeButton) {
      closeButton.click();
    } else {
      dialog.remove();
    }
  }

  function stopAuthenticationMonitor() {
    window.clearInterval(authMonitorTimer);
    window.clearTimeout(authTimeoutTimer);
    authMonitorTimer = undefined;
    authTimeoutTimer = undefined;
  }

  function tryCloseBrowser() {
    try {
      window.close();
    } catch {
      // 浏览器可能禁止关闭不是由脚本打开的标签页。
    }

    window.setTimeout(() => {
      if (window.closed) return;

      // 对部分浏览器中由脚本打开的窗口再尝试一次。
      try {
        const currentWindow = window.open('', '_self');
        currentWindow?.close();
      } catch {
        // 忽略浏览器的关闭限制。
      }

      if (!window.closed) {
        notify('认证成功，但浏览器阻止了自动关闭，请手动关闭当前标签页。', true);
      }
    }, 150);
  }

  function handleAuthenticationSuccess() {
    if (closeScheduled) return;
    closeScheduled = true;
    stopAuthenticationMonitor();
    forgetPendingAuthentication();
    closeAuthenticationDialog();
    notify('认证成功，正在关闭浏览器...');

    window.setTimeout(tryCloseBrowser, Math.max(0, Number(config.closeDelayMs) || 0));
  }

  function checkAuthenticationCompletion() {
    if (!config.autoCloseAfterAuth || closeScheduled) return;

    const pageText = document.body?.innerText || '';
    if (hasAuthFailureSignal(pageText)) {
      stopAuthenticationMonitor();
      forgetPendingAuthentication();
      return;
    }

    if (findAuthenticationDialog()) {
      authDialogWasSeen = true;
    } else if (
      authDialogWasSeen
      && Date.now() - authStartedAt >= 2500
    ) {
      // 某些版本只有认证弹窗倒计时，没有成功文字或成功跳转。
      handleAuthenticationSuccess();
      return;
    }

    if (authenticationSucceeded()) {
      handleAuthenticationSuccess();
    }
  }

  function startAuthenticationMonitor() {
    startAuthenticationMonitorFrom(Date.now(), window.location.href);
  }

  function startAuthenticationMonitorFrom(startedAt, startUrl) {
    if (!config.autoCloseAfterAuth || authMonitorTimer) return;

    authStartedAt = startedAt;
    authStartUrl = startUrl;
    closeScheduled = false;
    authDialogWasSeen = false;
    rememberPendingAuthentication();
    authMonitorTimer = window.setInterval(checkAuthenticationCompletion, 250);
    const timeoutMs = Math.max(
      5000,
      Number(config.authTimeoutMs) || 30000
    );
    const remainingMs = Math.max(1000, timeoutMs - (Date.now() - startedAt));
    authTimeoutTimer = window.setTimeout(() => {
      stopAuthenticationMonitor();
      forgetPendingAuthentication();
    }, remainingMs);
  }

  function isLoginButton(element) {
    if (!element) return false;
    const passwordInput = findPasswordInput();
    const form = document.querySelector('#loginForm');
    const submitButton = findSubmitButton(form, passwordInput);
    return Boolean(submitButton && (element === submitButton || submitButton.contains(element)));
  }

  function likelyLoginPage(passwordInput) {
    if (!passwordInput) return false;
    const url = `${location.pathname}${location.search}`.toLowerCase();
    const text = document.body?.innerText || '';
    return /login|gportal|认证|登录|上网/.test(`${url} ${text}`.toLowerCase());
  }

  function notify(message, isError = false) {
    let box = document.getElementById('giwifi-auto-login-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'giwifi-auto-login-status';
      Object.assign(box.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        maxWidth: 'min(360px, calc(100vw - 32px))',
        padding: '10px 14px',
        borderRadius: '6px',
        color: '#fff',
        background: '#1677ff',
        boxShadow: '0 4px 14px rgba(0, 0, 0, .22)',
        font: '14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif'
      });
      document.body.appendChild(box);
    }

    box.textContent = message;
    box.style.background = isError ? '#d9363e' : '#1677ff';
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => box.remove(), 5000);
  }

  function submitLogin(submitButton) {
    if (!config.autoSubmit) return;

    window.setTimeout(() => {
      if (submitButton) {
        startAuthenticationMonitor();
        submitButton.click();
      }
    }, Math.max(0, Number(config.submitDelayMs) || 0));
  }

  function tryLogin() {
    if (attemptInProgress) return;
    if (!config.username || !config.password) {
      notify('请先通过 Tampermonkey 菜单设置 giWiFi 账号和密码。', true);
      return;
    }

    const usernameInput = findUsernameInput();
    const passwordInput = findPasswordInput();
    if (!likelyLoginPage(passwordInput)) return;

    if (hasCaptcha()) {
      notify('检测到验证码，请手动填写验证码后提交。', true);
      return;
    }

    if (!usernameInput) {
      notify('未找到账号输入框，请在脚本顶部配置 usernameSelector。', true);
      return;
    }

    const form = document.querySelector('#loginForm');
    const submitButton = findSubmitButton(form, passwordInput);
    if (!form || !submitButton) {
      notify('未找到 giWiFi 登录按钮，请检查页面是否加载完整。', true);
      return;
    }
    attemptInProgress = true;

    setInputValue(usernameInput, config.username);
    setInputValue(passwordInput, config.password);
    notify(config.autoSubmit ? '正在提交校园网认证...' : '账号密码已填写，请手动提交。');
    // 页面按钮的 onclick 会调用 login('loginForm')，其中包含 AES 加密和动态隐藏参数。
    submitLogin(submitButton);
  }

  function start() {
    registerMenu();
    document.addEventListener('click', (event) => {
      if (isLoginButton(event.target)) {
        startAuthenticationMonitor();
      }
    }, true);
    const pending = hasPendingAuthentication();
    if (pending) {
      startAuthenticationMonitorFrom(pending.startedAt, pending.startUrl || window.location.href);
      checkAuthenticationCompletion();
    }
    tryLogin();

    observer = new MutationObserver(() => {
      if (!attemptInProgress) tryLogin();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // 某些认证页会先异步加载登录表单。
    window.setTimeout(() => {
      attemptInProgress = false;
      tryLogin();
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
