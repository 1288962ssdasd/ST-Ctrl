# ST源码更新指南

## 如何发布新版本的ST源码供APP更新

### 1. 准备ST源码

1. 下载或克隆最新的SillyTavern源码
2. 应用Android兼容补丁（可选，根据需要）
3. 在项目根目录下放置必要的文件

### 2. 打包源码

将准备好的ST源码打包成zip文件：
```bash
# 在ST源码目录下执行
zip -r st-core-1.12.0.zip . -x "*.git*" -x "node_modules/*"
```

### 3. 创建GitHub Release

1. 打开您的仓库：https://github.com/1288962ssdasd/ST-Ctrl
2. 点击右侧 "Releases" → "Create a new release"
3. 创建新的tag，格式必须为：`st-版本号`
   - 例如：`st-1.12.0`、`st-1.13.0-beta`
4. 填写Release标题和描述
5. 将打包好的zip文件上传到Assets中
6. 点击 "Publish release"

### 4. 在APP中更新

1. 打开ST-Ctrl APP
2. 进入控制台
3. 点击 "更新"
4. 点击 "检查ST更新"
5. 如果有新版本，会显示下载并安装按钮
6. 点击后APP会自动：
   - 下载新版本zip
   - 备份用户数据和扩展
   - 替换核心文件
   - 恢复用户数据
   - 应用Android补丁

### Tag格式规范

- 必须以 `st-` 开头
- 后面跟随版本号
- 例如：
  - `st-1.12.0`（正式版）
  - `st-1.13.0-beta`（测试版）
  - `st-2.0.0`（大版本更新）

### 更新会保留的内容

- 用户数据（`data/` 目录）
- 第三方扩展（`public/scripts/extensions/third-party/`）
- 用户设置和配置

### 更新会替换的内容

- 所有ST核心文件
- 官方扩展
- 主题文件

---

## APP（ST-Ctrl）自身更新流程

### 发布新版本APP

1. 修改代码
2. 推送到仓库（main或master分支）
3. GitHub Actions会自动构建APK
4. 创建Release，tag格式：`v1.0.0`、`v1.1.0`等
5. 上传构建好的APK到Assets

### 在APP中检查APP更新

1. 进入控制台 → 更新
2. 点击 "检查App更新"
3. 会跳转到GitHub Releases页面下载新APK

---

## 开发调试提示

1. 如果需要测试更新功能，可以在本地创建一个zip文件
2. 修改UpdateChecker.kt来指向本地测试服务器（可选）
3. 路由调试功能主要用于开发时调试API
