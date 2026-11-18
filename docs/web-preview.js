document.addEventListener('DOMContentLoaded',()=>{
 const unavailable=/AndroidFolder|AndroidGuard|openLauncherIcons|checkAppUpdate|chooseSafetyLibrary|restoreFromSafetyLibrary|repairSafetyLibrary|disableSafetyLibrary/;
 document.querySelectorAll('button[onclick]').forEach(b=>{if(unavailable.test(b.getAttribute('onclick'))){b.disabled=true;b.title='浏览器预览版暂不支持此安卓功能';b.style.opacity='.45';}});
 document.querySelectorAll('.tavern-set-card,.set-card').forEach(card=>{
 const title=card.querySelector('h4')?.textContent||'';
 if(/LOCAL TAVERN|CLOUD SYNC|IMPORT & FOLDER SCAN|DATA & SAFETY/i.test(title)){
  card.hidden=true;
 }
 });
 for(const el of document.querySelectorAll('p,div,span')){
  if(el.children.length===0&&el.textContent.includes('卡库主体：应用私有 IndexedDB'))el.textContent='数据保存在当前浏览器的网站存储中；清除网站数据会删除。导出文件请到浏览器下载列表查找。';
 }
});

(function(){
 function fitBrowserViewport(){
  const v=window.visualViewport,root=document.documentElement;
  root.style.setProperty('--browser-height',(v?v.height:window.innerHeight)+'px');
  root.style.setProperty('--browser-width',(v?v.width:window.innerWidth)+'px');
  root.style.setProperty('--browser-top',(v?v.offsetTop:0)+'px');
  root.style.setProperty('--browser-left',(v?v.offsetLeft:0)+'px');
 }
 fitBrowserViewport();window.addEventListener('resize',fitBrowserViewport);
 if(window.visualViewport){visualViewport.addEventListener('resize',fitBrowserViewport);visualViewport.addEventListener('scroll',fitBrowserViewport);}
})();
