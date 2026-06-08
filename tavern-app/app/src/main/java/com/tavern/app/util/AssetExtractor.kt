package com.tavern.app.util

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

object AssetExtractor {

    private const val CORE_ZIP = "core/tavern-core.zip"
    private const val VERSION_FILE = "core_version.txt"
    private const val TAG = "AssetExtractor"
    
    // GitHub repo for fallback download
    private const val GITHUB_REPO = "wancDDY/ST-Ctrl"
    private const val GITHUB_LATEST_RELEASE = "https://api.github.com/repos/$GITHUB_REPO/releases/latest"

    fun needsExtraction(context: Context): Boolean {
        val versionFile = File(context.filesDir, VERSION_FILE)
        if (!versionFile.exists()) return true

        val bundledVersion = readBundledVersion(context)
        val extractedVersion = versionFile.readText().trim()
        return bundledVersion != extractedVersion
    }

    fun hasLocalCoreZip(context: Context): Boolean {
        return try {
            context.assets.open(CORE_ZIP).use { input ->
                input.available() > 1024 // Check if file is larger than 1KB (not empty)
            }
        } catch (e: Exception) {
            false
        }
    }

    fun extractCore(context: Context, onProgress: (Float, String) -> Unit = { _, _ -> }): Result<File> = runCatching {
        val coreDir = File(context.filesDir, "core")
        // Preserve user-installed extensions before wiping the core directory
        val extDir = File(coreDir, "public/scripts/extensions/third-party")
        val extBackup = File(context.cacheDir, "ext-backup")
        try { extBackup.deleteRecursively() } catch (_: Exception) {}
        if (extDir.exists()) {
            val renamed = extDir.renameTo(extBackup)
            if (!renamed) {
                Log.w(TAG, "renameTo failed for extensions, using copyRecursively fallback")
                try {
                    extBackup.mkdirs()
                    extDir.copyRecursively(extBackup, overwrite = true)
                    extDir.deleteRecursively()
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to backup extensions: ${e.message}", e)
                }
            }
        }
        if (coreDir.exists()) {
            coreDir.deleteRecursively()
        }
        coreDir.mkdirs()

        val tmpZip = File(context.cacheDir, "tavern-core-tmp.zip")
        
        // Try local assets first, fall back to download
        val hasLocalZip = hasLocalCoreZip(context)
        if (hasLocalZip) {
            try {
                Log.i(TAG, "Extracting core assets from APK assets...")
                onProgress(0.1f, "从APK解压核心代码…")
                extractFromAssets(context, tmpZip, onProgress)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to extract from assets, falling back to download: ${e.message}")
                onProgress(0.1f, "APK解压失败，从网络下载…")
                downloadCoreFromGitHub(context, tmpZip, onProgress)
            }
        } else {
            Log.i(TAG, "No core zip in APK, downloading from GitHub...")
            downloadCoreFromGitHub(context, tmpZip, onProgress)
        }

        // Extract the ZIP
        onProgress(0.6f, "解压核心文件…")
        extractZipToDir(tmpZip, coreDir, onProgress)

        // Clean up temp ZIP
        tmpZip.delete()

        // Copy plugin-bridge-server.js from assets (not inside tavern-core.zip)
        try {
            context.assets.open("core/plugin-bridge-server.js").use { input ->
                FileOutputStream(File(coreDir, "plugin-bridge-server.js")).use { output ->
                    input.copyTo(output)
                }
            }
            context.assets.open("core/plugin-adapter.js").use { input ->
                FileOutputStream(File(coreDir, "plugin-adapter.js")).use { output ->
                    input.copyTo(output)
                }
            }
            Log.i(TAG, "Copied plugin bridge files to core dir")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to copy plugin files: ${e.message}")
        }

        // Restore user-installed extensions
        val newExtDir = File(coreDir, "public/scripts/extensions/third-party")
        if (extBackup.exists()) {
            try { newExtDir.deleteRecursively() } catch (_: Exception) {}
            newExtDir.parentFile?.mkdirs()
            val restored = extBackup.renameTo(newExtDir)
            if (!restored) {
                Log.w(TAG, "renameTo failed for restore, using copyRecursively fallback")
                try {
                    extBackup.copyRecursively(newExtDir, overwrite = true)
                    extBackup.deleteRecursively()
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to restore extensions: ${e.message}", e)
                }
            }
            Log.i(TAG, "Restored user extensions")
        }

        val version = readBundledVersion(context)
        File(context.filesDir, VERSION_FILE).writeText(version)

        onProgress(1.0f, "完成！")
        coreDir
    }

