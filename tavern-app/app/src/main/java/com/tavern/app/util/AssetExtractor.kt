package com.tavern.app.util

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

object AssetExtractor {

    private const val CORE_ZIP = "core/tavern-core.zip"
    private const val CORE_SERVER_JS = "core/server.js"
    private const val VERSION_FILE = "core_version.txt"
    private const val TAG = "AssetExtractor"

    fun needsExtraction(context: Context): Boolean {
        val versionFile = File(context.filesDir, VERSION_FILE)
        if (!versionFile.exists()) return true

        val bundledVersion = readBundledVersion(context)
        val extractedVersion = versionFile.readText().trim()
        return bundledVersion != extractedVersion
    }

    fun extractCore(context: Context): Result<File> = runCatching {
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

        Log.i(TAG, "Extracting core assets to ${coreDir.absolutePath}")

        // 检测 core 的打包方式：
        // 方式 A：assets/core/tavern-core.zip 存在 → 走 zip 解压
        // 方式 B：assets/core/server.js 存在（直接放源码）→ 走目录递归复制
        val useZip = assetExists(context, CORE_ZIP)
        val useFlatCore = assetExists(context, CORE_SERVER_JS)

        if (useZip && !useFlatCore) {
            // === 方式 A：从 ZIP 解压 ===
            Log.i(TAG, "Mode A: Extracting from assets/core/tavern-core.zip")
            val tmpZip = File(context.cacheDir, "tavern-core-tmp.zip")
            context.assets.open(CORE_ZIP).use { input ->
                FileOutputStream(tmpZip).use { output ->
                    val buffer = ByteArray(65536)
                    var bytesRead: Int
                    var totalCopied = 0L
                    while (input.read(buffer).also { bytesRead = it } != -1) {
                        output.write(buffer, 0, bytesRead)
                        totalCopied += bytesRead
                        if (totalCopied % (10 * 1024 * 1024) < 65536) {
                            Log.i(TAG, "Copied ${totalCopied / (1024 * 1024)} MB...")
                        }
                    }
                    Log.i(TAG, "ZIP copy complete: ${totalCopied / (1024 * 1024)} MB")
                }
            }

            Log.i(TAG, "Extracting files...")
            FileInputStream(tmpZip).use { fis ->
                ZipInputStream(fis).use { zis ->
                    var entry = zis.nextEntry
                    var count = 0
                    while (entry != null) {
                        val normalizedName = entry.name.replace('\\', '/')
                        val targetFile = File(coreDir, normalizedName)
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
                        if (count % 1000 == 0) {
                            Log.i(TAG, "Extracted $count entries...")
                        }
                        entry = zis.nextEntry
                    }
                    Log.i(TAG, "Extraction complete: $count entries")
                }
            }
            tmpZip.delete()
        } else if (useFlatCore) {
            // === 方式 B：递归复制 assets/core/ 目录下的所有文件 ===
            Log.i(TAG, "Mode B: Copying all files from assets/core/ (flat layout)")
            val count = copyAssetDirRecursive(context, "core", coreDir)
            Log.i(TAG, "Copied $count files from assets/core/ to ${coreDir.absolutePath}")
        } else {
            throw IllegalStateException(
                "Neither assets/core/tavern-core.zip nor assets/core/server.js was found. " +
                "Please either (1) place tavern-core.zip in assets/core, " +
                "or (2) put the full tavern-core source tree (with server.js) in assets/core/"
            )
        }

        // Copy plugin-bridge-server.js from assets (if bundled separately)
        try {
            context.assets.open("core/plugin-bridge-server.js").use { input ->
                FileOutputStream(File(coreDir, "plugin-bridge-server.js")).use { output ->
                    input.copyTo(output)
                }
            }
            Log.i(TAG, "Copied plugin-bridge-server.js to core dir")
        } catch (e: Exception) {
            Log.w(TAG, "plugin-bridge-server.js not bundled separately (may be inside core tree): ${e.message}")
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

        val bundledVersion = readBundledVersion(context)
        File(context.filesDir, VERSION_FILE).writeText(bundledVersion)

        coreDir
    }

    fun getCoreDir(context: Context): File = File(context.filesDir, "core")

    // ---------- helpers ----------

    /** Check if an asset path exists (for files, not directories). */
    private fun assetExists(context: Context, path: String): Boolean {
        return try {
            context.assets.open(path).use { it.close() }
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Recursively copy a directory from assets to the filesystem. */
    private fun copyAssetDirRecursive(
        context: Context,
        assetPath: String,
        targetDir: File
    ): Int {
        targetDir.mkdirs()
        var count = 0
        val entries = try {
            context.assets.list(assetPath) ?: emptyArray()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to list assets/$assetPath: ${e.message}")
            return 0
        }
        if (entries.isEmpty()) {
            // Could be a file — but list() returning empty on a file path is ambiguous,
            // so we rely on the try-open below to disambiguate at the leaves.
        }
        for (entry in entries) {
            val subAsset = if (assetPath.isEmpty()) entry else "$assetPath/$entry"
            val target = File(targetDir, entry)

            // Try to list sub-assets to detect whether it's a directory.
            val subList = try {
                context.assets.list(subAsset)
            } catch (_: Exception) {
                null
            }
            val isDir = !subList.isNullOrEmpty()

            if (isDir) {
                target.mkdirs()
                count += copyAssetDirRecursive(context, subAsset, target)
            } else {
                try {
                    context.assets.open(subAsset).use { ins ->
                        target.parentFile?.mkdirs()
                        FileOutputStream(target).use { outs ->
                            ins.copyTo(outs)
                        }
                    }
                    count++
                    if (count % 1000 == 0) {
                        Log.i(TAG, "Copied $count asset files...")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Skip asset $subAsset: ${e.message}")
                }
            }
        }
        return count
    }

    private fun readBundledVersion(context: Context): String {
        // 优先读取 version.txt；如果没有，尝试从 core/package.json 的 "version" 字段读取
        val paths = arrayOf("core/version.txt", "core/package.json")
        for (p in paths) {
            try {
                context.assets.open(p).use { ins ->
                    val text = ins.bufferedReader().use { it.readText().trim() }
                    if (p.endsWith("package.json")) {
                        // 轻量解析：匹配 "version": "x.y.z"
                        val regex = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
                        val match = regex.find(text)
                        if (match != null && match.groupValues[1].isNotEmpty()) {
                            return match.groupValues[1]
                        }
                    } else {
                        if (text.isNotEmpty()) return text
                    }
                }
            } catch (_: Exception) {
                // try next
            }
        }
        return "1.0.0"
    }
}
