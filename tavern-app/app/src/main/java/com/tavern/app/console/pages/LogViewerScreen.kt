package com.tavern.app.console.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tavern.app.util.AssetExtractor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

data class LogEntry(
    val raw: String,
    val level: LogLevel = LogLevel.INFO
)

enum class LogLevel(val displayName: String) {
    ALL("全部"),
    DEBUG("调试"),
    INFO("信息"),
    WARN("警告"),
    ERROR("错误")
}

@Composable
fun LogViewerScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    var logEntries by remember { mutableStateOf<List<LogEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var autoRefresh by remember { mutableStateOf(true) }
    var selectedLevel by remember { mutableStateOf(LogLevel.ALL) }
    var searchQuery by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    suspend fun loadLogs() {
        logEntries = withContext(Dispatchers.IO) {
            val coreDir = AssetExtractor.getCoreDir(ctx)
            val entries = mutableListOf<LogEntry>()
            val logFile = File(coreDir, "data/default-user/content.log")
            if (logFile.exists()) {
                try {
                    logFile.readLines().takeLast(500).forEach { line ->
                        val level = when {
                            line.contains("error", ignoreCase = true) || line.contains("fail", ignoreCase = true) -> LogLevel.ERROR
                            line.contains("warn", ignoreCase = true) -> LogLevel.WARN
                            line.contains("debug", ignoreCase = true) -> LogLevel.DEBUG
                            else -> LogLevel.INFO
                        }
                        entries.add(LogEntry(line, level))
                    }
                } catch (_: Exception) {}
            }
            if (entries.isEmpty()) entries.add(LogEntry("(暂无日志)", LogLevel.INFO))
            entries
        }
        loading = false
        if (logEntries.isNotEmpty()) {
            scope.launch {
                listState.animateScrollToItem(logEntries.size - 1)
            }
        }
    }

    LaunchedEffect(Unit) {
        loadLogs()
        while (isActive && autoRefresh) {
            delay(2000)
            loadLogs()
        }
    }

    val filteredLogs = remember(logEntries, selectedLevel, searchQuery) {
        logEntries.filter { entry ->
            val levelMatch = selectedLevel == LogLevel.ALL || entry.level == selectedLevel
            val searchMatch = searchQuery.isBlank() || entry.raw.contains(searchQuery, ignoreCase = true)
            levelMatch && searchMatch
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(modifier = Modifier.fillMaxSize().padding(20.dp)) {
            TextButton(onClick = onBack) {
                Text("← 返回", color = Color(0xFFD4A853), fontSize = 15.sp)
            }
            Spacer(modifier = Modifier.height(24.dp))
            Text("日志查看", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
            Text("最多显示 500 条服务器日志", fontSize = 13.sp, color = Color(0xFF8A8A80))
            Spacer(modifier = Modifier.height(16.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = { Text("搜索日志...") },
                    leadingIcon = { Icon(Icons.Outlined.Search, null) },
                    modifier = Modifier.weight(1f),
                    singleLine = true
                )
                Button(
                    onClick = {
                        scope.launch { loadLogs() }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surface)
                ) {
                    Icon(Icons.Outlined.Refresh, null, tint = Color(0xFFD4A853))
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    LogLevel.values().forEach { level ->
                        FilterChip(
                            selected = selectedLevel == level,
                            onClick = { selectedLevel = level },
                            label = { Text(level.displayName, fontSize = 11.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = Color(0xFFD4A853),
                                selectedLabelColor = Color.Black
                            )
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Switch(
                        checked = autoRefresh,
                        onCheckedChange = { autoRefresh = it },
                        colors = SwitchDefaults.colors(checkedThumbColor = Color(0xFFD4A853))
                    )
                    Text("自动刷新", fontSize = 11.sp, color = Color(0xFF8A8A80))
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            if (loading) {
                Box(modifier = Modifier.fillMaxWidth().padding(40.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Color(0xFFD4A853))
                }
            } else {
                Surface(shape = RoundedCornerShape(10.dp), color = Color(0xFF0A0A10), modifier = Modifier.fillMaxWidth().weight(1f)) {
                    if (filteredLogs.isEmpty()) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("没有匹配的日志", color = Color(0xFF8A8A80), fontSize = 14.sp)
                        }
                    } else {
                        LazyColumn(state = listState, modifier = Modifier.padding(12.dp)) {
                            items(filteredLogs) { entry ->
                                val color = when (entry.level) {
                                    LogLevel.ERROR -> Color(0xFFCC4455)
                                    LogLevel.WARN -> Color(0xFFD4A853)
                                    LogLevel.DEBUG -> Color(0xFF61AFEF)
                                    else -> Color(0xFF8A8A80)
                                }
                                Text(entry.raw, color = color, fontSize = 11.sp, fontFamily = FontFamily.Monospace, lineHeight = 16.sp)
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text("共 ${filteredLogs.size} 条日志", color = Color(0xFF8A8A80), fontSize = 11.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(
                            onClick = {
                                scope.launch {
                                    if (filteredLogs.isNotEmpty()) {
                                        listState.animateScrollToItem(0)
                                    }
                                }
                            }
                        ) {
                            Icon(Icons.Outlined.VerticalAlignTop, null, tint = Color(0xFF8A8A80), modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(2.dp))
                            Text("顶部", color = Color(0xFF8A8A80), fontSize = 11.sp)
                        }
                        TextButton(
                            onClick = {
                                scope.launch {
                                    if (filteredLogs.isNotEmpty()) {
                                        listState.animateScrollToItem(filteredLogs.size - 1)
                                    }
                                }
                            }
                        ) {
                            Icon(Icons.Outlined.VerticalAlignBottom, null, tint = Color(0xFF8A8A80), modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(2.dp))
                            Text("底部", color = Color(0xFF8A8A80), fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }
}
