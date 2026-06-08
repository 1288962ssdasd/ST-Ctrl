import java.net.URL
import java.io.FileOutputStream
import java.io.BufferedInputStream
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ======================================================================
// 构建时自动准备酒馆核心代码 (tavern-core.zip)
//
// 获取顺序（任一成功即可）：
//   1) 本地已存在：assets/core/tavern-core.zip (由开发者手动放入，不进 git)
//   2) 自定义 URL：通过 TAVERN_CORE_URL / TAVERN_APK_URL 指定
//   3) 回退：从 wancDDY/ST-Ctrl 的 latest release APK 中提取
//
// 注意：tavern-core.zip 已在 .gitignore 中排除，不会被提交到 git
// ======================================================================

tasks.register("prepareTavernCore") {
    description = "Prepare tavern-core.zip (local file > custom URL > wancDDY release)"
    group = "build"

    val coreDir = file("src/main/assets/core")
    val coreZip = file("${coreDir.absolutePath}/tavern-core.zip")

    fun mb(f: java.io.File) = String.format("%.2f", f.length() / 1048576.0)

    fun downloadTo(urlStr: String, target: java.io.File, label: String) {
        println("[tavern-core] 下载 $label: $urlStr")
        target.parentFile?.mkdirs()
        val conn = URL(urlStr).openConnection()
        conn.setRequestProperty("User-Agent", "ST-Ctrl-build")
        conn.connectTimeout = 60000
        conn.readTimeout = 600000
        BufferedInputStream(conn.getInputStream()).use { input ->
            FileOutputStream(target).use { output ->
                val buffer = ByteArray(1024 * 1024)
                var bytesRead: Int
                var total = 0L
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    output.write(buffer, 0, bytesRead)
                    total += bytesRead
                    if (total % (20 * 1024 * 1024) < buffer.size) {
                        println("[tavern-core]   已下载 ${String.format("%.2f", total / 1048576.0)} MB…")
                    }
                }
                println("[tavern-core]   完成，共 ${String.format("%.2f", total / 1048576.0)} MB")
            }
        }
    }

    doFirst {
        // 路径 1：本地已有有效 zip，直接用
        if (coreZip.exists() && coreZip.length() > 1024) {
            println("[tavern-core] 使用本地 core: ${coreZip.absolutePath} (${mb(coreZip)} MB)")
            return@doFirst
        }
        coreDir.mkdirs()

        val customCoreUrl = System.getenv("TAVERN_CORE_URL")
        val customApkUrl = System.getenv("TAVERN_APK_URL")

        // 路径 2a：自定义 tavern-core.zip 直链 URL
        if (!customCoreUrl.isNullOrBlank()) {
            println("[tavern-core] 使用 TAVERN_CORE_URL 下载…")
            downloadTo(customCoreUrl, coreZip, "tavern-core.zip")
            if (coreZip.length() > 1024) {
                println("[tavern-core] 完成: ${mb(coreZip)} MB")
                return@doFirst
            }
            coreZip.delete()
            println("[tavern-core] 下载结果过小，继续尝试其他方式…")
        }

        // 路径 2b：自定义 APK URL（从中提取 tavern-core.zip）
        var apkUrl: String? = customApkUrl
        if (apkUrl.isNullOrBlank()) {
            // 路径 3：从 wancDDY/ST-Ctrl latest release 找 APK
            println("[tavern-core] 解析 wancDDY/ST-Ctrl release 获取 APK…")
            val repo = "wancDDY/ST-Ctrl"
            try {
                val json = URL("https://api.github.com/repos/$repo/releases/latest")
                    .readText(charset = Charsets.UTF_8)
                val apkPattern = """"browser_download_url":\s*"([^"]+\.apk)"""".toRegex()
                val m = apkPattern.find(json)
                if (m != null) apkUrl = m.groupValues[1]
            } catch (e: Exception) {
                println("[tavern-core] GitHub API 访问失败: ${e.message}")
            }
        }

        if (!apkUrl.isNullOrBlank()) {
            val tmpApk = file("${buildDir}/tmp-tavern-release.apk")
            tmpApk.parentFile?.mkdirs()
            if (!(tmpApk.exists() && tmpApk.length() > 1024 * 1024)) {
                downloadTo(apkUrl, tmpApk, "release APK")
            } else {
                println("[tavern-core] 使用缓存 APK: ${mb(tmpApk)} MB")
            }

            println("[tavern-core] 从 APK 中提取 assets/core/tavern-core.zip…")
            var ok = false
            try {
                ZipFile(tmpApk).use { zip ->
                    val entry = zip.getEntry("assets/core/tavern-core.zip")
                        ?: throw GradleException("APK 中找不到 assets/core/tavern-core.zip")
                    zip.getInputStream(entry).use { input ->
                        FileOutputStream(coreZip).use { output -> input.copyTo(output) }
                    }
                    ok = true
                }
            } catch (e: Exception) {
                // APK 可能损坏，删除缓存下次重试
                tmpApk.delete()
                throw GradleException("APK 解析失败: ${e.message}，缓存已清理，请重试")
            }

            if (ok && coreZip.length() > 1024) {
                println("[tavern-core] 完成: ${mb(coreZip)} MB")
                return@doFirst
            }
            coreZip.delete()
        }

        // 全部失败，给出明确指引
        throw GradleException(
            "\n============================================================\n" +
            "无法获取 tavern-core.zip。请选择以下任一方式：\n" +
            "  1) 手动把你的 137MB tavern-core.zip 放到:\n" +
            "     tavern-app/app/src/main/assets/core/tavern-core.zip\n" +
            "     （该路径已在 .gitignore 中，不会进 git）\n" +
            "  2) 执行前设置环境变量:\n" +
            "     export TAVERN_CORE_URL=https://your-host/tavern-core.zip\n" +
            "  3) 保持默认，构建机访问 GitHub 自动从 wancDDY/ST-Ctrl 提取\n" +
            "============================================================"
        )
    }
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Resources") }
    .configureEach { dependsOn("prepareTavernCore") }

// 清理任务：删除下载的核心文件和 APK 缓存
tasks.register<Delete>("cleanTavernCore") {
    description = "Remove local tavern-core.zip and cached release APK"
    group = "build"
    delete(
        file("src/main/assets/core/tavern-core.zip"),
        file("${buildDir}/tmp-tavern-release.apk")
    )
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
