package com.tavern.app.util

import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * 开发者模式下的"侧载核心"管理。
 *
 * 当 APP 内置的 tavern-core.zip 无法满足开发需求时（例如你正在频繁修改
 * 酒馆的 JS/插件/配置），可以：
 *   1. 把整份 SillyTavern 源码（解压后的目录）拷到手机的某个目录
 *   2. 在设置页面开启"开发者模式"并选择这个目录
 *   3. APP 启动时直接用这个目录作为核心，无需从 assets 解压
 *
 * 这样你改源码 → 手机上替换文件 → 重启 APP，就能看到效果。
 */
object DevCoreManager {

    private const val TAG = "DevCoreManager"

    /**
     * 返回当前的核心目录：
     * - 侧载目录已配置且有效 → 返回侧载目录
     * - 否则 → 返回 APP 默认的数据目录
     */
    fun resolveCoreDir(context: Context): File {
        val sideload = SettingsState_sideloadPath(context)
        if (SettingsState_devModeEnabled(context) && !sideload.isNullOrBlank()) {
            val dir = File(sideload)
            if (isValidCoreDir(dir)) {
                Log.i(TAG, "使用侧载核心目录: ${dir.absolutePath}")
                return dir
            }
            Log.w(TAG, "侧载目录无效或缺少 server.js，回退到默认: ${dir.absolutePath}")
        }
        return File(context.filesDir, "core")
    }

    /** 检测一个目录是否包含完整的酒馆源码（至少需要 server.js 和 package.json） */
    fun isValidCoreDir(dir: File): Boolean {
        return dir.exists() &&
               dir.isDirectory &&
               File(dir, "server.js").exists() &&
               File(dir, "package.json").exists()
    }

    /** 简要描述指定目录的状态（供 UI 展示） */
    fun describe(dir: File?): String {
        if (dir == null) return "未配置"
        return if (!dir.exists()) {
            "目录不存在"
        } else if (!dir.isDirectory) {
            "不是目录"
        } else if (!isValidCoreDir(dir)) {
            "目录已存在但缺少 server.js，可能不是酒馆源码目录"
        } else {
            "✓ 已识别为酒馆源码目录（${File(dir, "server.js").length()} bytes）"
        }
    }

