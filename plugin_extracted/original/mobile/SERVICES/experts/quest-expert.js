/**
 * @layer Service
 * @file   quest-expert.js
 * @description 任务专家 - 生成游戏任务
 *
 * 职责:
 *   - 根据世界上下文和剧情生成任务
 *   - 生成任务步骤和奖励
 *   - [Task 6.5] 注入游戏状态（金钱、关系、阶段）
 *   - [Task 6.5] 完整任务类型体系（main/side/daily/event）
 *   - [Task 6.5] 步骤类型（travel/dialogue/shopping/gift/investigate/wait）
 *   - [Task 6.5] 任务链机制（chainTo/chainDelay/chainConditions）
 *   - [Task 6.5] 去重：传入当前活跃任务列表
 *   - 输出标准化的任务数据结构
 *
 * 输出JSON格式:
 *   {
 *     quests: [{
 *       id: string,
 *       name: string,
 *       type: string,
 *       description: string,
 *       importance: string,
 *       steps: [{type: string, label: string, ...}],
 *       rewards: {gold: number, exp: number, items: []},
 *       penalty: {type: string, value: number},
 *       expiresAt: number,
 *       relatedNPC: string,
 *       worldTag: string,
 *       chainTo: string|null,
 *       chainDelay: number|null,
 *       chainConditions: Array|null
 *     }],
 *     meta: {...}
 *   }
 *
 * 铁则合规:
 *   - 铁则一: 数据读写通过 Schema 辅助函数（通过 platform.get() 获取 Service）
 *   - 铁则三: Service 层只处理数据操作和 AI 调用
 *   - 铁则七: 通过 LLMGateway 调用 AI
 *   - 铁则九: 错误处理降级
 */

