#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import { CommandLineParser } from './src/command-line.js';
import { serverDirectory } from './src/server-directory.js';

console.log(`Node version: ${process.version}. Running in ${process.env.NODE_ENV} environment. Server directory: ${serverDirectory}`);

// config.yaml will be set when parsing command line arguments
const cliArgs = new CommandLineParser().parse(process.argv);
globalThis.DATA_ROOT = cliArgs.dataRoot;
globalThis.COMMAND_LINE_ARGS = cliArgs;
process.chdir(serverDirectory);

// ==================== 酒馆主服务启动 ====================
// 使用异步方式启动酒馆主服务，避免阻塞插件桥接器
(async () => {
    try {
        await import('./src/server-main.js');
        console.log(`[SillyTavern] 主服务启动完成`);
    } catch (error) {
        console.error('A critical error has occurred while starting the server:', error);
    }
})();

// ==================== 插件桥接服务器（内嵌） ====================
// 功能：共享变量存储 + 事件总线 + WebSocket
// 替代原TTS代理（端口3001），解决两个插件之间的时序性问题
// 内存安全：LRU淘汰 + 定期清理 + 内存监控 + 错误隔离

try {
    const http = require('http');

    // 如果ws模块不可用，退化为纯HTTP模式（无WebSocket）
    let WebSocketServerImpl = null;
    try {
        WebSocketServerImpl = require('ws').WebSocketServer;
    } catch (e) {
        console.log('[PluginBridge] ws模块不可用，将以纯HTTP模式运行');
    }

    const PluginBridgeServer = {
        // ==================== 配置 ====================
        config: {
            port: 3001,
            maxVariables: 10000,          // 最大变量数
            maxEventQueue: 100,           // 每个订阅者最大事件队列
            maxConnections: 20,           // 最大WebSocket连接数
            maxRequestBodySize: 1048576,  // 1MB
            maxVarValueSize: 65536,       // 64KB per variable
            heartbeatInterval: 30000,     // 30秒心跳
            cleanupInterval: 60000,       // 60秒清理
            memoryCheckInterval: 30000,   // 30秒内存检查
            memoryThreshold: 0.8,         // 内存使用超过80%时触发清理
            defaultTTL: 0,                // 0=永不过期
            persistInterval: 30000,       // 30秒自动持久化
            persistFile: null             // 持久化文件路径（动态设置）
        },

        // ==================== 内部状态 ====================
        _store: new Map(),                // key -> {value, updatedAt, ttl, expiresAt}
        _accessOrder: [],                 // LRU追踪（最近访问的key在末尾）
        _persistPath: null,               // 持久化文件完整路径
        _persistDirty: false,             // 数据是否变更（需要保存）
        _persistEnabled: false,           // 持久化是否启用

        _subscriptions: new Map(),        // pattern -> Set<ws>
        _eventQueue: new Map(),           // ws -> [{event, data, timestamp}]

        _clients: new Set(),              // 活跃WebSocket连接
        _wsServer: null,                  // WebSocketServer实例
        _httpServer: null,                // HTTP服务器实例
        _isRunning: false,
        _actualPort: null,                // 实际监听的端口号

        _timers: {},                      // 定时器引用

        _stats: {
            startTime: Date.now(),
            totalRequests: 0,
            totalEvents: 0,
            totalVarReads: 0,
            totalVarWrites: 0,
            errors: 0
        },

        // ==================== 初始化与生命周期 ====================

        init: function () {
            try {
                // 注册全局异常处理，防止进程崩溃
                process.on('uncaughtException', function (err) {
                    console.error('[PluginBridge] uncaughtException:', err && err.message);
                    PluginBridgeServer._stats.errors++;
                });

                process.on('unhandledRejection', function (reason) {
                    console.error('[PluginBridge] unhandledRejection:', reason && reason.message || reason);
                    PluginBridgeServer._stats.errors++;
                });

                // [持久化] 初始化持久化
                this._initPersistence();

                console.log('[PluginBridge] 初始化完成');
                return true;
            } catch (err) {
                console.error('[PluginBridge] 初始化失败:', err && err.message);
                return false;
            }
        },

        // ==================== [持久化] 数据持久化层 ====================
        // [铁则一] 数据分层：按 domain:key 结构存储，与前端 DataStore 一致
        // [铁则九] 错误降级：持久化失败不阻断服务器启动和运行

        /**
         * 初始化持久化
         * 设置持久化文件路径，尝试加载已有数据
         */
        _initPersistence: function () {
            try {
                const path = require('path');
                const fs = require('fs');

                // 确定持久化文件路径
                // 优先使用 DATA_ROOT，否则使用当前目录
                const dataRoot = globalThis.DATA_ROOT || path.join(__dirname, '..', '..', 'data');
                this._persistPath = path.join(dataRoot, 'plugin-bridge-store.json');
                this.config.persistFile = this._persistPath;

                // 确保目录存在
                const dir = path.dirname(this._persistPath);
                if (!fs.existsSync(dir)) {
                    try {
                        fs.mkdirSync(dir, { recursive: true });
                    } catch (e) {
                        console.warn('[PluginBridge] 无法创建数据目录，持久化已禁用:', e.message);
                        return;
                    }
                }

                // 尝试加载已有数据
                this._loadFromDisk();

                // 启用持久化
                this._persistEnabled = true;

                // 注册进程退出时的保存
                this._registerExitHandlers();

                console.log('[PluginBridge] 持久化已启用:', this._persistPath);
            } catch (err) {
                // [铁则九] 错误降级：持久化失败不阻断
                console.warn('[PluginBridge] 持久化初始化失败，将以内存模式运行:', err.message);
                this._persistEnabled = false;
            }
        },

        /**
         * 从磁盘加载数据
         * [铁则一] 数据分层：保持 domain:key 结构
         */
        _loadFromDisk: function () {
            try {
                const fs = require('fs');

                if (!fs.existsSync(this._persistPath)) {
                    console.log('[PluginBridge] 持久化文件不存在，将创建新文件');
                    return;
                }

                const raw = fs.readFileSync(this._persistPath, 'utf8');
                if (!raw || raw.trim() === '') {
                    console.log('[PluginBridge] 持久化文件为空');
                    return;
                }

                const data = JSON.parse(raw);

                // 恢复数据到内存
                // [铁则一] 保持分层结构：data[domain][key] = entry
                if (data && typeof data === 'object') {
                    let count = 0;
                    for (const [domain, domainData] of Object.entries(data)) {
                        if (domainData && typeof domainData === 'object') {
                            for (const [key, entry] of Object.entries(domainData)) {
                                const fullKey = `${domain}.${key}`;
                                // 检查是否过期
                                if (entry.expiresAt && Date.now() > entry.expiresAt) {
                                    continue; // 跳过过期数据
                                }
                                this._store.set(fullKey, entry);
                                this._accessOrder.push(fullKey);
                                count++;
                            }
                        }
                    }
                    console.log(`[PluginBridge] 从磁盘恢复 ${count} 条数据`);
                }
            } catch (err) {
                // [铁则九] 错误降级：加载失败不阻断
                console.warn('[PluginBridge] 从磁盘加载数据失败:', err.message);
                // 清空可能损坏的数据
                this._store.clear();
                this._accessOrder = [];
            }
        },

        /**
         * 保存数据到磁盘
         * [铁则一] 数据分层：按 domain:key 结构序列化
         * [铁则九] 错误降级：保存失败不阻断运行
         */
        _saveToDisk: function () {
            if (!this._persistEnabled || !this._persistPath) {
                return false;
            }

            try {
                const fs = require('fs');
                const path = require('path');

                // [铁则一] 按 domain 分层组织数据
                // 结构: { domain1: { key1: entry1, key2: entry2 }, domain2: {...} }
                const data = {};
                const now = Date.now();

                for (const [fullKey, entry] of this._store.entries()) {
                    // 跳过过期数据
                    if (entry.expiresAt && now > entry.expiresAt) {
                        continue;
                    }

                    // 解析 domain 和 key
                    const firstDot = fullKey.indexOf('.');
                    if (firstDot === -1) continue;

                    const domain = fullKey.substring(0, firstDot);
                    const key = fullKey.substring(firstDot + 1);

                    if (!data[domain]) {
                        data[domain] = {};
                    }
                    data[domain][key] = entry;
                }

                // 原子写入：先写入临时文件，再重命名
                const tempPath = this._persistPath + '.tmp';
                fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
                fs.renameSync(tempPath, this._persistPath);

                this._persistDirty = false;
                return true;
            } catch (err) {
                // [铁则九] 错误降级：保存失败不阻断
                console.warn('[PluginBridge] 保存到磁盘失败:', err.message);
                return false;
            }
        },

        /**
         * 标记数据需要持久化
         */
        _markDirty: function () {
            this._persistDirty = true;
        },

        /**
         * 注册进程退出处理
         * 确保退出前保存数据
         */
        _registerExitHandlers: function () {
            const self = this;

            // 正常退出
            process.on('SIGINT', function () {
                console.log('[PluginBridge] 收到 SIGINT，正在保存数据...');
                self._saveToDisk();
            });

            process.on('SIGTERM', function () {
                console.log('[PluginBridge] 收到 SIGTERM，正在保存数据...');
                self._saveToDisk();
            });

            // 异常退出也尝试保存
            process.on('exit', function () {
                if (self._persistDirty) {
                    self._saveToDisk();
                }
            });
        },

        start: function () {
            try {
                if (this._isRunning) {
                    console.log('[PluginBridge] 服务器已在运行');
                    return;
                }

                if (!this.init()) {
                    console.error('[PluginBridge] 初始化失败，无法启动');
                    return;
                }

                var self = this;
                var portsToTry = [3001, 3002, 3003];
                var tryIndex = 0;

                function tryStart() {
                    if (tryIndex >= portsToTry.length) {
                        console.warn('[PluginBridge] 所有端口均被占用，桥接服务器启动失败');
                        console.warn('[PluginBridge] 这不会影响酒馆主服务的正常运行');
                        return;
                    }

                    var port = portsToTry[tryIndex];
                    self._checkPort(port).then(function(available) {
                        if (available) {
                            // 创建HTTP服务器
                            self._httpServer = http.createServer(function (req, res) {
                                self._handleRequest(req, res);
                            });

                            // WebSocket upgrade处理（仅当ws模块可用时）
                            if (WebSocketServerImpl) {
                                self._httpServer.on('upgrade', function (req, socket, head) {
                                    self._handleUpgrade(req, socket, head);
                                });
                            }

                            // 尝试监听端口
                            self._tryListen(self._httpServer, port).then(function(actualPort) {
                                self._isRunning = true;
                                self._stats.startTime = Date.now();
                                console.log('[PluginBridge] 服务器已启动，端口:', actualPort);
                                if (!WebSocketServerImpl) {
                                    console.log('[PluginBridge] 运行模式: 纯HTTP（无WebSocket）');
                                } else {
                                    console.log('[PluginBridge] 运行模式: HTTP + WebSocket');
                                }

                                // 启动定期清理定时器
                                self._timers.cleanup = setInterval(function () {
                                    self._cleanupExpired();
                                }, self.config.cleanupInterval);

                                // 启动内存监控定时器
                                self._timers.memoryCheck = setInterval(function () {
                                    self._checkMemory();
                                }, self.config.memoryCheckInterval);

                                // 启动心跳定时器（仅WebSocket模式）
                                if (WebSocketServerImpl) {
                                    self._timers.heartbeat = setInterval(function () {
                                        self._sendHeartbeat();
                                    }, self.config.heartbeatInterval);
                                }

                                // [持久化] 启动自动保存定时器
                                self._timers.persist = setInterval(function () {
                                    if (self._persistDirty && self._persistEnabled) {
                                        self._saveToDisk();
                                    }
                                }, self.config.persistInterval);

                                // 防止定时器阻止进程退出（如果作为库被引入时）
                                if (self._timers.cleanup) self._timers.cleanup.unref();
                                if (self._timers.memoryCheck) self._timers.memoryCheck.unref();
                                if (self._timers.heartbeat) self._timers.heartbeat.unref();
                                if (self._timers.persist) self._timers.persist.unref();
                            }).catch(function(err) {
                                console.log('[PluginBridge] 端口 ' + port + ' 被占用，尝试下一个...');
                                tryIndex++;
                                tryStart();
                            });
                        } else {
                            console.log('[PluginBridge] 端口 ' + port + ' 被占用，尝试下一个...');
                            tryIndex++;
                            tryStart();
                        }
                    });
                }

                tryStart();

            } catch (err) {
                console.error('[PluginBridge] 启动失败:', err && err.message);
                this._stats.errors++;
            }
        },

        stop: function () {
            try {
                // [持久化] 停止前强制保存数据
                if (this._persistDirty && this._persistEnabled) {
                    console.log('[PluginBridge] 正在保存数据...');
                    this._saveToDisk();
                }

                // 清除所有定时器
                var timers = this._timers;
                Object.keys(timers).forEach(function (key) {
                    if (timers[key]) {
                        clearInterval(timers[key]);
                        timers[key] = null;
                    }
                });

                // 关闭所有WebSocket连接
                if (this._clients) {
                    this._clients.forEach(function (ws) {
                        try {
                            ws.close(1001, 'Server shutting down');
                        } catch (e) {
                            // 忽略关闭错误
                        }
                    });
                    this._clients.clear();
                }

                // 关闭WebSocket服务器
                if (this._wsServer) {
                    try {
                        this._wsServer.close();
                    } catch (e) {
                        // 忽略
                    }
                    this._wsServer = null;
                }

                // 关闭HTTP服务器
                if (this._httpServer) {
                    try {
                        this._httpServer.close();
                    } catch (e) {
                        // 忽略
                    }
                    this._httpServer = null;
                }

                this._isRunning = false;
                console.log('[PluginBridge] 服务器已停止');
            } catch (err) {
                console.error('[PluginBridge] 停止时出错:', err && err.message);
            }
        },

        // ==================== 端口检测 ====================

        _checkPort: function(port) {
            var net = require('net');
            return new Promise(function(resolve) {
                var server = net.createServer();
                server.once('error', function(err) {
                    if (err.code === 'EADDRINUSE') {
                        resolve(false);
                    } else {
                        resolve(false);
                    }
                });
                server.once('listening', function() {
                    server.close();
                    resolve(true);
                });
                server.listen(port, '127.0.0.1');
            });
        },

        _tryListen: function(httpServer, port) {
            var self = this;
            return new Promise(function(resolve, reject) {
                httpServer.once('error', function(err) {
                    if (err.code === 'EADDRINUSE') {
                        reject(err);
                    } else {
                        reject(err);
                    }
                });
                httpServer.listen(port, '0.0.0.0', function() {
                    self._actualPort = port;
                    self.config.port = port;
                    resolve(port);
                });
            });
        },

        getActualPort: function() {
            return this._actualPort;
        },

        // ==================== 变量操作 ====================

        getVar: function (key) {
            try {
                if (typeof key !== 'string' || key.length === 0) {
                    return { error: '无效的key' };
                }

                var entry = this._store.get(key);
                if (!entry) {
                    return { error: '变量不存在', key: key };
                }

                // 检查是否过期
                if (entry.expiresAt && Date.now() > entry.expiresAt) {
                    this._store.delete(key);
                    this._removeFromAccessOrder(key);
                    return { error: '变量已过期', key: key };
                }

                // 更新LRU访问顺序
                this._touchAccessOrder(key);
                this._stats.totalVarReads++;

                return { value: entry.value, updatedAt: entry.updatedAt };
            } catch (err) {
                this._stats.errors++;
                return { error: '读取变量失败: ' + (err && err.message) };
            }
        },

        setVar: function (key, value, ttl) {
            try {
                if (typeof key !== 'string' || key.length === 0) {
                    return { error: '无效的key' };
                }

                // 检查值大小
                var valueStr = typeof value === 'string' ? value : JSON.stringify(value);
                if (valueStr && valueStr.length > this.config.maxVarValueSize) {
                    return { error: '变量值超过大小限制(64KB)' };
                }

                // 检查变量数量上限，必要时淘汰
                if (!this._store.has(key) && this._store.size >= this.config.maxVariables) {
                    this._evictLRU(1);
                }

                var now = Date.now();
                var effectiveTTL = (typeof ttl === 'number' && ttl > 0) ? ttl : this.config.defaultTTL;
                var expiresAt = effectiveTTL > 0 ? now + effectiveTTL : null;

                this._store.set(key, {
                    value: value,
                    updatedAt: now,
                    ttl: effectiveTTL,
                    expiresAt: expiresAt
                });

                this._touchAccessOrder(key);
                this._stats.totalVarWrites++;

                // [持久化] 标记数据变更
                this._markDirty();

                // 触发变量变更事件
                this.publish('var.changed', { key: key, value: value, updatedAt: now });

                return { success: true, key: key, updatedAt: now };
            } catch (err) {
                this._stats.errors++;
                return { error: '写入变量失败: ' + (err && err.message) };
            }
        },

        deleteVar: function (key) {
            try {
                if (typeof key !== 'string' || key.length === 0) {
                    return { error: '无效的key' };
                }

                var existed = this._store.delete(key);
                this._removeFromAccessOrder(key);

                if (existed) {
                    // [持久化] 标记数据变更
                    this._markDirty();

                    // 触发变量删除事件
                    this.publish('var.deleted', { key: key });
                    return { success: true, key: key };
                }

                return { error: '变量不存在', key: key };
            } catch (err) {
                this._stats.errors++;
                return { error: '删除变量失败: ' + (err && err.message) };
            }
        },

        batchGet: function (keys) {
            try {
                if (!Array.isArray(keys)) {
                    return { error: 'keys必须是数组' };
                }

                if (keys.length > 100) {
                    return { error: '批量读取最多支持100个key' };
                }

                var results = {};
                var self = this;

                keys.forEach(function (key) {
                    var result = self.getVar(key);
                    if (!result.error) {
                        results[key] = result.value;
                    }
                });

                return { values: results, count: Object.keys(results).length };
            } catch (err) {
                this._stats.errors++;
                return { error: '批量读取失败: ' + (err && err.message) };
            }
        },

        batchSet: function (vars) {
            try {
                if (!vars || typeof vars !== 'object') {
                    return { error: 'vars必须是对象' };
                }

                var keys = Object.keys(vars);
                if (keys.length > 100) {
                    return { error: '批量写入最多支持100个变量' };
                }

                // 检查变量数量上限，必要时淘汰
                var newKeys = keys.filter(function (k) { return !PluginBridgeServer._store.has(k); });
                if (this._store.size + newKeys.length > this.config.maxVariables) {
                    this._evictLRU(this._store.size + newKeys.length - this.config.maxVariables + 1);
                }

                var results = {};
                var self = this;

                keys.forEach(function (key) {
                    var result = self.setVar(key, vars[key]);
                    results[key] = result.error ? { error: result.error } : { success: true };
                });

                return { results: results, count: keys.length };
            } catch (err) {
                this._stats.errors++;
                return { error: '批量写入失败: ' + (err && err.message) };
            }
        },

        getByNamespace: function (ns) {
            try {
                if (typeof ns !== 'string' || ns.length === 0) {
                    return { error: '无效的命名空间' };
                }

                // 确保命名空间以.结尾
                var prefix = ns.endsWith('.') ? ns : ns + '.';
                var results = {};
                var now = Date.now();
                var self = this;

                this._store.forEach(function (entry, key) {
                    if (key.startsWith(prefix)) {
                        // 跳过过期变量
                        if (entry.expiresAt && now > entry.expiresAt) {
                            self._store.delete(key);
                            self._removeFromAccessOrder(key);
                            return;
                        }
                        results[key] = {
                            value: entry.value,
                            updatedAt: entry.updatedAt,
                            ttl: entry.ttl
                        };
                        self._touchAccessOrder(key);
                        self._stats.totalVarReads++;
                    }
                });

                return { namespace: ns, values: results, count: Object.keys(results).length };
            } catch (err) {
                this._stats.errors++;
                return { error: '查询命名空间失败: ' + (err && err.message) };
            }
        },

        // ==================== 事件操作 ====================

        publish: function (eventName, data) {
            try {
                if (typeof eventName !== 'string' || eventName.length === 0) {
                    return { error: '无效的事件名' };
                }

                this._stats.totalEvents++;

                // 限制data大小
                var dataStr = null;
                try {
                    dataStr = JSON.stringify(data);
                } catch (e) {
                    dataStr = String(data);
                }
                if (dataStr && dataStr.length > this.config.maxVarValueSize) {
                    return { error: '事件数据超过大小限制(64KB)' };
                }

                var self = this;
                var matched = false;

                // 遍历所有订阅，匹配通配符
                this._subscriptions.forEach(function (wsSet, pattern) {
                    if (self._matchPattern(pattern, eventName)) {
                        matched = true;
                        wsSet.forEach(function (ws) {
                            self._enqueueEvent(ws, eventName, data);
                        });
                    }
                });

                return { success: true, event: eventName, matched: matched };
            } catch (err) {
                this._stats.errors++;
                return { error: '发布事件失败: ' + (err && err.message) };
            }
        },

        subscribe: function (ws, pattern) {
            try {
                if (typeof pattern !== 'string' || pattern.length === 0) {
                    return { error: '无效的订阅模式' };
                }

                if (!this._subscriptions.has(pattern)) {
                    this._subscriptions.set(pattern, new Set());
                }
                this._subscriptions.get(pattern).add(ws);

                // 确保事件队列存在
                if (!this._eventQueue.has(ws)) {
                    this._eventQueue.set(ws, []);
                }

                return { success: true, pattern: pattern };
            } catch (err) {
                this._stats.errors++;
                return { error: '订阅失败: ' + (err && err.message) };
            }
        },

        unsubscribe: function (ws, pattern) {
            try {
                if (typeof pattern !== 'string' || pattern.length === 0) {
                    return { error: '无效的订阅模式' };
                }

                var wsSet = this._subscriptions.get(pattern);
                if (wsSet) {
                    wsSet.delete(ws);
                    // 如果没有订阅者了，删除整个pattern
                    if (wsSet.size === 0) {
                        this._subscriptions.delete(pattern);
                    }
                }

                return { success: true, pattern: pattern };
            } catch (err) {
                this._stats.errors++;
                return { error: '取消订阅失败: ' + (err && err.message) };
            }
        },

        // ==================== 内存安全 ====================

        _enforceLimits: function () {
            try {
                // 强制变量数量上限
                if (this._store.size > this.config.maxVariables) {
                    this._evictLRU(this._store.size - this.config.maxVariables);
                }

                // 清理空的事件队列（对应已断开的连接）
                var self = this;
                this._eventQueue.forEach(function (queue, ws) {
                    if (!self._clients.has(ws)) {
                        self._eventQueue.delete(ws);
                    }
                });

                // 清理无效的订阅
                this._subscriptions.forEach(function (wsSet, pattern) {
                    wsSet.forEach(function (ws) {
                        if (!self._clients.has(ws)) {
                            wsSet.delete(ws);
                        }
                    });
                    if (wsSet.size === 0) {
                        self._subscriptions.delete(pattern);
                    }
                });
            } catch (err) {
                this._stats.errors++;
            }
        },

        _cleanupExpired: function () {
            try {
                var now = Date.now();
                var self = this;
                var cleaned = 0;

                this._store.forEach(function (entry, key) {
                    if (entry.expiresAt && now > entry.expiresAt) {
                        self._store.delete(key);
                        self._removeFromAccessOrder(key);
                        cleaned++;
                    }
                });

                // 同时清理断开的连接和无效订阅
                this._enforceLimits();

                if (cleaned > 0) {
                    console.log('[PluginBridge] 清理了', cleaned, '个过期变量');
                }
            } catch (err) {
                this._stats.errors++;
            }
        },

        _checkMemory: function () {
            try {
                var memUsage = process.memoryUsage();
                var heapUsed = memUsage.heapUsed;
                var heapTotal = memUsage.heapTotal;
                var ratio = heapTotal > 0 ? heapUsed / heapTotal : 0;

                if (ratio > this.config.memoryThreshold) {
                    console.log('[PluginBridge] 内存使用过高 (' + Math.round(ratio * 100) + '%)，触发主动清理');
                    this._cleanupExpired();
                    this._enforceLimits();

                    // 如果仍然过高，强制淘汰更多变量
                    if (this._store.size > this.config.maxVariables * 0.5) {
                        var evictCount = Math.floor(this._store.size * 0.3);
                        console.log('[PluginBridge] 强制淘汰', evictCount, '个变量');
                        this._evictLRU(evictCount);
                    }

                    // 尝试触发GC（如果可用）
                    if (typeof global.gc === 'function') {
                        global.gc();
                    }
                }
            } catch (err) {
                this._stats.errors++;
            }
        },

        _evictLRU: function (count) {
            try {
                count = Math.min(count, this._accessOrder.length);
                for (var i = 0; i < count; i++) {
                    var oldestKey = this._accessOrder.shift();
                    if (oldestKey) {
                        this._store.delete(oldestKey);
                    }
                }
            } catch (err) {
                this._stats.errors++;
            }
        },

        _touchAccessOrder: function (key) {
            try {
                // 从当前位置移除
                var idx = this._accessOrder.indexOf(key);
                if (idx !== -1) {
                    this._accessOrder.splice(idx, 1);
                }
                // 添加到末尾（最近访问）
                this._accessOrder.push(key);
            } catch (err) {
                this._stats.errors++;
            }
        },

        _removeFromAccessOrder: function (key) {
            try {
                var idx = this._accessOrder.indexOf(key);
                if (idx !== -1) {
                    this._accessOrder.splice(idx, 1);
                }
            } catch (err) {
                this._stats.errors++;
            }
        },

        // ==================== 事件队列管理 ====================

        _enqueueEvent: function (ws, eventName, data) {
            try {
                if (!this._eventQueue.has(ws)) {
                    this._eventQueue.set(ws, []);
                }

                var queue = this._eventQueue.get(ws);

                // 如果队列已满，丢弃最旧的事件
                while (queue.length >= this.config.maxEventQueue) {
                    queue.shift();
                }

                queue.push({
                    event: eventName,
                    data: data,
                    timestamp: Date.now()
                });

                // 尝试立即发送
                this._flushEventQueue(ws);
            } catch (err) {
                this._stats.errors++;
            }
        },

        _flushEventQueue: function (ws) {
            try {
                if (ws.readyState !== 1) { // WebSocket.OPEN
                    return;
                }

                var queue = this._eventQueue.get(ws);
                if (!queue || queue.length === 0) {
                    return;
                }

                // 一次最多发送10条，避免阻塞
                var batch = queue.splice(0, 10);

                var message = JSON.stringify({
                    type: 'events',
                    events: batch
                });

                try {
                    ws.send(message);
                } catch (e) {
                    // 发送失败，放回队列
                    queue.unshift.apply(queue, batch);
                }
            } catch (err) {
                this._stats.errors++;
            }
        },

        // ==================== HTTP处理 ====================

        _handleRequest: function (req, res) {
            try {
                this._stats.totalRequests++;

                // CORS 支持（允许浏览器跨域请求）
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }

                // 请求体大小限制：通过检查Content-Length
                var contentLength = parseInt(req.headers['content-length'] || '0', 10);
                if (contentLength > this.config.maxRequestBodySize) {
                    this._sendError(res, '请求体过大', 413);
                    return;
                }

                // 解析URL路径
                var url;
                try {
                    url = new URL(req.url, 'http://localhost');
                } catch (e) {
                    this._sendError(res, '无效的URL', 400);
                    return;
                }

                var pathname = url.pathname;
                var method = req.method.toUpperCase();

                // 路由
                this._handleAPI(req, res, pathname, method);
            } catch (err) {
                this._stats.errors++;
                try {
                    this._sendError(res, '服务器内部错误', 500);
                } catch (e) {
                    // 忽略
                }
            }
        },

        _handleAPI: function (req, res, pathname, method) {
            var self = this;

            // 健康检查
            if (pathname === '/api/health' && method === 'GET') {
                this._sendJSON(res, { status: 'ok', timestamp: Date.now() });
                return;
            }

            // 服务器状态
            if (pathname === '/api/status' && method === 'GET') {
                this._sendJSON(res, this.getStatus());
                return;
            }

            // 变量操作路由
            if (pathname.startsWith('/api/var/')) {
                // 批量读取 GET /api/var/batch
                if (pathname === '/api/var/batch' && method === 'GET') {
                    this._parseBody(req, function (body) {
                        var keys = body && body.keys;
                        var result = self.batchGet(keys);
                        self._sendJSON(res, result, result.error ? 400 : 200);
                    });
                    return;
                }

                // 批量写入 POST /api/var/batch
                if (pathname === '/api/var/batch' && method === 'POST') {
                    this._parseBody(req, function (body) {
                        var vars = body && body.vars;
                        var result = self.batchSet(vars);
                        self._sendJSON(res, result, result.error ? 400 : 200);
                    });
                    return;
                }

                // 命名空间查询 GET /api/var/namespace/:ns
                var nsMatch = pathname.match(/^\/api\/var\/namespace\/(.+)$/);
                if (nsMatch && method === 'GET') {
                    var ns = decodeURIComponent(nsMatch[1]);
                    var result = self.getByNamespace(ns);
                    self._sendJSON(res, result, result.error ? 400 : 200);
                    return;
                }

                // 单个变量操作 /api/var/:key
                var varMatch = pathname.match(/^\/api\/var\/(.+)$/);
                if (varMatch) {
                    var key = decodeURIComponent(varMatch[1]);

                    if (method === 'GET') {
                        var result = self.getVar(key);
                        self._sendJSON(res, result, result.error ? 404 : 200);
                        return;
                    }

                    if (method === 'POST') {
                        self._parseBody(req, function (body) {
                            if (!body || body.value === undefined) {
                                self._sendError(res, '缺少value字段', 400);
                                return;
                            }
                            var result = self.setVar(key, body.value, body.ttl);
                            self._sendJSON(res, result, result.error ? 400 : 200);
                        });
                        return;
                    }

                    if (method === 'DELETE') {
                        var result = self.deleteVar(key);
                        self._sendJSON(res, result, result.error ? 404 : 200);
                        return;
                    }
                }
            }

            // 事件操作路由
            if (pathname.startsWith('/api/event/')) {
                // 发布事件 POST /api/event/:eventName
                var eventMatch = pathname.match(/^\/api\/event\/(.+)$/);
                if (eventMatch && method === 'POST') {
                    var eventName = decodeURIComponent(eventMatch[1]);
                    this._parseBody(req, function (body) {
                        var result = self.publish(eventName, body && body.data);
                        self._sendJSON(res, result, result.error ? 400 : 200);
                    });
                    return;
                }
            }

            // 列出订阅 GET /api/event/subscriptions
            if (pathname === '/api/event/subscriptions' && method === 'GET') {
                var subs = [];
                this._subscriptions.forEach(function (wsSet, pattern) {
                    subs.push({ pattern: pattern, subscribers: wsSet.size });
                });
                this._sendJSON(res, { subscriptions: subs, total: subs.length });
                return;
            }

            // PhoneEngine 状态上报 POST /api/engine/status
            if (pathname === '/api/engine/status' && method === 'POST') {
                this._parseBody(req, function (body) {
                    self._engineStatus = body;
                    self._engineStatusLastUpdate = Date.now();
                    self._sendJSON(res, { success: true, received: true });
                });
                return;
            }

            // PhoneEngine 状态查询 GET /api/engine/status
            if (pathname === '/api/engine/status' && method === 'GET') {
                var status = self._engineStatus || null;
                var lastUpdate = self._engineStatusLastUpdate || 0;
                self._sendJSON(res, {
                    hasReport: !!status,
                    lastUpdate: lastUpdate,
                    lastUpdateAgo: lastUpdate > 0 ? (Date.now() - lastUpdate) + 'ms ago' : 'never',
                    engine: status
                });
                return;
            }

            // ==================== AI API 代理路由（解决前端跨域问题）====================
            // AI 代理健康检查 GET /api/ai/proxy/health
            if (pathname === '/api/ai/proxy/health' && method === 'GET') {
                self._sendJSON(res, {
                    status: 'ok',
                    message: 'AI Proxy 路由就绪',
                    timestamp: new Date().toISOString()
                });
                return;
            }

            // AI API 代理 POST /api/ai/proxy
            if (pathname === '/api/ai/proxy' && method === 'POST') {
                self._parseBody(req, async function (body) {
                    try {
                        var baseUrl = body && body.baseUrl;
                        var apiKey = body && body.apiKey;
                        var model = body && body.model;
                        var messages = body && body.messages;
                        var max_tokens = body && body.max_tokens;
                        var temperature = body && body.temperature;

                        if (!baseUrl || !apiKey) {
                            self._sendJSON(res, {
                                error: '缺少必要参数',
                                message: 'baseUrl 和 apiKey 是必需的'
                            }, 400);
                            return;
                        }

                        // 智能拼接 URL
                        var url = baseUrl.replace(/\/$/, '');
                        var hasV1 = /\/v1$/i.test(url);
                        url = hasV1 ? url + '/chat/completions' : url + '/v1/chat/completions';

                        console.log('[AI Proxy] 代理请求到:', url);

                        var fetch = require('node-fetch');
                        var response = await fetch(url, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': 'Bearer ' + apiKey
                            },
                            body: JSON.stringify({
                                model: model || 'gpt-3.5-turbo',
                                messages: messages || [],
                                max_tokens: max_tokens || 500,
                                temperature: temperature !== undefined ? temperature : 0.7
                            })
                        });

                        if (!response.ok) {
                            var errorText = await response.text();
                            console.error('[AI Proxy] API 错误', response.status, errorText);
                            self._sendJSON(res, {
                                error: 'API 错误 ' + response.status,
                                detail: errorText
                            }, response.status);
                            return;
                        }

                        var data = await response.json();
                        self._sendJSON(res, data);
                    } catch (e) {
                        console.error('[AI Proxy] 代理请求失败:', e);
                        self._sendJSON(res, {
                            error: '代理请求失败',
                            message: e && e.message
                        }, 500);
                    }
                });
                return;
            }

            // 未找到路由
            this._sendError(res, '未找到路由: ' + method + ' ' + pathname, 404);
        },

        // ==================== WebSocket处理 ====================

        _handleUpgrade: function (req, socket, head) {
            try {
                // 检查连接数上限
                if (this._clients.size >= this.config.maxConnections) {
                    console.log('[PluginBridge] WebSocket连接数已达上限，拒绝连接');
                    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
                    socket.destroy();
                    return;
                }

                if (!this._wsServer) {
                    // 延迟创建WebSocketServer，确保在upgrade时才初始化
                    this._wsServer = new WebSocketServerImpl({ noServer: true });
                    var self = this;

                    this._wsServer.on('connection', function (ws) {
                        self._clients.add(ws);
                        self._eventQueue.set(ws, []);
                        console.log('[PluginBridge] WebSocket客户端已连接，当前连接数:', self._clients.size);

                        ws.on('message', function (message) {
                            self._handleWSMessage(ws, message);
                        });

                        ws.on('close', function () {
                            self._handleWSClose(ws);
                        });

                        ws.on('error', function (err) {
                            console.error('[PluginBridge] WebSocket错误:', err && err.message);
                            self._stats.errors++;
                            self._handleWSClose(ws);
                        });

                        // 发送欢迎消息
                        try {
                            ws.send(JSON.stringify({
                                type: 'connected',
                                timestamp: Date.now(),
                                serverInfo: {
                                    maxConnections: self.config.maxConnections,
                                    maxEventQueue: self.config.maxEventQueue,
                                    heartbeatInterval: self.config.heartbeatInterval
                                }
                            }));
                        } catch (e) {
                            // 忽略
                        }
                    });
                }

                this._wsServer.handleUpgrade(req, socket, head, function (ws) {
                    this._wsServer.emit('connection', ws, req);
                }.bind(this));
            } catch (err) {
                this._stats.errors++;
                console.error('[PluginBridge] WebSocket upgrade失败:', err && err.message);
                try {
                    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                    socket.destroy();
                } catch (e) {
                    // 忽略
                }
            }
        },

        _handleWSMessage: function (ws, message) {
            try {
                var data;
                try {
                    data = JSON.parse(message.toString('utf8'));
                } catch (e) {
                    try {
                        ws.send(JSON.stringify({ type: 'error', message: '无效的JSON' }));
                    } catch (sendErr) {
                        // 忽略
                    }
                    return;
                }

                var type = data.type;

                if (type === 'subscribe') {
                    // 订阅事件
                    var patterns = data.patterns;
                    if (!Array.isArray(patterns)) {
                        patterns = [data.pattern];
                    }
                    var self = this;
                    var subscribed = [];
                    patterns.forEach(function (p) {
                        if (typeof p === 'string' && p.length > 0) {
                            self.subscribe(ws, p);
                            subscribed.push(p);
                        }
                    });
                    try {
                        ws.send(JSON.stringify({ type: 'subscribed', patterns: subscribed }));
                    } catch (e) {
                        // 忽略
                    }
                    return;
                }

                if (type === 'unsubscribe') {
                    // 取消订阅
                    var patterns = data.patterns;
                    if (!Array.isArray(patterns)) {
                        patterns = [data.pattern];
                    }
                    var self = this;
                    patterns.forEach(function (p) {
                        if (typeof p === 'string') {
                            self.unsubscribe(ws, p);
                        }
                    });
                    try {
                        ws.send(JSON.stringify({ type: 'unsubscribed' }));
                    } catch (e) {
                        // 忽略
                    }
                    return;
                }

                if (type === 'publish') {
                    // 通过WebSocket发布事件
                    var result = this.publish(data.event, data.data);
                    try {
                        ws.send(JSON.stringify({ type: 'published', result: result }));
                    } catch (e) {
                        // 忽略
                    }
                    return;
                }

                if (type === 'get') {
                    // 通过WebSocket读取变量
                    var result = this.getVar(data.key);
                    try {
                        ws.send(JSON.stringify({ type: 'var', key: data.key, result: result }));
                    } catch (e) {
                        // 忽略
                    }
                    return;
                }

                if (type === 'set') {
                    // 通过WebSocket写入变量
                    var result = this.setVar(data.key, data.value, data.ttl);
                    try {
                        ws.send(JSON.stringify({ type: 'var_set', result: result }));
                    } catch (e) {
                        // 忽略
                    }
                    return;
                }

                if (type === 'ping') {
                    // 心跳响应
                    try {
                        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                    } catch (e) {
                        // 忽略
                    }
                    return;
                }

                if (type === 'status') {
                    // 状态查询
                    try {
                        ws.send(JSON.stringify({ type: 'status', data: this.getStatus() }));
                    } catch (e) {
                        // 忽略
                    }
                    return;
                }

                // 未知消息类型
                try {
                    ws.send(JSON.stringify({ type: 'error', message: '未知的消息类型: ' + type }));
                } catch (e) {
                    // 忽略
                }
            } catch (err) {
                this._stats.errors++;
            }
        },

        _handleWSClose: function (ws) {
            try {
                this._clients.delete(ws);

                // 清理该连接的订阅
                var self = this;
                this._subscriptions.forEach(function (wsSet, pattern) {
                    wsSet.delete(ws);
                    if (wsSet.size === 0) {
                        self._subscriptions.delete(pattern);
                    }
                });

                // 清理事件队列
                this._eventQueue.delete(ws);

                console.log('[PluginBridge] WebSocket客户端断开，当前连接数:', this._clients.size);
            } catch (err) {
                this._stats.errors++;
            }
        },

        _sendHeartbeat: function () {
            try {
                if (!this._clients || this._clients.size === 0) {
                    return;
                }

                var self = this;
                var disconnected = [];

                this._clients.forEach(function (ws) {
                    try {
                        if (ws.readyState === 1) { // OPEN
                            ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
                        } else {
                            disconnected.push(ws);
                        }
                    } catch (e) {
                        disconnected.push(ws);
                    }
                });

                // 清理断开的连接
                disconnected.forEach(function (ws) {
                    self._handleWSClose(ws);
                });
            } catch (err) {
                this._stats.errors++;
            }
        },

        // ==================== 工具方法 ====================

        _parseBody: function (req, callback) {
            try {
                var chunks = [];
                var size = 0;
                var maxSize = this.config.maxRequestBodySize;

                req.on('data', function (chunk) {
                    size += chunk.length;
                    if (size > maxSize) {
                        // 超过大小限制，停止读取
                        chunks = null;
                        return;
                    }
                    if (chunks) {
                        chunks.push(chunk);
                    }
                });

                req.on('end', function () {
                    if (!chunks) {
                        callback(null);
                        return;
                    }

                    var body;
                    try {
                        var raw = Buffer.concat(chunks).toString('utf8');
                        body = raw.length > 0 ? JSON.parse(raw) : {};
                    } catch (e) {
                        body = {};
                    }
                    callback(body);
                });

                req.on('error', function () {
                    callback(null);
                });
            } catch (err) {
                callback(null);
            }
        },

        _sendJSON: function (res, data, statusCode) {
            try {
                statusCode = statusCode || 200;
                res.writeHead(statusCode, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'X-Powered-By': 'PluginBridge'
                });
                res.end(JSON.stringify(data));
            } catch (err) {
                this._stats.errors++;
            }
        },

        _sendError: function (res, message, statusCode) {
            try {
                statusCode = statusCode || 500;
                res.writeHead(statusCode, {
                    'Content-Type': 'application/json; charset=utf-8'
                });
                res.end(JSON.stringify({ error: message }));
            } catch (err) {
                this._stats.errors++;
            }
        },

        _matchPattern: function (pattern, eventName) {
            try {
                // 支持通配符 * 匹配（仅支持末尾通配符如 quest.*）
                if (pattern === eventName) {
                    return true;
                }

                if (pattern.endsWith('.*')) {
                    var prefix = pattern.slice(0, -1); // 去掉 *，保留 .
                    return eventName.startsWith(prefix);
                }

                // 支持 * 在中间，如 quest.*.update
                if (pattern.indexOf('*') !== -1) {
                    var regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$';
                    try {
                        var regex = new RegExp(regexStr);
                        return regex.test(eventName);
                    } catch (e) {
                        return false;
                    }
                }

                return false;
            } catch (err) {
                return false;
            }
        },

        getStatus: function () {
            try {
                var memUsage = process.memoryUsage();
                var uptime = Date.now() - this._stats.startTime;

                return {
                    server: 'PluginBridge',
                    version: '1.0.0',
                    running: this._isRunning,
                    uptime: uptime,
                    uptimeFormatted: this._formatUptime(uptime),
                    config: {
                        port: this.config.port,
                        maxVariables: this.config.maxVariables,
                        maxConnections: this.config.maxConnections,
                        maxEventQueue: this.config.maxEventQueue,
                        heartbeatInterval: this.config.heartbeatInterval
                    },
                    stats: {
                        totalRequests: this._stats.totalRequests,
                        totalEvents: this._stats.totalEvents,
                        totalVarReads: this._stats.totalVarReads,
                        totalVarWrites: this._stats.totalVarWrites,
                        errors: this._stats.errors
                    },
                    memory: {
                        heapUsed: memUsage.heapUsed,
                        heapTotal: memUsage.heapTotal,
                        heapUsedMB: Math.round(memUsage.heapUsed / 1048576 * 100) / 100,
                        heapTotalMB: Math.round(memUsage.heapTotal / 1048576 * 100) / 100,
                        rss: memUsage.rss,
                        rssMB: Math.round(memUsage.rss / 1048576 * 100) / 100,
                        heapUsageRatio: memUsage.heapTotal > 0
                            ? Math.round(memUsage.heapUsed / memUsage.heapTotal * 100) / 100
                            : 0
                    },
                    resources: {
                        variables: this._store.size,
                        connections: this._clients ? this._clients.size : 0,
                        subscriptions: this._subscriptions.size,
                        pendingEvents: this._countPendingEvents()
                    },
                    mode: WebSocketServerImpl ? 'HTTP+WebSocket' : 'HTTP-only'
                };
            } catch (err) {
                return { error: '获取状态失败: ' + (err && err.message) };
            }
        },

        _formatUptime: function (ms) {
            try {
                var seconds = Math.floor(ms / 1000);
                var minutes = Math.floor(seconds / 60);
                var hours = Math.floor(minutes / 60);
                var days = Math.floor(hours / 24);

                seconds = seconds % 60;
                minutes = minutes % 60;
                hours = hours % 24;

                var parts = [];
                if (days > 0) parts.push(days + 'd');
                if (hours > 0) parts.push(hours + 'h');
                if (minutes > 0) parts.push(minutes + 'm');
                parts.push(seconds + 's');

                return parts.join(' ');
            } catch (err) {
                return 'unknown';
            }
        },

        _countPendingEvents: function () {
            try {
                var total = 0;
                this._eventQueue.forEach(function (queue) {
                    total += queue.length;
                });
                return total;
            } catch (err) {
                return 0;
            }
        }
    };

    // 直接启动插件桥接服务器
    PluginBridgeServer.start();

} catch (error) {
    console.warn('[PluginBridge] 插件桥接器加载失败，跳过:', error.message);
    console.warn('[PluginBridge] 这不会影响酒馆主服务的正常运行');
}
