package com.operit.webviewapp;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import android.database.Cursor;
import android.provider.OpenableColumns;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {

    private WebView webView;
    private AppUpdater appUpdater;
    private ValueCallback<Uri[]> filePathCallback;
    private static final int FILE_REQ = 1001;
    private static final int TREE_REQ = 1002;
    private static final int TAVERN_TREE_REQ = 1003;
    private static final int SAFETY_TREE_REQ = 1004;
    private String pendingTavernPointId = "";
    private volatile String nextFilePickerMode = "system";
    private volatile boolean nextFilePickerMultiple = false;
    private final ConcurrentHashMap<String, Uri> selectedFileUris = new ConcurrentHashMap<>();

    private Intent createFilePickerIntent(String action, boolean allowMultiple) {
        Intent intent = new Intent(action);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    private boolean launchFilePicker(Intent intent) {
        if (intent.resolveActivity(getPackageManager()) == null) return false;
        try {
            startActivityForResult(intent, FILE_REQ);
            return true;
        } catch (Throwable ignore) {
            return false;
        }
    }

    private void cancelFilePicker() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
    }

    private void launchPreferredFilePicker(boolean allowMultiple) {
        String mode = nextFilePickerMode;
        nextFilePickerMode = "system";
        Intent picker;
        String unavailableMessage;
        if ("other".equals(mode)) {
            Intent contentIntent = createFilePickerIntent(Intent.ACTION_GET_CONTENT, allowMultiple);
            if (contentIntent.resolveActivity(getPackageManager()) == null) {
                cancelFilePicker();
                recordDiagnosisEvent("note", "file_picker", "其他文件管理器入口当前不可用");
                Toast.makeText(MainActivity.this, "没有可用的其他文件管理器，请安装或启用后重试", Toast.LENGTH_LONG).show();
                return;
            }
            picker = Intent.createChooser(contentIntent, "选择文件管理器");
            unavailableMessage = "其他文件管理器无法打开，请检查是否已启用";
        } else {
            picker = createFilePickerIntent(Intent.ACTION_OPEN_DOCUMENT, allowMultiple);
            unavailableMessage = "系统文件选择器不可用，请切换为“其他文件管理器”";
        }
        if (!launchFilePicker(picker)) {
            cancelFilePicker();
            recordDiagnosisEvent("note", "file_picker", unavailableMessage);
            Toast.makeText(MainActivity.this, unavailableMessage, Toast.LENGTH_LONG).show();
        }
    }

    private String selectedFileKey(String name, long size) { return (name == null ? "" : name) + "\n" + size; }
    private void rememberSelectedUri(Uri uri) {
        if (uri == null) return;
        String name = "", sizeText = "0";
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) sizeText = String.valueOf(c.getLong(si));
            }
        } catch (Throwable ignore) {} finally { if (c != null) c.close(); }
        try { selectedFileUris.put(selectedFileKey(name, Long.parseLong(sizeText)), uri); } catch (Throwable ignore) {}
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        MainActivityHolder.activity=this;

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // 允许 file:// 协议访问 http://127.0.0.1（本地酒馆互联必需）
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 缓解 WebView 闪屏：禁用过场动画导致的合成层闪烁
        webView.setBackgroundColor(0xFFFFFFFF);

        // 原生下载桥：支持中文文件名，直接存到下载目录
        webView.addJavascriptInterface(new DownloadBridge(), "AndroidDL");
        appUpdater = new AppUpdater(this);
        // HTTP 代理桥：让 JS 通过 Java 发 HTTP 请求，Java 自己管 cookie（含 .sig）
        webView.addJavascriptInterface(new StHttpBridge(getCacheDir()), "StHttpBridge");
        // 导航桥：打开系统浏览器、退出 App
        webView.addJavascriptInterface(new NavBridge(), "AndroidNav");
        webView.addJavascriptInterface(new PickerBridge(), "AndroidPicker");
        // 独立于 WebView/IndexedDB 的存储哨兵：检测“曾有卡但网页库突然为空”
        webView.addJavascriptInterface(new StorageGuardBridge(), "AndroidGuard");
        // 只读、脱敏的本机诊断桥：不读取角色卡正文、图片、聊天或密钥。
        webView.addJavascriptInterface(new DiagnosisBridge(), "AndroidDiagnosis");
        webView.addJavascriptInterface(new FolderBridge(), "AndroidFolder");
        webView.addJavascriptInterface(new AiHttpBridge(), "AndroidAI");

        webView.setWebViewClient(new WebViewClient());

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;

                boolean allowMultiple = nextFilePickerMultiple || (params != null
                        && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                nextFilePickerMultiple = false;

                // The import dialog records the preferred route before clicking the input.
                launchPreferredFilePicker(allowMultiple);
                return true;
            }
        });

        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SAFETY_TREE_REQ) {
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                Uri uri=data.getData();int flags=Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                try { getContentResolver().takePersistableUriPermission(uri,flags); } catch(Throwable ignore) {}
                getSharedPreferences("safety_library",MODE_PRIVATE).edit().putString("uri",uri.toString()).apply();
                webView.evaluateJavascript("typeof onSafetyFolderChosen==='function'&&onSafetyFolderChosen()",null);
            }
            return;
        }
        if (requestCode == TAVERN_TREE_REQ) {
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData();
                int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                try { getContentResolver().takePersistableUriPermission(uri, flags); } catch (Throwable ignore) {}
                String pointId=(pendingTavernPointId==null||pendingTavernPointId.length()==0)?"legacy":pendingTavernPointId;
                getSharedPreferences("tavern_folders", MODE_PRIVATE).edit().putString(pointId, uri.toString()).apply();
                pendingTavernPointId="";
                webView.evaluateJavascript("typeof onTavernFolderChosen==='function'&&onTavernFolderChosen('"+pointId.replace("'","")+"')", null);
            }
            return;
        }
        if (requestCode == TREE_REQ) {
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData();
                try { getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Throwable ignore) {}
                getSharedPreferences("folder_scan", MODE_PRIVATE).edit().putString(uri.toString(), uri.toString()).apply();
                final String chosen=uri.toString().replace("\\","\\\\").replace("'","\\'");
                webView.evaluateJavascript("typeof onScanFolderChosen==='function'?onScanFolderChosen('"+chosen+"'):(typeof renderFolderLib==='function'&&renderFolderLib())", null);
            }
            return;
        }
        if (requestCode != FILE_REQ) return;
        Uri[] results = null;
        if (resultCode == Activity.RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                android.content.ClipData clip = data.getClipData();
                ArrayList<Uri> list = new ArrayList<>();
                for (int i = 0; i < clip.getItemCount(); i++) {
                    list.add(clip.getItemAt(i).getUri());
                }
                results = list.toArray(new Uri[0]);
            } else if (data.getDataString() != null) {
                results = new Uri[]{ Uri.parse(data.getDataString()) };
            }
        }
        if (results != null) for (Uri uri : results) rememberSelectedUri(uri);
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        // 优先让 JS 处理（逐层关闭弹层），JS 处理不了再由 NavBridge.exitApp() 退出
        webView.evaluateJavascript(
            "typeof window._handleNativeBack==='function'?window._handleNativeBack():null", null);
    }

    // 原生下载桥：JS 传 base64 内容 + 文件名，写入公共下载目录，完整保留中文名
    private class DownloadBridge {
        @JavascriptInterface public void checkAppUpdate() { runOnUiThread(() -> appUpdater.check()); }

        // —— 分块写入：用于超大文件（如完整备份），避免一次性传输撑爆 JS 桥 ——
        private java.io.OutputStream chunkOut = null;
        private String chunkPath = null;
        private android.net.Uri chunkUri = null;
        private java.io.File chunkFile = null;
        private java.util.zip.ZipOutputStream zipOut = null;
        private java.io.OutputStream zipBaseOut = null;
        private final ConcurrentHashMap<String, String> stageJobs = new ConcurrentHashMap<>();
        private File stageFile(String taskId, String fileId) { return new File(new File(transferDir(), safePart(taskId)), safePart(fileId)); }
        private void setStageJob(String id, String state, long done, long total, String error) {
            try { JSONObject o=new JSONObject();o.put("state",state);o.put("done",done);o.put("total",total);if(error!=null)o.put("error",error);stageJobs.put(id,o.toString()); } catch(Throwable ignore) {}
        }
        @JavascriptInterface public String beginSelectedStage(final String name, final long size, final String taskId, final String fileId) {
            final Uri uri=selectedFileUris.remove(selectedFileKey(name,size));if(uri==null)return "";
            final String job="copy_"+System.currentTimeMillis()+"_"+Math.abs(fileId.hashCode());setStageJob(job,"running",0,size,null);
            new Thread(new Runnable(){public void run(){InputStream in=null;OutputStream out=null;long done=0;try{File target=stageFile(taskId,fileId),dir=target.getParentFile();if(!dir.exists())dir.mkdirs();if(dir.getUsableSpace()<size+128L*1024*1024)throw new Exception("可用空间不足，至少需要文件大小再加128MB");in=getContentResolver().openInputStream(uri);if(in==null)throw new Exception("无法读取所选文件");out=new FileOutputStream(target,false);byte[] buf=new byte[8*1024*1024];int n;while((n=in.read(buf))!=-1){out.write(buf,0,n);done+=n;setStageJob(job,"running",done,size,null);}out.flush();setStageJob(job,"done",done,size,null);}catch(Throwable e){try{stageFile(taskId,fileId).delete();}catch(Throwable ignore){}setStageJob(job,"error",done,size,e.getMessage()!=null?e.getMessage():e.toString());}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}try{if(out!=null)out.close();}catch(Throwable ignore){}}}}).start();return job;
        }
        @JavascriptInterface public String stageCopyStatus(String jobId){String s=stageJobs.get(jobId);return s==null?"{\"state\":\"missing\"}":s;}
        private boolean supportedZipName(String name){String x=name==null?"":name.toLowerCase(java.util.Locale.ROOT);return x.endsWith(".png")||x.endsWith(".json")||x.endsWith(".txt")||x.endsWith(".docx")||x.endsWith(".md")||x.endsWith(".jsonl");}
        private boolean safeZipEntry(ZipEntry e){if(e==null)return false;long size=e.getSize(),packed=e.getCompressedSize();return !e.isDirectory()&&supportedZipName(e.getName())&&size>=0&&size<=32L*1024*1024&&packed>=0&&(size==0||packed>0&&size/Math.max(1L,packed)<=200);}
        @JavascriptInterface public String listZipEntries(String taskId,String fileId,int offset,int limit){JSONObject out=new JSONObject();JSONArray rows=new JSONArray();ZipFile z=null;try{z=new ZipFile(stageFile(taskId,fileId));int eligible=0,skipped=0;Enumeration<? extends ZipEntry> en=z.entries();while(en.hasMoreElements()){ZipEntry e=en.nextElement();if(!safeZipEntry(e)){if(!e.isDirectory())skipped++;continue;}if(eligible>=offset&&rows.length()<Math.max(1,Math.min(limit,500))){JSONObject r=new JSONObject();r.put("index",eligible);r.put("name",e.getName());r.put("size",e.getSize());r.put("compressedSize",e.getCompressedSize());rows.put(r);}eligible++;}out.put("total",eligible);out.put("skipped",skipped);out.put("entries",rows);out.put("next",Math.min(eligible,offset+rows.length()));}catch(Throwable e){try{out.put("error",e.getMessage()!=null?e.getMessage():e.toString());}catch(Throwable ignore){}}finally{try{if(z!=null)z.close();}catch(Throwable ignore){}}return out.toString();}
        @JavascriptInterface public String extractZipEntry(String taskId,String zipFileId,int targetIndex,String childFileId){JSONObject out=new JSONObject();ZipFile z=null;InputStream in=null;OutputStream os=null;try{z=new ZipFile(stageFile(taskId,zipFileId));Enumeration<? extends ZipEntry> en=z.entries();ZipEntry chosen=null;int eligible=0;while(en.hasMoreElements()){ZipEntry e=en.nextElement();if(!safeZipEntry(e))continue;if(eligible++==targetIndex){chosen=e;break;}}if(chosen==null)throw new Exception("ZIP条目不存在");File target=stageFile(taskId,childFileId),dir=target.getParentFile();if(!dir.exists())dir.mkdirs();in=z.getInputStream(chosen);os=new FileOutputStream(target,false);byte[] buf=new byte[256*1024];long done=0;int n;while((n=in.read(buf))!=-1){done+=n;if(done>32L*1024*1024)throw new Exception("ZIP条目超过32MB");os.write(buf,0,n);}os.flush();out.put("id",childFileId);out.put("name",chosen.getName());out.put("size",done);}catch(Throwable e){try{stageFile(taskId,childFileId).delete();out.put("error",e.getMessage()!=null?e.getMessage():e.toString());}catch(Throwable ignore){}}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}try{if(os!=null)os.close();}catch(Throwable ignore){}try{if(z!=null)z.close();}catch(Throwable ignore){}}return out.toString();}
        @JavascriptInterface public String extractZipBatch(String taskId,String zipFileId,int offset,int maxItems,long maxBytes){JSONObject out=new JSONObject();JSONArray rows=new JSONArray();ZipFile z=null;try{z=new ZipFile(stageFile(taskId,zipFileId));Enumeration<? extends ZipEntry> en=z.entries();int eligible=0;long batchBytes=0;while(en.hasMoreElements()){ZipEntry e=en.nextElement();if(!safeZipEntry(e))continue;if(eligible++<offset)continue;if(rows.length()>0&&batchBytes+e.getSize()>Math.max(1L,maxBytes)){eligible--;break;}String childId="ze_"+safePart(zipFileId)+"_"+(eligible-1);File target=stageFile(taskId,childId);InputStream in=null;OutputStream os=null;long done=0;try{in=z.getInputStream(e);os=new FileOutputStream(target,false);byte[] buf=new byte[256*1024];int n;while((n=in.read(buf))!=-1){done+=n;if(done>32L*1024*1024)throw new Exception("ZIP条目超过32MB");os.write(buf,0,n);}os.flush();JSONObject r=new JSONObject();r.put("index",eligible-1);r.put("id",childId);r.put("name",e.getName());r.put("size",done);rows.put(r);batchBytes+=done;}catch(Throwable itemError){target.delete();}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}try{if(os!=null)os.close();}catch(Throwable ignore){}}}out.put("entries",rows);out.put("next",eligible);out.put("bytes",batchBytes);}catch(Throwable e){try{out.put("error",e.getMessage()!=null?e.getMessage():e.toString());}catch(Throwable ignore){}}finally{try{if(z!=null)z.close();}catch(Throwable ignore){}}return out.toString();}
        @JavascriptInterface public void deleteStageFile(String taskId,String fileId){try{stageFile(taskId,fileId).delete();}catch(Throwable ignore){}}
        @JavascriptInterface public long stageFileSize(String taskId,String fileId){try{return stageFile(taskId,fileId).length();}catch(Throwable e){return -1;}}
        private android.net.Uri zipUri = null;
        private java.io.File zipFile = null;
        private boolean zipEntryOpen = false;
        private String zipPath = null;

        @JavascriptInterface
        public boolean beginFile(final String fileName) {
            try {
                closeChunkQuietly();
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName);
                    cv.put(android.provider.MediaStore.Downloads.RELATIVE_PATH,
                            Environment.DIRECTORY_DOWNLOADS + "/卡库");
                    chunkUri = getContentResolver().insert(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (chunkUri == null) throw new Exception("无法创建文件");
                    chunkOut = getContentResolver().openOutputStream(chunkUri);
                    chunkPath = "下载/卡库/" + fileName;
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS), "卡库");
                    if (!dir.exists()) dir.mkdirs();
                    chunkFile = new File(dir, fileName);
                    chunkOut = new FileOutputStream(chunkFile);
                    chunkPath = chunkFile.getAbsolutePath();
                }
                return true;
            } catch (Exception e) {
                closeChunkQuietly();
                return false;
            }
        }

        @JavascriptInterface
        public boolean appendChunk(final String base64Chunk) {
            try {
                if (chunkOut == null) return false;
                byte[] bytes = android.util.Base64.decode(base64Chunk, android.util.Base64.DEFAULT);
                chunkOut.write(bytes);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean endFile() {
            try {
                if (chunkOut == null) return false;
                chunkOut.flush();
                chunkOut.close();
                chunkOut = null;
                final String path = chunkPath;
                runOnUiThread(new Runnable() {
                    public void run() {
                        Toast.makeText(MainActivity.this, "已保存：" + path, Toast.LENGTH_LONG).show();
                    }
                });
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface public void abortFile(){
            try{if(chunkOut!=null)chunkOut.close();}catch(Throwable ignore){}chunkOut=null;
            try{if(chunkUri!=null)getContentResolver().delete(chunkUri,null,null);}catch(Throwable ignore){}try{if(chunkFile!=null)chunkFile.delete();}catch(Throwable ignore){}
            chunkPath=null;chunkUri=null;chunkFile=null;
        }
        private void closeChunkQuietly() {
            try { if (chunkOut != null) chunkOut.close(); } catch (Exception ignore) {}
            chunkOut = null; chunkPath = null; chunkUri = null; chunkFile = null;
        }

        private java.io.OutputStream createDownloadOutput(String fileName, boolean zip) throws Exception {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                android.content.ContentValues cv = new android.content.ContentValues();
                cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName);
                cv.put(android.provider.MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/卡库");
                if (zip) cv.put(android.provider.MediaStore.Downloads.MIME_TYPE, "application/zip");
                android.net.Uri uri = getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new Exception("无法创建文件");
                if (zip) zipUri=uri;
                return getContentResolver().openOutputStream(uri);
            }
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "卡库");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir,fileName);
            if(zip)zipFile=out;
            return new FileOutputStream(out);
        }
        @JavascriptInterface public boolean beginZip(String fileName){
            try{abortZip();zipBaseOut=createDownloadOutput(fileName,true);zipOut=new java.util.zip.ZipOutputStream(new java.io.BufferedOutputStream(zipBaseOut));zipPath="下载/卡库/"+fileName;return true;}catch(Throwable e){abortZip();return false;}
        }
        @JavascriptInterface public boolean beginZipEntry(String name){
            try{if(zipOut==null)return false;if(zipEntryOpen){zipOut.closeEntry();zipEntryOpen=false;}name=name==null?"file.bin":name.replace('\\','/').replaceAll("^/+","");zipOut.putNextEntry(new java.util.zip.ZipEntry(name));zipEntryOpen=true;return true;}catch(Throwable e){return false;}
        }
        @JavascriptInterface public boolean appendZipChunk(String base64Chunk){
            try{if(zipOut==null||!zipEntryOpen)return false;zipOut.write(android.util.Base64.decode(base64Chunk,android.util.Base64.DEFAULT));return true;}catch(Throwable e){return false;}
        }
        @JavascriptInterface public boolean endZipEntry(){try{if(zipOut==null||!zipEntryOpen)return false;zipOut.closeEntry();zipEntryOpen=false;zipOut.flush();return true;}catch(Throwable e){return false;}}
        @JavascriptInterface public boolean finishZip(){
            try{if(zipOut==null)return false;if(zipEntryOpen){zipOut.closeEntry();zipEntryOpen=false;}zipOut.finish();zipOut.close();zipOut=null;zipBaseOut=null;final String path=zipPath;zipPath=null;zipUri=null;zipFile=null;runOnUiThread(new Runnable(){public void run(){Toast.makeText(MainActivity.this,"已保存："+path,Toast.LENGTH_LONG).show();}});return true;}catch(Throwable e){abortZip();return false;}
        }
        @JavascriptInterface public void abortZip(){
            try{if(zipOut!=null)zipOut.close();else if(zipBaseOut!=null)zipBaseOut.close();}catch(Throwable ignore){}zipOut=null;zipBaseOut=null;zipEntryOpen=false;
            try{if(zipUri!=null)getContentResolver().delete(zipUri,null,null);}catch(Throwable ignore){}try{if(zipFile!=null)zipFile.delete();}catch(Throwable ignore){}zipUri=null;zipFile=null;zipPath=null;
        }
        private File transferDir(){File d=new File(getFilesDir(),"transfer_staging");if(!d.exists())d.mkdirs();return d;}
        @JavascriptInterface public boolean beginStage(String taskId,String fileId){try{File d=new File(transferDir(),safePart(taskId));if(!d.exists())d.mkdirs();chunkFile=new File(d,safePart(fileId));chunkOut=new FileOutputStream(chunkFile);return true;}catch(Throwable e){closeChunkQuietly();return false;}}
        @JavascriptInterface public boolean appendStageChunk(String b64){return appendChunk(b64);}
        @JavascriptInterface public boolean endStage(){try{if(chunkOut==null)return false;chunkOut.flush();chunkOut.close();chunkOut=null;chunkFile=null;return true;}catch(Throwable e){closeChunkQuietly();return false;}}
        @JavascriptInterface public String readStageChunk(String taskId,String fileId,long offset,int len){java.io.RandomAccessFile r=null;try{r=new java.io.RandomAccessFile(new File(new File(transferDir(),safePart(taskId)),safePart(fileId)),"r");r.seek(offset);byte[] b=new byte[Math.min(Math.max(1,len),512*1024)];int n=r.read(b);return n<0?"":android.util.Base64.encodeToString(b,0,n,android.util.Base64.NO_WRAP);}catch(Throwable e){return "";}finally{try{if(r!=null)r.close();}catch(Throwable ignore){}}}
        @JavascriptInterface public void clearStage(String taskId){deleteTransferTree(new File(transferDir(),safePart(taskId)));}
        private String safePart(String s){return (s==null?"x":s).replaceAll("[^A-Za-z0-9._-]","_");}
        private void deleteTransferTree(File f){if(f==null||!f.exists())return;if(f.isDirectory()){File[] a=f.listFiles();if(a!=null)for(File x:a)deleteTransferTree(x);}f.delete();}
        @JavascriptInterface
        public void saveBase64(final String base64Data, final String fileName) {
            try {
                byte[] bytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
                final String path;
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    // Android 10+：用 MediaStore，无需任何权限，存到 下载/卡库
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName);
                    cv.put(android.provider.MediaStore.Downloads.RELATIVE_PATH,
                            Environment.DIRECTORY_DOWNLOADS + "/卡库");
                    android.net.Uri uri = getContentResolver().insert(
                            android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new Exception("无法创建文件");
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(bytes);
                    os.flush();
                    os.close();
                    path = "下载/卡库/" + fileName;
                } else {
                    // Android 9 及以下：直接写文件
                    File dir = new File(Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS), "卡库");
                    if (!dir.exists()) dir.mkdirs();
                    File out = new File(dir, fileName);
                    FileOutputStream fos = new FileOutputStream(out);
                    fos.write(bytes);
                    fos.flush();
                    fos.close();
                    path = out.getAbsolutePath();
                }
                runOnUiThread(new Runnable() {
                    public void run() {
                        Toast.makeText(MainActivity.this, "已保存：" + path, Toast.LENGTH_LONG).show();
                    }
                });
            } catch (final Exception e) {
                runOnUiThread(new Runnable() {
                    public void run() {
                        Toast.makeText(MainActivity.this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                });
            }
        }
    }

    // AI 诊断使用的独立原生日志。只保存脱敏后的错误摘要，不保存卡片内容、文件名或密钥。
    private synchronized void recordDiagnosisEvent(String level, String module, String message) {
        try {
            String safe = redactDiagnosisText(message);
            if (safe.length() > 600) safe = safe.substring(0, 600);
            String mod = module == null ? "app" : module.replaceAll("[^A-Za-z0-9_\\-\\u4e00-\\u9fa5]", "_");
            if (mod.length() > 40) mod = mod.substring(0, 40);
            android.content.SharedPreferences pref = getSharedPreferences("kaku_diagnosis", MODE_PRIVATE);
            org.json.JSONArray old;
            try { old = new org.json.JSONArray(pref.getString("events", "[]")); }
            catch (Throwable e) { old = new org.json.JSONArray(); }
            org.json.JSONArray out = new org.json.JSONArray();
            int start = Math.max(0, old.length() - 199);
            for (int i = start; i < old.length(); i++) out.put(old.opt(i));
            org.json.JSONObject row = new org.json.JSONObject();
            row.put("at", System.currentTimeMillis());
            row.put("level", "error".equals(level) ? "error" : "note");
            row.put("module", mod);
            row.put("message", safe);
            out.put(row);
            pref.edit().putString("events", out.toString()).apply();
        } catch (Throwable ignore) {}
    }

    private String redactDiagnosisText(String value) {
        String s = value == null ? "" : value;
        s = s.replaceAll("(?i)bearer\\s+[^\\s]+", "Bearer [secret]");
        s = s.replaceAll("(?i)sk[-_][A-Za-z0-9._-]{6,}", "[secret]");
        s = s.replaceAll("(?i)(content|file)://[^\\s]+", "[local-resource]");
        s = s.replaceAll("(?i)https?://[^\\s]+", "[network-endpoint]");
        s = s.replaceAll("(?i)(/storage/|/sdcard/|/data/)[^\\s]+", "[local-path]");
        s = s.replaceAll("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "[email]");
        return s.replace('\n', ' ').replace('\r', ' ').trim();
    }

    /**
     * AI 诊断桥：只返回运行环境、容量、选择器和实时备份数量等只读摘要。
     * 不返回目录 URI、文件名、卡片文字、聊天、图片、API Key 或账号密码。
     */
    private class DiagnosisBridge {
        @JavascriptInterface public void record(String level, String module, String message) {
            recordDiagnosisEvent(level, module, message);
        }
        @JavascriptInterface public void clearLogs() {
            getSharedPreferences("kaku_diagnosis", MODE_PRIVATE).edit().remove("events").apply();
        }
        @JavascriptInterface public synchronized void startupCheckpoint(int cardCount) {
            try {
                android.content.SharedPreferences p = getSharedPreferences("kaku_diagnosis", MODE_PRIVATE);
                String currentWebView = "unknown";
                try {
                    android.content.pm.PackageInfo wp = android.os.Build.VERSION.SDK_INT >= 26 ? android.webkit.WebView.getCurrentWebViewPackage() : null;
                    if (wp != null && wp.versionName != null) currentWebView = wp.versionName;
                } catch (Throwable ignore) {}
                String previousWebView = p.getString("last_webview_version", "");
                String change = previousWebView.length() == 0 ? "first_record" : (previousWebView.equals(currentWebView) ? "same" : "changed");
                long freeMB = Math.max(0L, getFilesDir().getUsableSpace() / (1024L * 1024L));
                recordDiagnosisEvent("note", "startup_checkpoint", "stage=app_start; outcome=ok; cards=" + Math.max(0, cardCount) + "; webview=" + change + "; privateFreeMB=" + freeMB);
                if ("changed".equals(change)) recordDiagnosisEvent("note", "webview_runtime", "stage=version; outcome=changed");
                p.edit().putString("last_webview_version", currentWebView).putLong("last_checkpoint_at", System.currentTimeMillis()).apply();
            } catch (Throwable ignore) {}
        }
        private boolean canResolve(Intent i) {
            try { return i != null && i.resolveActivity(getPackageManager()) != null; }
            catch (Throwable e) { return false; }
        }
        private long mb(long bytes) { return Math.max(0L, bytes / (1024L * 1024L)); }
        @JavascriptInterface public synchronized String environmentReport() {
            org.json.JSONObject out = new org.json.JSONObject();
            android.database.Cursor cursor = null;
            try {
                out.put("source", "android-app");
                out.put("androidSdk", android.os.Build.VERSION.SDK_INT);
                out.put("androidRelease", android.os.Build.VERSION.RELEASE == null ? "" : android.os.Build.VERSION.RELEASE);
                out.put("manufacturer", android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER);
                out.put("model", android.os.Build.MODEL == null ? "" : android.os.Build.MODEL);

                try {
                    android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                    out.put("appVersion", pi.versionName == null ? "3.9.3" : pi.versionName);
                    long vc = android.os.Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
                    out.put("appVersionCode", vc);
                } catch (Throwable e) { out.put("appVersion", "无法读取"); }

                try {
                    android.content.pm.PackageInfo wp = android.os.Build.VERSION.SDK_INT >= 26 ? android.webkit.WebView.getCurrentWebViewPackage() : null;
                    out.put("webViewPackage", wp == null ? "系统提供" : wp.packageName);
                    out.put("webViewVersion", wp == null || wp.versionName == null ? "无法读取" : wp.versionName);
                } catch (Throwable e) { out.put("webViewPackage", "无法读取"); out.put("webViewVersion", "无法读取"); }

                File internal = getFilesDir();
                org.json.JSONObject storage = new org.json.JSONObject();
                storage.put("privateFreeMB", mb(internal.getUsableSpace()));
                storage.put("privateTotalMB", mb(internal.getTotalSpace()));
                try {
                    File external = Environment.getExternalStorageDirectory();
                    storage.put("sharedFreeMB", mb(external.getUsableSpace()));
                    storage.put("sharedTotalMB", mb(external.getTotalSpace()));
                } catch (Throwable e) { storage.put("sharedAvailable", false); }
                out.put("storage", storage);

                try {
                    android.app.ActivityManager am = (android.app.ActivityManager)getSystemService(ACTIVITY_SERVICE);
                    android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                    am.getMemoryInfo(mi);
                    org.json.JSONObject memory = new org.json.JSONObject();
                    memory.put("availableMB", mb(mi.availMem));
                    memory.put("totalMB", mb(mi.totalMem));
                    memory.put("lowMemory", mi.lowMemory);
                    memory.put("lowMemoryThresholdMB", mb(mi.threshold));
                    out.put("memory", memory);
                } catch (Throwable e) { out.put("memory", new org.json.JSONObject()); }

                org.json.JSONObject pickers = new org.json.JSONObject();
                pickers.put("systemFile", canResolve(createFilePickerIntent(Intent.ACTION_OPEN_DOCUMENT, false)));
                pickers.put("otherFileManager", canResolve(createFilePickerIntent(Intent.ACTION_GET_CONTENT, false)));
                pickers.put("folderAuthorization", canResolve(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)));
                out.put("pickers", pickers);

                org.json.JSONObject safety = new org.json.JSONObject();
                String uriText = getSharedPreferences("safety_library", MODE_PRIVATE).getString("uri", "");
                boolean configured = uriText != null && uriText.length() > 0;
                safety.put("configured", configured);
                safety.put("permissionPersisted", false);
                safety.put("readable", false);
                safety.put("directoryFileCount", 0);
                if (configured) {
                    Uri tree = Uri.parse(uriText);
                    try {
                        for (android.content.UriPermission permission : getContentResolver().getPersistedUriPermissions()) {
                            if (tree.equals(permission.getUri()) && permission.isReadPermission()) { safety.put("permissionPersisted", true); break; }
                        }
                    } catch (Throwable ignore) {}
                    try {
                        Uri dir = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, android.provider.DocumentsContract.getTreeDocumentId(tree));
                        Uri children = android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir, android.provider.DocumentsContract.getDocumentId(dir));
                        // 不请求 DISPLAY_NAME：诊断只验证目录可读并统计条目，不读取或返回文件名。
                        cursor = getContentResolver().query(children, new String[]{android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null);
                        int files = 0;
                        if (cursor != null) while (cursor.moveToNext()) {
                            String mime = cursor.getString(0);
                            if (!android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) files++;
                        }
                        safety.put("readable", cursor != null);
                        safety.put("directoryFileCount", files);
                    } catch (Throwable e) {
                        safety.put("readable", false);
                        safety.put("readError", redactDiagnosisText(e.getClass().getSimpleName()));
                    } finally { if (cursor != null) { cursor.close(); cursor = null; } }
                }
                out.put("safety", safety);

                android.content.SharedPreferences guardPref = getSharedPreferences("kaku_storage_guard", MODE_PRIVATE);
                org.json.JSONObject storageGuard = new org.json.JSONObject();
                storageGuard.put("hadCards", guardPref.getBoolean("had_cards", false));
                storageGuard.put("lastCount", guardPref.getInt("last_count", 0));
                storageGuard.put("maxCount", guardPref.getInt("max_count", 0));
                storageGuard.put("lastSeenAt", guardPref.getLong("last_seen_at", 0L));
                storageGuard.put("lastNonzeroAt", guardPref.getLong("last_nonzero_at", 0L));
                out.put("storageGuard", storageGuard);

                android.content.SharedPreferences diagPref = getSharedPreferences("kaku_diagnosis", MODE_PRIVATE);
                org.json.JSONObject checkpoint = new org.json.JSONObject();
                checkpoint.put("hasWebViewBaseline", diagPref.contains("last_webview_version"));
                checkpoint.put("lastCheckpointAt", diagPref.getLong("last_checkpoint_at", 0L));
                out.put("diagnosticCheckpoint", checkpoint);

                org.json.JSONArray events;
                try { events = new org.json.JSONArray(getSharedPreferences("kaku_diagnosis", MODE_PRIVATE).getString("events", "[]")); }
                catch (Throwable e) { events = new org.json.JSONArray(); }
                org.json.JSONArray recent = new org.json.JSONArray();
                int start = Math.max(0, events.length() - 200);
                for (int i = start; i < events.length(); i++) recent.put(events.opt(i));
                out.put("recentEvents", recent);
                out.put("privacy", "No card text, image, chat, secret, account, filename or directory URI collected");
            } catch (Throwable e) {
                try { out.put("reportError", redactDiagnosisText(e.getClass().getSimpleName())); } catch (Throwable ignore) {}
            } finally { if (cursor != null) cursor.close(); }
            return out.toString();
        }
    }

    /** 原生存储哨兵：只记录“曾经成功保存过卡”，不保存卡片内容。 */
    private class StorageGuardBridge {
        private final String PREF = "kaku_storage_guard";
        @JavascriptInterface
        public boolean hadCards() {
            return getSharedPreferences(PREF, MODE_PRIVATE).getBoolean("had_cards", false);
        }
        @JavascriptInterface
        public void markCards() {
            getSharedPreferences(PREF, MODE_PRIVATE).edit().putBoolean("had_cards", true).apply();
        }
        @JavascriptInterface
        public void clearCards() {
            getSharedPreferences(PREF, MODE_PRIVATE).edit()
                    .putBoolean("had_cards", false).putInt("last_count", 0).putInt("max_count", 0)
                    .putLong("last_nonzero_at", 0L).putLong("last_seen_at", System.currentTimeMillis()).apply();
        }
        @JavascriptInterface
        public void updateCardCount(int count) {
            count = Math.max(0, count);
            android.content.SharedPreferences p = getSharedPreferences(PREF, MODE_PRIVATE);
            android.content.SharedPreferences.Editor e = p.edit()
                    .putInt("last_count", count).putLong("last_seen_at", System.currentTimeMillis());
            if (count > 0) e.putBoolean("had_cards", true)
                    .putInt("max_count", Math.max(count, p.getInt("max_count", 0)))
                    .putLong("last_nonzero_at", System.currentTimeMillis());
            e.apply();
        }
        @JavascriptInterface
        public String status() {
            org.json.JSONObject out = new org.json.JSONObject();
            android.content.SharedPreferences p = getSharedPreferences(PREF, MODE_PRIVATE);
            try {
                out.put("hadCards", p.getBoolean("had_cards", false));
                out.put("lastCount", p.getInt("last_count", 0));
                out.put("maxCount", p.getInt("max_count", 0));
                out.put("lastSeenAt", p.getLong("last_seen_at", 0L));
                out.put("lastNonzeroAt", p.getLong("last_nonzero_at", 0L));
            } catch (Throwable ignore) {}
            return out.toString();
        }
    }

    private class PickerBridge {
        @JavascriptInterface public void setMultiple(boolean multiple){nextFilePickerMultiple=multiple;}
        @JavascriptInterface
        public void setMode(String mode) {
            nextFilePickerMode = "other".equals(mode) ? "other" : "system";
        }
    }

    /** 导航桥：打开外部链接（系统浏览器）、退出 App */
    private class NavBridge {
        @JavascriptInterface
        public void openUrl(final String url) {
            try {
                final android.net.Uri uri = android.net.Uri.parse(url);
                runOnUiThread(new Runnable() {
                    public void run() {
                        try {
                            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(intent);
                        } catch (Exception e) {
                            Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
            } catch (Exception e) { /* ignore */ }
        }

        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(new Runnable() {
                public void run() {
                    finishAffinity();
                }
            });
        }
    }

    /**
     * ST HTTP 代理桥：JS 调用 Java 发 HTTP 请求，Java 用 CookieManager 完整管理 cookie
     * 解决 file:// → http:// 跨协议时 WebView fetch 无法携带/存储 cookie 的问题
     * JS 用法：
     *   StHttpBridge.get(url, csrfToken)            → "{status:200, body:\"...\"}"
     *   StHttpBridge.post(url, csrfToken, body)     → "{status:200, body:\"...\"}"
     *   StHttpBridge.put(url, csrfToken, body)      → "{status:200, body:\"...\"}"
     *   StHttpBridge.del(url, csrfToken)            → "{status:200, body:\"...\"}"
     */
    private static class StHttpBridge {
        private String basicOrigin="", basicValue="";
        @JavascriptInterface public synchronized void setBasicAuth(String origin,String username,String password){
            try{java.net.URL u=new java.net.URL(origin);basicOrigin=u.getProtocol()+"://"+u.getAuthority();basicValue=(username==null||username.length()==0)?"":"Basic "+android.util.Base64.encodeToString((username+":"+(password==null?"":password)).getBytes("UTF-8"),android.util.Base64.NO_WRAP);}catch(Throwable e){basicOrigin="";basicValue="";}
        }
        private synchronized void applyBasicAuth(java.net.HttpURLConnection conn){
            String origin=conn.getURL().getProtocol()+"://"+conn.getURL().getAuthority();
            if(basicValue.length()>0&&origin.equals(basicOrigin)){conn.setRequestProperty("Authorization",basicValue);conn.setInstanceFollowRedirects(false);}
        }

        private final java.net.CookieManager cookieMgr;
        private final File cacheDir;
        // 大响应写临时文件的阈值：超过 4MB 就不进内存，直接落盘，JS 分块读回
        private static final int INLINE_MAX = 4 * 1024 * 1024;

        public StHttpBridge(File cacheDir) {
            this.cacheDir = cacheDir;
            cookieMgr = new java.net.CookieManager(null, java.net.CookiePolicy.ACCEPT_ALL);
            java.net.CookieHandler.setDefault(cookieMgr);
        }

        private String doRequest(String method, String url, String csrfToken, String body) {
            java.net.HttpURLConnection conn = null;
            try {
                java.net.URL u = new java.net.URL(url);
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod(method);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/json");applyBasicAuth(conn);

                // 注入 CSRF token
                if (csrfToken != null && !csrfToken.isEmpty()) {
                    conn.setRequestProperty("X-CSRF-Token", csrfToken);
                }

                // 注入 Java CookieManager 中储存的 cookie（含 session + .sig）
                java.net.URI uri = u.toURI();
                java.util.Map<String, java.util.List<String>> cookieHeaders =
                        cookieMgr.get(uri, new java.util.HashMap<String, java.util.List<String>>());
                java.util.List<String> cookieList = cookieHeaders.get("Cookie");
                if (cookieList != null && !cookieList.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookieList.get(0));
                }

                // 发送 body（POST/PUT）
                if (body != null && !body.isEmpty()) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    byte[] b = body.getBytes("UTF-8");
                    conn.setRequestProperty("Content-Length", String.valueOf(b.length));
                    java.io.OutputStream os = conn.getOutputStream();
                    os.write(b);
                    os.flush();
                    os.close();
                }

                // 读取响应，同时让 CookieManager 存入新 cookie
                int status = conn.getResponseCode();
                cookieMgr.put(uri, conn.getHeaderFields());

                java.io.InputStream is = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
                // 先读进内存，但一旦超过 INLINE_MAX 就转为落盘模式（不再累积内存），
                // 彻底杜绝上千张卡的大响应 OOM。小响应走内存快路径，多数请求几 KB。
                java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                java.io.File spillFile = null;
                java.io.FileOutputStream spillOut = null;
                long totalRead = 0;
                if (is != null) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        totalRead += n;
                        if (spillOut == null && baos.size() + n > INLINE_MAX) {
                            // 超过阈值：把已读的内存内容 flush 到临时文件，之后一律写文件
                            spillFile = new java.io.File(cacheDir, "st_resp_" + System.currentTimeMillis() + ".tmp");
                            spillOut = new java.io.FileOutputStream(spillFile);
                            baos.writeTo(spillOut);
                            baos.reset(); // 释放内存
                        }
                        if (spillOut != null) {
                            spillOut.write(buf, 0, n);
                        } else {
                            baos.write(buf, 0, n);
                        }
                    }
                    is.close();
                }

                if (spillOut != null) {
                    // 大响应：落盘完成，返回文件路径 + 总字节数，JS 用 readSpillChunk 分块读回
                    spillOut.flush();
                    spillOut.close();
                    String path = spillFile.getAbsolutePath();
                    String pEnc = android.util.Base64.encodeToString(path.getBytes("UTF-8"), android.util.Base64.NO_WRAP);
                    return "{\"status\":" + status + ",\"spill\":\"" + pEnc + "\",\"size\":" + totalRead + "}";
                }

                // 小响应：直接内联 base64 返回（原有快路径）
                byte[] bodyBytes = baos.toByteArray();
                String encoded = android.util.Base64.encodeToString(bodyBytes, android.util.Base64.NO_WRAP);
                return "{\"status\":" + status + ",\"b64\":\"" + encoded + "\"}";

            } catch (Throwable e) {
                String msg = (e.getMessage() != null ? e.getMessage() : e.toString());
                msg = msg.replace("\\", "\\\\").replace("\"", "'");
                return "{\"status\":-1,\"b64\":\"" + android.util.Base64.encodeToString(
                        msg.getBytes(), android.util.Base64.NO_WRAP) + "\"}";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        @JavascriptInterface
        public String get(String url, String csrfToken) {
            return doRequest("GET", url, csrfToken, null);
        }

        @JavascriptInterface
        public String post(String url, String csrfToken, String body) {
            return doRequest("POST", url, csrfToken, body);
        }

        @JavascriptInterface
        public String put(String url, String csrfToken, String body) {
            return doRequest("PUT", url, csrfToken, body);
        }

        @JavascriptInterface
        public String del(String url, String csrfToken) {
            return doRequest("DELETE", url, csrfToken, null);
        }

        /** 分块读取落盘的大响应：从 path 的 offset 处读 len 字节，返回 base64。
         *  JS 循环调用直到读满 size，再自己拼接 + UTF-8 解码。避免一次性过大触发 Binder IPC 限制/OOM。 */
        @JavascriptInterface
        public String readSpillChunk(String pathB64, long offset, int len) {
            java.io.RandomAccessFile raf = null;
            try {
                String path = new String(android.util.Base64.decode(pathB64, android.util.Base64.NO_WRAP), "UTF-8");
                raf = new java.io.RandomAccessFile(path, "r");
                raf.seek(offset);
                byte[] buf = new byte[len];
                int got = raf.read(buf);
                raf.close();
                if (got <= 0) return "{\"n\":0,\"b64\":\"\"}";
                String enc = android.util.Base64.encodeToString(buf, 0, got, android.util.Base64.NO_WRAP);
                return "{\"n\":" + got + ",\"b64\":\"" + enc + "\"}";
            } catch (Throwable e) {
                try { if (raf != null) raf.close(); } catch (Throwable ignore) {}
                String msg = (e.getMessage() != null ? e.getMessage() : e.toString()).replace("\\", "\\\\").replace("\"", "'");
                return "{\"n\":-1,\"err\":\"" + msg + "\"}";
            }
        }

        /** 读完临时文件后删除，回收缓存空间 */
        @JavascriptInterface
        public void deleteSpill(String pathB64) {
            try {
                String path = new String(android.util.Base64.decode(pathB64, android.util.Base64.NO_WRAP), "UTF-8");
                new java.io.File(path).delete();
            } catch (Throwable ignore) {}
        }

        /**
         * 拉取角色列表「轻量版」：在原生层用 JsonReader 流式解析响应，
         * 只抽出每张卡的 name/avatar/description（截断），永不把大响应整体载入内存。
         * 结果精简数组落盘（通常几百 KB），JS 用现有 readSpillChunk 秒读回。
         * 彻底解决大酒馆（数千张卡 / 几十 MB 响应）把 WebView 渲染进程撑爆 OOM 的问题。
         */
        @JavascriptInterface
        public String fetchCharListLite(String url, String csrfToken, String body) {
            java.net.HttpURLConnection conn = null;
            android.util.JsonReader jr = null;
            java.io.FileOutputStream fos = null;
            try {
                java.net.URL u = new java.net.URL(url);
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(120000); // 大库解析慢，放宽读超时
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/json");applyBasicAuth(conn);
                if (csrfToken != null && !csrfToken.isEmpty()) {
                    conn.setRequestProperty("X-CSRF-Token", csrfToken);
                }
                java.net.URI uri = u.toURI();
                java.util.Map<String, java.util.List<String>> cookieHeaders =
                        cookieMgr.get(uri, new java.util.HashMap<String, java.util.List<String>>());
                java.util.List<String> cookieList = cookieHeaders.get("Cookie");
                if (cookieList != null && !cookieList.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookieList.get(0));
                }
                if (body != null && !body.isEmpty()) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    byte[] b = body.getBytes("UTF-8");
                    conn.setRequestProperty("Content-Length", String.valueOf(b.length));
                    java.io.OutputStream os = conn.getOutputStream();
                    os.write(b); os.flush(); os.close();
                }

                int status = conn.getResponseCode();
                cookieMgr.put(uri, conn.getHeaderFields());
                if (status < 200 || status >= 300) {
                    return "{\"status\":" + status + ",\"b64\":\"" + android.util.Base64.encodeToString(
                            ("HTTP " + status).getBytes("UTF-8"), android.util.Base64.NO_WRAP) + "\"}";
                }

                // 流式解析：InputStream → JsonReader，边读边抽，绝不整体载入
                java.io.InputStream is = conn.getInputStream();
                jr = new android.util.JsonReader(new java.io.InputStreamReader(is, "UTF-8"));

                // 精简结果直接边解析边写临时文件（连精简数组也不在内存整体拼接）
                java.io.File outFile = new java.io.File(cacheDir, "st_list_" + System.currentTimeMillis() + ".tmp");
                fos = new java.io.FileOutputStream(outFile);
                java.io.Writer w = new java.io.BufferedWriter(new java.io.OutputStreamWriter(fos, "UTF-8"), 65536);

                w.write("[");
                int count = parseLiteList(jr, w);
                w.write("]");
                w.flush();
                w.close();
                fos = null;
                jr.close();
                jr = null;

                long size = outFile.length();
                String pEnc = android.util.Base64.encodeToString(
                        outFile.getAbsolutePath().getBytes("UTF-8"), android.util.Base64.NO_WRAP);
                return "{\"status\":" + status + ",\"spill\":\"" + pEnc + "\",\"size\":" + size + ",\"count\":" + count + "}";

            } catch (Throwable e) {
                String msg = (e.getMessage() != null ? e.getMessage() : e.toString());
                msg = msg.replace("\\", "\\\\").replace("\"", "'");
                return "{\"status\":-1,\"b64\":\"" + android.util.Base64.encodeToString(
                        msg.getBytes(), android.util.Base64.NO_WRAP) + "\"}";
            } finally {
                try { if (jr != null) jr.close(); } catch (Throwable ignore) {}
                try { if (fos != null) fos.close(); } catch (Throwable ignore) {}
                if (conn != null) conn.disconnect();
            }
        }

        // 流式遍历顶层（数组，或包了一层的对象），逐个角色对象抽字段写出，返回处理张数
        private int parseLiteList(android.util.JsonReader jr, java.io.Writer w) throws java.io.IOException {
            int count = 0;
            android.util.JsonToken t = jr.peek();
            if (t == android.util.JsonToken.BEGIN_ARRAY) {
                jr.beginArray();
                while (jr.hasNext()) {
                    if (writeOneChar(jr, w, count > 0)) count++;
                }
                jr.endArray();
            } else if (t == android.util.JsonToken.BEGIN_OBJECT) {
                // 顶层是对象：找到第一个数组类型的值当作角色列表
                jr.beginObject();
                boolean consumed = false;
                while (jr.hasNext()) {
                    jr.nextName();
                    if (!consumed && jr.peek() == android.util.JsonToken.BEGIN_ARRAY) {
                        jr.beginArray();
                        while (jr.hasNext()) {
                            if (writeOneChar(jr, w, count > 0)) count++;
                        }
                        jr.endArray();
                        consumed = true;
                    } else {
                        jr.skipValue();
                    }
                }
                jr.endObject();
            } else {
                jr.skipValue();
            }
            return count;
        }

        // 解析单个角色对象，只保留 name/avatar/description（description 截断到 120 字符）
        private boolean writeOneChar(android.util.JsonReader jr, java.io.Writer w, boolean prependComma) throws java.io.IOException {
            if (jr.peek() != android.util.JsonToken.BEGIN_OBJECT) { jr.skipValue(); return false; }
            String name = null, avatar = null, desc = null;
            jr.beginObject();
            while (jr.hasNext()) {
                String key = jr.nextName();
                if ("name".equals(key) && jr.peek() == android.util.JsonToken.STRING) {
                    name = jr.nextString();
                } else if ("avatar".equals(key) && jr.peek() == android.util.JsonToken.STRING) {
                    avatar = jr.nextString();
                } else if ("description".equals(key) && jr.peek() == android.util.JsonToken.STRING) {
                    desc = jr.nextString();
                    if (desc.length() > 120) desc = desc.substring(0, 120);
                } else {
                    jr.skipValue();
                }
            }
            jr.endObject();
            if (prependComma) w.write(",");
            w.write("{\"name\":");   w.write(jsonStr(name));
            w.write(",\"avatar\":"); w.write(jsonStr(avatar));
            w.write(",\"description\":"); w.write(jsonStr(desc));
            w.write("}");
            return true;
        }

        // 最小 JSON 字符串转义
        private String jsonStr(String s) {
            if (s == null) return "\"\"";
            StringBuilder b = new StringBuilder(s.length() + 8);
            b.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"':  b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default:
                        if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            b.append('"');
            return b.toString();
        }

        // 分块上传缓冲区（解决 Binder 1MB IPC 限制：1.4MB PNG base64 约 1.87MB 会被截断）
        private final java.io.ByteArrayOutputStream _uploadBuf = new java.io.ByteArrayOutputStream();

        /** 开始一次新的分块传输，清空缓冲区 */
        @JavascriptInterface
        public void uploadBegin() {
            _uploadBuf.reset();
        }

        /** 追加一块 base64 数据（每块建议 ≤200KB base64 字符，约 150KB 二进制） */
        @JavascriptInterface
        public String uploadAppend(String b64chunk) {
            try {
                byte[] chunk = android.util.Base64.decode(b64chunk, android.util.Base64.DEFAULT);
                _uploadBuf.write(chunk);
                return "OK:" + _uploadBuf.size();
            } catch (Throwable e) {
                return "ERR:" + e.getMessage();
            }
        }

        /** 把缓冲区内容作为 multipart/form-data 上传，返回酒馆响应 */
        @JavascriptInterface
        public String uploadCommit(String url, String csrfToken, String fileName) {
            java.net.HttpURLConnection conn = null;
            try {
                byte[] fileBytes = _uploadBuf.toByteArray();
                _uploadBuf.reset(); // 用完即清
                String boundary = "KakuJavaBound" + System.currentTimeMillis();
                String CRLF = "\r\n";
                java.io.ByteArrayOutputStream baosBody = new java.io.ByteArrayOutputStream();
                String partHeader = "--" + boundary + CRLF
                    + "Content-Disposition: form-data; name=\"avatar\"; filename=\"" + fileName + "\"" + CRLF
                    + "Content-Type: image/png" + CRLF + CRLF;
                baosBody.write(partHeader.getBytes("UTF-8"));
                baosBody.write(fileBytes);
                baosBody.write((CRLF + "--" + boundary + "--" + CRLF).getBytes("UTF-8"));
                byte[] bodyBytes = baosBody.toByteArray();
                java.net.URL u = new java.net.URL(url);
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(60000);
                conn.setDoOutput(true);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/json");applyBasicAuth(conn);
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                conn.setRequestProperty("Content-Length", String.valueOf(bodyBytes.length));
                if (csrfToken != null && !csrfToken.isEmpty())
                    conn.setRequestProperty("X-CSRF-Token", csrfToken);
                java.net.URI uri = u.toURI();
                java.util.Map<String, java.util.List<String>> ch =
                    cookieMgr.get(uri, new java.util.HashMap<String, java.util.List<String>>());
                java.util.List<String> cl = ch.get("Cookie");
                if (cl != null && !cl.isEmpty()) conn.setRequestProperty("Cookie", cl.get(0));
                java.io.OutputStream os = conn.getOutputStream();
                os.write(bodyBytes); os.flush(); os.close();
                int status = conn.getResponseCode();
                cookieMgr.put(uri, conn.getHeaderFields());
                java.io.InputStream is = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
                java.io.ByteArrayOutputStream baosResp = new java.io.ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[8192]; int n;
                    while ((n = is.read(buf)) != -1) baosResp.write(buf, 0, n);
                    is.close();
                }
                String respBody = baosResp.toString("UTF-8");
                String encoded = android.util.Base64.encodeToString(respBody.getBytes("UTF-8"), android.util.Base64.NO_WRAP);
                return "{\"status\":" + status + ",\"b64\":\"" + encoded + "\"}";
            } catch (Throwable e) {
                String msg = e.getMessage() != null ? e.getMessage() : e.toString();
                msg = msg.replace("\\", "\\\\").replace("\"", "'");
                try {
                    return "{\"status\":-1,\"b64\":\"" + android.util.Base64.encodeToString(msg.getBytes("UTF-8"), android.util.Base64.NO_WRAP) + "\"}";
                } catch (Exception ex) { return "{\"status\":-1,\"b64\":\"\"}"; }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /**
         * 上传角色卡 PNG —— multipart/form-data 完全在 Java 侧构造，避免 JS base64 中转的编码问题
         */
        @JavascriptInterface
        public String postMultipart(String url, String csrfToken, String fileName, String fileB64) {
            java.net.HttpURLConnection conn = null;
            try {
                byte[] fileBytes = android.util.Base64.decode(fileB64, android.util.Base64.DEFAULT);
                String boundary = "KakuJavaBound" + System.currentTimeMillis();
                String CRLF = "\r\n";
                java.io.ByteArrayOutputStream baosBody = new java.io.ByteArrayOutputStream();
                String partHeader = "--" + boundary + CRLF
                    + "Content-Disposition: form-data; name=\"avatar\"; filename=\"" + fileName + "\"" + CRLF
                    + "Content-Type: image/png" + CRLF
                    + CRLF;
                baosBody.write(partHeader.getBytes("UTF-8"));
                baosBody.write(fileBytes);
                baosBody.write((CRLF + "--" + boundary + "--" + CRLF).getBytes("UTF-8"));
                byte[] bodyBytes = baosBody.toByteArray();
                java.net.URL u = new java.net.URL(url);
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(60000);
                conn.setDoOutput(true);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/json");applyBasicAuth(conn);
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                conn.setRequestProperty("Content-Length", String.valueOf(bodyBytes.length));
                if (csrfToken != null && !csrfToken.isEmpty()) {
                    conn.setRequestProperty("X-CSRF-Token", csrfToken);
                }
                java.net.URI uri = u.toURI();
                java.util.Map<String, java.util.List<String>> ch =
                    cookieMgr.get(uri, new java.util.HashMap<String, java.util.List<String>>());
                java.util.List<String> cl = ch.get("Cookie");
                if (cl != null && !cl.isEmpty()) conn.setRequestProperty("Cookie", cl.get(0));
                java.io.OutputStream os = conn.getOutputStream();
                os.write(bodyBytes); os.flush(); os.close();
                int status = conn.getResponseCode();
                cookieMgr.put(uri, conn.getHeaderFields());
                java.io.InputStream is = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
                java.io.ByteArrayOutputStream baosResp = new java.io.ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[8192]; int n;
                    while ((n = is.read(buf)) != -1) baosResp.write(buf, 0, n);
                    is.close();
                }
                String respBody = baosResp.toString("UTF-8");
                String encoded = android.util.Base64.encodeToString(respBody.getBytes("UTF-8"), android.util.Base64.NO_WRAP);
                return "{\"status\":" + status + ",\"b64\":\"" + encoded + "\"}";
            } catch (Throwable e) {
                String msg = e.getMessage() != null ? e.getMessage() : e.toString();
                msg = msg.replace("\\", "\\\\").replace("\"", "'");
                try {
                    return "{\"status\":-1,\"b64\":\"" + android.util.Base64.encodeToString(msg.getBytes("UTF-8"), android.util.Base64.NO_WRAP) + "\"}";
                } catch (Exception ex) { return "{\"status\":-1,\"b64\":\"\"}"; }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /**
         * 发送预构建的 multipart/form-data（body 由 JS 侧构造后 base64 传入）
         * 解决 FormData 无法直接跨 JavascriptInterface 传输的问题
         */
        @JavascriptInterface
        public String postRaw(String url, String csrfToken, String contentType, String bodyB64) {
            java.net.HttpURLConnection conn = null;
            try {
                byte[] bodyBytes = android.util.Base64.decode(bodyB64, android.util.Base64.DEFAULT);
                java.net.URL u = new java.net.URL(url);
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/json");applyBasicAuth(conn);
                conn.setRequestProperty("Content-Type", contentType);
                if (csrfToken != null && !csrfToken.isEmpty()) {
                    conn.setRequestProperty("X-CSRF-Token", csrfToken);
                }
                // 注入 cookie
                java.net.URI uri = u.toURI();
                java.util.Map<String, java.util.List<String>> ch =
                        cookieMgr.get(uri, new java.util.HashMap<String, java.util.List<String>>());
                java.util.List<String> cl = ch.get("Cookie");
                if (cl != null && !cl.isEmpty()) conn.setRequestProperty("Cookie", cl.get(0));
                // 写 body
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Length", String.valueOf(bodyBytes.length));
                java.io.OutputStream os = conn.getOutputStream();
                os.write(bodyBytes); os.flush(); os.close();
                // 读响应
                int status = conn.getResponseCode();
                cookieMgr.put(uri, conn.getHeaderFields());
                java.io.InputStream is = (status >= 400) ? conn.getErrorStream() : conn.getInputStream();
                java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[8192]; int n;
                    long total = 0;
                    while ((n = is.read(buf)) != -1) {
                        total += n;
                        if (total > 10L * 1024 * 1024) { is.close();
                            String m = "响应过大";
                            return "{\"status\":-2,\"b64\":\"" + android.util.Base64.encodeToString(m.getBytes(), android.util.Base64.NO_WRAP) + "\"}";
                        }
                        baos.write(buf, 0, n);
                    }
                    is.close();
                }
                String respBody = baos.toString("UTF-8");
                String encoded = android.util.Base64.encodeToString(respBody.getBytes("UTF-8"), android.util.Base64.NO_WRAP);
                return "{\"status\":" + status + ",\"b64\":\"" + encoded + "\"}";
            } catch (Throwable e) {
                String msg = e.getMessage() != null ? e.getMessage() : e.toString();
                return "{\"status\":-1,\"b64\":\"" + android.util.Base64.encodeToString(msg.getBytes(), android.util.Base64.NO_WRAP) + "\"}";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
    }

        private static class MainActivityHolder { static MainActivity activity; }
    @Override protected void onDestroy(){ if(MainActivityHolder.activity==this)MainActivityHolder.activity=null; super.onDestroy(); }

    /** OpenAI-compatible AI request bridge. API keys stay local and are only sent to the configured endpoint. */
    private static class AiHttpBridge {
        @JavascriptInterface public String get(String url, String apiKey) { return request("GET", url, apiKey, null); }
        @JavascriptInterface public String post(String url, String apiKey, String body) { return request("POST", url, apiKey, body); }
        @JavascriptInterface public void getAsync(final String requestId, final String url, final String apiKey) {
            asyncRequest(requestId, "GET", url, apiKey, null);
        }
        @JavascriptInterface public void postAsync(final String requestId, final String url, final String apiKey, final String body) {
            asyncRequest(requestId, "POST", url, apiKey, body);
        }
        private void asyncRequest(final String requestId, final String method, final String url, final String apiKey, final String body) {
            new Thread(new Runnable(){ @Override public void run(){
                final String result=request(method,url,apiKey,body);
                final String encoded=android.util.Base64.encodeToString(result.getBytes(java.nio.charset.StandardCharsets.UTF_8),android.util.Base64.NO_WRAP);
                final MainActivity owner=MainActivityHolder.activity;
                if(owner!=null)owner.runOnUiThread(new Runnable(){@Override public void run(){if(owner.webView!=null)owner.webView.evaluateJavascript("window.onAIHttpResult&&window.onAIHttpResult('"+requestId.replace("'","")+"','"+encoded+"')",null);}});
            }}).start();
        }
        private String request(String method, String url, String apiKey, String body) {
            java.net.HttpURLConnection conn = null;
            try {
                java.net.URL u = new java.net.URL(url);
                String scheme = u.getProtocol();
                if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)))
                    throw new IllegalArgumentException("Only HTTP/HTTPS endpoints are allowed");
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod(method);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(120000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/json");
                if (apiKey != null && !apiKey.trim().isEmpty())
                    conn.setRequestProperty("Authorization", "Bearer " + apiKey.trim());
                if (body != null) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    byte[] out = body.getBytes("UTF-8");
                    conn.setFixedLengthStreamingMode(out.length);
                    java.io.OutputStream os = conn.getOutputStream();
                    os.write(out); os.flush(); os.close();
                }
                int status = conn.getResponseCode();
                java.io.InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                if (is != null) { byte[] buf = new byte[8192]; int n, total=0; while ((n=is.read(buf))!=-1) { total+=n; if(total>8*1024*1024) throw new java.io.IOException("AI response exceeds 8MB"); baos.write(buf,0,n); } is.close(); }
                String b64 = android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP);
                return "{\"status\":"+status+",\"b64\":\""+b64+"\"}";
            } catch (Throwable e) {
                try { String msg=e.getMessage()!=null?e.getMessage():e.toString(); String b64=android.util.Base64.encodeToString(msg.getBytes("UTF-8"),android.util.Base64.NO_WRAP); return "{\"status\":-1,\"b64\":\""+b64+"\"}"; } catch(Throwable x){ return "{\"status\":-1,\"b64\":\"\"}"; }
            } finally { if(conn!=null) conn.disconnect(); }
        }
    }


    private class FolderBridge {
        @JavascriptInterface public int getLauncherIcon(){return getSharedPreferences("appearance",MODE_PRIVATE).getInt("launcherIcon",2);}
        @JavascriptInterface public String setLauncherIcon(int selected){if(selected<1||selected>3)return "error:invalid";try{android.content.pm.PackageManager pm=getPackageManager();pm.setComponentEnabledSetting(new android.content.ComponentName(MainActivity.this,getPackageName()+".LauncherIcon"+selected),android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED,android.content.pm.PackageManager.DONT_KILL_APP);for(int i=1;i<=3;i++)if(i!=selected)pm.setComponentEnabledSetting(new android.content.ComponentName(MainActivity.this,getPackageName()+".LauncherIcon"+i),android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,android.content.pm.PackageManager.DONT_KILL_APP);getSharedPreferences("appearance",MODE_PRIVATE).edit().putInt("launcherIcon",selected).apply();return "ok";}catch(Throwable e){return "error:"+e.getMessage();}}

        private String escJson(String s) { return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", ""); }
        private java.io.OutputStream tavernOut;
        private Uri tavernWriteUri;
        private java.io.OutputStream safetyOut;
private java.io.InputStream safetyReadIn;
private final java.util.HashMap<String,Uri> safetyBatchFiles=new java.util.HashMap<>();
private boolean safetyBatchActive=false;
        @JavascriptInterface public void chooseTavernFolder(final String pointId) {
            pendingTavernPointId=(pointId==null||pointId.length()==0)?"legacy":pointId.replaceAll("[^A-Za-z0-9_-]","");
            runOnUiThread(new Runnable(){ public void run(){
                Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(i,TAVERN_TREE_REQ);
            }});
        }
        private String tavernPointUri(String pointId){
            String id=(pointId==null||pointId.length()==0)?"legacy":pointId;
            String u=getSharedPreferences("tavern_folders",MODE_PRIVATE).getString(id,"");
            if(u.length()==0&&"legacy".equals(id)){u=getSharedPreferences("tavern_folder",MODE_PRIVATE).getString("uri","");if(u.length()>0)getSharedPreferences("tavern_folders",MODE_PRIVATE).edit().putString("legacy",u).apply();}
            return u;
        }
        @JavascriptInterface public String getTavernFolder(String pointId,String kind) {
            String u=tavernPointUri(pointId);if(u.length()==0)return "{}";
            try{Uri tree=Uri.parse(u),root=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),target="cards".equals(kind)?findCharactersDir(tree):root;return "{\"uri\":\""+escJson(u)+"\",\"name\":\""+escJson(leafName(docName(root)))+"\",\"target\":\""+escJson(leafName(docName(target)))+"\",\"ready\":"+(target!=null)+"}";}catch(Throwable e){return "{\"uri\":\""+escJson(u)+"\",\"error\":\""+escJson(e.getMessage())+"\"}";}
        }
        private String leafName(String s){if(s==null)return "";s=s.replace('\\','/');int p=s.lastIndexOf('/');return p>=0?s.substring(p+1):s;}
        @JavascriptInterface public void clearTavernFolder(String pointId) {
            String id=(pointId==null||pointId.length()==0)?"legacy":pointId,u=tavernPointUri(id);
            getSharedPreferences("tavern_folders",MODE_PRIVATE).edit().remove(id).apply();
            if("legacy".equals(id))getSharedPreferences("tavern_folder",MODE_PRIVATE).edit().clear().apply();
            if(u.length()>0)try{getContentResolver().releasePersistableUriPermission(Uri.parse(u),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);}catch(Throwable ignore){}
        }
        private String docName(Uri doc){if(doc==null)return "";android.database.Cursor c=null;try{c=getContentResolver().query(doc,new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);return c!=null&&c.moveToFirst()?c.getString(0):"";}catch(Throwable e){return "";}finally{if(c!=null)c.close();}}
        private Uri childDir(Uri parent,String wanted)throws Exception{Uri children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(parent,android.provider.DocumentsContract.getDocumentId(parent));android.database.Cursor c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE},null,null,null);if(c==null)return null;try{while(c.moveToNext()){if(android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))&&wanted.equalsIgnoreCase(c.getString(1)))return android.provider.DocumentsContract.buildDocumentUriUsingTree(parent,c.getString(0));}}finally{c.close();}return null;}
        private Uri findCharactersDir(Uri tree)throws Exception{Uri root=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree));String n=docName(root);if("characters".equalsIgnoreCase(n))return root;if("default-user".equalsIgnoreCase(n)){Uri x=childDir(root,"characters");if(x!=null)return x;}Uri direct=childDir(root,"characters");if(direct!=null)return direct;Uri def=childDir(root,"default-user");if(def!=null){Uri x=childDir(def,"characters");if(x!=null)return x;}Uri data=childDir(root,"data");if(data!=null){def=childDir(data,"default-user");if(def!=null){Uri x=childDir(def,"characters");if(x!=null)return x;}}throw new java.io.IOException("未找到 default-user/characters，请直接选择 characters 或 default-user 文件夹");}
        private Uri personaRoot(String pointId)throws Exception{String u=tavernPointUri(pointId);if(u.length()==0)throw new java.io.IOException("请先选择酒馆账号目录");Uri tree=Uri.parse(u);Uri root=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree));if(findFile(root,"settings.json")==null)throw new java.io.IOException("请选择直接包含 settings.json 与 User Avatars 的账号目录");return root;}
        private String personaRead(Uri uri)throws Exception{java.io.InputStream in=getContentResolver().openInputStream(uri);if(in==null)throw new java.io.IOException("文件不可读");try{java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] buf=new byte[32768];int count;while((count=in.read(buf))!=-1){if(out.size()+count>32*1024*1024)throw new java.io.IOException("设置文件超过32MB，本测试版停止读取");out.write(buf,0,count);}return new String(out.toByteArray(),"UTF-8");}finally{in.close();}}
        private void personaWrite(Uri uri,String text)throws Exception{java.io.OutputStream out=getContentResolver().openOutputStream(uri,"wt");if(out==null)throw new java.io.IOException("文件不可写");try{out.write(text.getBytes("UTF-8"));out.flush();}finally{out.close();}}
        private void personaCopy(android.util.JsonReader r,android.util.JsonWriter w)throws Exception{switch(r.peek()){case BEGIN_OBJECT:r.beginObject();w.beginObject();while(r.hasNext()){w.name(r.nextName());personaCopy(r,w);}r.endObject();w.endObject();break;case BEGIN_ARRAY:r.beginArray();w.beginArray();while(r.hasNext())personaCopy(r,w);r.endArray();w.endArray();break;case STRING:w.value(r.nextString());break;case NUMBER:w.value(new java.math.BigDecimal(r.nextString()));break;case BOOLEAN:w.value(r.nextBoolean());break;case NULL:r.nextNull();w.nullValue();break;default:throw new java.io.IOException("JSON结构无效");}}
        private String personaHash(Uri uri)throws Exception{java.security.MessageDigest md=java.security.MessageDigest.getInstance("SHA-256");java.io.InputStream in=getContentResolver().openInputStream(uri);try{byte[] buf=new byte[32768];int n;while((n=in.read(buf))!=-1)md.update(buf,0,n);}finally{in.close();}StringBuilder b=new StringBuilder();for(byte x:md.digest())b.append(String.format(java.util.Locale.US,"%02x",x&255));return b.toString();}
        private void personaCopyFile(Uri from,Uri to)throws Exception{java.io.InputStream in=getContentResolver().openInputStream(from);try{java.io.OutputStream out=getContentResolver().openOutputStream(to,"wt");try{byte[] buf=new byte[32768];int n;while((n=in.read(buf))!=-1)out.write(buf,0,n);out.flush();}finally{out.close();}}finally{in.close();}}
        @JavascriptInterface public String readPersonaSettings(String id){try{Uri file=findFile(personaRoot(id),"settings.json");String hash=personaHash(file);org.json.JSONObject power=new org.json.JSONObject();android.util.JsonReader r=new android.util.JsonReader(new java.io.InputStreamReader(getContentResolver().openInputStream(file),"UTF-8"));try{r.beginObject();while(r.hasNext()){String key=r.nextName();if(!"power_user".equals(key)){r.skipValue();continue;}r.beginObject();while(r.hasNext()){key=r.nextName();if("personas".equals(key)||"persona_descriptions".equals(key)){java.io.StringWriter str=new java.io.StringWriter();android.util.JsonWriter w=new android.util.JsonWriter(str);personaCopy(r,w);w.flush();power.put(key,new org.json.JSONObject(str.toString()));}else r.skipValue();}r.endObject();}r.endObject();}finally{r.close();}if(!hash.equals(personaHash(file)))throw new java.io.IOException("设置读取期间发生变化，请重新扫描");org.json.JSONObject root=new org.json.JSONObject();root.put("power_user",power);org.json.JSONObject result=new org.json.JSONObject();result.put("text",root.toString());result.put("token",hash);return result.toString();}catch(Throwable e){return "{\"error\":\""+escJson(e.getMessage())+"\"}";}}
        private void personaPatch(Uri source,Uri target,org.json.JSONObject patch)throws Exception{android.util.JsonReader r=new android.util.JsonReader(new java.io.InputStreamReader(getContentResolver().openInputStream(source),"UTF-8"));try{android.util.JsonWriter w=new android.util.JsonWriter(new java.io.OutputStreamWriter(getContentResolver().openOutputStream(target,"wt"),"UTF-8"));try{r.beginObject();w.beginObject();boolean found=false;while(r.hasNext()){String key=r.nextName();w.name(key);if(!"power_user".equals(key)){personaCopy(r,w);continue;}found=true;r.beginObject();w.beginObject();while(r.hasNext()){key=r.nextName();w.name(key);if(patch.has(key)){r.skipValue();android.util.JsonReader pr=new android.util.JsonReader(new java.io.StringReader(patch.getJSONObject(key).toString()));try{personaCopy(pr,w);}finally{pr.close();}}else personaCopy(r,w);}r.endObject();for(String k:new String[]{"personas","persona_descriptions"}){ /* keys are already present in supported account settings */ }w.endObject();}if(!found)throw new java.io.IOException("缺少power_user，停止写回");r.endObject();w.endObject();w.flush();}finally{w.close();}}finally{r.close();}}
        private volatile boolean personaCommitRunning=false;
        private void personaStage(final String stage){runOnUiThread(new Runnable(){public void run(){webView.evaluateJavascript("window.onPersonaNativeStage&&window.onPersonaNativeStage("+org.json.JSONObject.quote(stage)+")",null);}});}
        @JavascriptInterface public synchronized void commitPersonaSettingsAsync(final String id,final String expected,final String entries){if(personaCommitRunning)return;personaCommitRunning=true;new Thread(new Runnable(){public void run(){final String result=commitPersonaSettings(id,expected,entries);personaCommitRunning=false;runOnUiThread(new Runnable(){public void run(){webView.evaluateJavascript("window.onPersonaNativeDone&&window.onPersonaNativeDone("+org.json.JSONObject.quote(result)+")",null);}});}},"persona-commit").start();}
        @JavascriptInterface public String commitPersonaSettings(String id,String expected,String entries){Uri temp=null;try{personaStage("正在读取并校验酒馆设置…");Uri root=personaRoot(id),settings=findFile(root,"settings.json");if(!personaHash(settings).equals(expected))throw new java.io.IOException("设置已变化，请停止酒馆后重新扫描");org.json.JSONObject selected=new org.json.JSONObject(readPersonaSettings(id));if(selected.has("error"))throw new java.io.IOException(selected.getString("error"));org.json.JSONObject power=new org.json.JSONObject(selected.getString("text")).getJSONObject("power_user");org.json.JSONObject names=power.optJSONObject("personas"),descs=power.optJSONObject("persona_descriptions");if(names==null||descs==null)throw new java.io.IOException("缺少User集合，停止写回");org.json.JSONArray rows=new org.json.JSONArray(entries);for(int i=0;i<rows.length();i++){org.json.JSONObject row=rows.getJSONObject(i);String key=row.getString("key");if(!key.matches("kaku_persona_[A-Za-z0-9_-]+\\.(png|jpg|jpeg|webp)"))throw new java.io.IOException("新头像文件名无效");org.json.JSONObject d=row.getJSONObject("descriptor");d.put("description",row.getString("description"));names.put(key,row.getString("name"));descs.put(key,d);}String tag=System.currentTimeMillis()+"-"+java.util.UUID.randomUUID().toString().substring(0,8);temp=android.provider.DocumentsContract.createDocument(getContentResolver(),root,"application/json","settings.persona-stage-"+tag+".json");personaStage("正在合并名称、正文和配置…");personaPatch(settings,temp,power);String stagedHash=personaHash(temp);personaStage("正在备份并校验酒馆设置，可能需要较长时间…");String backupName="settings.persona-backup-"+tag+".json";Uri copy=android.provider.DocumentsContract.createDocument(getContentResolver(),root,"application/json",backupName);personaCopyFile(settings,copy);if(!expected.equals(personaHash(copy))||!expected.equals(personaHash(settings)))throw new java.io.IOException("设置变化或备份校验失败，停止写回");personaStage("正在写回并核验结果，请勿关闭…");try{personaCopyFile(temp,settings);if(!stagedHash.equals(personaHash(settings)))throw new java.io.IOException("设置写入校验失败");}catch(Throwable error){personaCopyFile(copy,settings);if(!expected.equals(personaHash(settings)))throw new java.io.IOException("恢复校验失败，请使用 "+backupName);throw new java.io.IOException("写回失败，已恢复设置："+error.getMessage());}return "{\"ok\":true,\"backup\":\""+escJson(backupName)+"\"}";}catch(Throwable e){return "{\"error\":\""+escJson(e.getMessage())+"\"}";}finally{if(temp!=null)try{android.provider.DocumentsContract.deleteDocument(getContentResolver(),temp);}catch(Throwable ignore){}}}
        @JavascriptInterface public String rollbackPersonaAvatar(String id,String name){try{if(!name.matches("kaku_persona_[A-Za-z0-9_-]+\\.(png|jpg|jpeg|webp)"))throw new java.io.IOException("文件名无效");Uri file=findFile(childDir(personaRoot(id),"User Avatars"),name);return file==null||android.provider.DocumentsContract.deleteDocument(getContentResolver(),file)?"ok":"error:头像回退失败";}catch(Throwable e){return "error:"+e.getMessage();}}
        @JavascriptInterface public String scanTavernFolder(String pointId,String mode){String u=tavernPointUri(pointId);if(u.length()==0)return "{\"error\":\"尚未选择酒馆文件夹\",\"files\":[]}";StringBuilder out=new StringBuilder("{\"files\":[");int count=0;android.database.Cursor c=null;try{boolean role="cards".equals(mode);Uri tree=Uri.parse(u),dir="persona".equals(mode)?childDir(personaRoot(pointId),"User Avatars"):(role?findCharactersDir(tree):android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)));if(dir==null)throw new java.io.IOException("未找到 User Avatars 目录");Uri children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,android.provider.DocumentsContract.Document.COLUMN_SIZE},null,null,null);if(c!=null)while(c.moveToNext()&&count<5000){String name=c.getString(1),mime=c.getString(2);if(android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime))continue;String low=name==null?"":name.toLowerCase(java.util.Locale.US);boolean ok=low.endsWith(".png")||low.endsWith(".json")||(!role&&(low.endsWith(".txt")||low.endsWith(".docx")||low.endsWith(".webp")||low.endsWith(".jpg")||low.endsWith(".jpeg")));if(!ok)continue;Uri f=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));if(count++>0)out.append(',');out.append("{\"name\":\"").append(escJson(name)).append("\",\"uri\":\"").append(escJson(f.toString())).append("\",\"size\":").append(c.isNull(3)?0:c.getLong(3)).append('}');}return out.append("],\"count\":").append(count).append(",\"target\":\"").append(escJson(docName(dir))).append("\"}").toString();}catch(Throwable e){return "{\"error\":\""+escJson(e.getMessage())+"\",\"files\":[]}";}finally{if(c!=null)c.close();}}
        @JavascriptInterface public String readTavernChunk(String uri,int offset,int len){java.io.InputStream in=null;try{in=getContentResolver().openInputStream(Uri.parse(uri));long skip=offset;while(skip>0){long n=in.skip(skip);if(n<=0)break;skip-=n;}byte[] b=new byte[Math.min(len,512*1024)];int n=in.read(b);return n<0?"":android.util.Base64.encodeToString(b,0,n,android.util.Base64.NO_WRAP);}catch(Throwable e){return "";}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}}}
        private Uri findFile(Uri dir,String name)throws Exception{Uri children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));android.database.Cursor c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);if(c==null)return null;try{while(c.moveToNext())if(name.equalsIgnoreCase(c.getString(1)))return android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));}finally{c.close();}return null;}
        @JavascriptInterface public String beginTavernWrite(String pointId,String mode,String name,boolean overwrite){try{if(tavernOut!=null){tavernOut.close();tavernOut=null;}name=name==null?"file.bin":name.replaceAll("[\\/:*?\"<>|]","_");String u=tavernPointUri(pointId);Uri tree=Uri.parse(u),dir="persona".equals(mode)?childDir(personaRoot(pointId),"User Avatars"):("cards".equals(mode)?findCharactersDir(tree):android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)));if(dir==null)throw new java.io.IOException("未找到 User Avatars 目录");Uri old=findFile(dir,name);if(old!=null&&!overwrite)return "exists";if(old!=null)tavernWriteUri=old;else{String low=name.toLowerCase(java.util.Locale.US),mime=low.endsWith(".png")?"image/png":low.endsWith(".webp")?"image/webp":(low.endsWith(".jpg")||low.endsWith(".jpeg"))?"image/jpeg":low.endsWith(".json")?"application/json":low.endsWith(".txt")?"text/plain":low.endsWith(".docx")?"application/vnd.openxmlformats-officedocument.wordprocessingml.document":"application/octet-stream";tavernWriteUri=android.provider.DocumentsContract.createDocument(getContentResolver(),dir,mime,name);}if(tavernWriteUri==null)throw new java.io.IOException("无法创建目标文件");tavernOut=getContentResolver().openOutputStream(tavernWriteUri,"wt");return tavernOut!=null?"ok":"error";}catch(Throwable e){return "error:"+(e.getMessage()==null?e.toString():e.getMessage());}}
        @JavascriptInterface public boolean appendTavernChunk(String b64){try{if(tavernOut==null)return false;byte[] b=android.util.Base64.decode(b64,android.util.Base64.DEFAULT);tavernOut.write(b);return true;}catch(Throwable e){return false;}}
        @JavascriptInterface public boolean endTavernWrite(){try{if(tavernOut==null)return false;tavernOut.flush();tavernOut.close();tavernOut=null;return true;}catch(Throwable e){try{if(tavernOut!=null)tavernOut.close();}catch(Throwable ignore){}tavernOut=null;return false;}}
        @JavascriptInterface public void chooseSafetyFolder(){runOnUiThread(new Runnable(){public void run(){Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(i,SAFETY_TREE_REQ);}});}
        private String safetyUri(){return getSharedPreferences("safety_library",MODE_PRIVATE).getString("uri","");}
        @JavascriptInterface public synchronized void disableSafetyFolder(){String u=safetyUri();try{if(safetyOut!=null){safetyOut.close();safetyOut=null;}}catch(Throwable ignore){}getSharedPreferences("safety_library",MODE_PRIVATE).edit().remove("uri").apply();if(u.length()>0)try{getContentResolver().releasePersistableUriPermission(Uri.parse(u),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);}catch(Throwable ignore){}}
        @JavascriptInterface public String safetyInfo(){String u=safetyUri();return "{\"ready\":"+(u.length()>0)+",\"uri\":\""+escJson(u)+"\",\"name\":\""+(u.length()>0?escJson(folderName(Uri.parse(u))):"")+"\"}";}
        @JavascriptInterface public synchronized String beginSafetyBatch(){org.json.JSONObject hashes=new org.json.JSONObject();android.database.Cursor c=null;try{safetyBatchFiles.clear();String u=safetyUri();if(u.length()==0)return "{}";Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);java.util.ArrayList<Uri> metaUris=new java.util.ArrayList<>();while(c!=null&&c.moveToNext()){String name=c.getString(1);if(name==null)continue;Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));safetyBatchFiles.put(name.toLowerCase(java.util.Locale.US),x);if(name.toLowerCase(java.util.Locale.US).startsWith("kaku_meta_")&&name.toLowerCase(java.util.Locale.US).endsWith(".json"))metaUris.add(x);}safetyBatchActive=true;return hashes.toString();}catch(Throwable e){safetyBatchFiles.clear();safetyBatchActive=false;return "";}finally{if(c!=null)c.close();}}
        @JavascriptInterface public synchronized void endSafetyBatch(){safetyBatchActive=false;safetyBatchFiles.clear();}
        @JavascriptInterface public synchronized boolean hasSafetyPair(String rawName,String metaName){return safetyBatchActive&&safetyBatchFiles.containsKey(rawName.toLowerCase(java.util.Locale.US))&&safetyBatchFiles.containsKey(metaName.toLowerCase(java.util.Locale.US));}
        @JavascriptInterface public synchronized String commitSafetyRevision(String rawTemp,String rawName,String metaTemp,String metaName){
            try{
                Uri tree=Uri.parse(safetyUri());Uri dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree));
                Uri raw=(safetyBatchActive?safetyBatchFiles.get(rawTemp.toLowerCase(java.util.Locale.US)):findFile(dir,rawTemp)),meta=(safetyBatchActive?safetyBatchFiles.get(metaTemp.toLowerCase(java.util.Locale.US)):findFile(dir,metaTemp));if(raw==null||meta==null)return "error:临时副本缺失，保留旧备份";
                String suffix=".previous_"+System.currentTimeMillis();Uri oldRaw=(safetyBatchActive?safetyBatchFiles.get(rawName.toLowerCase(java.util.Locale.US)):findFile(dir,rawName)),oldMeta=(safetyBatchActive?safetyBatchFiles.get(metaName.toLowerCase(java.util.Locale.US)):findFile(dir,metaName));
                // Retain previous complete documents; never truncate them in place.
                if(oldRaw!=null){oldRaw=android.provider.DocumentsContract.renameDocument(getContentResolver(),oldRaw,rawName+suffix);if(oldRaw==null)return "error:无法保留旧原件";}
                if(oldMeta!=null){oldMeta=android.provider.DocumentsContract.renameDocument(getContentResolver(),oldMeta,metaName+suffix);if(oldMeta==null)return "error:无法保留旧元数据";}
                raw=android.provider.DocumentsContract.renameDocument(getContentResolver(),raw,rawName);if(raw==null)return "error:原件提交失败，旧副本仍保留";
                meta=android.provider.DocumentsContract.renameDocument(getContentResolver(),meta,metaName);if(meta==null)return "error:元数据提交失败，旧副本仍保留";
                if(oldRaw!=null)try{android.provider.DocumentsContract.deleteDocument(getContentResolver(),oldRaw);}catch(Throwable ignore){}
                if(oldMeta!=null)try{android.provider.DocumentsContract.deleteDocument(getContentResolver(),oldMeta);}catch(Throwable ignore){}
                if(safetyBatchActive){safetyBatchFiles.remove(rawTemp.toLowerCase(java.util.Locale.US));safetyBatchFiles.remove(metaTemp.toLowerCase(java.util.Locale.US));safetyBatchFiles.put(rawName.toLowerCase(java.util.Locale.US),raw);safetyBatchFiles.put(metaName.toLowerCase(java.util.Locale.US),meta);}
                return "ok";
            }catch(Throwable e){return "error:"+e.toString();}
        }
        @JavascriptInterface public synchronized String beginSafetyWrite(String name){return beginSafetyWriteMode(name,false);}
        @JavascriptInterface public synchronized String beginSafetyWriteMode(String name,boolean overwrite){try{if(safetyOut!=null){safetyOut.close();safetyOut=null;}String u=safetyUri();if(u.length()==0)return "not_configured";name=(name==null?"card.bin":name).replaceAll("[\\/:*?\"<>|]","_");Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree));String low=name.toLowerCase(java.util.Locale.US);Uri old=safetyBatchActive?safetyBatchFiles.get(low):findFile(dir,name);if(old!=null&&!overwrite)return "exists";String mime=low.endsWith(".png")?"image/png":low.endsWith(".json")||low.endsWith(".kaku-meta")?"application/json":low.endsWith(".txt")?"text/plain":"application/octet-stream";Uri target=old!=null?old:android.provider.DocumentsContract.createDocument(getContentResolver(),dir,mime,name);if(target==null)throw new java.io.IOException("无法创建安全副本");if(safetyBatchActive)safetyBatchFiles.put(low,target);safetyOut=getContentResolver().openOutputStream(target,"wt");return safetyOut!=null?"ok":"error";}catch(Throwable e){return "error:"+(e.getMessage()==null?e.toString():e.getMessage());}}
        @JavascriptInterface public synchronized int deleteSafetyCard(String id){if(id==null||id.length()==0)return 0;String u=safetyUri();if(u.length()==0)return 0;int deleted=0;android.database.Cursor c=null;try{Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);String prefix="kaku_"+id;while(c!=null&&c.moveToNext()){String name=c.getString(1);if(name!=null&&(name.startsWith(prefix+"__")||name.equals(prefix+".kaku-meta")||name.startsWith("kaku_meta_"+id+".json"))){Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));if(android.provider.DocumentsContract.deleteDocument(getContentResolver(),x))deleted++;}}}catch(Throwable ignore){}finally{if(c!=null)c.close();}return deleted;}
        @JavascriptInterface public synchronized int deleteSafetyCards(String idsJson){String u=safetyUri();if(u.length()==0)return 0;int deleted=0;android.database.Cursor c=null;try{org.json.JSONArray a=new org.json.JSONArray(idsJson==null?"[]":idsJson);java.util.HashSet<String> ids=new java.util.HashSet<>();for(int i=0;i<a.length();i++){String id=a.optString(i,"").toLowerCase(java.util.Locale.US);if(id.length()>0)ids.add(id);}if(ids.isEmpty())return 0;Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);while(c!=null&&c.moveToNext()){String name=c.getString(1),low=name==null?"":name.toLowerCase(java.util.Locale.US);boolean match=false;for(String id:ids){if(low.startsWith("kaku_"+id+"__")||low.startsWith("kaku_meta_"+id)||low.startsWith("kaku_"+id+".kaku-meta")||low.startsWith("kaku_"+id+".kakumeta")){match=true;break;}}if(match){Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));if(android.provider.DocumentsContract.deleteDocument(getContentResolver(),x))deleted++;}}}catch(Throwable ignore){}finally{if(c!=null)c.close();}return deleted;}
        private String safetyOriginalHash(Uri dir,String id){android.database.Cursor c=null;java.io.InputStream in=null;try{Uri children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);String prefix=("kaku_"+id+"__").toLowerCase(java.util.Locale.US);while(c!=null&&c.moveToNext()){String name=c.getString(1),low=name==null?"":name.toLowerCase(java.util.Locale.US);if(!low.startsWith(prefix))continue;Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));in=getContentResolver().openInputStream(x);java.security.MessageDigest md=java.security.MessageDigest.getInstance("SHA-256");byte[] b=new byte[256*1024];int n;while((n=in.read(b))>0)md.update(b,0,n);StringBuilder h=new StringBuilder();for(byte v:md.digest())h.append(String.format(java.util.Locale.US,"%02x",v&255));return h.toString();}}catch(Throwable ignore){}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}if(c!=null)c.close();}return "";}
        @JavascriptInterface public String findSafetyIdByHash(String hash,String excludeId){if(hash==null||hash.length()==0)return "";String u=safetyUri();if(u.length()==0)return "";android.database.Cursor c=null;try{Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);while(c!=null&&c.moveToNext()){String name=c.getString(1),low=name==null?"":name.toLowerCase(java.util.Locale.US);if(!low.startsWith("kaku_meta_")||!low.contains(".json"))continue;Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));java.io.InputStream in=null;try{in=getContentResolver().openInputStream(x);java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] b=new byte[4096];int n;while((n=in.read(b))>0&&out.size()<1024*1024)out.write(b,0,n);org.json.JSONObject o=new org.json.JSONObject(new String(out.toByteArray(),java.nio.charset.StandardCharsets.UTF_8));String id=o.optString("id","");String oldHash=o.optString("importHash","");if(!id.equals(excludeId)&&(hash.equals(oldHash)||oldHash.length()==0&&hash.equals(safetyOriginalHash(dir,id))))return id;}catch(Throwable ignore){}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}}}}catch(Throwable ignore){}finally{if(c!=null)c.close();}return "";}
        @JavascriptInterface public String readSafetyMeta(String id){java.io.InputStream in=null;try{String u=safetyUri();if(u.length()==0)return "";Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),x=findFile(dir,"kaku_meta_"+id+".json");if(x==null)x=findFile(dir,"kaku_"+id+".kaku-meta");if(x==null)x=findFile(dir,"kaku_"+id+".kaku-meta.json");if(x==null)return "";in=getContentResolver().openInputStream(x);java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream();byte[] b=new byte[8192];int n;while((n=in.read(b))>0){out.write(b,0,n);if(out.size()>1024*1024)throw new java.io.IOException("元数据文件过大");}return android.util.Base64.encodeToString(out.toByteArray(),android.util.Base64.NO_WRAP);}catch(Throwable e){return "";}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}}}
        private boolean isSafetyMetaName(String name){String low=name==null?"":name.toLowerCase(java.util.Locale.US);return low.startsWith("kaku_meta_")&&low.contains(".json")||low.startsWith("kaku_")&&(low.contains(".kaku-meta")||low.contains(".kakumeta"));}
        @JavascriptInterface public synchronized int deleteSafetyMeta(String id){if(id==null||id.length()==0)return 0;String u=safetyUri();if(u.length()==0)return 0;int deleted=0;if(safetyBatchActive){java.util.ArrayList<String> keys=new java.util.ArrayList<>();String target=id.toLowerCase(java.util.Locale.US);for(String low:safetyBatchFiles.keySet())if(low.startsWith("kaku_meta_"+target)||low.startsWith("kaku_"+target)&&(low.contains(".kaku-meta")||low.contains(".kakumeta")))keys.add(low);for(String low:keys){Uri x=safetyBatchFiles.remove(low);try{if(x!=null&&android.provider.DocumentsContract.deleteDocument(getContentResolver(),x))deleted++;}catch(Throwable ignore){}}return deleted;}android.database.Cursor c=null;try{Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);String target=id.toLowerCase(java.util.Locale.US);while(c!=null&&c.moveToNext()){String name=c.getString(1),low=name==null?"":name.toLowerCase(java.util.Locale.US);if(low.startsWith("kaku_meta_"+target)||low.startsWith("kaku_"+target)&&(low.contains(".kaku-meta")||low.contains(".kakumeta"))){Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));if(android.provider.DocumentsContract.deleteDocument(getContentResolver(),x))deleted++;}}}catch(Throwable ignore){}finally{if(c!=null)c.close();}return deleted;}
        @JavascriptInterface public synchronized int cleanupSafetyMetadata(){String u=safetyUri();if(u.length()==0)return 0;int deleted=0;android.database.Cursor c=null;try{Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null);while(c!=null&&c.moveToNext()){String name=c.getString(1);if(isSafetyMetaName(name)){Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));if(android.provider.DocumentsContract.deleteDocument(getContentResolver(),x))deleted++;}}}catch(Throwable ignore){}finally{if(c!=null)c.close();}return deleted;}
        @JavascriptInterface public synchronized boolean appendSafetyChunk(String b64){try{if(safetyOut==null)return false;safetyOut.write(android.util.Base64.decode(b64,android.util.Base64.DEFAULT));return true;}catch(Throwable e){return false;}}
        @JavascriptInterface public synchronized boolean endSafetyWrite(){try{if(safetyOut==null)return false;safetyOut.flush();safetyOut.close();safetyOut=null;return true;}catch(Throwable e){try{if(safetyOut!=null)safetyOut.close();}catch(Throwable ignore){}safetyOut=null;return false;}}
        @JavascriptInterface public String safetyFolderUri(){return safetyUri();}
        @JavascriptInterface public void chooseFolder() {
            runOnUiThread(new Runnable(){ public void run(){
                Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(i,TREE_REQ);
            }});
        }
        @JavascriptInterface public String listFolders() {
            java.util.Map<String,?> all=getSharedPreferences("folder_scan",MODE_PRIVATE).getAll();
            StringBuilder sb=new StringBuilder("[");boolean first=true;
            for(String uri:all.keySet()){if(!first)sb.append(',');first=false;sb.append("{\"uri\":\"").append(escJson(uri)).append("\",\"name\":\"").append(escJson(folderName(Uri.parse(uri)))).append("\"}");}
            return sb.append(']').toString();
        }
        private String folderName(Uri uri){try{String id=android.provider.DocumentsContract.getTreeDocumentId(uri);int p=id.lastIndexOf(':');return p>=0?id.substring(p+1):id;}catch(Throwable e){return "已授权文件夹";}}
        @JavascriptInterface public void removeFolder(String uri){getSharedPreferences("folder_scan",MODE_PRIVATE).edit().remove(uri).apply();try{getContentResolver().releasePersistableUriPermission(Uri.parse(uri),Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Throwable ignore){}}
        @JavascriptInterface public String indexSafetyRestore(){org.json.JSONObject out=new org.json.JSONObject();org.json.JSONArray files=new org.json.JSONArray();android.database.Cursor c=null;try{String u=safetyUri();if(u.length()==0)throw new java.io.IOException("尚未选择实时备份目录");Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,android.provider.DocumentsContract.Document.COLUMN_SIZE},null,null,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME+" ASC");java.util.LinkedHashMap<String,org.json.JSONObject> originals=new java.util.LinkedHashMap<>();java.util.HashMap<String,org.json.JSONObject> metas=new java.util.HashMap<>();while(c!=null&&c.moveToNext()){String docId=c.getString(0),name=c.getString(1),low=name==null?"":name.toLowerCase(java.util.Locale.US),mime=c.getString(2);if(android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime))continue;Uri x=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,docId);if(low.contains(".pending_")||low.contains(".previous_"))continue;if(low.startsWith("kaku_meta_")&&low.endsWith(".json")){int end=low.indexOf(".json",10);String id=end>10?name.substring(10,end):"";if(id.length()==0)continue;java.io.InputStream in=null;try{in=getContentResolver().openInputStream(x);java.io.ByteArrayOutputStream b=new java.io.ByteArrayOutputStream();byte[] buf=new byte[8192];int n;while((n=in.read(buf))>0&&b.size()<1024*1024)b.write(buf,0,n);metas.put(id,new org.json.JSONObject(new String(b.toByteArray(),java.nio.charset.StandardCharsets.UTF_8)));}catch(Throwable ignore){}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}}continue;}if(!low.startsWith("kaku_")||!low.contains("__")||!low.endsWith(".png")&&!low.endsWith(".json"))continue;int sep=name.indexOf("__",5);if(sep<=5)continue;String id=name.substring(5,sep),restoreName=name.substring(sep+2);org.json.JSONObject row=new org.json.JSONObject();row.put("id",id);row.put("name",restoreName);row.put("uri",x.toString());row.put("size",c.isNull(3)?0:c.getLong(3));originals.put(id,row);}for(java.util.Map.Entry<String,org.json.JSONObject> e:originals.entrySet()){org.json.JSONObject meta=metas.get(e.getKey());if(meta!=null){e.getValue().put("meta",meta);e.getValue().put("section",meta.optString("section",""));}files.put(e.getValue());}out.put("files",files);out.put("count",files.length());}catch(Throwable e){try{out.put("error",e.getMessage()!=null?e.getMessage():e.toString());out.put("files",files);}catch(Throwable ignore){}}finally{if(c!=null)c.close();}return out.toString();}
        @JavascriptInterface public synchronized boolean beginSafetyRead(String uri){try{if(safetyReadIn!=null)safetyReadIn.close();safetyReadIn=getContentResolver().openInputStream(Uri.parse(uri));return safetyReadIn!=null;}catch(Throwable e){try{if(safetyReadIn!=null)safetyReadIn.close();}catch(Throwable ignore){}safetyReadIn=null;return false;}}
        @JavascriptInterface public synchronized String nextSafetyReadChunk(int len){try{if(safetyReadIn==null)return "";byte[] b=new byte[Math.max(1,Math.min(len,1024*1024))];int n=safetyReadIn.read(b);return n<0?"":android.util.Base64.encodeToString(b,0,n,android.util.Base64.NO_WRAP);}catch(Throwable e){return "";}}
        @JavascriptInterface public synchronized void endSafetyRead(){try{if(safetyReadIn!=null)safetyReadIn.close();}catch(Throwable ignore){}safetyReadIn=null;}
        @JavascriptInterface public String readSafetyChunk(String uri,int offset,int len){java.io.InputStream in=null;try{in=getContentResolver().openInputStream(Uri.parse(uri));if(in==null)return "";long left=Math.max(0,offset);while(left>0){long n=in.skip(left);if(n<=0){if(in.read()==-1)return "";n=1;}left-=n;}byte[] b=new byte[Math.max(1,Math.min(len,1024*1024))];int n=in.read(b);return n<0?"":android.util.Base64.encodeToString(b,0,n,android.util.Base64.NO_WRAP);}catch(Throwable e){return "";}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}}}
        @JavascriptInterface public String scanSafetyFolder(){java.io.File cache=new java.io.File(getCacheDir(),"folder_scan");deleteTree(cache);cache.mkdirs();String u=safetyUri();if(u.length()==0)return "{\"error\":\"尚未选择实时备份目录\",\"files\":[]}";StringBuilder out=new StringBuilder("{\"files\":[");android.database.Cursor c=null;boolean first=true;int copied=0,failed=0;try{Uri tree=Uri.parse(u),dir=android.provider.DocumentsContract.buildDocumentUriUsingTree(tree,android.provider.DocumentsContract.getTreeDocumentId(tree)),children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(dir,android.provider.DocumentsContract.getDocumentId(dir));c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,android.provider.DocumentsContract.Document.COLUMN_SIZE},null,null,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME+" ASC");while(c!=null&&c.moveToNext()){String name=c.getString(1),low=name==null?"":name.toLowerCase(java.util.Locale.US),mime=c.getString(2);if(android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)||isSafetyMetaName(name)||!low.startsWith("kaku_")||!low.contains("__")||!low.endsWith(".png")&&!low.endsWith(".json"))continue;Uri child=android.provider.DocumentsContract.buildDocumentUriUsingTree(dir,c.getString(0));java.io.File dst=new java.io.File(cache,"s"+copied+(low.endsWith(".png")?".png":".json"));java.io.InputStream in=null;java.io.FileOutputStream fos=null;long got=0;try{in=getContentResolver().openInputStream(child);if(in==null)throw new java.io.IOException("无法打开");fos=new java.io.FileOutputStream(dst);byte[] b=new byte[256*1024];int n;while((n=in.read(b))>0){fos.write(b,0,n);got+=n;}fos.flush();if(!first)out.append(',');first=false;out.append("{\"name\":\"").append(escJson(name)).append("\",\"path\":\"").append(escJson(dst.getAbsolutePath())).append("\",\"size\":").append(got).append('}');copied++;}catch(Throwable e){dst.delete();failed++;}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}try{if(fos!=null)fos.close();}catch(Throwable ignore){}}}}catch(Throwable e){return "{\"error\":\""+escJson(e.getMessage())+"\",\"files\":[]}";}finally{if(c!=null)c.close();}return out.append("],\"count\":").append(copied).append(",\"readFailed\":").append(failed).append('}').toString();}
        @JavascriptInterface public String scanFolder(String treeUri,int offset,int limit){
            java.io.File dir=new java.io.File(getCacheDir(),"folder_scan");deleteTree(dir);dir.mkdirs();offset=Math.max(0,offset);limit=Math.max(1,limit);
            StringBuilder out=new StringBuilder("{\"files\":["),skippedNames=new StringBuilder("[");int[] eligible={0},copied={0},next={offset},unsupported={0},oversized={0},failed={0},skipShown={0};long[] totalBytes={0};boolean[] first={true},skipFirst={true},hasMore={false};String[] stopReason={""};
            try{Uri root=android.provider.DocumentsContract.buildDocumentUriUsingTree(Uri.parse(treeUri),android.provider.DocumentsContract.getTreeDocumentId(Uri.parse(treeUri)));scanDocPage(root,"",dir,out,offset,limit,eligible,copied,next,totalBytes,first,hasMore,stopReason,unsupported,oversized,failed,skippedNames,skipShown,skipFirst);}
            catch(Throwable e){return "{\"error\":\""+escJson(e.getMessage())+"\",\"files\":[]}";}
            skippedNames.append(']');return out.append("],\"count\":").append(copied[0]).append(",\"nextOffset\":").append(next[0]).append(",\"hasMore\":").append(hasMore[0]).append(",\"stopReason\":\"").append(stopReason[0]).append("\",\"scannedEligible\":").append(eligible[0]).append(",\"unsupported\":").append(unsupported[0]).append(",\"oversized\":").append(oversized[0]).append(",\"readFailed\":").append(failed[0]).append(",\"skippedNames\":").append(skippedNames).append('}').toString();
        }
        private void addSkippedName(StringBuilder names,int[] shown,boolean[] first,String name){if(shown[0]>=8)return;if(!first[0])names.append(',');first[0]=false;names.append('"').append(escJson(name)).append('"');shown[0]++;}
        private void scanDocPage(Uri doc,String prefix,java.io.File cache,StringBuilder out,int offset,int limit,int[] eligible,int[] copied,int[] next,long[] totalBytes,boolean[] first,boolean[] hasMore,String[] stopReason,int[] unsupported,int[] oversized,int[] failed,StringBuilder skippedNames,int[] skipShown,boolean[] skipFirst)throws Exception{
            if(hasMore[0])return;Uri children=android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(doc,android.provider.DocumentsContract.getDocumentId(doc));android.database.Cursor c=getContentResolver().query(children,new String[]{android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME,android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,android.provider.DocumentsContract.Document.COLUMN_SIZE},null,null,android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME+" ASC");if(c==null)return;
            try{while(c.moveToNext()){
                String id=c.getString(0),name=c.getString(1),mime=c.getString(2);long size=c.isNull(3)?0:c.getLong(3);Uri child=android.provider.DocumentsContract.buildDocumentUriUsingTree(doc,id);
                if(android.provider.DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)){scanDocPage(child,prefix+name+"/",cache,out,offset,limit,eligible,copied,next,totalBytes,first,hasMore,stopReason,unsupported,oversized,failed,skippedNames,skipShown,skipFirst);if(hasMore[0])return;continue;}
                String low=name==null?"":name.toLowerCase(java.util.Locale.US);if(isSafetyMetaName(name))continue;if(!low.endsWith(".png")&&!low.endsWith(".json")){unsupported[0]++;addSkippedName(skippedNames,skipShown,skipFirst,prefix+name);continue;}
                int pos=eligible[0]++;if(pos<offset)continue;if(copied[0]>=limit){hasMore[0]=true;stopReason[0]="limit";return;}
                if(size>24L*1024*1024){oversized[0]++;addSkippedName(skippedNames,skipShown,skipFirst,prefix+name);next[0]=pos+1;continue;}
                java.io.File dst=new java.io.File(cache,"f"+copied[0]+(low.endsWith(".png")?".png":".json"));java.io.InputStream in=null;java.io.FileOutputStream fos=null;long got=0;boolean ioFailed=false;
                try{in=getContentResolver().openInputStream(child);if(in==null)throw new java.io.IOException("无法打开");fos=new java.io.FileOutputStream(dst);byte[] b=new byte[65536];int n;while((n=in.read(b))>0){got+=n;if(got>24L*1024*1024)break;fos.write(b,0,n);}}catch(Throwable e){ioFailed=true;}finally{try{if(in!=null)in.close();}catch(Throwable ignore){}try{if(fos!=null)fos.close();}catch(Throwable ignore){}}
                if(ioFailed){dst.delete();failed[0]++;addSkippedName(skippedNames,skipShown,skipFirst,prefix+name);next[0]=pos+1;continue;}if(got>24L*1024*1024){dst.delete();oversized[0]++;addSkippedName(skippedNames,skipShown,skipFirst,prefix+name);next[0]=pos+1;continue;}
                totalBytes[0]+=got;next[0]=pos+1;if(!first[0])out.append(',');first[0]=false;out.append("{\"name\":\"").append(escJson(prefix+name)).append("\",\"path\":\"").append(escJson(dst.getAbsolutePath())).append("\",\"size\":").append(got).append('}');copied[0]++;
            }}finally{c.close();}
        }
        @JavascriptInterface public String readChunk(String path,int offset,int len){java.io.RandomAccessFile r=null;try{r=new java.io.RandomAccessFile(path,"r");r.seek(offset);byte[] b=new byte[len];int n=r.read(b);r.close();if(n<0)n=0;return android.util.Base64.encodeToString(b,0,n,android.util.Base64.NO_WRAP);}catch(Throwable e){try{if(r!=null)r.close();}catch(Throwable ignore){}return "";}}
        @JavascriptInterface public void clearScan(){deleteTree(new java.io.File(getCacheDir(),"folder_scan"));}
        private void deleteTree(java.io.File f){if(f==null||!f.exists())return;if(f.isDirectory()){java.io.File[] a=f.listFiles();if(a!=null)for(java.io.File x:a)deleteTree(x);}f.delete();}
    }


}