;(function () {
  'use strict';

  /**
   * 任务专家类
   * 继承 BaseExpert
   */
  class QuestExpert extends window.BaseExpert {
    constructor(platform, config) {
      super(platform, {
        expertId: 'quest-expert',
        channel: 'channel-director', // [F-07] 使用 director 专用通道 (30000ms timeout)
        role: 'quest-generator',
        ...config,
      });

      // [Task 6.5] 任务类型定义（main/side/daily/event）
      this._questTypes = [
        'main', // 主线
        'side', // 支线
        'daily', // 日常
        'event', // 事件
      ];

      // 重要性级别
      this._importanceLevels = [
        'critical', // 关键
        'high', // 高
        'medium', // 中
        'low', // 低
      ];

      // [Task 6.5] 步骤类型定义（扩展版）
      this._stepTypes = [
        'travel', // 前往某地
        'dialogue', // 与某人对话
        'shopping', // 购买物品
        'gift', // 送出礼物
        'investigate', // 调查/探索
        'wait', // 等待（时间触发）
        'open_app', // 打开应用
        'send_message', // 发送消息
        'visit_location', // 访问地点
        'interact_npc', // 与NPC互动
        'complete_task', // 完成任务
        'spend_gold', // 消费金币
        'send_gift', // 送礼物
        'shop_checkout', // 商城购物
        'custom', // 自定义
      ];

      // [Task 6.5] 任务链配置
      this._chainConfig = {
        maxChainDepth: 5,         // 最大任务链深度
        defaultChainDelay: 300000, // 默认链延迟5分钟
        supportedConditions: [    // 支持的链条件
          'quest_completed',      // 前置任务完成
          'relationship_above',   // 关系值高于阈值
          'money_above',         // 金钱高于阈值
          'time_passed',         // 时间流逝
          'npc_met',             // 遇到特定NPC
          'item_owned',          // 拥有特定物品
        ],
      };
    }

    /**
     * 生成任务
     * @param {Object} context - 上下文信息
     * @param {string} context.questType - 任务类型
     * @param {string} context.importance - 重要性
     * @param {string} context.triggerEvent - 触发事件
     * @param {number} context.questCount - 生成数量（默认1-2）
     * @returns {Promise<Object|null>} 任务列表
     */
    async generate(context) {
      const result = await super.generate(context);
      if (!result) return null;

      // 添加元数据
      result.meta = {
        generatedAt: this._getTimestamp(),
        questType: context.questType || 'mixed',
        expertId: this._expertId,
      };

      // 处理任务数据，确保所有字段完整
      if (result.quests && Array.isArray(result.quests)) {
        result.quests = result.quests.map((quest) => this._normalizeQuest(quest, context));
      }

      return result;
    }

    /**
     * 构建 Prompt 上下文
     * [Task 6.5] 增强：注入游戏状态、任务类型体系、步骤类型、任务链、去重
     * @param {Object} context - 原始上下文
     * @returns {Promise<Object>} 构建后的上下文
     */
    async _buildPrompt(context) {
      const baseContext = await super._buildPrompt(context);

      // [铁则一修复] 通过 WorldData Schema 获取世界数据
      let worldContext = {};
      let step2Data = null;
      let charId = context.charId || baseContext.charId || 'default';
      
      try {
        // [修复] 使用 WorldData Schema 直接读取，不依赖 Service 方法
        const WorldData = window.PhoneData?.World;
        if (WorldData) {
          const wd = new WorldData(this._platform);
          // 优先尝试获取完整世界数据
          const worldData = await wd.get(charId);
          if (worldData) {
            worldContext = worldData;
            step2Data = {
              world: worldData.world || { news: [] },
              maps: worldData.maps || { outdoor: {}, inside: {} },
              npcs: worldData.npcs || [],
              rules: worldData.rules || [],
              factions: worldData.factions || []
            };
          } else {
            // 降级：尝试获取 Step2 数据
            step2Data = await wd.getStep2(charId);
            if (step2Data) {
              worldContext = step2Data.world || {};
            }
          }
        }
      } catch (e) {
        console.warn('[QuestExpert] 获取世界数据失败:', e);
      }

      // [铁则一修复] 获取活跃任务（去重用）- 通过 questService
      let activeQuests = [];
      try {
        var questSvc = this._platform?.get?.('questService');
        if (questSvc?.getActiveQuests) {
          activeQuests = await questSvc.getActiveQuests() || [];
        }
      } catch (e) {
        console.warn('[QuestExpert] 获取活跃任务失败:', e);
      }

      // [铁则一修复] 获取NPC列表 - 通过 npcGeneratorService 或 worldService
      let npcList = [];
      try {
        if (step2Data && step2Data.npcs && step2Data.npcs.length > 0) {
          npcList = step2Data.npcs;
        } else {
          var npcGenSvc = this._platform?.get?.('npcGeneratorService');
          if (npcGenSvc?.getNPCList) {
            npcList = await npcGenSvc.getNPCList() || [];
          }
        }
      } catch (e) {
        console.warn('[QuestExpert] 获取NPC列表失败:', e);
      }

      // [Task 6.5] 获取游戏状态（金钱、关系、阶段）
      let gameState = {
        money: 0,
        relationships: [],
        stage: '',
        phase: '',
      };
      try {
        // 获取金钱
        var econSvc = this._platform?.get?.('economyService');
        if (econSvc?.getBalance) {
          gameState.money = await econSvc.getBalance(charId) || 0;
        }
      } catch (e) {
        console.warn('[QuestExpert] 获取金钱失败:', e);
      }

      try {
        // 获取关系列表
        var friendSvc = this._platform?.get?.('friendService');
        if (friendSvc?.getRelationships) {
          gameState.relationships = await friendSvc.getRelationships() || [];
        }
      } catch (e) {
        console.warn('[QuestExpert] 获取关系数据失败:', e);
      }

      try {
        // 获取当前阶段
        var statusSvc = this._platform?.get?.('statusService');
        if (statusSvc?.getCurrentStatus) {
          var status = await statusSvc.getCurrentStatus();
          if (status) {
            gameState.stage = status.stage || status.phase || '';
            gameState.phase = status.phase || '';
          }
        }
      } catch (e) {
        console.warn('[QuestExpert] 获取阶段状态失败:', e);
      }

      // [v4.3-fix] 正确提取 V2 数据结构中的字段
      return {
        ...baseContext,
        // 世界信息
        worldName: worldContext.name || '未知世界',
        worldTheme: worldContext.theme || '通用',
        era: worldContext.era || '现代',
        atmosphere: worldContext.atmosphere || '普通',
        keyLocations: worldContext.keyLocations || (step2Data?.maps?.outdoor?.nodes?.map(function(n) { return n.name; }) || []),
        factions: worldContext.factions || step2Data?.factions || [],
        worldRules: worldContext.rules || step2Data?.rules || [],
        // 任务配置
        questType: context.questType || 'mixed',
        questTypes: this._questTypes.join(', '),
        importance: context.importance || 'medium',
        importanceLevels: this._importanceLevels.join(', '),
        stepTypes: this._stepTypes.join(', '),
        // [Task 6.5] 游戏状态注入
        gameState: gameState,
        // [Task 6.5] 去重：当前活跃任务列表
        activeQuestNames: activeQuests.map(function(q) { return q.name; }).join(', '),
        activeQuestIds: activeQuests.map(function(q) { return q.id; }),
        activeQuestCount: activeQuests.length,
        // NPC列表
        npcList: npcList.slice(0, 10).map(function(npc) {
          return {
            name: npc.name,
            role: npc.role || '普通角色',
            relationship: npc.relationship || '未知',
          };
        }),
        // 触发事件
        triggerEvent: context.triggerEvent || null,
        // [Task 6.5] 任务链机制
        chainConfig: this._chainConfig,
        // 生成数量
        questCount: context.questCount || 1,
      };
    }

    /**
     * 验证结果
     * @param {Object} result - 解析后的结果
     * @returns {boolean} 是否有效
     */
    _validateResult(result) {
      if (!result || typeof result !== 'object') {
        return false;
      }

      if (!Array.isArray(result.quests)) {
        return false;
      }

      // 验证每个任务
      for (const quest of result.quests) {
        if (!quest.id || !quest.name || !quest.description) {
          console.warn('[QuestExpert] 任务缺少必要字段:', quest);
          return false;
        }

        // 验证步骤
        if (quest.steps && !Array.isArray(quest.steps)) {
          console.warn('[QuestExpert] 任务 steps 不是数组:', quest);
          return false;
        }
      }

      return true;
    }

    /**
     * 规范化任务数据
     * [Task 6.5] 增加 chainTo/chainDelay/chainConditions 字段
     * @param {Object} quest - 原始任务数据
     * @param {Object} context - 上下文
     * @returns {Object} 规范化后的任务
     */
    _normalizeQuest(quest, context) {
      const now = this._getTimestamp();
      const defaultExpiry = 7 * 24 * 60 * 60 * 1000; // 7天

      return {
        id: quest.id || this._generateId(),
        name: quest.name || '未命名任务',
        type: quest.type || quest.questType || context?.questType || 'side',
        description: quest.description || '完成任务目标',
        importance: quest.importance || context?.importance || 'medium',
        steps: this._normalizeSteps(quest.steps),
        rewards: {
          gold: quest.rewards?.gold || quest.reward?.gold || 0,
          exp: quest.rewards?.exp || quest.reward?.exp || 0,
          items: quest.rewards?.items || quest.reward?.items || [],
        },
        penalty: quest.penalty || { type: 'none', value: 0 },
        expiresAt: quest.expiresAt || now + defaultExpiry,
        relatedNPC: quest.relatedNPC || quest.friendId || quest.issuerId || null,
        worldTag: quest.worldTag || context?.worldTag || 'general',
        createdAt: now,
        status: 'pending',
        // [Task 6.5] 任务链字段
        chainTo: quest.chainTo || null,
        chainDelay: quest.chainDelay || null,
        chainConditions: quest.chainConditions || null,
      };
    }

    /**
     * 规范化步骤数据
     * @param {Array} steps - 原始步骤
     * @returns {Array} 规范化后的步骤
     */
    _normalizeSteps(steps) {
      if (!Array.isArray(steps) || steps.length === 0) {
        // 默认步骤
        return [
          {
            type: 'custom',
            label: '完成任务目标',
          },
        ];
      }

      return steps.map((step, index) => ({
        order: index + 1,
        type: step.type || 'custom',
        label: step.label || step.description || `步骤 ${index + 1}`,
        target: step.target || step.app || null,
        params: step.params || {},
        completed: false,
      }));
    }

    /**
     * 生成默认任务（完全降级）
     * @param {Object} context - 上下文
     * @returns {Object} 任务列表
     */
    generateFallbackQuests(context) {
      return this._generateFallback(context);
    }

    /**
     * [重写] 生成 fallback 数据
     * @param {Object} context - 上下文
     * @returns {Object} 任务列表
     */
    _generateFallback(context) {
      const questType = context?.questType || 'side';
      const npcName = context?.npcName || '神秘人';

      const templates = {
        main: [
          {
            name: '探索新世界',
            description: '探索这个神秘的世界，发现隐藏的秘密。',
            steps: [
              { type: 'travel', label: '前往新区域' },
              { type: 'dialogue', label: '与当地人交谈' },
            ],
            rewards: { gold: 500, exp: 100 },
          },
        ],
        side: [
          {
            name: '收集材料',
            description: '帮助收集一些必要的材料。',
            steps: [
              { type: 'travel', label: '前往收集地点' },
              { type: 'investigate', label: '调查材料位置' },
            ],
            rewards: { gold: 100, exp: 50 },
          },
          {
            name: '传递消息',
            description: `帮${npcName}传递一个重要消息。`,
            steps: [
              { type: 'send_message', label: '发送消息' },
            ],
            rewards: { gold: 50, exp: 30 },
          },
        ],
        daily: [
          {
            name: '每日签到',
            description: '完成每日签到任务。',
            steps: [{ type: 'open_app', label: '打开手机应用' }],
            rewards: { gold: 20, exp: 10 },
          },
        ],
        event: [
          {
            name: '限时挑战',
            description: '完成限时挑战任务，获得丰厚奖励。',
            steps: [{ type: 'investigate', label: '调查事件现场' }],
            rewards: { gold: 200, exp: 100 },
          },
        ],
      };

      const typeTemplates = templates[questType] || templates.side;
      const selected = typeTemplates[Math.floor(Math.random() * typeTemplates.length)];

      const quest = this._normalizeQuest(
        {
          ...selected,
          type: questType,
          importance: context?.importance || 'medium',
          relatedNPC: context?.npcId || null,
        },
        context
      );

      return {
        quests: [quest],
        meta: {
          generatedAt: this._getTimestamp(),
          isFallback: true,
          expertId: this._expertId,
        },
      };
    }

    /**
     * 快速生成简单任务
     * @param {string} name - 任务名称
     * @param {string} description - 任务描述
     * @param {Array} steps - 步骤
     * @returns {Object} 任务对象
     */
    quickGenerate(name, description, steps) {
      const quest = this._normalizeQuest({
        name: name || '快速任务',
        description: description || '完成指定目标',
        steps: steps || [{ type: 'custom', label: '完成任务' }],
      });

      return {
        quests: [quest],
        meta: {
          generatedAt: this._getTimestamp(),
          isQuick: true,
          expertId: this._expertId,
        },
      };
    }

    /**
     * 生成新手任务
     * @returns {Object} 新手任务列表
     */
    generateStarterQuests() {
      const quests = [
        {
          id: 'starter_welcome',
          name: '欢迎来到新世界',
          type: 'main',
          description: '熟悉手机功能，完成基础操作。',
          importance: 'high',
          steps: [
            { type: 'open_app', label: '打开手机', target: 'message' },
            { type: 'send_message', label: '发送第一条消息' },
          ],
          rewards: { gold: 100, exp: 50 },
          worldTag: 'starter',
        },
        {
          id: 'starter_social',
          name: '建立社交圈',
          type: 'side',
          description: '添加第一个好友。',
          importance: 'medium',
          steps: [{ type: 'interact_npc', label: '添加好友' }],
          rewards: { gold: 50, exp: 30 },
          worldTag: 'starter',
        },
        {
          id: 'starter_explore',
          name: '探索功能',
          type: 'daily',
          description: '尝试不同的手机功能。',
          importance: 'low',
          steps: [{ type: 'open_app', label: '探索应用', target: 'weibo' }],
          rewards: { gold: 30, exp: 20 },
          worldTag: 'starter',
        },
      ];

      return {
        quests: quests.map((q) => this._normalizeQuest(q, {})),
        meta: {
          generatedAt: this._getTimestamp(),
          isStarter: true,
          expertId: this._expertId,
        },
      };
    }
  }

  // 导出到全局
  window.QuestExpert = QuestExpert;

})();
