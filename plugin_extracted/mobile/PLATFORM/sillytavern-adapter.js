/**
 * SillyTavern Adapter
 * SillyTavern 平台适配器实现
 *
 * 实现 IPlatformAdapter 接口，对接 SillyTavern 的变量系统和 API。
 */

;(function () {
  'use strict';

  // 全局扩展设置名（用于 extension_settings 对象）
  const EXT_ID = 'mobile-phone';
  // localStorage 兜底键名（当 ST 扩展设置不可用时使用）
  const LS_FALLBACK_KEY = 'mobile_phone_settings';

  class SillyTavernAdapter extends IPlatformAdapter {
    constructor(options = {}) {
      super();

      // [P2 修复] 使用 ST 标准扩展机制（extension_settings + saveSettingsDebounced）
      //   替代之前的 HTTP API（/api/plugins/xb-bridge-test/*）。
      //   RT15548/LittleWhiteBox 等所有标准 ST 扩展都用这个机制。
      //   优点：
      //     1. 数据由 ST 写入 settings.json → 持久化到磁盘（进程重启不丢）
      //     2. 不需要后端路由 → 不依赖 server-main.js 改动
      //     3. 跨浏览器/APP 一致
      //   降级链：extension_settings → localStorage → 内存 Map
      this._options = {
        varPrefix: options.varPrefix || 'xb',
        cacheEnabled: options.cacheEnabled !== false,
        cacheTTL: options.cacheTTL || 15000,
        ...options,
      };

      console.log('[SillyTavernAdapter] 使用 ST 扩展设置（extension_settings）');

      // 内存缓存
      this._cache = new Map();
      this._cacheTimestamps = new Map();

      // 变更监听器
      this._changeListeners = new Set();

      // 就绪状态
      this._ready = false;

      // 初始化（异步，不等待）
      this._init();
    }

    // ==================== 初始化 ====================

    async _init() {
      console.log('[SillyTavernAdapter] 初始化...');

      // 等待 SillyTavern 环境就绪（带超时）
      const stReady = await this._waitForSillyTavern(8000);

      if (stReady) {
        // 确保 extension_settings 中有我们的命名空间
        if (typeof window.extension_settings !== 'undefined' && window.extension_settings) {
          if (!window.extension_settings[EXT_ID]) {
            window.extension_settings[EXT_ID] = {};
          }
        }
        this._ready = true;
        console.log('[SillyTavernAdapter] ✅ 已就绪（ST 扩展设置机制）');
      } else {
        // 降级为独立模式（只用 localStorage）
        this._ready = true;
        console.log('[SillyTavernAdapter] ⚠️ ST 未就绪，降级为 localStorage 独立模式');
      }
    }

    async _waitForSillyTavern(timeout = 8000) {
      const start = Date.now();
      return new Promise((resolve) => {
        const check = () => {
          if (window.SillyTavern) {
            return resolve(true);
          }
          if (Date.now() - start > timeout) {
            console.warn('[SillyTavernAdapter] 等待 SillyTavern 超时，降级为独立模式');
            return resolve(false);
          }
          setTimeout(check, 100);
        };
        check();
      });
    }

    // ==================== 内部存储访问器（extension_settings → localStorage → 内存） ====================

    _getStore() {
      // 优先使用 ST 的 extension_settings（持久化到 settings.json）
      if (typeof window.extension_settings !== 'undefined' &&
          window.extension_settings &&
          window.extension_settings[EXT_ID]) {
        return { type: 'extension_settings', data: window.extension_settings[EXT_ID] };
      }

      // 降级：localStorage（浏览器刷新也能保留）
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          const raw = window.localStorage.getItem(LS_FALLBACK_KEY);
          const data = raw ? JSON.parse(raw) : {};
          return { type: 'localStorage', data: data, _needWriteBack: true };
        }
      } catch (e) {
        // localStorage 不可用，继续降级
      }

      // 最终降级：纯内存（进程重启丢失，聊胜于无）
      if (!this._memStore) this._memStore = {};
      return { type: 'memory', data: this._memStore };
    }

    _saveStore(store) {
      if (store.type === 'extension_settings') {
        // ST 标准方式：调用 saveSettingsDebounced()
        try {
          if (typeof window.saveSettingsDebounced === 'function') {
            window.saveSettingsDebounced();
          } else if (typeof window.eventSource !== 'undefined' && window.eventSource) {
            // 有些版本通过事件触发保存
            window.eventSource.emit('settings_changed');
          }
        } catch (e) {
          console.warn('[SillyTavernAdapter] ST 保存失败，写入 localStorage:', e);
          // 兜底：写入 localStorage
          try {
            window.localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(window.extension_settings[EXT_ID]));
          } catch (e2) { /* 忽略 */ }
        }
      } else if (store.type === 'localStorage') {
        try {
          window.localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(store.data));
        } catch (e) { /* 忽略 */ }
      }
      // memory 模式无需显式保存
    }

    // ==================== IPlatformAdapter 实现 ====================

    async read(key) {
      const fullKey = this._normalizeKey(key);

      // 检查缓存
      if (this._options.cacheEnabled) {
        const cached = this._getCached(fullKey);
        if (cached !== undefined) return cached;
      }

      try {
        const store = this._getStore();
        const value = store.data[fullKey];

        // 规范：null/undefined 视为未设置
        if (value === undefined || value === null) return null;

        // 更新缓存
        if (this._options.cacheEnabled) {
          this._setCached(fullKey, value);
        }

        return value;
      } catch (e) {
        console.warn('[SillyTavernAdapter] 读取失败:', fullKey, e);
        return null;
      }
    }

    async write(key, value) {
      const fullKey = this._normalizeKey(key);

      try {
        const store = this._getStore();
        const oldValue = store.data[fullKey];

        // 真正写入存储
        store.data[fullKey] = value;
        this._saveStore(store);

        // 更新缓存
        if (this._options.cacheEnabled) {
          this._setCached(fullKey, value);
        }

        // 触发变更事件（仅在值确实变化时）
        if (JSON.stringify(oldValue) !== JSON.stringify(value)) {
          this._notifyChange(fullKey, value);
        }

        return true;
      } catch (e) {
        console.error('[SillyTavernAdapter] 写入失败:', fullKey, e);
        return false;
      }
    }

    async delete(key) {
      const fullKey = this._normalizeKey(key);

      try {
        const store = this._getStore();
        delete store.data[fullKey];
        this._saveStore(store);

        this._cache.delete(fullKey);
        this._cacheTimestamps.delete(fullKey);

        return true;
      } catch (e) {
        console.error('[SillyTavernAdapter] 删除失败:', fullKey, e);
        return false;
      }
    }

    async list(prefix) {
      const namespace = prefix || this._options.varPrefix;
      try {
        const store = this._getStore();
        const keys = [];
        for (const key of Object.keys(store.data)) {
          if (key === namespace || key.startsWith(namespace + '.') ||
              key === 'xb.' + namespace || key.startsWith('xb.' + namespace + '.')) {
            keys.push(key);
          }
        }
        return keys;
      } catch (e) {
        console.warn('[SillyTavernAdapter] list() 失败:', e);
        return [];
      }
    }

    async batchRead(keys) {
      if (!keys || keys.length === 0) return {};

      const result = {};
      const uncachedKeys = [];

      // 先过滤缓存
      if (this._options.cacheEnabled) {
        for (const key of keys) {
          const cached = this._getCached(key);
          if (cached !== undefined) {
            result[key] = cached;
          } else {
            uncachedKeys.push(key);
          }
        }
      } else {
        uncachedKeys.push(...keys);
      }

      if (uncachedKeys.length === 0) return result;

      // 直接从 store 一次性读取（无需网络，毫秒级）
      try {
        const store = this._getStore();
        for (const key of uncachedKeys) {
          const fullKey = this._normalizeKey(key);
          const value = store.data[fullKey];
          if (value !== undefined && value !== null) {
            result[key] = value;
            if (this._options.cacheEnabled) this._setCached(fullKey, value);
          }
        }
        return result;
      } catch (e) {
        console.warn('[SillyTavernAdapter] batchRead 失败:', e);
      }

      // 降级方案：并行读取（Promise.all 比串行快 10 倍）
      const promises = uncachedKeys.map(async (key) => {
        const value = await this.read(key);
        if (value !== null && value !== undefined) result[key] = value;
      });
      await Promise.all(promises);

      return result;
    }

    async batchWrite(data) {
      const entries = Object.entries(data);
      if (entries.length === 0) return true;

      // 【P2 修复】直接写入 extension_settings 对象，一次保存
      try {
        const store = this._getStore();
        let hasChange = false;

        for (const [key, value] of entries) {
          const fullKey = this._normalizeKey(key);
          const oldValue = store.data[fullKey];

          if (JSON.stringify(oldValue) !== JSON.stringify(value)) {
            store.data[fullKey] = value;
            hasChange = true;

            // 更新缓存
            if (this._options.cacheEnabled) this._setCached(fullKey, value);

            // 通知变更
            this._notifyChange(fullKey, value);
          }
        }

        // 一次保存（减少 I/O）
        if (hasChange) this._saveStore(store);

        return true;
      } catch (e) {
        console.warn('[SillyTavernAdapter] batchWrite 失败:', e);
        // 降级：逐个写入
        const promises = entries.map(async ([key, value]) => {
          await this.write(key, value);
        });
        await Promise.all(promises);
        return true;
      }
    }

    onVariableChange(callback) {
      this._changeListeners.add(callback);
      return () => this._changeListeners.delete(callback);
    }

    onVariable(key, callback) {
      const fullKey = this._normalizeKey(key);

      const wrappedCallback = (changedKey, value) => {
        if (changedKey === fullKey) {
          callback(value);
        }
      };

      this._changeListeners.add(wrappedCallback);
      return () => this._changeListeners.delete(wrappedCallback);
    }

    getChatContext() {
      try {
        return window.SillyTavern?.getContext() ?? null;
      } catch (e) {
        return null;
      }
    }

    /**
     * [T3修复] 获取 ST 上下文（铁则六公开接口）
     * @returns {Object|null}
     */
    getSTContext() {
      return this.getChatContext();
    }

    getCurrentCharacter() {
      const context = this.getChatContext();
      return context?.character ?? null;
    }

    async sendMessage(content, options = {}) {
      // 通过 SillyTavern 的事件系统发送消息
      try {
        if (window.eventSource && options.eventType) {
          window.eventSource.emit(options.eventType, {
            content,
            ...options.data,
          });
        }
        return true;
      } catch (e) {
        console.error('[SillyTavernAdapter] 发送消息失败:', e);
        return false;
      }
    }

    async getWorldInfoEntry(entryName) {
      try {
        const context = this.getChatContext();
        const worldInfo = context?.worldInfo;

        if (!worldInfo) return null;

        // 查找条目
        for (const entry of worldInfo.entries || []) {
          if (entry.comment === entryName || entry.key?.includes(entryName)) {
            return entry.content;
          }
        }

        return null;
      } catch (e) {
        console.error('[SillyTavernAdapter] 获取世界书条目失败:', e);
        return null;
      }
    }

    /**
     * [铁则六修复] 获取世界书所有条目
     * 提供给 LLMGateway 使用，避免直接访问 window.SillyTavern
     * @returns {Array|null} 世界书条目数组
     */
    getWorldBookEntries() {
      try {
        const context = this.getChatContext();
        const worldInfo = context?.worldInfo;
        
        if (worldInfo && worldInfo.entries) {
          return worldInfo.entries;
        }
        
        return null;
      } catch (e) {
        console.error('[SillyTavernAdapter] 获取世界书条目列表失败:', e);
        return null;
      }
    }

    /**
     * [铁则六修复] 根据变量名获取世界书条目内容
     * @param {string} varName - 变量名或条目ID
     * @returns {string|null} 条目内容
     */
    getWorldBookEntryByName(varName) {
      try {
        const entries = this.getWorldBookEntries();
        if (!entries) return null;
        
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].name === varName || entries[i].id == varName || entries[i].comment === varName) {
            return entries[i].content || entries[i].text || '';
          }
        }
        
        return null;
      } catch (e) {
        console.error('[SillyTavernAdapter] 获取世界书变量失败:', e);
        return null;
      }
    }

    async setWorldInfoEntry(entryName, content) {
      try {
        const context = this.getChatContext();
        const worldInfo = context?.worldInfo;

        if (!worldInfo) {
          console.warn('[SillyTavernAdapter] setWorldInfoEntry: 无法获取世界书');
          return false;
        }

        // 查找已有条目
        let entry = null;
        for (const e of worldInfo.entries || []) {
          if (e.comment === entryName || e.key?.includes(entryName)) {
            entry = e;
            break;
          }
        }

        if (entry) {
          // 更新已有条目
          entry.content = content;
          // 通知 ST 世界书变更
          if (worldInfo.updateEntry) {
            worldInfo.updateEntry(entry.uid || entry.id, entry);
          }
        } else {
          // 创建新条目
          const newEntry = {
            key: [entryName],
            comment: entryName,
            content: content,
            constant: false,
            selective: false,
            enabled: true,
          };
          worldInfo.entries = worldInfo.entries || [];
          worldInfo.entries.push(newEntry);
          if (worldInfo.addEntry) {
            worldInfo.addEntry(newEntry);
          }
        }

        return true;
      } catch (e) {
        console.error('[SillyTavernAdapter] 设置世界书条目失败:', e);
        return false;
      }
    }

    getPlatformName() {
      return 'SillyTavern';
    }

    getPlatformVersion() {
      try {
        return window.SillyTavern?.version ?? 'unknown';
      } catch (e) {
        return 'unknown';
      }
    }

    /**
     * 获取 AI API 代理 URL
     * [铁则六] 环境适配在入口处完成 - AI 代理 URL 由适配器提供
     */
    getAIProxyUrl() {
      // ST 插件路由提供 AI 代理
      return `${this._options.apiBase}/ai/proxy`;
    }

    // ==================== [阶段C] 扩展方法 ====================

    /**
     * 追加世界书条目内容（不覆盖已有内容）
     * [铁则六] 世界书操作必须通过适配器
     * @param {object} entry - { name: string, content: string, options?: object }
     * @returns {Promise<boolean>}
     */
    async appendWorldInfo(entry) {
      try {
        if (!entry || !entry.name || !entry.content) {
          console.warn('[SillyTavernAdapter] appendWorldInfo: 缺少 name 或 content');
          return false;
        }

        // 先读取已有内容
        var existing = await this.getWorldInfoEntry(entry.name);
        var newContent = entry.content;

        if (existing && existing.trim()) {
          // 已有内容，追加（避免重复）
          if (existing.indexOf(entry.content.trim()) === -1) {
            newContent = existing + '\n' + entry.content;
          } else {
            // 内容已存在，不重复写入
            return true;
          }
        }

        return await this.setWorldInfoEntry(entry.name, newContent);
      } catch (e) {
        console.warn('[SillyTavernAdapter] appendWorldInfo 失败:', e);
        return false;
      }
    }

    /**
     * 获取当前角色信息（结构化）
     * [铁则六] 通过适配器获取ST上下文
     * @returns {object|null} { id, name, description, personality, scenario, firstMes, avatar }
     */
    getCharacterInfo() {
      try {
        var ctx = this.getChatContext();
        if (!ctx) return null;

        // [修复] characterId 是数组索引，characters 是本地数组
        // getOneCharacter() 会发API请求可能404，直接从本地取
        var char = null;
        if (ctx.characters && Array.isArray(ctx.characters) && ctx.characterId !== undefined) {
          char = ctx.characters[ctx.characterId] || null;
        }
        // 降级：尝试旧路径
        if (!char && ctx.character) {
          char = ctx.character;
        }
        if (!char) return null;

        return {
          id: char.avatar || char.name || 'unknown',
          name: char.name || '未知角色',
          description: char.description || char.data?.description || '',
          personality: char.personality || char.data?.personality || '',
          scenario: char.scenario || char.data?.scenario || '',
          firstMes: char.first_mes || '',
          avatar: char.avatar || ''
        };
      } catch (e) {
        console.warn('[SillyTavernAdapter] getCharacterInfo 失败:', e);
        return null;
      }
    }

    /**
     * 获取ST最近聊天消息
     * [铁则六] 通过适配器获取ST上下文
     * @param {number} count - 获取条数，默认6
     * @returns {Array<{name, is_user, mes, send_date}>}
     */
    getRecentChatMessages(count) {
      count = count || 6;
      try {
        var ctx = this.getChatContext();
        if (!ctx || !ctx.chat || ctx.chat.length === 0) return [];

        return ctx.chat.slice(-count).map(function (msg) {
          return {
            name: msg.name || (msg.is_user ? 'User' : 'AI'),
            is_user: !!msg.is_user,
            mes: msg.mes || '',
            send_date: msg.send_date || Date.now()
          };
        });
      } catch (e) {
        console.warn('[SillyTavernAdapter] getRecentChatMessages 失败:', e);
        return [];
      }
    }

    /**
     * 获取当前角色ID
     * @returns {string|null}
     */
    getCurrentCharacterId() {
      try {
        var char = this.getCurrentCharacter();
        if (!char) return null;
        // ST 角色卡用 avatar 字段作为唯一标识
        return char.avatar || char.name || null;
      } catch (e) {
        return null;
      }
    }

    /**
     * 获取所有角色ID列表
     * @returns {Array<string>}
     */
    getAllCharacterIds() {
      try {
        var context = this.getChatContext();
        if (!context || !context.characters) return [];

        return context.characters
          .filter(function (c) { return c && c.avatar; })
          .map(function (c) { return c.avatar; });
      } catch (e) {
        console.warn('[SillyTavernAdapter] getAllCharacterIds 失败:', e);
        return [];
      }
    }

    isReady() {
      return this._ready;
    }

    async waitForReady(timeout = 30000) {
      if (this._ready) return;

      return new Promise((resolve, reject) => {
        let settled = false;

        const check = () => {
          if (settled) return;
          if (this._ready) {
            settled = true;
            clearTimeout(timer);
            resolve();
          } else {
            timer = setTimeout(check, 100);
          }
        };

        let timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('SillyTavernAdapter ready timeout'));
        }, timeout);

        check();
      });
    }

    // ==================== 内部方法 ====================

    _normalizeKey(key) {
      // 确保键名格式一致
      if (key.startsWith('xb.')) return key;
      if (key.startsWith('phone.')) return `xb.${key}`;
      return `${this._options.varPrefix}.${key}`;
    }

    _getCached(key) {
      if (!this._cache.has(key)) return undefined;

      const timestamp = this._cacheTimestamps.get(key);
      const now = Date.now();

      if (now - timestamp > this._options.cacheTTL) {
        // 缓存过期
        this._cache.delete(key);
        this._cacheTimestamps.delete(key);
        return undefined;
      }

      return this._cache.get(key);
    }

    _setCached(key, value) {
      this._cache.set(key, value);
      this._cacheTimestamps.set(key, Date.now());
    }

    _notifyChange(key, value) {
      for (const listener of this._changeListeners) {
        try {
          listener(key, value);
        } catch (e) {
          console.error('[SillyTavernAdapter] 监听器错误:', e);
        }
      }
    }

    /**
     * 读取小白X的向量相关结构化数据
     * [铁则六] 环境相关逻辑在适配器中完成
     *
     * 只读取 chat_metadata 中的文本数据，不读取 IndexedDB 中的向量
     *
     * @returns {Promise<Object|null>}
     */
    async getXBXVectorData() {
      try {
        var chatMetadata = this._getChatMetadata();
        if (!chatMetadata) return null;

        var xbxExt = chatMetadata.extensions && chatMetadata.extensions.LittleWhiteBox;
        if (!xbxExt) return null;

        return {
          stateAtoms: xbxExt.stateAtoms || [],
          l0Index: xbxExt.l0Index || null,
          storySummary: xbxExt.storySummary || null
        };
      } catch (e) {
        console.warn('[STAdapter] 读取小白X数据失败:', e);
        return null;
      }
    }

    /**
     * 获取当前聊天的 metadata
     * @private
     */
    _getChatMetadata() {
      try {
        // 方法1: 通过 SillyTavern getContext
        if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
          var ctx = window.SillyTavern.getContext();
          if (ctx && ctx.chat_metadata) return ctx.chat_metadata;
        }
        // 方法2: 全局变量
        if (window.chat_metadata) return window.chat_metadata;
        // 方法3: 通过 ST 全局变量
        if (window.this_chid !== undefined && window.chat_metadata) {
          return window.chat_metadata;
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    dispose() {
      if (this._pollInterval) {
        clearInterval(this._pollInterval);
        this._pollInterval = null;
      }

      this._changeListeners.clear();
      this._cache.clear();
      this._cacheTimestamps.clear();

      this._ready = false;
    }
  }

  // 暴露到全局
  window.SillyTavernAdapter = SillyTavernAdapter;

  console.log('[Platform] SillyTavernAdapter 已加载');
})();
