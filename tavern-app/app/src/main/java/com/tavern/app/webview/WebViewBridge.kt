package com.tavern.app.webview

import android.util.Log
import android.webkit.JavascriptInterface
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class RegisteredRoute(
    val path: String,
    val method: String,
    val handler: String,
    val registeredAt: Long = System.currentTimeMillis()
)

object RouteRegistry {
    private val _routes = MutableStateFlow<List<RegisteredRoute>>(emptyList())
    val routes: StateFlow<List<RegisteredRoute>> = _routes.asStateFlow()

    fun registerRoute(path: String, method: String, handler: String) {
        val newRoute = RegisteredRoute(path, method, handler)
        _routes.value = _routes.value + newRoute
        Log.d("RouteRegistry", "Registered route: $method $path -> $handler")
    }

    fun unregisterRoute(path: String, method: String) {
        _routes.value = _routes.value.filterNot { it.path == path && it.method == method }
        Log.d("RouteRegistry", "Unregistered route: $method $path")
    }

    fun getRoutes(): List<RegisteredRoute> = _routes.value

    fun clearRoutes() {
        _routes.value = emptyList()
        Log.d("RouteRegistry", "All routes cleared")
    }
}

class WebViewBridge {

    @JavascriptInterface
    fun log(message: String) {
        Log.d("TavernWebView", message)
    }

    @JavascriptInterface
    fun logDebug(message: String) {
        Log.d("TavernWebView", "[DEBUG] $message")
    }

    @JavascriptInterface
    fun logInfo(message: String) {
        Log.i("TavernWebView", "[INFO] $message")
    }

    @JavascriptInterface
    fun logWarn(message: String) {
        Log.w("TavernWebView", "[WARN] $message")
    }

    @JavascriptInterface
    fun logError(message: String) {
        Log.e("TavernWebView", "[ERROR] $message")
    }

    @JavascriptInterface
    fun getPlatform(): String = "android"

    @JavascriptInterface
    fun getAppVersion(): String = "1.0.0"

    @JavascriptInterface
    fun shareText(text: String) { /* reserved */ }

    @JavascriptInterface
    fun registerRoute(path: String, method: String, handler: String) {
        RouteRegistry.registerRoute(path, method, handler)
    }

    @JavascriptInterface
    fun unregisterRoute(path: String, method: String) {
        RouteRegistry.unregisterRoute(path, method)
    }

    @JavascriptInterface
    fun getRegisteredRoutes(): String {
        return try {
            val routes = RouteRegistry.getRoutes()
            routes.joinToString(separator = "\n") { "${it.method} ${it.path} -> ${it.handler}" }
        } catch (e: Exception) {
            "Error: ${e.message}"
        }
    }

    @JavascriptInterface
    fun clearAllRoutes() {
        RouteRegistry.clearRoutes()
    }

    @JavascriptInterface
    fun sendToDebugConsole(message: String, level: String = "info") {
        when (level.lowercase()) {
            "debug" -> Log.d("DebugConsole", message)
            "info" -> Log.i("DebugConsole", message)
            "warn" -> Log.w("DebugConsole", message)
            "error" -> Log.e("DebugConsole", message)
            else -> Log.d("DebugConsole", message)
        }
    }
}
