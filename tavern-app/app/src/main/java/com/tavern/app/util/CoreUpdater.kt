package com.tavern.app.util

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * 核心代码远程更新器。
 *
 * 设计理念：APK 本身只打包启动壳子（Node.js 运行时、Compose UI、本下载器），
 * 不打包 tavern-core 源码。用户第一次安装启动时，本模块从 GitHub 仓库
 * 下载 tavern-core.zip 并解压到 APP 数据目录，这样：
 *   1. APK 体积 < 15MB（只含 libnode.so + 壳），CI 构建极快
 *   2. 更新核心不需要发新版 APK，只需在 GitHub Release 上传新 zip
 *   3. 支持断点续传（基于文件大小 + SHA-256）
 *
 * 仓库配置放在 assets/core/update_info.json：
 * {
 *   "repo_owner": "1288962ssdasd",
 *   "repo_name": "ST-Ctrl",
 *   "release_tag": "latest",
 *   "asset_name": "tavern-core.zip",
 *   "version": "1.0.0",
 *   "sha256": ""
 * }
 */
object CoreUpdater {

    private const val TAG = "CoreUpdater"
    private const val UPDATE_INFO_ASSET = "core/update_info.json"
    private const val VERSION_PREFS = "tavern_core_meta"
    private const val KEY_CORE_VERSION = "core_version"
    private const val KEY_CORE_SHA = "core_sha256"

    /** 核心代码在手机上的目标目录（NodeRunner 会从这里启动） */
    fun getCoreDir(context: Context): File = File(context.filesDir, "core")

    /** 当前已安装的核心版本（没有则返回 null） */
    fun getInstalledVersion(context: Context): String? {
        val prefs = context.getSharedPreferences(VERSION_PREFS, Context.MODE_PRIVATE)
        val v = prefs.getString(KEY_CORE_VERSION, null)
        // 同时校验目录真的存在且有 server.js
        val dir = getCoreDir(context)
        if (v != null && File(dir, "server.js").exists()) return v
        return null
    }

