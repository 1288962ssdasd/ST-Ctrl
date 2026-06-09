import java.util.zip.ZipFile
import java.io.BufferedOutputStream
import java.io.FileOutputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tavern.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tavern.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    signingConfigs {
        create("release") {
            // Use debug keystore for release (same signature as debug)
            storeFile = file("${project.rootDir}/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    externalNativeBuild {
        cmake {
            path("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("src/main/jniLibs")
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    aaptOptions {
        noCompress("so", "node", "js", "zip")
    }
}

dependencies {
    // Compose
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")

    // Core
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")

    // WebView
    implementation("androidx.webkit:webkit:1.9.0")

    // Security
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // R8 / Tink 混淆所需的注解库
    // Tink 加密库引用了这些注解，但它们是 compile-only 的，需要显式添加
    compileOnly("com.google.errorprone:error_prone_annotations:2.23.0")
    compileOnly("com.google.code.findbugs:jsr305:3.0.2")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // Material Icons Extended
    implementation("androidx.compose.material:material-icons-extended")

    // WorkManager (auto backup)
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Compose Navigation
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Test
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
}

// ==========================================================================
// 自定义任务：构建时自动准备 Node.js 运行时和 tavern-core 依赖
// ==========================================================================

import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import java.io.BufferedInputStream
import java.io.FileInputStream

// ---------- 下载 Node.js Mobile Runtime (libnode.so) ----------
// 从 nodejs-mobile 官方发布下载真正的 libnode.so（约 57MB zip）
// 避免将 50MB+ 的二进制文件放入 Git 仓库 / LFS
// 参考: https://github.com/nodejs-mobile/nodejs-mobile/releases
tasks.register("downloadNodejsMobile") {
    group = "nodejs-mobile"
    description = "Download and extract Node.js for Mobile Apps shared libraries (libnode.so)"

    val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs").asFile
    val tmpZip = layout.buildDirectory.file("tmp-nodejs/nodejs-mobile.zip").get().asFile
    val nodejsMobileUrl = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip"
    val abiMap = mapOf(
        "arm64" to "arm64-v8a",
        "arm" to "armeabi-v7a",
        "x86_64" to "x86_64"
    )

    outputs.upToDateWhen {
        // 若三个平台的 libnode.so 都已存在且 > 1MB，视为已就绪
        listOf("arm64-v8a", "armeabi-v7a", "x86_64").all { abi ->
            val f = File(jniLibsDir, "$abi/libnode.so")
            f.exists() && f.length() > 1_000_000
        }
    }

    doLast {
        tmpZip.parentFile.mkdirs()

        // 下载 zip（带缓存检查）
        if (!tmpZip.exists() || tmpZip.length() < 5_000_000) {
            println("[nodejs-mobile] Downloading v18.20.4 from: $nodejsMobileUrl")
            val conn = java.net.URI(nodejsMobileUrl).toURL().openConnection() as java.net.HttpURLConnection
            conn.instanceFollowRedirects = true
            conn.connectTimeout = 60000
            conn.readTimeout = 300000
            conn.setRequestProperty("User-Agent", "tavern-app-builder")
            conn.connect()
            if (conn.responseCode !in 200..299) {
                throw GradleException("Failed to download Node.js Mobile: HTTP ${conn.responseCode} (${conn.responseMessage})")
            }
            val totalLen = conn.contentLengthLong
            conn.inputStream.use { input ->
                BufferedOutputStream(FileOutputStream(tmpZip)).use { output ->
                    val buf = ByteArray(65536)
                    var total = 0L
                    var read: Int
                    var lastPrint = 0L
                    while (input.read(buf).also { read = it } != -1) {
                        output.write(buf, 0, read)
                        total += read
                        if (totalLen > 0 && total - lastPrint > 5_000_000) {
                            println("[nodejs-mobile] Downloaded ${total / (1024 * 1024)}MB / ${totalLen / (1024 * 1024)}MB")
                            lastPrint = total
                        }
                    }
                }
            }
            println("[nodejs-mobile] Download complete: ${tmpZip.length()} bytes")
        } else {
            println("[nodejs-mobile] Using cached zip (${tmpZip.length()} bytes)")
        }

        // 扫描 zip 中各平台的 libnode.so 路径
        val foundPaths = mutableMapOf<String, String>() // zipAbi -> zipPath
        ZipFile(tmpZip).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val e = entries.nextElement()
                val name = e.name
                if (!e.isDirectory && name.endsWith("libnode.so")) {
                    for ((zipAbi, _) in abiMap) {
                        if (name.contains(zipAbi) && zipAbi !in foundPaths) {
                            foundPaths[zipAbi] = name
                        }
                    }
                }
            }
        }
        if (foundPaths.isEmpty()) {
            throw GradleException("No libnode.so found in the downloaded zip!")
        }
        println("[nodejs-mobile] Found: $foundPaths")

        // 解压各平台的 libnode.so 到 jniLibs/
        ZipFile(tmpZip).use { zip ->
            for ((zipAbi, androidAbi) in abiMap) {
                val zipPath = foundPaths[zipAbi] ?: continue
                val entry = zip.getEntry(zipPath) ?: continue
                val outDir = File(jniLibsDir, androidAbi)
                outDir.mkdirs()
                val outFile = File(outDir, "libnode.so")
                zip.getInputStream(entry).use { ins ->
                    FileOutputStream(outFile).use { ous ->
                        ins.copyTo(ous)
                    }
                }
                println("[nodejs-mobile] $androidAbi: ${outFile.length()} bytes")
            }
        }
        println("[nodejs-mobile] Done. libnode.so ready for packaging.")
    }
}

// ---------- npm install for tavern-core node_modules ----------
// 如果仓库中已包含 node_modules（完整推送），此任务会自动跳过
tasks.register("npmInstallCore") {
    group = "nodejs-mobile"
    description = "Run npm install in assets/core if node_modules is missing"

    val coreDir = layout.projectDirectory.dir("src/main/assets/core").asFile

    outputs.upToDateWhen {
        if (!coreDir.exists()) return@upToDateWhen true
        val nm = File(coreDir, "node_modules")
        // node_modules 存在且有内容 → 跳过
        nm.exists() && nm.listFiles()?.isNotEmpty() == true
    }

    doLast {
        if (!coreDir.exists()) {
            println("[npm-install] assets/core/ not found, skipping")
            return@doLast
        }
        val pkgJson = File(coreDir, "package.json")
        if (!pkgJson.exists()) {
            println("[npm-install] assets/core/package.json not found, skipping npm install")
            return@doLast
        }
        println("[npm-install] Running npm install in: ${coreDir.absolutePath}")
        val proc = ProcessBuilder("npm", "install", "--omit=dev", "--no-audit", "--no-fund")
            .directory(coreDir)
            .redirectOutput(ProcessBuilder.Redirect.INHERIT)
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start()
        val exitCode = proc.waitFor()
        if (exitCode != 0) {
            throw GradleException("npm install failed with exit code $exitCode")
        }
        println("[npm-install] Done. node_modules is now ready.")
    }
}

// ---------- 打包 tavern-core 为 zip（关键优化：避免 25k+ 个文件压垮 AAPT2） ----------
// 将 assets/core/ 下的所有文件打包成单个 tavern-core.zip
// 然后清理 assets/core/ 目录，只保留 zip 和 package.json（用于版本读取）
// 运行时 AssetExtractor 会检测 zip 模式并解压
tasks.register("packageCoreZip") {
    group = "nodejs-mobile"
    description = "Package assets/core/ into tavern-core.zip (avoids AAPT2 choking on 25k+ files)"

    val coreDir = layout.projectDirectory.dir("src/main/assets/core").asFile
    val coreZipFile = File(coreDir, "tavern-core.zip")
    val versionMarker = File(coreDir, "package.json")

    outputs.upToDateWhen {
        // 如果 zip 已存在且 core 目录中只剩很少文件（已清理过），则跳过
        if (coreZipFile.exists() && coreZipFile.length() > 10_000_000) {
            val fileCount = coreDir.walkTopDown().count { it.isFile }
            if (fileCount <= 5) {
                println("[packageCoreZip] tavern-core.zip already packaged (${coreZipFile.length()} bytes), skipping")
                return@upToDateWhen true
            }
        }
        false
    }

    doLast {
        if (!coreDir.exists()) {
            println("[packageCoreZip] assets/core/ not found, skipping")
            return@doLast
        }

        // 如果 zip 已经是最新的（之前打包过且源文件已清理），跳过
        val existingFileCount = coreDir.walkTopDown().count { it.isFile }
        if (coreZipFile.exists() && coreZipFile.length() > 10_000_000 && existingFileCount <= 5) {
            println("[packageCoreZip] Already packaged, skipping")
            return@doLast
        }

        println("[packageCoreZip] Packaging assets/core/ directory...")
        println("[packageCoreZip] Scanning files (this may take a moment)...")

        // 收集所有文件（排除即将生成的 zip 本身）
        val filesToZip = mutableListOf<File>()
        coreDir.walkTopDown().forEach { f ->
            if (f.isFile && f.name != "tavern-core.zip") {
                filesToZip.add(f)
            }
        }
        println("[packageCoreZip] Found ${filesToZip.size} files to package")

        // 读取 package.json 内容（用于之后保留副本）
        val pkgJsonContent = if (versionMarker.exists()) versionMarker.readBytes() else null

        // 创建 zip
        println("[packageCoreZip] Creating tavern-core.zip...")
        // 先写到临时文件，完成后再重命名
        val tmpZipFile = File(coreDir, "tavern-core.zip.tmp")
        if (tmpZipFile.exists()) tmpZipFile.delete()

        var entryCount = 0
        val buffer = ByteArray(65536)
        ZipOutputStream(BufferedOutputStream(FileOutputStream(tmpZipFile))).use { zos ->
            for (file in filesToZip) {
                val relPath = file.relativeTo(coreDir).path.replace('\\', '/')
                if (relPath.isEmpty() || relPath == "tavern-core.zip") continue

                val entry = ZipEntry(relPath)
                entry.size = file.length()
                zos.putNextEntry(entry)

                BufferedInputStream(FileInputStream(file)).use { bis ->
                    var read: Int
                    while (bis.read(buffer).also { read = it } != -1) {
                        zos.write(buffer, 0, read)
                    }
                }
                zos.closeEntry()
                entryCount++
                if (entryCount % 5000 == 0) {
                    println("[packageCoreZip] Packaged $entryCount/${filesToZip.size} files...")
                }
            }
        }

        // 重命名为最终 zip
        if (coreZipFile.exists()) coreZipFile.delete()
        tmpZipFile.renameTo(coreZipFile)
        println("[packageCoreZip] Zip created: ${coreZipFile.length()} bytes ($entryCount entries)")

        // 清理 assets/core/ 目录：只保留 tavern-core.zip 和 package.json
        // 这样 AAPT2 只处理这 2 个文件（而不是 25k+ 个）
        println("[packageCoreZip] Cleaning original files from assets/core/ (keeping only zip + package.json)...")
        var deletedCount = 0
        val keptFiles = setOf("tavern-core.zip", "package.json")
        coreDir.walkTopDown().sortedWith(compareByDescending { it.path.length }).forEach { f ->
            if (f == coreDir) return@forEach
            if (f.isFile && f.name in keptFiles) return@forEach
            if (f.isFile) {
                if (f.delete()) deletedCount++
            } else if (f.isDirectory) {
                // 只删除空目录
                try { f.delete() } catch (_: Exception) {}
            }
        }
        println("[packageCoreZip] Deleted $deletedCount original files. assets/core/ now minimized for AAPT2.")

        // 确保 package.json 存在（用于 CI 读取版本号）
        if (pkgJsonContent != null && !versionMarker.exists()) {
            versionMarker.writeBytes(pkgJsonContent)
            println("[packageCoreZip] package.json restored for version reading")
        }

        println("[packageCoreZip] Done.")
    }
}

// ---------- 让 preBuild 依赖我们的自定义任务 ----------
// 注意：必须在 android {} 块之后调用，否则 preBuild 任务还不存在
// 任务链：downloadNodejsMobile → npmInstallCore → packageCoreZip → preBuild
tasks.named("preBuild") {
    dependsOn("downloadNodejsMobile", "packageCoreZip")
}
