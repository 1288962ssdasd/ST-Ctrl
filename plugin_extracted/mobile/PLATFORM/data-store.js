/**
 * Data Store
 * 统一数据存储层
 *
 * 提供单一真相源，所有数据读写必须经过此层。
 * 支持领域划分、缓存策略、持久化和订阅机制。
 *
 * 公共工具引用：deepClone / deepEqual 来自 UTILS/clone.js（window.PhoneUtils）
 */

;(function () {
  'use strict';

  class DataStore {
    constructor(adapter, options = {}) {
      // 平台适配器
      this._adapter = adapter;

      // 配置
      this._config = {
        defaultPersist: options.defaultPersist ?? true,
        defaultDebounceTime: options.defaultDebounceTime ?? 100,
        maxCacheSize: options.maxCacheSize ?? 1000,
        ...options,
      };

      // 领域定义: domain -> config
      this._domains = new Map();

      // 内存缓存: fullKey -> { value, timestamp, dirty }
      this._cache = new Map();

      // 缓存访问顺序（用于 LRU 淘汰）
      this._accessOrder = [];

      // 订阅者: fullKey -> Set<callback>
      this._subscribers = new Map();

      // 待写入队列: fullKey -> value
      this._pendingWrites = new Map();

      // 防抖定时器
      this._flushTimer = null;

      // 是否正在刷新
      this._flushing = false;

      // 路径映射: shortKey -> fullKey
      this._pathMappings = new Map();

      // 页面关闭前强制持久化，防止数据丢失
      this._bindUnloadProtection();

      console.log('[DataStore] 初始化完成');
    }

    // ==================== 领域管理 ====================

    /**
     * 绑定页面关闭保护，确保数据在页面刷新/关闭前持久化
     */
    _bindUnloadProtection() {
      const doFlush = () => {
        if (this._pendingWrites.size > 0 && this._adapter) {
          // 同步写入所有待持久化数据（使用 sendBeacon 或同步 fetch）
          for (const [fullKey, value] of this._pendingWrites) {
            try {
              const [domain, ...keyParts] = fullKey.split('.');
              const key = keyParts.join('.');
              const storagePath = this.toStoragePath(domain, key);
              // 使用 navigator.sendBeacon 确保页面关闭时也能发送
              const apiUrl = this._adapter._options?.apiBase;
              if (apiUrl && navigator.sendBeacon) {
                const payload = JSON.stringify({ value: typeof value === 'string' ? value : JSON.stringify(value) });
                navigator.sendBeacon(
                  `${apiUrl}/var/${encodeURIComponent(storagePath)}`,
                  new Blob([payload], { type: 'application/json' })
                );
              }
            } catch (e) {
              // 静默失败，不阻断页面关闭
            }
          }
        }
      };

      window.addEventListener('beforeunload', doFlush);
      window.addEventListener('pagehide', doFlush);
    }

    // ==================== localStorage 降级存储 ====================

    _LS_PREFIX = 'xb_phone_ds_';

    _saveToLocalStorage(fullKey, value) {
      try {
        localStorage.setItem(this._LS_PREFIX + fullKey, JSON.stringify(value));
      } catch (e) {
        console.warn('[DataStore] localStorage 写入失败:', fullKey, e);
      }
    }

    _loadFromLocalStorage(fullKey) {
      try {
        const raw = localStorage.getItem(this._LS_PREFIX + fullKey);
        if (raw === null) return null;
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    }

    _flushToLocalStorage() {
      for (const [fullKey, cached] of this._cache) {
        if (cached.dirty) {
          this._saveToLocalStorage(fullKey, cached.value);
          cached.dirty = false;
        }
      }
      // 也写入待写入队列
      for (const [fullKey, value] of this._pendingWrites) {
        this._saveToLocalStorage(fullKey, value);
      }
      this._pendingWrites.clear();
    }

    /**
     * 注册领域
     * @param {string} name - 领域名称
     * @param {Object} config - 配置
     *   - schema: 数据 schema
     *   - persist: 是否持久化
     *   - debounceTime: 防抖时间
     *   - retention: 保留策略 { max, maxAge }
     * @returns {Promise<void>}
     */
    async registerDomain(name, config = {}) {
      this._domains.set(name, {
        schema: config.schema || {},
        persist: config.persist !== false,
        debounceTime: config.debounceTime || this._config.defaultDebounceTime,
        retention: config.retention || null,
      });
      console.log('[DataStore] 注册领域:', name);

      // [修复] 如果领域需要持久化，立即从持久化层恢复数据
      if (config.persist !== false && this._adapter) {
        await this._loadDomainData(name, config.schema);
      }
    }

    /**
     * [v4.31.0-fix] 检查领域是否已注册（公开方法）
     * @param {string} name - 领域名称
     * @returns {boolean}
     */
    hasDomain(name) {
      return this._domains.has(name);
    }

    /**
     * [新增] 从持久化层加载领域数据
     * @param {string} domain - 领域名称
     * @param {Object} schema - 领域 schema
     */
    async _loadDomainData(domain, schema) {
      if (!schema) return;

      const keys = Object.keys(schema);
      let loaded = 0;

      for (const key of keys) {
        const fullKey = `${domain}.${key}`;
        
        // 跳过已缓存的数据
        if (this._cache.has(fullKey)) continue;

        try {
          const storagePath = this.toStoragePath(domain, key);
          const value = await this._adapter.read(storagePath);

          if (value !== null && value !== undefined) {
            // 解析 JSON
            let parsed = value;
            if (typeof value === 'string') {
              try {
                parsed = JSON.parse(value);
              } catch (e) {
                // 保持字符串
              }
            }

            // 存入缓存
            this._setCache(fullKey, parsed, false);
            loaded++;
          }
        } catch (e) {
          // 尝试从 localStorage 恢复
          const localValue = this._loadFromLocalStorage(fullKey);
          if (localValue !== null) {
            this._setCache(fullKey, localValue, false);
            loaded++;
            console.log('[DataStore] 从 localStorage 恢复:', fullKey);
          }
        }
      }

      if (loaded > 0) {
        console.log('[DataStore] 领域数据恢复完成:', domain, '加载', loaded, '项');
      }
    }

    /**
     * [新增] 恢复所有领域数据（启动时调用）
     */
    async restoreAllDomains() {
      console.log('[DataStore] 开始恢复所有领域数据...');
      
      for (const [domain, config] of this._domains) {
        if (config.persist) {
          await this._loadDomainData(domain, config.schema);
        }
      }

      console.log('[DataStore] 所有领域数据恢复完成');
    }

    /**
     * 注册路径映射
     * @param {string} storagePath - 存储路径，如 'xb.friends.list'
     * @param {string} domain - 领域名
     * @param {string} key - 键名
     */
    registerPathMapping(storagePath, domain, key) {
      const fullKey = `${domain}.${key}`;
      this._pathMappings.set(storagePath, fullKey);
      console.log('[DataStore] 注册路径映射:', storagePath, '->', fullKey);
    }

    /**
     * 解析存储路径
     * @param {string} storagePath
     * @returns {string|null} 完整键名
     */
    resolvePath(storagePath) {
      return this._pathMappings.get(storagePath) || null;
    }

    /**
     * 转换为存储路径
     * @param {string} domain
     * @param {string} key
     * @returns {string} 存储路径
     */
    toStoragePath(domain, key) {
      const fullKey = `${domain}.${key}`;

      // 反向查找
      for (const [storagePath, mappedKey] of this._pathMappings) {
        if (mappedKey === fullKey) {
          return storagePath;
        }
      }

      // 默认格式
      return `xb.${domain}.${key}`;
    }

    // ==================== 核心读写 API ====================

    /**
     * 读取数据
     * @param {string} domain - 领域名
     * @param {string} key - 键名
     * @param {any} defaultValue - 默认值
     * @returns {Promise<any>}
     */
    async get(domain, key, defaultValue = undefined) {
      const fullKey = `${domain}.${key}`;

      // 1. 检查内存缓存
      const cached = this._cache.get(fullKey);
      if (cached !== undefined) {
        this._updateAccessOrder(fullKey);
        // [修复] 返回深克隆，防止调用者修改缓存导致 _deepEqual 误判为"值未变化"而跳过写入
        return this._deepClone(cached.value);
      }

      // 2. 从持久化层加载
      try {
        const storagePath = this.toStoragePath(domain, key);
        const value = await this._adapter.read(storagePath);

        if (value !== null && value !== undefined) {
          // 解析 JSON
          let parsed = value;
          if (typeof value === 'string') {
            try {
              parsed = JSON.parse(value);
            } catch (e) {
              // 保持字符串
            }
          }

          // 存入缓存
          this._setCache(fullKey, parsed, false);
          return parsed;
        }
      } catch (e) {
        console.warn('[DataStore] 读取失败:', fullKey, e);
        // 降级：尝试从 localStorage 恢复
        const localValue = this._loadFromLocalStorage(fullKey);
        if (localValue !== null) {
          console.log('[DataStore] 从 localStorage 恢复:', fullKey);
          this._setCache(fullKey, localValue, false);
          return localValue;
        }
      }

      return defaultValue;
    }

    /**
     * 同步读取（仅从缓存）
     * @param {string} domain
     * @param {string} key
     * @param {any} defaultValue
     * @returns {any}
     */
    getSync(domain, key, defaultValue = undefined) {
      const fullKey = `${domain}.${key}`;
      const cached = this._cache.get(fullKey);

      if (cached !== undefined) {
        this._updateAccessOrder(fullKey);
        // [修复] 返回深克隆，防止调用者修改缓存
        return this._deepClone(cached.value);
      }

      return defaultValue;
    }

    /**
     * 设置数据
     * @param {string} domain - 领域名
     * @param {string} key - 键名
     * @param {any} value - 值
     * @param {Object} options - 选项
     *   - persist: 是否持久化
     *   - debounceTime: 防抖时间
     *   - silent: 是否静默（不触发事件）
     *   - lineage: 血缘信息 { source, operation, triggeredBy, correlationId, metadata }
     * @returns {boolean}
     */
    set(domain, key, value, options = {}) {
      const fullKey = `${domain}.${key}`;
      const domainConfig = this._domains.get(domain) || {};

      // 获取旧值
      const oldValue = this._cache.get(fullKey)?.value;

      // 值相同，跳过
      if (this._deepEqual(oldValue, value)) {
        return false;
      }

      // [v4.31.0] 数据约束验证
      if (window.PhoneDataConstraints) {
        const validationResult = window.PhoneDataConstraints.validate(domain, key, value);
        if (!validationResult.valid) {
          console.warn('[DataStore] 数据约束验证失败:', fullKey, validationResult.errors);
          // 发射约束违规事件
          if (window.Platform?.emit) {
            window.Platform.emit('data:constraintViolation', {
              domain,
              key,
              fullKey,
              errors: validationResult.errors,
              value,
            });
          }
        }
      }

      // [v4.31.0] 数据血缘追踪
      let lineage = null;
      if (window.PhoneDataLineage && options.lineage !== false) {
        lineage = window.PhoneDataLineage.createLineage(domain, key, value, oldValue, {
          source: options.lineage?.source || 'data-store',
          operation: options.lineage?.operation || 'set',
          triggeredBy: options.lineage?.triggeredBy || 'system',
          correlationId: options.lineage?.correlationId || null,
          metadata: options.lineage?.metadata || null,
        });

        // 如果值是对象，附加血缘信息（使用 _lineage 前缀避免冲突）
        if (lineage && value && typeof value === 'object' && !Array.isArray(value)) {
          value = window.PhoneDataLineage.attachLineage(value, lineage);
        }
      }

      // 更新缓存
      const shouldPersist = options.persist !== undefined
        ? options.persist
        : (domainConfig.persist !== false && this._config.defaultPersist);

      this._setCache(fullKey, value, shouldPersist);

      // 触发变更事件
      if (!options.silent) {
        this._notify(fullKey, value, oldValue);

        // 触发全局事件（增强：包含血缘信息）
        if (window.Platform?.emit) {
          const eventData = {
            domain,
            key,
            value,
            oldValue,
            fullKey,
          };
          
          // 添加血缘信息到事件
          if (lineage) {
            eventData._lineage = {
              _version: lineage._version,
              _timestamp: lineage._timestamp,
              _source: lineage._source,
              _operation: lineage._operation,
              _triggeredBy: lineage._triggeredBy,
              _correlationId: lineage._correlationId,
              _changeType: lineage._changeType,
            };
          }
          
          window.Platform.emit('data:changed', eventData);
        }
      }

      // 持久化
      if (shouldPersist) {
        const debounceTime = options.debounceTime || domainConfig.debounceTime || this._config.defaultDebounceTime;
        this._scheduleFlush(fullKey, value, debounceTime);
      }

      // 应用保留策略
      if (domainConfig.retention) {
        this._applyRetention(domain, key, domainConfig.retention);
      }

      return true;
    }

    /**
     * 删除数据
     * @param {string} domain
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async delete(domain, key) {
      const fullKey = `${domain}.${key}`;
      const oldValue = this._cache.get(fullKey)?.value;

      // 删除缓存
      this._cache.delete(fullKey);
      this._removeFromAccessOrder(fullKey);

      // 删除持久化
      try {
        const storagePath = this.toStoragePath(domain, key);
        await this._adapter.delete(storagePath);
      } catch (e) {
        console.warn('[DataStore] 删除失败:', fullKey, e);
      }

      // 触发事件
      this._notify(fullKey, undefined, oldValue);

      if (window.Platform?.emit) {
        window.Platform.emit('data:deleted', { domain, key, fullKey, oldValue });
      }

      return true;
    }

    /**
     * 按前缀清理数据（缓存 + 持久化）
     * @param {string} prefix - 键前缀，如 'friends.' 或 'char123:messages.'
     * @param {object} options - { persist: boolean, notify: boolean }
     * @returns {Promise<number>} 清理的条目数
     */
    async clearByPrefix(prefix, options = {}) {
      const persist = options.persist !== false;
      const notify = options.notify !== false;
      let cleared = 0;

      // 1. 清理内存缓存
      const cacheKeysToDelete = [];
      for (const fullKey of this._cache.keys()) {
        if (fullKey.startsWith(prefix)) {
          const oldValue = this._cache.get(fullKey)?.value;
          cacheKeysToDelete.push(fullKey);
          this._removeFromAccessOrder(fullKey);
          if (notify) {
            this._notify(fullKey, undefined, oldValue);
          }
          cleared++;
        }
      }
      for (const key of cacheKeysToDelete) {
        this._cache.delete(key);
      }

      // 2. 清理持久化层（通过适配器）
      if (persist && this._adapter) {
        try {
          // 尝试使用适配器的 list + delete
          if (typeof this._adapter.list === 'function') {
            const allKeys = await this._adapter.list(prefix);
            for (const key of allKeys) {
              try {
                await this._adapter.delete(key);
                cleared++;
              } catch (e) {
                console.warn('[DataStore] clearByPrefix 删除持久化项失败:', key, e);
              }
            }
          }
        } catch (e) {
          console.warn('[DataStore] clearByPrefix 持久化清理失败:', e);
        }
      }

      // 3. 清理待写入队列
      for (const fullKey of this._pendingWrites.keys()) {
        if (fullKey.startsWith(prefix)) {
          this._pendingWrites.delete(fullKey);
        }
      }

      console.log('[DataStore] clearByPrefix:', prefix, '清理了', cleared, '条');

      if (notify && window.Platform?.emit) {
        window.Platform.emit('data:cleared', { prefix, cleared });
      }

      return cleared;
    }

    /**
     * 批量操作
     * @param {Array<{domain, key, value, options}>} operations
     */
    async batch(operations) {
      const results = [];

      for (const op of operations) {
        if (op.value === undefined) {
          // 删除操作
          results.push(await this.delete(op.domain, op.key));
        } else {
          // 设置操作（静默模式，最后统一触发）
          results.push(this.set(op.domain, op.key, op.value, { ...op.options, silent: true }));
        }
      }

      // 立即刷新所有待写入
      await this.flush();

      // 触发批量变更事件
      if (window.Platform?.emit) {
        window.Platform.emit('data:batch', { operations });
      }

      return results;
    }

    // ==================== 订阅 API ====================

    /**
     * 订阅数据变更
     * @param {string} domain - 领域名，支持通配符 *
     * @param {string} key - 键名，支持通配符 *
     * @param {Function} callback - (value, oldValue, meta) => void
     * @returns {Function} 取消订阅函数
     */
    subscribe(domain, key, callback) {
      const fullKey = key ? `${domain}.${key}` : domain;

      if (!this._subscribers.has(fullKey)) {
        this._subscribers.set(fullKey, new Set());
      }

      this._subscribers.get(fullKey).add(callback);

      // 立即触发一次（如果数据存在）
      const currentValue = this._cache.get(fullKey)?.value;
      if (currentValue !== undefined) {
        setTimeout(() => {
          try {
            callback(currentValue, undefined, { immediate: true, fullKey });
          } catch (e) {
            console.error('[DataStore] 初始回调错误:', e);
          }
        }, 0);
      }

      return () => this.unsubscribe(domain, key, callback);
    }

    /**
     * 取消订阅
     */
    unsubscribe(domain, key, callback) {
      const fullKey = key ? `${domain}.${key}` : domain;
      this._subscribers.get(fullKey)?.delete(callback);
    }

    // ==================== 持久化控制 ====================

    /**
     * 立即刷新所有待写入
     */
    async flush() {
      if (this._flushing || this._pendingWrites.size === 0) {
        return;
      }

      // 检查适配器是否可用
      if (!this._adapter) {
        console.warn('[DataStore] 无法刷新：适配器未初始化，降级到 localStorage');
        this._flushToLocalStorage();
        return;
      }

      this._flushing = true;

      if (this._flushTimer) {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
      }

      const writes = new Map(this._pendingWrites);
      this._pendingWrites.clear();

      // [v3.3.2-fix] 改为 debug 级别，减少日志噪音；可通过 ui-feedback 面板过滤
      console.debug('[DataStore] 刷新写入:', writes.size, '项');

      for (const [fullKey, value] of writes) {
        try {
          const [domain, ...keyParts] = fullKey.split('.');
          const key = keyParts.join('.');
          const storagePath = this.toStoragePath(domain, key);

          await this._adapter.write(storagePath, value);

          // 更新缓存状态
          const cached = this._cache.get(fullKey);
          if (cached) {
            cached.dirty = false;
          }
        } catch (e) {
          console.error('[DataStore] 写入失败:', fullKey, e);
          // 降级到 localStorage
          this._saveToLocalStorage(fullKey, value);
          // 更新缓存状态
          const cached = this._cache.get(fullKey);
          if (cached) {
            cached.dirty = false;
          }
        }
      }

      this._flushing = false;

      // 如果还有未写入的，继续刷新
      if (this._pendingWrites.size > 0) {
        setTimeout(() => this.flush(), 1000);
      }
    }

    /**
     * 强制刷新（用于页面关闭前）
     */
    async forceFlush() {
      return this.flush();
    }

    // ==================== 内部方法 ====================

    _setCache(fullKey, value, dirty) {
      // LRU 淘汰
      if (this._cache.size >= this._config.maxCacheSize && !this._cache.has(fullKey)) {
        this._evictLRU();
      }

      this._cache.set(fullKey, {
        value: this._deepClone(value),
        timestamp: Date.now(),
        dirty,
      });

      this._updateAccessOrder(fullKey);
    }

    _updateAccessOrder(fullKey) {
      const index = this._accessOrder.indexOf(fullKey);
      if (index > -1) {
        this._accessOrder.splice(index, 1);
      }
      this._accessOrder.push(fullKey);
    }

    _removeFromAccessOrder(fullKey) {
      const index = this._accessOrder.indexOf(fullKey);
      if (index > -1) {
        this._accessOrder.splice(index, 1);
      }
    }

    _evictLRU() {
      // 淘汰最久未访问的
      const toEvict = this._accessOrder.shift();
      if (toEvict) {
        const cached = this._cache.get(toEvict);
        if (cached?.dirty) {
          // 脏数据先刷新
          this._pendingWrites.set(toEvict, cached.value);
          this._scheduleFlush(toEvict, cached.value, 0);
        }
        this._cache.delete(toEvict);
      }
    }

    _scheduleFlush(fullKey, value, debounceTime) {
      this._pendingWrites.set(fullKey, value);

      if (this._flushTimer) {
        clearTimeout(this._flushTimer);
      }

      this._flushTimer = setTimeout(() => {
        this.flush();
      }, debounceTime);
    }

    _notify(fullKey, value, oldValue) {
      const meta = { timestamp: Date.now(), fullKey };

      // 通知精确订阅者
      const subscribers = this._subscribers.get(fullKey);
      if (subscribers) {
        for (const callback of subscribers) {
          try {
            callback(value, oldValue, meta);
          } catch (e) {
            console.error('[DataStore] 订阅回调错误:', e);
          }
        }
      }

      // 通知通配符订阅者
      for (const [pattern, callbacks] of this._subscribers) {
        if (pattern.includes('*') && this._matchPattern(pattern, fullKey)) {
          for (const callback of callbacks) {
            try {
              callback(value, oldValue, { ...meta, pattern });
            } catch (e) {
              console.error('[DataStore] 通配符订阅回调错误:', e);
            }
          }
        }
      }
    }

    _matchPattern(pattern, fullKey) {
      // 简单通配符匹配
      const regex = new RegExp('^' + pattern.replace(/\*/g, '[^.]+') + '$');
      return regex.test(fullKey);
    }

    _applyRetention(domain, key, retention) {
      // 异步应用保留策略
      setTimeout(() => {
        const fullKey = `${domain}.${key}`;
        const cached = this._cache.get(fullKey);
        if (!cached) return;

        let value = cached.value;
        if (!Array.isArray(value)) return;

        // 按数量限制
        if (retention.max && value.length > retention.max) {
          value = value.slice(-retention.max);
          this.set(domain, key, value, { silent: true });
        }

        // 按时间限制
        if (retention.maxAge) {
          const cutoff = Date.now() - retention.maxAge;
          const filtered = value.filter(item => {
            const ts = item.timestamp || item._t || item.time || 0;
            return ts >= cutoff;
          });
          if (filtered.length < value.length) {
            this.set(domain, key, filtered, { silent: true });
          }
        }
      }, 0);
    }

    _deepClone(obj) {
      return window.PhoneUtils?.deepClone?.(obj) ?? obj;
    }

    _deepEqual(a, b) {
      return window.PhoneUtils?.deepEqual?.(a, b) ?? false;
    }
  }

  // 暴露到全局
  window.DataStore = DataStore;

  console.log('[Platform] DataStore 已加载');
})();
