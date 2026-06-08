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
// 如果 assets/core/tavern-core.zip 为空或不存在，则从 wancDDY/ST-Ctrl 的
// release APK 中提取一份有效的 tavern-core.zip
// ======================================================================

tasks.register("prepareTavernCore") {
    description = "Extract tavern-core.zip from wancDDY/ST-Ctrl release APK"
    group = "build"

    val coreDir = file("src/main/assets/core")
    val coreZip = file("${coreDir.absolutePath}/tavern-core.zip")

    doFirst {
        val needsDownload = !coreZip.exists() || coreZip.length() < 1024
        if (!needsDownload) {
            println("[tavern-core] tavern-core.zip 已存在 (${String.format("%.2f", coreZip.length() / 1048576.0)} MB)，跳过下载")
            return@doFirst
        }

        println("[tavern-core] tavern-core.zip 为空或不存在，从 wancDDY/ST-Ctrl release APK 中提取…")

        val repo = "wancDDY/ST-Ctrl"
        val latestApi = URL("https://api.github.com/repos/$repo/releases/latest")
        var apkUrl: String? = null

        try {
            val json = latestApi.readText(charset = Charsets.UTF_8)
            // 找到第一个名字是 .apk 的浏览器下载地址
            val apkPattern = """"browser_download_url":\s*"([^"]+\.apk)"""".toRegex()
            val m = apkPattern.find(json)
            if (m != null) apkUrl = m.groupValues[1]
        } catch (e: Exception) {
            throw GradleException("无法访问 GitHub API: ${e.message}")
        }

        if (apkUrl == null) {
            throw GradleException("在 $repo 的 latest release 中找不到 .apk 资源，请手动将 tavern-core.zip 放入 $coreDir")
        }

        println("[tavern-core] APK 地址: $apkUrl")
        coreDir.mkdirs()

        // 先下载 APK 到临时文件
        val tmpApk = file("${buildDir}/tmp-tavern-release.apk")
        tmpApk.parentFile?.mkdirs()
        if (tmpApk.exists() && tmpApk.length() > 1024 * 1024) {
            println("[tavern-core] 缓存 APK 已存在 (${String.format("%.2f", tmpApk.length() / 1048576.0)} MB)，跳过下载")
        } else {
            println("[tavern-core] 正在下载 APK（首次运行较慢，约 300MB）…")
            val conn = URL(apkUrl).openConnection()
            conn.setRequestProperty("User-Agent", "ST-Ctrl-build")
            conn.connectTimeout = 60000
            conn.readTimeout = 600000
            BufferedInputStream(conn.getInputStream()).use { input ->
                FileOutputStream(tmpApk).use { output ->
                    val buffer = ByteArray(1024 * 1024)
                    var bytesRead: Int
                    var total = 0L
                    while (input.read(buffer).also { bytesRead = it } != -1) {
                        output.write(buffer, 0, bytesRead)
                        total += bytesRead
                        if (total % (20 * 1024 * 1024) < buffer.size) {
                            println("[tavern-core] 已下载 ${String.format("%.2f", total / 1048576.0)} MB…")
                        }
                    }
                    println("[tavern-core] APK 下载完成，共 ${String.format("%.2f", total / 1048576.0)} MB")
                }
            }
        }

        // 从 APK 中提取 assets/core/tavern-core.zip
        println("[tavern-core] 从 APK 中提取 tavern-core.zip…")
        var extracted = false
        ZipFile(tmpApk).use { zip ->
            val entry = zip.getEntry("assets/core/tavern-core.zip")
            if (entry == null) {
                throw GradleException("APK 中找不到 assets/core/tavern-core.zip")
            }
            zip.getInputStream(entry).use { input ->
                FileOutputStream(coreZip).use { output ->
                    input.copyTo(output)
                }
            }
            extracted = true
        }

        if (!extracted || coreZip.length() < 1024) {
            coreZip.delete()
            throw GradleException("从 APK 提取的 tavern-core.zip 无效，请检查下载是否完整")
        }

        println("[tavern-core] 提取完成: ${coreZip.absolutePath} (${String.format("%.2f", coreZip.length() / 1048576.0)} MB)")
    }
}

// 确保在资源处理之前完成下载
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Resources") }
    .configureEach { dependsOn("prepareTavernCore") }

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