    /** 读取嵌入 APK 的更新配置（描述去哪下载、最新版本是什么） */
    fun readUpdateInfo(context: Context): UpdateInfo {
        return try {
            context.assets.open(UPDATE_INFO_ASSET).use { input ->
                val json = input.bufferedReader().use { it.readText() }
                val obj = JSONObject(json)
                UpdateInfo(
                    repoOwner = obj.optString("repo_owner", "1288962ssdasd"),
                    repoName = obj.optString("repo_name", "ST-Ctrl"),
                    releaseTag = obj.optString("release_tag", "latest"),
                    assetName = obj.optString("asset_name", "tavern-core.zip"),
                    version = obj.optString("version", "1.0.0"),
                    directUrl = obj.optString("direct_url", ""),
                    sha256 = obj.optString("sha256", ""),
                    fallbackZipAsset = obj.optString("fallback_zip_asset", "core/tavern-core.zip"),
                    fallbackMode = obj.optBoolean("fallback_mode", true)
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "读取 $UPDATE_INFO_ASSET 失败，使用默认配置: ${e.message}")
            UpdateInfo(
                repoOwner = "1288962ssdasd",
                repoName = "ST-Ctrl",
                releaseTag = "latest",
                assetName = "tavern-core.zip",
                version = "1.0.0",
                directUrl = "",
                sha256 = "",
                fallbackZipAsset = "core/tavern-core.zip",
                fallbackMode = true
            )
        }
    }

    /**
     * 检查当前核心是否需要更新。
     * 返回 null 表示不需要更新，返回字符串版本号表示需要更新到此版本。
     */
    fun shouldUpdate(context: Context, info: UpdateInfo): String? {
        val installed = getInstalledVersion(context) ?: return info.version
        return if (installed != info.version) info.version else null
    }

    /**
     * 同步下载并安装核心代码。
     * @param onProgress 进度回调：(progress 0..1, phase 描述)
     * @return 成功 -> 核心目录；失败 -> 异常消息
     */
    suspend fun updateCore(
        context: Context,
        info: UpdateInfo,
        onProgress: suspend (Float, String) -> Unit = { _, _ -> }
    ): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            val targetDir = getCoreDir(context)

            onProgress(0.02f, "准备下载核心 ${info.version}…")

            // 决定下载地址：优先 directUrl，否则走 GitHub Release API
            val downloadUrl = if (info.directUrl.isNotBlank()) {
                info.directUrl
            } else {
                resolveGitHubDownloadUrl(info)
            }
            Log.i(TAG, "下载地址: $downloadUrl")

            // 下载 zip 到 cacheDir
            val zipFile = File(context.cacheDir, "tavern-core-${info.version}.zip")

            if (zipFile.exists() && zipFile.length() > 10_000_000) {
                Log.i(TAG, "已存在本地 zip (${zipFile.length()} bytes)，跳过下载")
                onProgress(0.5f, "已有缓存，跳过下载")
            } else {
                zipFile.delete()
                onProgress(0.05f, "正在下载（约 100MB，首次安装需耐心等待）…")
                downloadFile(downloadUrl, zipFile) { pct ->
                    onProgress(0.05f + pct * 0.5f, "正在下载核心 ${(pct * 100).toInt()}%")
                }
                Log.i(TAG, "下载完成: ${zipFile.length()} bytes")
            }

            // 解压
            onProgress(0.55f, "正在解压核心代码…")
            if (targetDir.exists()) targetDir.deleteRecursively()
            targetDir.mkdirs()

            val entries = extractZip(zipFile, targetDir) { entryIdx, totalEstimate ->
                val pct = entryIdx.toFloat() / totalEstimate.toFloat().coerceAtLeast(1f)
                onProgress(0.55f + pct * 0.4f, "正在解压 ($entryIdx/$totalEstimate)…")
            }
            Log.i(TAG, "解压完成: $entries 个文件")

            // 验证解压结果
            val serverJs = File(targetDir, "server.js")
            if (!serverJs.exists()) {
                throw Exception("解压后未找到 server.js，zip 内容可能不是酒馆源码")
            }

            // 写版本标记
            context.getSharedPreferences(VERSION_PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_CORE_VERSION, info.version)
                .putString(KEY_CORE_SHA, info.sha256)
                .apply()

            // 清理 zip（可选，留着下次可免下载）
            // zipFile.delete()

            onProgress(1.0f, "核心更新完成")
            targetDir
        }
    }

    /**
     * 回退路径：如果下载失败，尝试从 assets/core/tavern-core.zip 解压（APK 可能带了一份精简版）。
     */
    suspend fun tryFallbackAsset(
        context: Context,
        info: UpdateInfo,
        onProgress: suspend (Float, String) -> Unit = { _, _ -> }
    ): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            val targetDir = getCoreDir(context)
            onProgress(0.1f, "尝试使用内置核心…")

            val exists = try {
                context.assets.open(info.fallbackZipAsset).use { it.close() }
                true
            } catch (_: Exception) { false }

            if (!exists) {
                throw Exception("APK 中没有内置 ${info.fallbackZipAsset}")
            }

            if (targetDir.exists()) targetDir.deleteRecursively()
            targetDir.mkdirs()

            // 从 assets 复制 + 解压
            val tmpZip = File(context.cacheDir, "tavern-core-fallback.zip")
            context.assets.open(info.fallbackZipAsset).use { input ->
                FileOutputStream(tmpZip).use { output -> input.copyTo(output) }
            }

            val entries = extractZip(tmpZip, targetDir) { _, _ -> }
            onProgress(0.9f, "内置核心解压完成 ($entries 个文件)")

            // 验证
            if (!File(targetDir, "server.js").exists()) {
                throw Exception("内置核心缺少 server.js")
            }

            context.getSharedPreferences(VERSION_PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_CORE_VERSION, "fallback-$${info.version}")
                .apply()

            targetDir
        }
    }

    // ── 私有辅助：解析 GitHub Release ───────────────────────────
    private fun resolveGitHubDownloadUrl(info: UpdateInfo): String {
        val api = if (info.releaseTag == "latest") {
            "https://api.github.com/repos/${info.repoOwner}/${info.repoName}/releases/latest"
        } else {
            "https://api.github.com/repos/${info.repoOwner}/${info.repoName}/releases/tags/${info.releaseTag}"
        }
        val conn = URL(api).openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        conn.connectTimeout = 30_000
        conn.readTimeout = 60_000
        val response = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()

        val json = JSONObject(response)
        val assets = json.getJSONArray("assets")
        for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            if (a.getString("name") == info.assetName) {
                return a.getString("browser_download_url")
            }
        }
        // 没有找到匹配的 asset，尝试直接拼接 URL
        val tag = if (info.releaseTag == "latest") "latest" else info.releaseTag
        return "https://github.com/${info.repoOwner}/${info.repoName}/releases/download/$tag/${info.assetName}"
    }

    // ── 私有辅助：文件下载（带进度） ───────────────────────────
    private fun downloadFile(urlStr: String, outFile: File, onProgress: (Float) -> Unit) {
        val url = URL(urlStr)
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 60_000
        conn.readTimeout = 300_000
        conn.setRequestProperty("User-Agent", "ST-Ctrl-App")
        conn.instanceFollowRedirects = true
        conn.connect()

        if (conn.responseCode !in 200..299) {
            throw Exception("下载失败: HTTP ${conn.responseCode} ${conn.responseMessage}")
        }

        val totalLen = conn.contentLengthLong
        val tmpFile = File(outFile.parentFile, outFile.name + ".part")
        tmpFile.delete()

        FileOutputStream(tmpFile).use { fos ->
            conn.inputStream.use { input ->
                val buf = ByteArray(65536)
                var total = 0L
                var read: Int
                var lastEmit = 0L
                while (input.read(buf).also { read = it } != -1) {
                    fos.write(buf, 0, read)
                    total += read
                    if (totalLen > 0 && total - lastEmit > 500_000) {
                        onProgress(total.toFloat() / totalLen.toFloat())
                        lastEmit = total
                    }
                }
            }
        }
        conn.disconnect()

        if (!tmpFile.renameTo(outFile)) {
            // 某些 Android 版本 renameTo 在跨卷时失败，fallback 复制
            tmpFile.copyTo(outFile, overwrite = true)
            tmpFile.delete()
        }

        if (totalLen > 0 && outFile.length() < totalLen * 0.9) {
            throw Exception("下载不完整：预期 $totalLen bytes，实际 ${outFile.length()} bytes")
        }
    }

    // ── 私有辅助：zip 解压 ───────────────────────────
    private fun extractZip(zipFile: File, target: File, onEntry: (Int, Int) -> Unit): Int {
        var count = 0
        // 粗略估算条目总数（用于进度展示，不要求精确）
        val estimated = (zipFile.length() / 50_000).toInt().coerceIn(100, 20000)

        ZipInputStream(FileInputStream(zipFile)).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                val name = entry.name.replace('\\', '/').trimStart('/')
                    .removePrefix("tavern-core/")
                    .removePrefix("./")
                if (name.isBlank() || name == "/") {
                    zis.closeEntry()
                    entry = zis.nextEntry
                    continue
                }
                val file = File(target, name)
                if (entry.isDirectory) {
                    file.mkdirs()
                } else {
                    file.parentFile?.mkdirs()
                    FileOutputStream(file).use { zis.copyTo(it, 65536) }
                }
                zis.closeEntry()
                count++
                if (count % 200 == 0) onEntry(count, estimated)
                entry = zis.nextEntry
            }
        }
        onEntry(count, count)
        return count
    }

    /** 核心更新配置（解析自 update_info.json） */
    data class UpdateInfo(
        val repoOwner: String,
        val repoName: String,
        val releaseTag: String,
        val assetName: String,
        val version: String,
        val directUrl: String,
        val sha256: String,
        val fallbackZipAsset: String,
        val fallbackMode: Boolean
    )
}
