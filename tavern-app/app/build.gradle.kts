import java.util.zip.ZipFile
import java.io.BufferedOutputStream
import java.io.FileOutputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------- Node.js Mobile Runtime Download ----------
// 从 nodejs-mobile 的社区维护版本下载真正的 libnode.so (arm64-v8a, armeabi-v7a, x86_64)
// 这避免了把 50MB+ 的二进制文件放入 Git 仓库 / LFS
// 参考: https://github.com/nodejs-mobile/nodejs-mobile/releases
val nodejsMobileVersion = "18.20.4"
val nodejsMobileUrl = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${nodejsMobileVersion}/nodejs-mobile-v${nodejsMobileVersion}-android.zip"
val nodejsMobileZip = layout.buildDirectory.file("tmp-nodejs/nodejs-mobile.zip").get().asFile
val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs").asFile

// ABI 在 zip 中的目录名 -> Android ABI 名
val abiMap = mapOf(
    "arm64" to "arm64-v8a",
    "arm" to "armeabi-v7a",
    "x86_64" to "x86_64"
)

tasks.register("downloadNodejsMobile") {
    group = "nodejs-mobile"
    description = "Download Node.js for Mobile Apps shared libraries (libnode.so)"

    outputs.upToDateWhen {
        // 如果三个目标平台的 libnode.so 都已存在且 > 1MB，则跳过
        listOf("arm64-v8a", "armeabi-v7a", "x86_64").all { abi ->
            val f = File(jniLibsDir, "$abi/libnode.so")
            f.exists() && f.length() > 1_000_000
        }
    }

    doLast {
        nodejsMobileZip.parentFile.mkdirs()

        // 下载 zip（带简单缓存检查）
        if (!nodejsMobileZip.exists() || nodejsMobileZip.length() < 5_000_000) {
            println("[nodejs-mobile] Downloading v${nodejsMobileVersion}...")
            val conn = java.net.URI(nodejsMobileUrl).toURL().openConnection() as java.net.HttpURLConnection
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "tavern-app-builder")
            conn.connect()
            if (conn.responseCode !in 200..299) {
                throw GradleException("Failed to download Node.js Mobile: HTTP ${conn.responseCode}")
            }
            conn.inputStream.use { input ->
                BufferedOutputStream(FileOutputStream(nodejsMobileZip)).use { output ->
                    input.copyTo(output)
                }
            }
            println("[nodejs-mobile] Downloaded ${nodejsMobileZip.length()} bytes")
        } else {
            println("[nodejs-mobile] Using cached zip (${nodejsMobileZip.length()} bytes)")
        }

        // 在 zip 中自动搜索 libnode.so 的位置
        val foundPaths = mutableMapOf<String, String>() // abi -> zipPath
        ZipFile(nodejsMobileZip).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val e = entries.nextElement()
                val name = e.name
                if (name.endsWith("libnode.so") && !e.isDirectory) {
                    for ((zipAbi, androidAbi) in abiMap) {
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
        println("[nodejs-mobile] Found libnode.so paths in zip: $foundPaths")

        // 解压 libnode.so 到 jniLibs/
        ZipFile(nodejsMobileZip).use { zip ->
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
                println("[nodejs-mobile] $androidAbi: ${outFile.length()} bytes -> ${outFile.absolutePath}")
            }
        }

        println("[nodejs-mobile] Done. Node.js runtime ready for packaging.")
    }
}

// ---------- npm install for tavern-core node_modules ----------
// 在构建前为 assets/core 运行 npm install，生成 node_modules 并打入 APK
val coreDir = layout.projectDirectory.dir("src/main/assets/core").asFile

tasks.register("npmInstallCore") {
    group = "nodejs-mobile"
    description = "Run npm install in assets/core to generate node_modules"

    outputs.upToDateWhen {
        // 如果 assets/core/node_modules 已经存在且非空，则跳过
        val nm = File(coreDir, "node_modules")
        nm.exists() && nm.listFiles()?.isNotEmpty() == true
    }

    doLast {
        val pkgJson = File(coreDir, "package.json")
        if (!pkgJson.exists()) {
            println("[npm-install] No package.json in assets/core, skipping npm install")
            return@doLast
        }
        if (!coreDir.exists()) {
            throw GradleException("assets/core directory not found: ${coreDir.absolutePath}")
        }
        println("[npm-install] Running 'npm install --omit=dev' in ${coreDir.absolutePath}")
        val proc = ProcessBuilder("npm", "install", "--omit=dev", "--no-audit", "--no-fund")
            .directory(coreDir)
            .redirectOutput(ProcessBuilder.Redirect.INHERIT)
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start()
        val exitCode = proc.waitFor()
        if (exitCode != 0) {
            throw GradleException("npm install failed with exit code $exitCode")
        }
        println("[npm-install] Done. node_modules generated in assets/core")
    }
}

// 在 preBuild 之前执行下载 + npm install
tasks.named("preBuild") {
    dependsOn("downloadNodejsMobile", "npmInstallCore")
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
