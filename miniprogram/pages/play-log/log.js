// pages/play-log/log.js
import cloudFcn from '../../cloudFcn.js'

/**
 * 被操作者可能是好几个人：「BWStar2067和oyyq」「A、B和C」
 *   （云端 joinNames 的格式：前面用顿号连，最后一个人前面用「和」）。
 *   名字是要染成蓝色的，连接词（、/和）不能跟着变蓝，所以拆成 [{name, sep}]，
 *   wxml 里名字走蓝、sep 走正文色。
 *   只有最后一段才可能带连接用的「和」——名字本身带「和」的（如「阿和」）
 *   如果切出空段就整体放弃切分，免得把人家名字切掉一半。
 */
function splitTargetNames(target) {
  const s = String(target || '')
  if (!s) return []
  const segs = s.split('、')
  const last = segs.pop()
  const idx = last.lastIndexOf('和')
  let names
  if (idx > 0) {
    const head = last.slice(0, idx)
    const tail = last.slice(idx + 1)
    names = (head && tail) ? segs.concat([head, tail]) : segs.concat([last])
  } else {
    names = segs.concat([last])
  }
  names = names.filter(Boolean)
  if (!names.length) return []
  return names.map((name, i) => ({
    name,
    // 最后一个人后面不带连接词；倒数第二个用「和」，更前面的用「、」
    sep: i === names.length - 1 ? '' : (i === names.length - 2 ? '和' : '、'),
  }))
}

/**
 * 把操作日志的 action 拆成三段，前端三段式渲染（避免被操作者名字重复出现）：
 *   渲染顺序：operatorName + (targetName) + action
 *   故 action 里不再含被操作者名，只保留前缀动词 + 后缀
 *
 *   e.g. "将OVH从第2位移至第1位" → pre='将', target='OVH', post='从第2位移至第1位'
 */
function splitAction(action) {
  // 切换单刷把人从游玩位移到等候区首位： 「因为A切换为单刷从游玩位移至等候区首位了」
  //   自己让位时没有操作者，写成「因为切换为单刷从游玩位移至等候区首位了」。
  //   必须**先**匹配没有名字的那条：否则 `.+?` 会把「切」当成名字切出来。
  //   老日志写的是「移至首位了」/「被移下机了」，规则一并保留，历史记录才不会把名字切错。
  const MOVE_TAIL = '(从游玩位移至等候区首位|移至首位|被移下机)了'
  const reasonSelf = action.match(new RegExp('^因为切换为(拼机|单刷)' + MOVE_TAIL + '$'))
  if (reasonSelf) {
    return {
      pre: '因为',
      target: '',
      post: '切换为' + reasonSelf[1] + reasonSelf[2] + '了',
    }
  }
  const reasonOther = action.match(new RegExp('^因为(.+?)切换为(拼机|单刷)' + MOVE_TAIL + '$'))
  if (reasonOther) {
    return {
      pre: '因为',
      target: reasonOther[1],
      post: '切换为' + reasonOther[2] + reasonOther[3] + '了',
    }
  }
  const moveMatch = action.match(/^将(.+?)从第(\d+)位移至第(\d+)位$/)
  if (moveMatch) {
    return {
      pre: '将',
      target: moveMatch[1],
      post: '从第' + moveMatch[2] + '位移至第' + moveMatch[3] + '位',
    }
  }
  // 强制下机：让X强制下机了
  //   必须排在下面那条「让X上机/下机了」前面，否则 `.+?` 会把「强制」吃进名字里。
  //   后缀不带「（不结算费用）」：日志只写发生了什么，不再附注计费说明。
  const forceMatch = action.match(/^让(.+?)强制下机了$/)
  if (forceMatch) {
    return {
      pre: '让',
      target: forceMatch[1],
      post: '强制下机了',
    }
  }
  const letMatch = action.match(/^让(.+?)(上机|下机)了$/)
  if (letMatch) {
    return {
      pre: '让',
      target: letMatch[1],
      post: letMatch[2] + '了',
    }
  }
  // 历史日志：以前设置页允许「替别人切换」时写下的 让X切换为拼机 / 让X切换为单刷。
  //   现在只能切自己，新日志不会再出现这种写法，这里保留只为正常显示旧记录。
  const letSwitchMatch = action.match(/^让(.+?)切换为(拼机|单刷)$/)
  if (letSwitchMatch) {
    return {
      pre: '让',
      target: letSwitchMatch[1],
      post: '切换为' + letSwitchMatch[2],
    }
  }
  const kickMatch = action.match(/^将(.+?)踢出队列$/)
  if (kickMatch) {
    return {
      pre: '将',
      target: kickMatch[1],
      post: '踢出队列',
    }
  }
  // 云函数改版前的旧格式：将自身位置移至第1位（不含从/至）
  const oldSelf = action.match(/^将自身位置移至第(\d+)位$/)
  if (oldSelf) {
    return {
      pre: '将',
      target: '自身',
      post: '从原位置移至第' + oldSelf[1] + '位',
    }
  }
  // 无被操作者的普通动作（加入了队列/离开了队列等）
  return { pre: '', target: '', post: action }
}

