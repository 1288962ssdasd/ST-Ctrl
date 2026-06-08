package com.tavern.app.console.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

data class RouteInfo(
    val path: String,
    val method: String,
    val description: String = "",
    val enabled: Boolean = true,
    val hits: Int = 0
)

@Composable
fun RouteDebugScreen(onBack: () -> Unit) {
    var routes by remember { mutableStateOf<List<RouteInfo>>(emptyList()) }
    var newRoutePath by remember { mutableStateOf("") }
    var newRouteMethod by remember { mutableStateOf("GET") }
    var newRouteDesc by remember { mutableStateOf("") }
    var showAddDialog by remember { mutableStateOf(false) }
    var selectedFilter by remember { mutableStateOf("全部") }

    val methods = listOf("GET", "POST", "PUT", "DELETE", "PATCH")
    val filters = listOf("全部", "GET", "POST", "PUT", "DELETE", "PATCH", "已启用", "已禁用")

    LaunchedEffect(Unit) {
        routes = listOf(
            RouteInfo("/api/health", "GET", "健康检查接口", true, 128),
            RouteInfo("/api/var/:key", "GET", "获取变量", true, 45),
            RouteInfo("/api/var/:key", "POST", "设置变量", true, 32),
            RouteInfo("/api/event/:event", "POST", "发布事件", true, 21),
            RouteInfo("/api/plugins/debug", "GET", "调试接口", false, 0)
        )
    }

    val filteredRoutes = remember(routes, selectedFilter) {
        routes.filter { route ->
            when (selectedFilter) {
                "全部" -> true
                "已启用" -> route.enabled
                "已禁用" -> !route.enabled
                else -> route.method == selectedFilter
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(modifier = Modifier.fillMaxSize().padding(20.dp)) {
            TextButton(onClick = onBack) {
                Text("← 返回", color = Color(0xFFD4A853), fontSize = 15.sp)
            }
            Spacer(modifier = Modifier.height(24.dp))
            Text("路由调试面板", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
            Text("管理和调试服务器路由", fontSize = 13.sp, color = Color(0xFF8A8A80))
            Spacer(modifier = Modifier.height(16.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { showAddDialog = true },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD4A853)),
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Outlined.Add, null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("添加路由")
                }
                Button(
                    onClick = { /* 刷新 */ },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surface),
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(Icons.Outlined.Refresh, null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text("刷新", color = MaterialTheme.colorScheme.onSurface)
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            ScrollableTabRow(
                selectedTabIndex = filters.indexOf(selectedFilter),
                containerColor = MaterialTheme.colorScheme.surface,
                contentColor = Color(0xFFD4A853),
                edgePadding = 0.dp
            ) {
                filters.forEach { filter ->
                    Tab(
                        selected = selectedFilter == filter,
                        onClick = { selectedFilter = filter },
                        text = { Text(filter, fontSize = 12.sp) }
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            Surface(shape = RoundedCornerShape(10.dp), color = Color(0xFF0A0A10), modifier = Modifier.fillMaxWidth().weight(1f)) {
                if (filteredRoutes.isEmpty()) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("暂无路由数据", color = Color(0xFF8A8A80), fontSize = 14.sp)
                    }
                } else {
                    LazyColumn(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(filteredRoutes) { route ->
                            RouteItem(
                                route = route,
                                onToggle = {
                                    routes = routes.map { if (it == route) it.copy(enabled = !it.enabled) else it }
                                },
                                onDelete = {
                                    routes = routes.filter { it != route }
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    if (showAddDialog) {
        AlertDialog(
            onDismissRequest = { showAddDialog = false },
            title = { Text("添加新路由") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = newRoutePath,
                        onValueChange = { newRoutePath = it },
                        label = { Text("路由路径") },
                        placeholder = { Text("/api/example") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = newRouteMethod,
                        onValueChange = { newRouteMethod = it },
                        label = { Text("请求方法") },
                        modifier = Modifier.fillMaxWidth(),
                        readOnly = true,
                        trailingIcon = {
                            DropdownMenu(expanded = false, onDismissRequest = {}) {
                                methods.forEach {
                                    DropdownMenuItem(text = { Text(it) }, onClick = { newRouteMethod = it })
                                }
                            }
                        }
                    )
                    OutlinedTextField(
                        value = newRouteDesc,
                        onValueChange = { newRouteDesc = it },
                        label = { Text("描述（可选）") },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        if (newRoutePath.isNotBlank()) {
                            routes = routes + RouteInfo(newRoutePath, newRouteMethod, newRouteDesc, true, 0)
                            newRoutePath = ""
                            newRouteDesc = ""
                            showAddDialog = false
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD4A853))
                ) {
                    Text("添加")
                }
            },
            dismissButton = {
                TextButton(onClick = { showAddDialog = false }) {
                    Text("取消")
                }
            }
        )
    }
}

@Composable
fun RouteItem(route: RouteInfo, onToggle: () -> Unit, onDelete: () -> Unit) {
    val methodColor = when (route.method) {
        "GET" -> Color(0xFF61AFEF)
        "POST" -> Color(0xFF98C379)
        "PUT" -> Color(0xFFD19A66)
        "DELETE" -> Color(0xFFE06C75)
        "PATCH" -> Color(0xFFC678DD)
        else -> Color(0xFF8A8A80)
    }

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (route.enabled) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.surface.copy(alpha = 0.5f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Surface(
                        shape = RoundedCornerShape(4.dp),
                        color = methodColor,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                    ) {
                        Text(route.method, color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    }
                    Text(route.path, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Switch(
                        checked = route.enabled,
                        onCheckedChange = { onToggle() },
                        colors = SwitchDefaults.colors(checkedThumbColor = Color(0xFFD4A853))
                    )
                    IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Outlined.Delete, null, tint = Color(0xFFE06C75), modifier = Modifier.size(18.dp))
                    }
                }
            }
            if (route.description.isNotBlank()) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(route.description, color = Color(0xFF8A8A80), fontSize = 11.sp)
            }
            Spacer(modifier = Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("调用次数: ${route.hits}", color = Color(0xFF8A8A80), fontSize = 10.sp)
            }
        }
    }
}
