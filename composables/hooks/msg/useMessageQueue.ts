import { MittEventType } from "../../utils/useMitt";

// 消息状态枚举
export enum MessageSendStatus {
  PENDING = "pending", // 等待发送
  SENDING = "sending", // 发送中
  SUCCESS = "success", // 发送成功
  ERROR = "error", // 发送失败
}

export const MessageSendStatusMap: Record<MessageSendStatus, string> = {
  [MessageSendStatus.PENDING]: "等待中",
  [MessageSendStatus.SENDING]: "发送中",
  [MessageSendStatus.SUCCESS]: "已发送",
  [MessageSendStatus.ERROR]: "错误",
};

// 消息队列项接口
export interface MessageQueueItem {
  id: any; // 消息唯一ID
  formData: ChatMessageDTO; // 消息数据
  status: MessageSendStatus; // 消息状态
  retryCount: number; // 重试次数
  callback?: (msg: ChatMessageVO) => void; // 回调函数
  createdAt: number; // 创建时间
  tempMsg?: ChatMessageVO; // 临时消息对象(预构建的消息)
}

// 消息队列管理类
class MessageQueueManager {
  private queue = reactive<Record<string | number, MessageQueueItem>>({});
  private pendingIds = reactive<any[]>([]);

  // 添加消息到队列
  add = (item: MessageQueueItem): void => {
    this.queue[item.id] = item; // 直接修改响应式对象
    this.pendingIds.push(item.id);
  };

  // 获取下一个待处理的消息
  getNextPending = (): MessageQueueItem | null => {
    const pendingId = this.pendingIds.find(id =>
      this.queue[id] && this.queue[id].status === MessageSendStatus.PENDING,
    );
    return pendingId ? this.queue[String(pendingId)] || null : null;
  };

  // 更新消息状态
  updateStatus = (id: any, status: MessageSendStatus): void => {
    if (this.queue[id])
      this.queue[id].status = status;
  };

  // 增加重试次数
  incrementRetryCount = (id: any): void => {
    if (this.queue[id])
      this.queue[id].retryCount++;
  };

  // 移除消息
  remove = (id: any): void => {
    delete this.queue[String(id)];
    const index = this.pendingIds.indexOf(id);
    if (index !== -1) {
      this.pendingIds.splice(index, 1);
    }
  };

  // 移除消息 - 已经发送一次的消息
  removePending = (id: any): void => {
    const index = this.pendingIds.indexOf(id);
    if (index !== -1) {
      this.pendingIds.splice(index, 1);
    }
  };

  // 获取所有消息
  getAll = (): MessageQueueItem[] => {
    return Object.values(this.queue);
  };

  // 获取指定ID的消息 - 已经是箭头函数
  get = (id: any) => {
    return this.queue[String(id)];
  };

  // 清空队列
  clear = (): void => {
    // 清空响应式对象需要特殊处理
    Object.keys(this.queue).forEach((key) => {
      delete this.queue[key];
    });
    this.pendingIds.length = 0; // 清空数组
  };

  // 获取队列长度
  get length() {
    return this.pendingIds.length;
  }
}

