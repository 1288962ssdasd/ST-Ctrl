/**
 * PluginBridge Server - 插件桥接服务器
 * 功能：共享变量存储 + 事件总线 + WebSocket + AI API 代理
 * 内嵌于 SillyTavern，替代原 TTS 代理（端口3001）
 */

'use strict';

const http = require('http');

// 如果ws模块不可用，退化为纯HTTP模式
let WebSocketServerImpl = null;
try {
    WebSocketServerImpl = require('ws').WebSocketServer;
} catch (e) {
    console.log('[PluginBridge] ws模块不可用，将以纯HTTP模式运行');
}

const PluginBridgeServer = {
    config: {
        port: 3001,
        maxVariables: 10000,
        maxEventQueue: 100,
        maxConnections: 20,
        maxRequestBodySize: 1048576,
        maxVarValueSize: 65536,
        heartbeatInterval: 30000,
        cleanupInterval: 60000,
        memoryCheckInterval: 30000,
        memoryThreshold: 0.8,
        defaultTTL: 0,
        persistInterval: 30000,
        persistFile: null
    },

    _store: new Map(),
    _accessOrder: [],
    _persistPath: null,
    _persistDirty: false,
    _persistEnabled: false,
    _subscriptions: new Map(),
    _eventQueue: new Map(),
    _clients: new Set(),
    _wsServer: null,
    _httpServer: null,
    _isRunning: false,
    _actualPort: null,
    _timers: {},
    _stats: {
        startTime: Date.now(),
        totalRequests: 0,
        totalEvents: 0,
        totalVarReads: 0,
        totalVarWrites: 0,
        errors: 0
    },

    init: function () {
        try {
            process.on('uncaughtException', (err) => {
                console.error('[PluginBridge] uncaughtException:', err && err.message);
                this._stats.errors++;
            });
            process.on('unhandledRejection', (reason) => {
                console.error('[PluginBridge] unhandledRejection:', reason && reason.message || reason);
                this._stats.errors++;
            });
            this._initPersistence();
            console.log('[PluginBridge] 初始化完成');
            return true;
        } catch (err) {
            console.error('[PluginBridge] 初始化失败:', err && err.message);
            return false;
        }
    },

    _initPersistence: function () {
        try {
            const path = require('path');
            const fs = require('fs');
            const dataRoot = globalThis.DATA_ROOT || path.join(__dirname, '..', '..', 'data');
            this._persistPath = path.join(dataRoot, 'plugin-bridge-store.json');
            this.config.persistFile = this._persistPath;
            const dir = path.dirname(this._persistPath);
            if (!fs.existsSync(dir)) {
                try {
                    fs.mkdirSync(dir, { recursive: true });
                } catch (e) {
                    console.warn('[PluginBridge] 无法创建数据目录，持久化已禁用:', e.message);
                    return;
                }
            }
            this._loadFromDisk();
            this._persistEnabled = true;
            this._registerExitHandlers();
            console.log('[PluginBridge] 持久化已启用:', this._persistPath);
        } catch (err) {
            console.warn('[PluginBridge] 持久化初始化失败，将以内存模式运行:', err.message);
            this._persistEnabled = false;
        }
    },

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
            if (data && typeof data === 'object') {
                let count = 0;
                for (const [domain, domainData] of Object.entries(data)) {
                    if (domainData && typeof domainData === 'object') {
                        for (const [key, entry] of Object.entries(domainData)) {
                            const fullKey = `${domain}.${key}`;
                            if (entry.expiresAt && Date.now() > entry.expiresAt) continue;
                            this._store.set(fullKey, entry);
                            this._accessOrder.push(fullKey);
                            count++;
                        }
                    }
                }
                console.log(`[PluginBridge] 从磁盘恢复 ${count} 条数据`);
            }
        } catch (err) {
            console.warn('[PluginBridge] 从磁盘加载数据失败:', err.message);
            this._store.clear();
            this._accessOrder = [];
        }
    },

    _saveToDisk: function () {
        if (!this._persistEnabled || !this._persistPath) return false;
        try {
            const fs = require('fs');
            const path = require('path');
            const data = {};
            const now = Date.now();
            for (const [fullKey, entry] of this._store.entries()) {
                if (entry.expiresAt && now > entry.expiresAt) continue;
                const firstDot = fullKey.indexOf('.');
                if (firstDot === -1) continue;
                const domain = fullKey.substring(0, firstDot);
                const key = fullKey.substring(firstDot + 1);
                if (!data[domain]) data[domain] = {};
                data[domain][key] = entry;
            }
            const tempPath = this._persistPath + '.tmp';
            fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tempPath, this._persistPath);
            this._persistDirty = false;
            return true;
        } catch (err) {
            console.warn('[PluginBridge] 保存到磁盘失败:', err.message);
            return false;
        }
    },

    _markDirty: function () {
        this._persistDirty = true;
    },

    _registerExitHandlers: function () {
        const self = this;
        process.on('SIGINT', () => { self._saveToDisk(); });
        process.on('SIGTERM', () => { self._saveToDisk(); });
        process.on('exit', () => { if (self._persistDirty) self._saveToDisk(); });
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
            const self = this;
            const portsToTry = [3001, 3002, 3003];
            let tryIndex = 0;

            function tryStart() {
                if (tryIndex >= portsToTry.length) {
                    console.warn('[PluginBridge] 所有端口均被占用，桥接服务器启动失败');
                    return;
                }
                const port = portsToTry[tryIndex];
                self._checkPort(port).then((available) => {
                    if (available) {
                        self._httpServer = http.createServer((req, res) => {
                            self._handleRequest(req, res);
                        });
                        if (WebSocketServerImpl) {
                            self._httpServer.on('upgrade', (req, socket, head) => {
                                self._handleUpgrade(req, socket, head);
                            });
                        }
                        self._tryListen(self._httpServer, port).then((actualPort) => {
                            self._isRunning = true;
                            self._stats.startTime = Date.now();
                            console.log('[PluginBridge] 服务器已启动，端口:', actualPort);
                            self._timers.cleanup = setInterval(() => self._cleanupExpired(), self.config.cleanupInterval);
                            self._timers.memoryCheck = setInterval(() => self._checkMemory(), self.config.memoryCheckInterval);
                            if (WebSocketServerImpl) {
                                self._timers.heartbeat = setInterval(() => self._sendHeartbeat(), self.config.heartbeatInterval);
                            }
                            self._timers.persist = setInterval(() => {
                                if (self._persistDirty && self._persistEnabled) self._saveToDisk();
                            }, self.config.persistInterval);
                            if (self._timers.cleanup) self._timers.cleanup.unref();
                            if (self._timers.memoryCheck) self._timers.memoryCheck.unref();
                            if (self._timers.heartbeat) self._timers.heartbeat.unref();
                            if (self._timers.persist) self._timers.persist.unref();
                        }).catch(() => {
                            tryIndex++;
                            tryStart();
                        });
                    } else {
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
            if (this._persistDirty && this._persistEnabled) this._saveToDisk();
            Object.keys(this._timers).forEach((key) => {
                if (this._timers[key]) {
                    clearInterval(this._timers[key]);
                    this._timers[key] = null;
                }
            });
            if (this._clients) {
                this._clients.forEach((ws) => {
                    try { ws.close(1001, 'Server shutting down'); } catch (e) {}
                });
                this._clients.clear();
            }
            if (this._wsServer) { try { this._wsServer.close(); } catch (e) {} this._wsServer = null; }
            if (this._httpServer) { try { this._httpServer.close(); } catch (e) {} this._httpServer = null; }
            this._isRunning = false;
            console.log('[PluginBridge] 服务器已停止');
        } catch (err) {
            console.error('[PluginBridge] 停止时出错:', err && err.message);
        }
    },

    _checkPort: function(port) {
        const net = require('net');
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => { server.close(); resolve(true); });
            server.listen(port, '127.0.0.1');
        });
    },

    _tryListen: function(httpServer, port) {
        const self = this;
        return new Promise((resolve, reject) => {
            httpServer.once('error', (err) => { if (err.code === 'EADDRINUSE') reject(err); else reject(err); });
            httpServer.listen(port, '0.0.0.0', () => {
                self._actualPort = port;
                self.config.port = port;
                resolve(port);
            });
        });
    },

    getVar: function (key) {
        try {
            if (typeof key !== 'string' || key.length === 0) return { error: '无效的key' };
            const entry = this._store.get(key);
            if (!entry) return { error: '变量不存在', key: key };
            if (entry.expiresAt && Date.now() > entry.expiresAt) {
                this._store.delete(key);
                this._removeFromAccessOrder(key);
                return { error: '变量已过期', key: key };
            }
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
            if (typeof key !== 'string' || key.length === 0) return { error: '无效的key' };
            const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
            if (valueStr && valueStr.length > this.config.maxVarValueSize) return { error: '变量值超过大小限制(64KB)' };
            if (!this._store.has(key) && this._store.size >= this.config.maxVariables) this._evictLRU(1);
            const now = Date.now();
            const effectiveTTL = (typeof ttl === 'number' && ttl > 0) ? ttl : this.config.defaultTTL;
            const expiresAt = effectiveTTL > 0 ? now + effectiveTTL : null;
            this._store.set(key, { value: value, updatedAt: now, ttl: effectiveTTL, expiresAt: expiresAt });
            this._touchAccessOrder(key);
            this._stats.totalVarWrites++;
            this._markDirty();
            this.publish('var.changed', { key: key, value: value, updatedAt: now });
            return { success: true, key: key, updatedAt: now };
        } catch (err) {
            this._stats.errors++;
            return { error: '写入变量失败: ' + (err && err.message) };
        }
    },

    deleteVar: function (key) {
        try {
            if (typeof key !== 'string' || key.length === 0) return { error: '无效的key' };
            const existed = this._store.delete(key);
            this._removeFromAccessOrder(key);
            if (existed) {
                this._markDirty();
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
            if (!Array.isArray(keys)) return { error: 'keys必须是数组' };
            if (keys.length > 100) return { error: '批量读取最多支持100个key' };
            const results = {};
            keys.forEach((key) => {
                const result = this.getVar(key);
                if (!result.error) results[key] = result.value;
            });
            return { values: results, count: Object.keys(results).length };
        } catch (err) {
            this._stats.errors++;
            return { error: '批量读取失败: ' + (err && err.message) };
        }
    },

    batchSet: function (vars) {
        try {
            if (!vars || typeof vars !== 'object') return { error: 'vars必须是对象' };
            const keys = Object.keys(vars);
            if (keys.length > 100) return { error: '批量写入最多支持100个变量' };
            const newKeys = keys.filter((k) => !this._store.has(k));
            if (this._store.size + newKeys.length > this.config.maxVariables) {
                this._evictLRU(this._store.size + newKeys.length - this.config.maxVariables + 1);
            }
            const results = {};
            keys.forEach((key) => {
                const result = this.setVar(key, vars[key]);
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
            if (typeof ns !== 'string' || ns.length === 0) return { error: '无效的命名空间' };
            const prefix = ns.endsWith('.') ? ns : ns + '.';
            const results = {};
            const now = Date.now();
            this._store.forEach((entry, key) => {
                if (key.startsWith(prefix)) {
                    if (entry.expiresAt && now > entry.expiresAt) {
                        this._store.delete(key);
                        this._removeFromAccessOrder(key);
                        return;
                    }
                    results[key] = { value: entry.value, updatedAt: entry.updatedAt, ttl: entry.ttl };
                    this._touchAccessOrder(key);
                    this._stats.totalVarReads++;
                }
            });
            return { namespace: ns, values: results, count: Object.keys(results).length };
        } catch (err) {
            this._stats.errors++;
            return { error: '查询命名空间失败: ' + (err && err.message) };
        }
    },

    publish: function (eventName, data) {
        try {
            if (typeof eventName !== 'string' || eventName.length === 0) return { error: '无效的事件名' };
            this._stats.totalEvents++;
            let dataStr = null;
            try { dataStr = JSON.stringify(data); } catch (e) { dataStr = String(data); }
            if (dataStr && dataStr.length > this.config.maxVarValueSize) return { error: '事件数据超过大小限制(64KB)' };
            let matched = false;
            this._subscriptions.forEach((wsSet, pattern) => {
                if (this._matchPattern(pattern, eventName)) {
                    matched = true;
                    wsSet.forEach((ws) => this._enqueueEvent(ws, eventName, data));
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
            if (typeof pattern !== 'string' || pattern.length === 0) return { error: '无效的订阅模式' };
            if (!this._subscriptions.has(pattern)) this._subscriptions.set(pattern, new Set());
            this._subscriptions.get(pattern).add(ws);
            if (!this._eventQueue.has(ws)) this._eventQueue.set(ws, []);
            return { success: true, pattern: pattern };
        } catch (err) {
            this._stats.errors++;
            return { error: '订阅失败: ' + (err && err.message) };
        }
    },

    unsubscribe: function (ws, pattern) {
        try {
            if (typeof pattern !== 'string' || pattern.length === 0) return { error: '无效的订阅模式' };
            const wsSet = this._subscriptions.get(pattern);
            if (wsSet) {
                wsSet.delete(ws);
                if (wsSet.size === 0) this._subscriptions.delete(pattern);
            }
            return { success: true, pattern: pattern };
        } catch (err) {
            this._stats.errors++;
            return { error: '取消订阅失败: ' + (err && err.message) };
        }
    },

    _enforceLimits: function () {
        try {
            if (this._store.size > this.config.maxVariables) this._evictLRU(this._store.size - this.config.maxVariables);
            this._eventQueue.forEach((queue, ws) => { if (!this._clients.has(ws)) this._eventQueue.delete(ws); });
            this._subscriptions.forEach((wsSet, pattern) => {
                wsSet.forEach((ws) => { if (!this._clients.has(ws)) wsSet.delete(ws); });
                if (wsSet.size === 0) this._subscriptions.delete(pattern);
            });
        } catch (err) {
            this._stats.errors++;
        }
    },

    _cleanupExpired: function () {
        try {
            const now = Date.now();
            let cleaned = 0;
            this._store.forEach((entry, key) => {
                if (entry.expiresAt && now > entry.expiresAt) {
                    this._store.delete(key);
                    this._removeFromAccessOrder(key);
                    cleaned++;
                }
            });
            this._enforceLimits();
            if (cleaned > 0) console.log('[PluginBridge] 清理了', cleaned, '个过期变量');
        } catch (err) {
            this._stats.errors++;
        }
    },

    _checkMemory: function () {
        try {
            const memUsage = process.memoryUsage();
            const heapUsed = memUsage.heapUsed;
            const heapTotal = memUsage.heapTotal;
            const ratio = heapTotal > 0 ? heapUsed / heapTotal : 0;
            if (ratio > this.config.memoryThreshold) {
                console.log('[PluginBridge] 内存使用过高 (' + Math.round(ratio * 100) + '%)，触发主动清理');
                this._cleanupExpired();
                this._enforceLimits();
                if (this._store.size > this.config.maxVariables * 0.5) {
                    const evictCount = Math.floor(this._store.size * 0.3);
                    console.log('[PluginBridge] 强制淘汰', evictCount, '个变量');
                    this._evictLRU(evictCount);
                }
                if (typeof global.gc === 'function') global.gc();
            }
        } catch (err) {
            this._stats.errors++;
        }
    },

    _evictLRU: function (count) {
        try {
            count = Math.min(count, this._accessOrder.length);
            for (let i = 0; i < count; i++) {
                const oldestKey = this._accessOrder.shift();
                if (oldestKey) this._store.delete(oldestKey);
            }
        } catch (err) {
            this._stats.errors++;
        }
    },

    _touchAccessOrder: function (key) {
        try {
            const idx = this._accessOrder.indexOf(key);
            if (idx !== -1) this._accessOrder.splice(idx, 1);
            this._accessOrder.push(key);
        } catch (err) {
            this._stats.errors++;
        }
    },

    _removeFromAccessOrder: function (key) {
        try {
            const idx = this._accessOrder.indexOf(key);
            if (idx !== -1) this._accessOrder.splice(idx, 1);
        } catch (err) {
            this._stats.errors++;
        }
    },

    _enqueueEvent: function (ws, eventName, data) {
        try {
            if (!this._eventQueue.has(ws)) this._eventQueue.set(ws, []);
            const queue = this._eventQueue.get(ws);
            while (queue.length >= this.config.maxEventQueue) queue.shift();
            queue.push({ event: eventName, data: data, timestamp: Date.now() });
            this._flushEventQueue(ws);
        } catch (err) {
            this._stats.errors++;
        }
    },

    _flushEventQueue: function (ws) {
        try {
            if (ws.readyState !== 1) return;
            const queue = this._eventQueue.get(ws);
            if (!queue || queue.length === 0) return;
            const batch = queue.splice(0, 10);
            const message = JSON.stringify({ type: 'events', events: batch });
            try { ws.send(message); } catch (e) { queue.unshift.apply(queue, batch); }
        } catch (err) {
            this._stats.errors++;
        }
    },

    _handleRequest: function (req, res) {
        try {
            this._stats.totalRequests++;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
            const contentLength = parseInt(req.headers['content-length'] || '0', 10);
            if (contentLength > this.config.maxRequestBodySize) { this._sendError(res, '请求体过大', 413); return; }
            let url;
            try { url = new URL(req.url, 'http://localhost'); } catch (e) { this._sendError(res, '无效的URL', 400); return; }
            this._handleAPI(req, res, url.pathname, req.method.toUpperCase());
        } catch (err) {
            this._stats.errors++;
            try { this._sendError(res, '服务器内部错误', 500); } catch (e) {}
        }
    },

    _handleAPI: function (req, res, pathname, method) {
        const self = this;
        if (pathname === '/api/health' && method === 'GET') { this._sendJSON(res, { status: 'ok', timestamp: Date.now() }); return; }
        if (pathname === '/api/status' && method === 'GET') { this._sendJSON(res, this.getStatus()); return; }
        if (pathname.startsWith('/api/var/')) {
            if (pathname === '/api/var/batch' && method === 'GET') { this._parseBody(req, (body) => { const result = self.batchGet(body && body.keys); self._sendJSON(res, result, result.error ? 400 : 200); }); return; }
            if (pathname === '/api/var/batch' && method === 'POST') { this._parseBody(req, (body) => { const result = self.batchSet(body && body.vars); self._sendJSON(res, result, result.error ? 400 : 200); }); return; }
            const nsMatch = pathname.match(/^\/api\/var\/namespace\/(.+)$/);
            if (nsMatch && method === 'GET') { const ns = decodeURIComponent(nsMatch[1]); const result = self.getByNamespace(ns); self._sendJSON(res, result, result.error ? 400 : 200); return; }
            const varMatch = pathname.match(/^\/api\/var\/(.+)$/);
            if (varMatch) {
                const key = decodeURIComponent(varMatch[1]);
                if (method === 'GET') { const result = self.getVar(key); self._sendJSON(res, result, result.error ? 404 : 200); return; }
                if (method === 'POST') { self._parseBody(req, (body) => { if (!body || body.value === undefined) { self._sendError(res, '缺少value字段', 400); return; } const result = self.setVar(key, body.value, body.ttl); self._sendJSON(res, result, result.error ? 400 : 200); }); return; }
                if (method === 'DELETE') { const result = self.deleteVar(key); self._sendJSON(res, result, result.error ? 404 : 200); return; }
            }
        }
        if (pathname.startsWith('/api/event/')) {
            const eventMatch = pathname.match(/^\/api\/event\/(.+)$/);
            if (eventMatch && method === 'POST') { const eventName = decodeURIComponent(eventMatch[1]); self._parseBody(req, (body) => { const result = self.publish(eventName, body && body.data); self._sendJSON(res, result, result.error ? 400 : 200); }); return; }
        }
        if (pathname === '/api/event/subscriptions' && method === 'GET') { const subs = []; this._subscriptions.forEach((wsSet, pattern) => { subs.push({ pattern: pattern, subscribers: wsSet.size }); }); this._sendJSON(res, { subscriptions: subs, total: subs.length }); return; }
        if (pathname === '/api/engine/status' && method === 'POST') { this._parseBody(req, (body) => { self._engineStatus = body; self._engineStatusLastUpdate = Date.now(); self._sendJSON(res, { success: true, received: true }); }); return; }
        if (pathname === '/api/engine/status' && method === 'GET') { const status = self._engineStatus || null; const lastUpdate = self._engineStatusLastUpdate || 0; self._sendJSON(res, { hasReport: !!status, lastUpdate: lastUpdate, lastUpdateAgo: lastUpdate > 0 ? (Date.now() - lastUpdate) + 'ms ago' : 'never', engine: status }); return; }
        if (pathname === '/api/ai/proxy/health' && method === 'GET') { self._sendJSON(res, { status: 'ok', message: 'AI Proxy 路由就绪', timestamp: new Date().toISOString() }); return; }
        if (pathname === '/api/ai/proxy' && method === 'POST') {
            self._parseBody(req, async (body) => {
                try {
                    const baseUrl = body && body.baseUrl;
                    const apiKey = body && body.apiKey;
                    const model = body && body.model;
                    const messages = body && body.messages;
                    const max_tokens = body && body.max_tokens;
                    const temperature = body && body.temperature;
                    if (!baseUrl || !apiKey) { self._sendJSON(res, { error: '缺少必要参数', message: 'baseUrl 和 apiKey 是必需的' }, 400); return; }
                    let url = baseUrl.replace(/\/$/, '');
                    const hasV1 = /\/v1$/i.test(url);
                    url = hasV1 ? url + '/chat/completions' : url + '/v1/chat/completions';
                    console.log('[AI Proxy] 代理请求到:', url);
                    const fetch = require('node-fetch');
                    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }, body: JSON.stringify({ model: model || 'gpt-3.5-turbo', messages: messages || [], max_tokens: max_tokens || 500, temperature: temperature !== undefined ? temperature : 0.7 }) });
                    if (!response.ok) { const errorText = await response.text(); console.error('[AI Proxy] API 错误', response.status, errorText); self._sendJSON(res, { error: 'API 错误 ' + response.status, detail: errorText }, response.status); return; }
                    const data = await response.json();
                    self._sendJSON(res, data);
                } catch (e) { console.error('[AI Proxy] 代理请求失败:', e); self._sendJSON(res, { error: '代理请求失败', message: e && e.message }, 500); }
            });
            return;
        }
        this._sendError(res, '未找到路由: ' + method + ' ' + pathname, 404);
    },

    _handleUpgrade: function (req, socket, head) {
        try {
            if (this._clients.size >= this.config.maxConnections) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
            if (!this._wsServer) {
                this._wsServer = new WebSocketServerImpl({ noServer: true });
                const self = this;
                this._wsServer.on('connection', (ws) => {
                    self._clients.add(ws);
                    self._eventQueue.set(ws, []);
                    console.log('[PluginBridge] WebSocket客户端已连接，当前连接数:', self._clients.size);
                    ws.on('message', (message) => { self._handleWSMessage(ws, message); });
                    ws.on('close', () => { self._handleWSClose(ws); });
                    ws.on('error', (err) => { console.error('[PluginBridge] WebSocket错误:', err && err.message); self._stats.errors++; self._handleWSClose(ws); });
                    try { ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now(), serverInfo: { maxConnections: self.config.maxConnections, maxEventQueue: self.config.maxEventQueue, heartbeatInterval: self.config.heartbeatInterval } })); } catch (e) {}
                });
            }
            this._wsServer.handleUpgrade(req, socket, head, (ws) => { this._wsServer.emit('connection', ws, req); });
        } catch (err) {
            this._stats.errors++;
            try { socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); socket.destroy(); } catch (e) {}
        }
    },

    _handleWSMessage: function (ws, message) {
        try {
            let data;
            try { data = JSON.parse(message.toString('utf8')); } catch (e) { try { ws.send(JSON.stringify({ type: 'error', message: '无效的JSON' })); } catch (sendErr) {} return; }
            const type = data.type;
            if (type === 'subscribe') { let patterns = data.patterns; if (!Array.isArray(patterns)) patterns = [data.pattern]; const subscribed = []; patterns.forEach((p) => { if (typeof p === 'string' && p.length > 0) { this.subscribe(ws, p); subscribed.push(p); } }); try { ws.send(JSON.stringify({ type: 'subscribed', patterns: subscribed })); } catch (e) {} return; }
            if (type === 'unsubscribe') { let patterns = data.patterns; if (!Array.isArray(patterns)) patterns = [data.pattern]; patterns.forEach((p) => { if (typeof p === 'string') this.unsubscribe(ws, p); }); try { ws.send(JSON.stringify({ type: 'unsubscribed' })); } catch (e) {} return; }
            if (type === 'publish') { const result = this.publish(data.event, data.data); try { ws.send(JSON.stringify({ type: 'published', result: result })); } catch (e) {} return; }
            if (type === 'get') { const result = this.getVar(data.key); try { ws.send(JSON.stringify({ type: 'var', key: data.key, result: result })); } catch (e) {} return; }
            if (type === 'set') { const result = this.setVar(data.key, data.value, data.ttl); try { ws.send(JSON.stringify({ type: 'var_set', result: result })); } catch (e) {} return; }
            if (type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() })); } catch (e) {} return; }
            if (type === 'status') { try { ws.send(JSON.stringify({ type: 'status', data: this.getStatus() })); } catch (e) {} return; }
            try { ws.send(JSON.stringify({ type: 'error', message: '未知的消息类型: ' + type })); } catch (e) {}
        } catch (err) {
            this._stats.errors++;
        }
    },

    _handleWSClose: function (ws) {
        try {
            this._clients.delete(ws);
            this._subscriptions.forEach((wsSet, pattern) => { wsSet.delete(ws); if (wsSet.size === 0) this._subscriptions.delete(pattern); });
            this._eventQueue.delete(ws);
            console.log('[PluginBridge] WebSocket客户端断开，当前连接数:', this._clients.size);
        } catch (err) {
            this._stats.errors++;
        }
    },

    _sendHeartbeat: function () {
        try {
            if (!this._clients || this._clients.size === 0) return;
            const disconnected = [];
            this._clients.forEach((ws) => {
                try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })); else disconnected.push(ws); } catch (e) { disconnected.push(ws); }
            });
            disconnected.forEach((ws) => this._handleWSClose(ws));
        } catch (err) {
            this._stats.errors++;
        }
    },

    _parseBody: function (req, callback) {
        try {
            const chunks = [];
            let size = 0;
            const maxSize = this.config.maxRequestBodySize;
            req.on('data', (chunk) => { size += chunk.length; if (size > maxSize) { chunks = null; return; } if (chunks) chunks.push(chunk); });
            req.on('end', () => { if (!chunks) { callback(null); return; } let body; try { const raw = Buffer.concat(chunks).toString('utf8'); body = raw.length > 0 ? JSON.parse(raw) : {}; } catch (e) { body = {}; } callback(body); });
            req.on('error', () => { callback(null); });
        } catch (err) {
            callback(null);
        }
    },

    _sendJSON: function (res, data, statusCode) {
        try {
            statusCode = statusCode || 200;
            res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'X-Powered-By': 'PluginBridge' });
            res.end(JSON.stringify(data));
        } catch (err) {
            this._stats.errors++;
        }
    },

    _sendError: function (res, message, statusCode) {
        try {
            statusCode = statusCode || 500;
            res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: message }));
        } catch (err) {
            this._stats.errors++;
        }
    },

    _matchPattern: function (pattern, eventName) {
        try {
            if (pattern === eventName) return true;
            if (pattern.endsWith('.*')) { const prefix = pattern.slice(0, -1); return eventName.startsWith(prefix); }
            if (pattern.indexOf('*') !== -1) { const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$'; try { const regex = new RegExp(regexStr); return regex.test(eventName); } catch (e) { return false; } }
            return false;
        } catch (err) {
            return false;
        }
    },

    getStatus: function () {
        try {
            const memUsage = process.memoryUsage();
            const uptime = Date.now() - this._stats.startTime;
            return {
                server: 'PluginBridge',
                version: '1.0.0',
                running: this._isRunning,
                uptime: uptime,
                uptimeFormatted: this._formatUptime(uptime),
                config: { port: this.config.port, maxVariables: this.config.maxVariables, maxConnections: this.config.maxConnections, maxEventQueue: this.config.maxEventQueue, heartbeatInterval: this.config.heartbeatInterval },
                stats: { totalRequests: this._stats.totalRequests, totalEvents: this._stats.totalEvents, totalVarReads: this._stats.totalVarReads, totalVarWrites: this._stats.totalVarWrites, errors: this._stats.errors },
                memory: { heapUsed: memUsage.heapUsed, heapTotal: memUsage.heapTotal, heapUsedMB: Math.round(memUsage.heapUsed / 1048576 * 100) / 100, heapTotalMB: Math.round(memUsage.heapTotal / 1048576 * 100) / 100, rss: memUsage.rss, rssMB: Math.round(memUsage.rss / 1048576 * 100) / 100, heapUsageRatio: memUsage.heapTotal > 0 ? Math.round(memUsage.heapUsed / memUsage.heapTotal * 100) / 100 : 0 },
                resources: { variables: this._store.size, connections: this._clients ? this._clients.size : 0, subscriptions: this._subscriptions.size, pendingEvents: this._countPendingEvents() },
                mode: WebSocketServerImpl ? 'HTTP+WebSocket' : 'HTTP-only'
            };
        } catch (err) {
            return { error: '获取状态失败: ' + (err && err.message) };
        }
    },

    _formatUptime: function (ms) {
        try {
            let seconds = Math.floor(ms / 1000);
            let minutes = Math.floor(seconds / 60);
            let hours = Math.floor(minutes / 60);
            let days = Math.floor(hours / 24);
            seconds = seconds % 60;
            minutes = minutes % 60;
            hours = hours % 24;
            const parts = [];
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
            let total = 0;
            this._eventQueue.forEach((queue) => { total += queue.length; });
            return total;
        } catch (err) {
            return 0;
        }
    }
};

// 自动启动
PluginBridgeServer.start();

module.exports = PluginBridgeServer;
