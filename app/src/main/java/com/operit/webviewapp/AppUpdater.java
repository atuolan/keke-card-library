package com.operit.webviewapp;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;

/** User-initiated updates from the project's public release channel. */
final class AppUpdater {
    private static final String META = "https://raw.githubusercontent.com/kitten112233/keke-card-library/main/update.json";
    private final Activity activity;
    private boolean busy;
    AppUpdater(Activity a) { activity = a; }
    private void message(String text) { activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show()); }
    private static HttpURLConnection connect(String address) throws Exception {
        URL url = new URL(address);
        for (int i=0;i<8;i++) {
            if (!"https".equals(url.getProtocol())) throw new IOException("更新地址必须使用 HTTPS");
            HttpURLConnection c=(HttpURLConnection)url.openConnection();
            c.setConnectTimeout(20000); c.setReadTimeout(30000); c.setInstanceFollowRedirects(false);
            int status=c.getResponseCode();
            if(status>=300 && status<400) { String location=c.getHeaderField("Location"); c.disconnect(); url=new URL(url,location); continue; }
            if(status!=200) { c.disconnect(); throw new IOException("服务器返回 "+status); }
            return c;
        }
        throw new IOException("重定向次数过多");
    }
    synchronized void check() {
        if(busy) { message("更新任务正在进行"); return; }
        busy=true; message("正在检查更新…");
        new Thread(() -> {
            try {
                HttpURLConnection c=connect(META); ByteArrayOutputStream out=new ByteArrayOutputStream();
                try(InputStream in=c.getInputStream()) { byte[] b=new byte[4096]; int n; while((n=in.read(b))!=-1) { out.write(b,0,n); if(out.size()>65536) throw new IOException("版本信息过大"); } } finally { c.disconnect(); }
                JSONObject meta=new JSONObject(out.toString("UTF-8"));
                int current=activity.getPackageManager().getPackageInfo(activity.getPackageName(),0).versionCode;
                if(meta.getInt("versionCode")<=current) { message("当前已是最新版本"); return; }
                String url=meta.getString("apkUrl");
                if(!url.startsWith("https://github.com/kitten112233/keke-card-library/releases/download/")) throw new IOException("更新来源不正确");
                if(!meta.getString("sha256").matches("[a-fA-F0-9]{64}")) throw new IOException("缺少有效校验信息");
                activity.runOnUiThread(() -> new AlertDialog.Builder(activity).setTitle("发现新版 "+meta.optString("versionName"))
                    .setMessage(meta.optString("notes","")+"\n\n下载后会验证文件，再打开系统安装界面。")
                    .setNegativeButton("稍后",null).setPositiveButton("下载更新",(d,w)->download(meta)).show());
            } catch(Exception e) { message("检查更新失败："+e.getMessage()); }
            finally { synchronized(this) { busy=false; } }
        },"kaku-update-check").start();
    }
    private synchronized void download(JSONObject meta) {
        if(busy) return; busy=true; message("正在下载更新，请稍候…");
        new Thread(() -> {
            File file=new File(activity.getCacheDir(),"updates/update.apk");
            try {
                file.getParentFile().mkdirs(); file.delete();
                HttpURLConnection c=connect(meta.getString("apkUrl")); MessageDigest digest=MessageDigest.getInstance("SHA-256"); long count=0;
                try(InputStream in=c.getInputStream(); OutputStream out=new FileOutputStream(file)) {
                    byte[] b=new byte[32768]; int n;
                    while((n=in.read(b))!=-1) { count+=n; if(count>150*1024*1024) throw new IOException("安装包过大"); out.write(b,0,n); digest.update(b,0,n); }
                } finally { c.disconnect(); }
                StringBuilder hash=new StringBuilder(); for(byte b:digest.digest()) hash.append(String.format("%02x",b&255));
                if(!hash.toString().equalsIgnoreCase(meta.getString("sha256"))) throw new IOException("文件校验失败，请重试");
                android.content.pm.PackageInfo apk=activity.getPackageManager().getPackageArchiveInfo(file.getPath(),0);
                if(apk==null || !activity.getPackageName().equals(apk.packageName) || apk.versionCode!=meta.getInt("versionCode")) throw new IOException("安装包版本或包名不匹配");
                activity.runOnUiThread(() -> install(file));
            } catch(Exception e) { file.delete(); message("下载更新失败："+e.getMessage()); }
            finally { synchronized(this) { busy=false; } }
        },"kaku-update-download").start();
    }
    private void install(File file) {
        if(Build.VERSION.SDK_INT>=26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity).setMessage("请允许卡库安装应用。返回卡库后，再次检查更新并下载即可继续安装。")
                .setPositiveButton("打开设置",(d,w)->activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+activity.getPackageName())))).setNegativeButton("稍后",null).show(); return;
        }
        try {
            Uri uri=FileProvider.getUriForFile(activity,activity.getPackageName()+".updates",file);
            activity.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch(Exception e) { message("无法打开安装界面："+e.getMessage()); }
    }
}
