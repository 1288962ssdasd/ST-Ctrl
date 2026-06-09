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
        noCompress("so", "node")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")
    implementation("androidx.webkit:webkit:1.9.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    compileOnly("com.google.errorprone:error_prone_annotations:2.23.0")
    compileOnly("com.google.code.findbugs:jsr305:3.0.2")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.work:work-runtime-ktx:2.9.0")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
}

// ==========================================================================
// 构建时下载 libnode.so（Node.js Mobile 运行时）
// 注意：tavern-core 源码不打包进 APK，由 CoreUpdater 在手机端首次启动时从 GitHub 下载
// ==========================================================================

tasks.register("downloadNodejsMobile") {
    group = "nodejs-mobile"
    description = "Download Node.js Mobile shared libraries for arm64/arm/x86_64"

    val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs").asFile
    val tmpZip = layout.buildDirectory.file("tmp-nodejs/nodejs-mobile-v18.20.4.zip").get().asFile
    val nodejsMobileUrl = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip"
    val abiMap = mapOf("arm64" to "arm64-v8a", "arm" to "armeabi-v7a", "x86_64" to "x86_64")

    outputs.upToDateWhen {
        listOf("arm64-v8a", "armeabi-v7a", "x86_64").all { abi ->
            val f = File(jniLibsDir, "$abi/libnode.so")
            f.exists() && f.length() > 1_000_000
        }
    }

    doLast {
        tmpZip.parentFile.mkdirs()

        if (!tmpZip.exists() || tmpZip.length() < 5_000_000) {
            println("[nodejs-mobile] Downloading v18.20.4: $nodejsMobileUrl")
            val conn = java.net.URI(nodejsMobileUrl).toURL().openConnection() as java.net.HttpURLConnection
            conn.instanceFollowRedirects = true
            conn.connectTimeout = 60000
            conn.readTimeout = 300000
            conn.setRequestProperty("User-Agent", "tavern-app-builder")
            conn.connect()
            if (conn.responseCode !in 200..299) {
                throw GradleException("Download failed: HTTP ${conn.responseCode}")
            }
            val totalLen = conn.contentLengthLong
            java.io.BufferedInputStream(conn.inputStream).use { input ->
                java.io.BufferedOutputStream(java.io.FileOutputStream(tmpZip)).use { output ->
                    val buf = ByteArray(65536)
                    var total = 0L
                    var read: Int
                    var lastPrint = 0L
                    while (input.read(buf).also { read = it } != -1) {
                        output.write(buf, 0, read)
                        total += read
                        if (totalLen > 0 && total - lastPrint > 10_000_000) {
                            println("[nodejs-mobile] ${total / (1024 * 1024)}MB / ${totalLen / (1024 * 1024)}MB")
                            lastPrint = total
                        }
                    }
                }
            }
            println("[nodejs-mobile] Downloaded: ${tmpZip.length()} bytes")
        } else {
            println("[nodejs-mobile] Using cached zip")
        }

        // 解压各平台
        val foundPaths = mutableMapOf<String, String>()
        java.util.zip.ZipFile(tmpZip).use { zip ->
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
        if (foundPaths.isEmpty()) throw GradleException("No libnode.so found in zip!")
        println("[nodejs-mobile] Found: $foundPaths")

        java.util.zip.ZipFile(tmpZip).use { zip ->
            for ((zipAbi, androidAbi) in abiMap) {
                val zipPath = foundPaths[zipAbi] ?: continue
                val entry = zip.getEntry(zipPath) ?: continue
                val outDir = File(jniLibsDir, androidAbi)
                outDir.mkdirs()
                val outFile = File(outDir, "libnode.so")
                zip.getInputStream(entry).use { ins ->
                    java.io.FileOutputStream(outFile).use { ous -> ins.copyTo(ous) }
                }
                println("[nodejs-mobile] $androidAbi -> ${outFile.length()} bytes")
            }
        }
        println("[nodejs-mobile] Done")
    }
}

// preBuild 依赖下载 libnode.so（仅此一个自定义任务）
tasks.named("preBuild") {
    dependsOn("downloadNodejsMobile")
}
