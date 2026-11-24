# Android 测试工程

同一套React组件打包成移动静态资源，由Capacitor8包装；服务器仍在独立Worker/D1，不把Next服务器页面当作离线APK。

```sh
npm ci
VITE_API_ORIGIN=https://studio.example.invalid node ../node_modules/vite/bin/vite.js build --config vite.config.mjs
node prepare-wrapper.mjs
node node_modules/@capacitor/cli/bin/capacitor sync android
cd android
./gradlew assembleDebug
```

构建前必须完成根目录依赖、字体准备和真实Web部署。API必须HTTPS。当前只用pre地址做静态编译，不表示地址上线。

包名cn.thuart68.rehearsalstudio；versionCode=1；versionName=0.1.0-test1。更新需递增versionCode。签名私钥不得入Git；封闭分发前保存稳定签名并测试升级兼容。当前没有签名APK。

- 显式配置https://localhost origin；Native会话和匿名凭证只在内存，重启重新验证。
- RECORD_AUDIO运行时权限由Capacitor处理；MediaRecorder沿用Web上传协议，后台时停止录音并提供备份/提交。
- PDF/PPTX/恢复凭证与录音备份通过Filesystem私有缓存及系统Share面板保存/分享；无全盘访问权限。
- 返回键由页面处理，未保存内容有提示，首页最小化应用。禁止HTTP混合内容，关闭Android备份与WebView调试。

实际完成：静态build、cap add android/sync、原生工程生成。未完成：APK、设备安装、两品牌真机、锁屏/来电/权限拒绝/断网/网络切换/20MiB下载与升级验收。

实际Gradle构建在下载8.14.3发行包时因Network is unreachable失败；也没有Android SDK，Java为17，而生成的Android工程要求Java21。未规避网络限制，不宣称APK通过。