    /**
     * 把用户从系统文件选择器选到的 URI 路径转换为真实路径。
     * 对于 SAF（存储访问框架）的 URI，我们把里面的所有文件复制到 APP 可写目录，
     * 因为直接通过 ContentResolver 读取文件会非常慢。
     */
    suspend fun persistTreeUri(context: Context, uri: Uri): Result<File> =
        withContext(Dispatchers.IO) {
            runCatching {
                // 1. 在 APP 自己的 files 目录下创建一个 "sideload-core" 目录
                val target = File(context.filesDir, "sideload-core")
                if (target.exists()) target.deleteRecursively()
                target.mkdirs()

                // 2. 从 SAF URI 复制文件树到 target
                val count = copyTreeFromUri(context, uri, target)
                Log.i(TAG, "已复制 $count 个文件到 ${target.absolutePath}")

                // 3. 写入 plugin-bridge-server.js
                try {
                    context.assets.open("core/plugin-bridge-server.js").use { input ->
                        FileOutputStream(File(target, "plugin-bridge-server.js")).use { output ->
                            input.copyTo(output)
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "复制 plugin-bridge-server.js 失败: ${e.message}")
                }

                target
            }
        }

    /**
     * 把一个 zip 文件解压到目标目录。
     * 支持手机上你自己导出的 tavern-core.zip，或者直接从 PC 拷贝过来的 zip。
     */
    fun extractZip(zipFile: File, target: File): Result<File> = runCatching {
        if (!zipFile.exists()) throw Exception("zip 文件不存在: ${zipFile.absolutePath}")
        if (target.exists()) target.deleteRecursively()
        target.mkdirs()

        java.util.zip.ZipInputStream(FileInputStream(zipFile)).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                val name = entry.name.replace('\\', '/')
                // 忽略 zip 里常见的多余目录（例如 tavern-core/ 前缀）
                val cleanName = if (name.startsWith("tavern-core/")) {
                    name.removePrefix("tavern-core/")
                } else {
                    name
                }
                if (cleanName.isBlank()) {
                    zis.closeEntry()
                    entry = zis.nextEntry
                    continue
                }
                val file = File(target, cleanName)
                if (entry.isDirectory) {
                    file.mkdirs()
                } else {
                    file.parentFile?.mkdirs()
                    FileOutputStream(file).use { zis.copyTo(it, 65536) }
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
        target
    }

    // ── 辅助：递归复制 SAF 目录树 ────────────────────────────────────────
    private fun copyTreeFromUri(context: Context, uri: Uri, target: File): Int {
        var count = 0
        val contentResolver = context.contentResolver
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri,
            DocumentsContract.getDocumentId(uri))

        val cursor = contentResolver.query(
            childrenUri,
            arrayOf(
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_DOCUMENT_ID
            ),
            null, null, null
        ) ?: return 0

        cursor.use {
            val mimeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)

            while (cursor.moveToNext()) {
                val mime = cursor.getString(mimeIdx) ?: continue
                val name = cursor.getString(nameIdx) ?: continue
                val id = cursor.getString(idIdx) ?: continue

                val childUri = DocumentsContract.buildDocumentUriUsingTree(uri, id)
                val targetFile = File(target, name)

                if (DocumentsContract.Document.MIME_TYPE_DIR == mime) {
                    targetFile.mkdirs()
                    count += copySubTree(context, childUri, targetFile)
                } else {
                    try {
                        contentResolver.openInputStream(childUri)?.use { input ->
                            FileOutputStream(targetFile).use { output -> input.copyTo(output) }
                        }
                        count++
                    } catch (e: Exception) {
                        Log.w(TAG, "复制文件失败: $name → ${e.message}")
                    }
                }
            }
        }
        return count
    }

    private fun copySubTree(context: Context, uri: Uri, target: File): Int {
        var count = 0
        val contentResolver = context.contentResolver
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri,
            DocumentsContract.getDocumentId(uri))

        val cursor = contentResolver.query(
            childrenUri,
            arrayOf(
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_DOCUMENT_ID
            ),
            null, null, null
        ) ?: return 0

        cursor.use {
            val mimeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)

            while (cursor.moveToNext()) {
                val mime = cursor.getString(mimeIdx) ?: continue
                val name = cursor.getString(nameIdx) ?: continue
                val id = cursor.getString(idIdx) ?: continue

                val childUri = DocumentsContract.buildDocumentUriUsingTree(uri, id)
                val targetFile = File(target, name)

                if (DocumentsContract.Document.MIME_TYPE_DIR == mime) {
                    targetFile.mkdirs()
                    count += copySubTree(context, childUri, targetFile)
                } else {
                    try {
                        contentResolver.openInputStream(childUri)?.use { input ->
                            FileOutputStream(targetFile).use { output -> input.copyTo(output) }
                        }
                        count++
                    } catch (e: Exception) {
                        Log.w(TAG, "复制文件失败: $name → ${e.message}")
                    }
                }
            }
        }
        return count
    }

    // ── 小工具：从 SettingsState 读取侧载路径 ────────────────────────
    private fun SettingsState_sideloadPath(context: Context): String? = runCatching {
        val prefs = context.getSharedPreferences("tavern_console_prefs", Context.MODE_PRIVATE)
        prefs.getString("sideload_core_dir", null)
    }.getOrNull()

    private fun SettingsState_devModeEnabled(context: Context): Boolean = runCatching {
        val prefs = context.getSharedPreferences("tavern_console_prefs", Context.MODE_PRIVATE)
        prefs.getBoolean("dev_mode_enabled", false)
    }.getOrDefault(false)

    /** 直接访问外部存储（如果用户授予了权限）的常见路径 */
    fun publicDirSuggestion(): String {
        val pub = Environment.getExternalStorageDirectory()
        return "${pub.absolutePath}/Download/tavern-core"
    }
}
