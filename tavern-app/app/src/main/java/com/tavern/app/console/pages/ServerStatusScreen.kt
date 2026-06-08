package com.tavern.app.console.pages

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tavern.app.console.ConsoleViewModel
import com.tavern.app.node.NodeState
import com.tavern.app.node.NodeRunner
import com.tavern.app.util.AssetExtractor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun ServerStatusScreen(
    viewModel: ConsoleViewModel,
    onBack: () -> Unit
) {
    val state by viewModel.nodeState.collectAsState()
    val port by viewModel.nodePort.collectAsState()
    val isRunning = state == NodeState.State.RUNNING
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var isRestarting by remember { mutableStateOf(false) }

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(modifier = Modifier.fillMaxSize().padding(20.dp)) {
            TextButton(onClick = onBack) {
                Text("← 返回", color = Color(0xFFD4A853), fontSize = 15.sp)
            }
            Spacer(modifier = Modifier.height(24.dp))
            Text("服务器状态", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
            Spacer(modifier = Modifier.height(24.dp))

            // Status indicator card
            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(20.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(16.dp)
                            .clip(CircleShape)
                            .background(if (isRunning) Color(0xFF5AA87A) else Color(0xFFCC4455))
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            if (isRunning) "运行中" else "已停止",
                            color = MaterialTheme.colorScheme.onBackground,
                            fontSize = 20.sp,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            if (isRunning) "服务器正在正常运行" else "服务器当前未启动",
                            color = Color(0xFF8A8A80),
                            fontSize = 13.sp
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Info card
            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Column {
                    InfoRow(icon = Icons.Outlined.Lan, label = "端口", value = port.toString())
                    InfoRow(icon = Icons.Outlined.Language, label = "地址", value = "127.0.0.1:$port")
                    InfoRow(icon = Icons.Outlined.Info, label = "Node版本", value = "v18.20.4")
                    InfoRow(
                        icon = if (isRunning) Icons.Outlined.CheckCircle else Icons.Outlined.Warning,
                        label = "服务状态",
                        value = state.name
                    )
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            // Restart button
            Button(
                onClick = {
                    isRestarting = true
                    scope.launch {
                        try {
                            val nodeRunner = NodeRunner(context)
                            if (isRunning) {
                                nodeRunner.stop()
                            }
                            // Wait a bit for node to stop
                            kotlinx.coroutines.delay(1000)
                            // Restart - we would need to trigger the same flow as MainActivity.startTavern()
                            // For now, let's just set the state and inform user to restart app
                            withContext(Dispatchers.Main) {
                                android.widget.Toast.makeText(
                                    context,
                                    "请重启APP以应用新端口设置",
                                    android.widget.Toast.LENGTH_LONG
                                ).show()
                            }
                        } finally {
                            isRestarting = false
                        }
                    }
                },
                enabled = !isRestarting,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD4A853)),
                modifier = Modifier.fillMaxWidth()
            ) {
                if (isRestarting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        color = Color.White,
                        strokeWidth = 2.dp
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("正在重启…")
                } else {
                    Icon(Icons.Outlined.Refresh, null, modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(if (isRunning) "重启服务" else "启动服务")
                }
            }
        }
    }
}

@Composable
private fun InfoRow(icon: ImageVector, label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = Color(0xFFD4A853),
            modifier = Modifier.size(22.dp)
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(label, color = Color(0xFF8A8A80), fontSize = 14.sp, modifier = Modifier.weight(1f))
        Text(value, color = MaterialTheme.colorScheme.onBackground, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}
