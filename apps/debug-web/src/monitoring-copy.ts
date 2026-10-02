export const debugMonitoringCopy = {
  notifications:
    '服务端航班/地面交通监控可通过已启用的 Assistance capability 与 Worker 运行，并产生站内 NotificationEvent；本 Debug Web 不自动轮询。原生 Push 与客户端后台定位尚未实现。',
  flight:
    '真实 AeroDataBox 调用只在服务端显式启用；本面板不显示凭证。本 Debug Web 不自动轮询；服务端航班监控由已启用的 capability / Worker 独立运行。',
  risk: '本面板按钮是手动测试触发；服务端监控与 Provider 流程也可产生或重新评估执行风险。本 Debug Web 不自动轮询；原生 Push 尚未实现。',
} as const;
