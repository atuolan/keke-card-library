document.addEventListener('DOMContentLoaded',()=>{
 const note=document.createElement('div');note.style.cssText='position:relative;padding:10px 16px;background:#fff1ce;color:#493719;font:13px/1.7 system-ui;border-bottom:1px solid #d5bd84';note.setAttribute('role','note');note.innerHTML='<b>浏览器预览版</b> · 数据仅保存在当前浏览器，与 APK 不自动同步。请定期导出备份，勿用无痕模式保存重要内容。 <a href="https://github.com/kitten112233/keke-card-library/releases/tag/v4.1.4" target="_blank" rel="noopener">下载安卓版</a>';
 document.body.prepend(note);
 const unavailable=/AndroidFolder|AndroidGuard|openLauncherIcons|checkAppUpdate|safety|Safety/;
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
