// 浏览器版外壳：由 web/build.js 在建置时附加到页面末尾，app/src/main/assets/index.html 本身不改。
// 规则沿用原作者浏览器预览版（docs/web-preview.js），并按当前页面结构修正：
//  1. 浏览器里用不了的设置板块（酒馆互通、WebDAV 云同步、导入与文件夹扫描、实时备份目录）隐藏；
//  2. 安卓专属按钮（应用图标、检查更新等）变灰，并说明原因；
//  3. 备份板块的“数据位置”改成浏览器里的实际情况；
//  4. 设置页“快速查找”里指向隐藏板块的按钮去掉。
// 弹窗大小与滚动由页面本身处理，外壳不管。
// 页面在安卓 App 或桌面版里打开时（有原生桥接），外壳什么都不做。
(function () {
  'use strict';
  if (window.AndroidDL || window.AndroidFolder) return;

  var HIDDEN_CARDS = /LOCAL TAVERN|CLOUD SYNC|IMPORT & FOLDER SCAN|DATA & SAFETY/i;
  var ANDROID_ONLY = /AndroidFolder|AndroidGuard|openLauncherIcons|checkAppUpdate|chooseSafetyLibrary|restoreFromSafetyLibrary|repairSafetyLibrary|disableSafetyLibrary/;
  var DATA_LOCATION_MARK = '卡库主体：应用私有 IndexedDB';

  function hideUnsupportedCards() {
    document.querySelectorAll('.set-card').forEach(function (card) {
      var title = card.querySelector('h4');
      if (title && HIDDEN_CARDS.test(title.textContent || '')) {
        card.hidden = true;
        card.setAttribute('data-kaku-web-hidden', '');
      }
    });
  }

  function disableAndroidButtons() {
    document.querySelectorAll('button[onclick]').forEach(function (b) {
      if (ANDROID_ONLY.test(b.getAttribute('onclick'))) {
        b.disabled = true;
        b.title = '浏览器版暂不支持此安卓功能';
        b.style.opacity = '.45';
        b.setAttribute('data-kaku-web-disabled', '');
      }
    });
  }

  function rewriteDataLocation() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || '').indexOf(DATA_LOCATION_MARK) < 0) continue;
      var box = node.parentElement;
      var label = box.querySelector('b');
      box.textContent = '';
      if (label) box.append(label, document.createElement('br'));
      box.append(
        '卡库主体：当前浏览器的网站存储（IndexedDB）；清除网站数据、换浏览器或使用无痕窗口时看不到原来的数据',
        document.createElement('br'),
        '用户导出：浏览器的下载列表 / 下载文件夹'
      );
      box.setAttribute('data-kaku-web-location', '');
      return;
    }
  }

  // 设置页顶部的“快速查找”按钮与当前分页的板块一一对应（按序号），把指向隐藏板块的按钮去掉
  function pruneQuickNav(page) {
    var body = document.querySelector('#settingsModal .modal-body');
    var nav = document.getElementById('settingsQuickNav');
    if (!body || !nav || !page) return;
    var cards = Array.prototype.filter.call(body.querySelectorAll('.set-card'), function (c) { return c.dataset.settingsPage === page; });
    nav.querySelectorAll('.settings-quick-item').forEach(function (b) {
      var card = cards[Number(b.getAttribute('data-quick-index'))];
      if (card && card.hasAttribute('data-kaku-web-hidden')) b.remove();
    });
  }
  var buildQuickNav = window.buildSettingsQuickNav;
  if (typeof buildQuickNav === 'function') {
    window.buildSettingsQuickNav = function (page) {
      var r = buildQuickNav.apply(this, arguments);
      pruneQuickNav(page);
      return r;
    };
  }

  function apply() {
    hideUnsupportedCards();
    disableAndroidButtons();
    rewriteDataLocation();
    var tab = document.querySelector('.settings-page-tab.active');
    if (tab) pruneQuickNav(tab.dataset.page);
    document.documentElement.setAttribute('data-kaku-web', '');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