    private fun extractFromAssets(context: Context, tmpZip: File, onProgress: (Float, String) -> Unit) {
        Log.i(TAG, "Copying ZIP from assets...")
        context.assets.open(CORE_ZIP).use { input ->
            FileOutputStream(tmpZip).use { output ->
                val buffer = ByteArray(65536)
                var bytesRead: Int
                var totalCopied = 0L
                val totalSize = input.available().toLong().coerceAtLeast(1)
                
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    output.write(buffer, 0, bytesRead)
                    totalCopied += bytesRead
                    val progress = 0.1f + (totalCopied.toFloat() / totalSize.toFloat()) * 0.3f
                    if (totalCopied % (5 * 1024 * 1024) < 65536) {
                        Log.i(TAG, "Copied ${totalCopied / (1024 * 1024)} MB...")
                        onProgress(progress, "复制中 ${totalCopied / (1024 * 1024)}MB…")
                    }
                }
                Log.i(TAG, "ZIP copy complete: ${totalCopied / (1024 * 1024)} MB")
            }
        }
    }

    private fun downloadCoreFromGitHub(context: Context, tmpZip: File, onProgress: (Float, String) -> Unit) {
        Log.i(TAG, "Downloading core from GitHub...")
        onProgress(0.15f, "查找最新版本…")
        
        // First, get the latest release with st-* tag
        val downloadUrl = findLatestStRelease()
        if (downloadUrl == null) {
            throw Exception("无法找到ST核心发布版本")
        }
        
        Log.i(TAG, "Downloading from: $downloadUrl")
        onProgress(0.2f, "正在下载…")
        
        // Download the file
        for (retry in 1..3) {
            try {
                val conn = URL(downloadUrl).openConnection() as HttpURLConnection
                conn.setRequestProperty("User-Agent", "ST-Ctrl-Android")
                conn.connectTimeout = 30000
                conn.readTimeout = 300000
                conn.instanceFollowRedirects = true
                
                val code = conn.responseCode
                if (code != HttpURLConnection.HTTP_OK) {
                    conn.disconnect()
                    if (retry < 3) {
                        Thread.sleep(2000)
                        continue
                    }
                    throw Exception("下载失败: HTTP $code")
                }
                
                val contentLength = conn.contentLength.toLong().coerceAtLeast(1)
                
                conn.inputStream.use { input ->
                    FileOutputStream(tmpZip).use { output ->
                        val buffer = ByteArray(65536)
                        var bytesRead: Int
                        var totalCopied = 0L
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            totalCopied += bytesRead
                            val progress = 0.2f + (totalCopied.toFloat() / contentLength.toFloat()) * 0.4f
                            if (totalCopied % (5 * 1024 * 1024) < 65536) {
                                Log.i(TAG, "Downloaded ${totalCopied / (1024 * 1024)} MB...")
                                onProgress(progress, "下载中 ${totalCopied / (1024 * 1024)}MB…")
                            }
                        }
                        Log.i(TAG, "Download complete: ${totalCopied / (1024 * 1024)} MB")
                    }
                }
                conn.disconnect()
                break
            } catch (e: Exception) {
                Log.w(TAG, "Download attempt $retry failed: ${e.message}")
                if (retry == 3) throw Exception("下载失败: ${e.message}")
                Thread.sleep(3000)
            }
        }
    }

    private fun findLatestStRelease(): String? {
        return try {
            val conn = URL(GITHUB_LATEST_RELEASE).openConnection() as HttpURLConnection
            conn.setRequestProperty("User-Agent", "ST-Ctrl-Android")
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            
            val json = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            
            // Simple JSON parsing - find assets with name containing "tavern-core" or ".zip"
            val assetsStart = json.indexOf("\"assets\":")
            if (assetsStart == -1) return null
            
            // Look for browser_download_url
            val urlPattern = """"browser_download_url":\s*"([^"]+)"""".toRegex()
            val matches = urlPattern.findAll(json)
            
            for (match in matches) {
                val url = match.groupValues[1]
                if (url.contains("tavern-core", ignoreCase = true) || url.endsWith(".zip")) {
                    return url
                }
            }
            null
        } catch (e: Exception) {
            Log.e(TAG, "Failed to find release: ${e.message}")
            null
        }
    }

    private fun extractZipToDir(zipFile: File, targetDir: File, onProgress: (Float, String) -> Unit) {
        Log.i(TAG, "Extracting files...")
        FileInputStream(zipFile).use { fis ->
            ZipInputStream(fis).use { zis ->
                var entry = zis.nextEntry
                var count = 0
                while (entry != null) {
                    val normalizedName = entry.name.replace('\\', '/')
                    val targetFile = File(targetDir, normalizedName)
                    if (entry.isDirectory) {
                        targetFile.mkdirs()
                    } else {
                        targetFile.parentFile?.mkdirs()
                        FileOutputStream(targetFile).use { fos ->
                            zis.copyTo(fos, 65536)
                        }
                    }
                    zis.closeEntry()
                    count++
                    if (count % 500 == 0) {
                        val progress = 0.6f + (count / 10000f).coerceAtMost(0.35f)
                        onProgress(progress, "解压 $count 个文件…")
                    }
                    entry = zis.nextEntry
                }
                Log.i(TAG, "Extraction complete: $count entries")
            }
        }
    }

    fun getCoreDir(context: Context): File = File(context.filesDir, "core")

    private fun readBundledVersion(context: Context): String {
        return try {
            context.assets.open("core/version.txt")
                .bufferedReader().use { it.readText().trim() }
        } catch (e: Exception) {
            "1.0.0"
        }
    }
}