export function useMessageQueue() {
  const queueManager = new MessageQueueManager();
  const isProcessingQueue = ref(false);
  // const processingDelay = 80; // 处理间隔(ms)
  const user = useUserStore();

  // 消息队列的响应式引用 - 不再需要computed，因为队列本身已经是响应式的
  const messageQueue = computed(() => queueManager.getAll());

  // 消息构建器 - 预先构建消息对象 - 已经是箭头函数
  const msgBuilder = (formData: ChatMessageDTO, tempId: any, time: number): ChatMessageVO => {
    // 构建临时消息对象
    return {
      fromUser: {
        userId: user.userId,
        avatar: user.userInfo.avatar,
        gender: user.userInfo.gender,
        nickName: user.userInfo.nickname,
      },
      message: {
        id: tempId,
        roomId: formData.roomId,
        sendTime: time,
        content: formData.content,
        type: formData.msgType,
        body: msgBodyVOBuilderMap[formData.msgType]?.(formData), // 消息体
      },
    } as ChatMessageVO<any>;
  };

  // 处理消息队列
  const processMessageQueue = async () => {
    if (isProcessingQueue.value || queueManager.length === 0) {
      return;
    }

    isProcessingQueue.value = true;

    // 获取队列中第一个待处理的消息
    const currentItem = queueManager.getNextPending();

    if (!currentItem) {
      isProcessingQueue.value = false;
      return;
    }

    // 更新状态为发送中
    queueManager.updateStatus(currentItem.id, MessageSendStatus.SENDING);

    try {
      // 发送消息
      const roomId = currentItem.formData.roomId;
      const clientId = currentItem.id;
      const user = useUserStore();
      const res = await sendChatMessage({
        ...currentItem.formData,
        roomId,
        clientId, // 用于辨识同一条消息
      }, user.getToken);
      if (res.code === StatusCode.SUCCESS) { // 发送成功
        if (!queueManager.get(currentItem.id)) {
          return;
        }
        queueManager.updateStatus(currentItem.id, MessageSendStatus.SUCCESS);
        mitter.emit(MittEventType.MESSAGE_QUEUE, {
          type: "success",
          payload: { queueItem: currentItem, msg: res.data },
        });
        if (typeof currentItem.callback === "function") {
          currentItem.callback(res.data);
        }
        // 从队列中移除
        queueManager.remove(currentItem.id);
      }
      else if (res.message === "您和对方已不是好友！") { // 特殊错误处理
        queueManager.updateStatus(currentItem.id, MessageSendStatus.ERROR);
        mitter.emit(MittEventType.MESSAGE_QUEUE, {
          type: "error",
          payload: { queueItem: currentItem },
        });
        queueManager.removePending(currentItem.id);
      }
      else { // 其他错误
        queueManager.updateStatus(currentItem.id, MessageSendStatus.ERROR);
        mitter.emit(MittEventType.MESSAGE_QUEUE, {
          type: "error",
          payload: { queueItem: currentItem },
        });
        queueManager.removePending(currentItem.id);
        // throw new Error(res.message);
      }
    }
    catch (error) { // 发送失败
      queueManager.updateStatus(currentItem.id, MessageSendStatus.ERROR);
      // // 触发事件通知
      // mitter.emit(MittEventType.MESSAGE_QUEUE, {
      //   type: "error",
      //   payload: { queueItem: currentItem },
      // });
      // // 如果未超过最大重试次数，则重试
      // if (currentItem.retryCount < maxRetryCount) {
      //   queueManager.incrementRetryCount(currentItem.id);
      //   queueManager.updateStatus(currentItem.id, MessageSendStatus.PENDING);
      //   // 触发重试事件
      //   mitter.emit(MittEventType.MESSAGE_QUEUE, {
      //     type: "retry",
      //     payload: { queueItem: currentItem },
      //   });
      // }
    }
    finally {
      isProcessingQueue.value = false;
      // 延迟一段时间后继续处理队列
      if (queueManager.length > 0) {
        processMessageQueue();
      }
    }
  };

  // 添加消息到队列 - 已经是箭头函数
  const addToMessageQueue = (formData: ChatMessageDTO, callback?: (msg: ChatMessageVO) => void) => {
    const time = Date.now();
    const id = `temp_${time}_${Math.floor(Math.random() * 100)}`;
    const tempMsg = msgBuilder(formData, id, time);
    // 生成唯一ID
    const queueItem: MessageQueueItem = {
      id,
      formData: JSON.parse(JSON.stringify(formData)),
      status: MessageSendStatus.PENDING,
      retryCount: 0,
      callback,
      createdAt: time,
      tempMsg, // 保存预构建的消息
    };

    // 添加到队列
    queueManager.add(queueItem);

    // 触发事件通知
    mitter.emit(MittEventType.MESSAGE_QUEUE, {
      type: "add",
      payload: { queueItem, msg: tempMsg },
    });

    // 如果队列没有在处理中，开始处理
    if (!isProcessingQueue.value) {
      processMessageQueue();
    }

    return {
      id: queueItem.id,
      tempMsg,
    };
  };

  // 重试发送消息
  const retryMessage = (messageId: any) => {
    const item = queueManager.get(messageId);
    if (!item?.tempMsg || item.status !== MessageSendStatus.ERROR) {
      return;
    }
    // 从消息列表中删除错误消息
    const chat = useChatStore();
    const roomId = item.tempMsg.message.roomId;
    if (!roomId) {
      return;
    }

    // 查找并删除消息列表中的错误消息
    if (roomId && chat.contactMap[roomId]) {
      const contact = chat.contactMap[roomId];
      const msgIndex = contact.msgIds.indexOf(messageId);
      if (msgIndex !== -1) {
        contact.msgIds.splice(msgIndex, 1);
      }
      delete contact.msgMap[messageId];
    }
    addToMessageQueue(item.formData, item.callback);
    // 触发重试事件
    mitter.emit(MittEventType.MESSAGE_QUEUE, {
      type: "retry",
      payload: {
        queueItem: item,
        msg: item.tempMsg,
      },
    });
  };
  // 删除未发送的消息
  const deleteUnSendMessage = (messageId: any) => {
    const item = queueManager.get(messageId);
    if (!item) {
      return;
    }

    // 只能删除未发送的消息（PENDING 或 ERROR 状态）
    if (item.status === MessageSendStatus.SENDING || item.status === MessageSendStatus.SUCCESS) {
      return;
    }

    // 从队列中移除
    queueManager.remove(messageId);

    // 从消息列表中删除
    const chat = useChatStore();
    const roomId = item.tempMsg?.message.roomId;
    if (roomId && chat.contactMap[roomId]) {
      const contact = chat.contactMap[roomId];
      const msgIndex = contact.msgIds.indexOf(messageId);
      if (msgIndex !== -1) {
        contact.msgIds.splice(msgIndex, 1);
      }
      delete contact.msgMap[messageId];
    }

    // 触发删除事件
    mitter.emit(MittEventType.MESSAGE_QUEUE, {
      type: "delete",
      payload: { queueItem: item },
    });
  };

  // 清空消息队列
  const clearMessageQueue = () => {
    queueManager.clear();

    // 触发清空事件
    mitter.emit(MittEventType.MESSAGE_QUEUE, {
      type: "clear",
    });
  };

  // 处理
  const resolveQueueItem = (clientId: string, msg: ChatMessageVO) => {
    queueManager.updateStatus(clientId, MessageSendStatus.SUCCESS);
    const currentItem = queueManager.get(clientId);
    if (!currentItem)
      return;
    mitter.emit(MittEventType.MESSAGE_QUEUE, {
      type: "success",
      payload: { queueItem: currentItem, msg },
    });
    if (typeof currentItem.callback === "function") {
      currentItem.callback(msg);
    }
    // 从队列中移除
    queueManager.remove(clientId);
  };

  return {
    messageQueue,
    isProcessingQueue,
    isExsist: (id: any) => !!queueManager.get(id),
    get: queueManager.get,
    addToMessageQueue,
    resolveQueueItem,
    processMessageQueue,
    retryMessage,
    deleteUnSendMessage,
    clearMessageQueue,
    msgBuilder,
  };
}