Page({

  /**
   * 页面的初始数据
   */
  data: {
    logLists: {
      machineLogs: [
        // {
        //   time: new Date('2025-03-01T17:00:00'), // 和timeStart一致，用作唯一key
        //   timeShow: '2025-03-01 17:00:00',
        //   action: 1,  // 操作类型
        //   user1: null,  // 操作人openid
        //   user2: null,  // 被操作人openid
        //   actionShow: 'xx对xx [+xx] 进行yy操作'
        // },
      ],
      wmLogs: [
        {
          time: new Date('2025-03-01T17:00:00'), // 和timeStart一致，用作唯一key
          dateShow: '2025-03-01',
          timeStartShow: '17:00',
          timeStart: new Date('2025-03-01T17:00:00'),
          timeEndShow: '19:30',
          timeEnd: new Date('2025-03-01T19:30:00'),
          isMulti: true,
          machineName: '乌蒙1号',
          time_duration: '2h30min',
          pointConsumed: 30,
          cardUsed: '会员（2折）',
          companion: '好椰'
        }, 
        {
          time: new Date('2025-03-01T20:00:00'), // 和timeStart一致，用作唯一key
          dateShow: '2025-03-01',
          timeStartShow: '20:00',
          timeStart: new Date('2025-03-01T20:00:00'),
          timeEndShow: '20:30',
          timeEnd: new Date('2025-03-01T20:30:00'),
          isMulti: false,
          machineName: '乌蒙1号',
          time_duration: '30min',
          pointConsumed: 30,
          cardUsed: '会员（2折）',
          同桌好友: ''
        }, 
      ],
      pointLogs: [
        {
          time: new Date('2025-03-01T19:30:00'),
          timeShow: '2025-03-01 19:31:00',
          points: 30,
          reason: '充值到账'
        },
        {
          time: new Date('2025-03-01T19:30:00'),
          timeShow: '2025-03-01 19:30:00',
          points: 30,
          reason: '出勤消费'
        }
      ],
    },
    activeLogList: 'machineLogs',
    selectedMachine: null/* {machineId: 't', machineName: '乌蒙1号', maxPlayer: 2} */
  },

  // 获取机器操作日志
  getQueueLog() {
    let machineId = this.data.selectedMachine?.machineId
    if (!machineId) return

    cloudFcn.queueLog(machineId).then(res => {
      if(!res.result.success) return Promise.reject(res)
      
      // 排序：**严格按时间倒序**（最新的在最上面）。
      //   一次操作的真实先后是「切换 / 下机 / 强制下机 → 自动上机」，
      //   所以自动上机那几条时间最晚，就该显示在最上面，
      //   下面才是「小影 切换为拼机」「小影 下机了」这种起因日志。
      //   （云端已经用 logTimeBeforeEmbark 把这些起因日志压在本批上机日志之前，
      //     这里不再用文案做任何覆盖 —— 以前按文案把「切换」提到「上机」上面，
      //     结果就是「切换为拼机」压在「oyyq 上机了」上面，因果又反了。）
      //
      // ⚠️ 不能用 reverse()：同一批日志时间戳只差几毫秒，reverse() 会把「先上机的人」
      //   翻到下面去。
      //
      // happenRank 只在两条日志时间戳**完全相同时**兜底（云端没部署 / 同一毫秒），
      //   数字越大越晚发生、越靠上：上机(50) 一定在 下机/切换(10~40) 之后。
      const happenRank = (info) => {
        const s = String(info || '')
        if (/上机/.test(s)) return 50                    // 自动上机：永远是最后一步
        if (/因为.+?切换为(拼机|单刷)|被移下机/.test(s)) return 40  // 被别人挤下机
        if (/因为切换为(拼机|单刷)/.test(s)) return 30    // 自己让位
        if (/切换为(拼机|单刷)/.test(s)) return 20        // 主动切换
        if (/下机|离开|移出/.test(s)) return 10           // 下机 / 离开队列
        if (/加入/.test(s)) return 5                     // 加入队列（最早）
        return 15
      }
      const ordered = res.result.data.slice().sort((a, b) => {
        const ta = new Date(a.timestamp).getTime() || 0
        const tb = new Date(b.timestamp).getTime() || 0
        if (ta !== tb) return tb - ta
        // 只有同一毫秒才看事件类型
        return happenRank(b.log_info) - happenRank(a.log_info)
      })
      let machineLogs = Array.from(ordered, (log, index) => {
        // 兼容三种历史格式：
        //   新格式：[HH:MM:SS] 用户名动作
        //   旧格式：用户名于<Date>动作
        //   更旧格式：用户用户名于<Date>动作
        const logInfo = String(log.log_info || '')
        let operatorName = '未知用户'
        let action = logInfo

        // 动作关键词（用于切分名称和动作）
        //   '让' 必须算一个切分点：日志文案是「小影让阿岚下机了」，
        //   不带 '让' 的话切在「下机」上，操作者会变成「小影让阿岚」，连「让」一起变蓝。
        //   '因为' 同理：切单刷把人移到队首写成「阿岚因为小影切换为单刷从游玩位移至等候区首位了」，
        //   不切在这里的话操作者会变成「阿岚因为小影」，
        //   '从游玩位' 兜住不带「因为」的写法；'移至首位' / '被移下机了' 是老日志用的词。
        //   ⚠️ 这行必须带 const markers = ，漏掉就是 ReferenceError，整页日志渲染不出来。
        const markers = ['加入了队列', '离开了队列', '切换为拼机', '切换为单刷', '从游玩位', '移至首位', '被移下机了', '因为', '将', '让', '上机', '下机']

        if (logInfo.startsWith('[')) {
          // 新格式：[HH:MM:SS] 用户名动作
          const body = logInfo.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/^用户/, '')
          let cut = -1
          for (const m of markers) {
            const i = body.indexOf(m)
            if (i < 0) continue
            // '让' 只有后面确实是「让某某上机/下机了」时才算切分点，
            // 否则昵称里带「让」的人（如「阿让」自己下机）会被从名字中间切开。
            //   除了「让X上机/下机了」，设置页替人切拼机状态也会写成「让X切换为单刷」
            if (m === '让' && (i === 0 || !/^让.+?(上机|下机)了$|^让.+?切换为(拼机|单刷)$/.test(body.slice(i)))) continue
            if (cut < 0 || i < cut) cut = i
          }
          if (cut > 0) {
            operatorName = body.slice(0, cut).trim()
            action = body.slice(cut).trim()
          } else {
            action = body.trim()
          }
        } else {
          // 旧格式：用户名于<Date>动作
          const body = logInfo.replace(/^用户/, '')
          const yiIdx = body.indexOf('于')
          if (yiIdx > 0) {
            operatorName = body.slice(0, yiIdx).trim()
            let rest = body.slice(yiIdx + 1)
            // 去掉 JS Date 字符串
            rest = rest.replace(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}[^)]*\)?/, '')
            rest = rest.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '')
            action = rest.trim()
          } else {
            action = body.trim()
          }
        }

        // 把 action 拆成三段式（pre + target + post）
        const { pre, target, post } = splitAction(action)

        return {
          // 列表 key：优先用日志文档 _id。
          //   ⚠️ 不能用 time 当 key —— 同一批写下的几条日志时间戳完全一样
          //   （拼机两人一起下机就是两条同秒记录），key 重复会让列表漏渲染、
          //   新日志看起来「不更新」。老数据 / mock 没有 _id 时用下标兜底。
          uid: log._id || ('log-' + index),
          time: Date.parse(new Date(log.timestamp).toString()),
          timeShow: new Date(log.timestamp).toLocaleString('zh-CN', {hour12: false}).replace(/\//g, "-"),
          operatorName,
          pre,
          target,
          // 名字逐个人渲染：名字蓝、连接词（、/和）黑
          targetParts: splitTargetNames(target),
          post,
        }
      })
      this.setData({
        ['logLists.machineLogs']: machineLogs
      })
    })
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    // 机台参数是 JSON 串传进来的。设置页那边用 encodeURIComponent 编码过，
    // 微信多数情况下会替我们解码，但基础库版本行为不完全一致，所以两种都试一次。
    let raw = options && options.selectedMachine
    let selectedMachine = {}
    if (raw) {
      try {
        selectedMachine = JSON.parse(raw) || {}
      } catch (e) {
        try {
          selectedMachine = JSON.parse(decodeURIComponent(raw)) || {}
        } catch (e2) {
          console.error('[日志页] 机台参数解析失败', e2)
        }
      }
    }
    if (Object.keys(selectedMachine).length != 0) this.setData({
      selectedMachine
    })
    this.getQueueLog()
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {
    // 首次进入由 onLoad 拉取；从别的页面返回时重新拉一次，
    //   否则「下机 → 回来看日志」还是上次的列表，看起来像日志没更新。
    if (this._shown) this.getQueueLog()
    this._shown = true
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  }
})