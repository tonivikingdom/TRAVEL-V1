import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { debugMonitoringCopy } from '../src/monitoring-copy.js';

describe('F-08 monitoring and client delivery responsibility copy', () => {
  it('distinguishes server monitoring from Debug Web polling, native Push and client location', () => {
    expect(debugMonitoringCopy.notifications).toContain(
      '服务端航班/地面交通监控',
    );
    expect(debugMonitoringCopy.notifications).toContain('已启用');
    expect(debugMonitoringCopy.notifications).toContain('Worker');
    expect(debugMonitoringCopy.notifications).toContain(
      '站内 NotificationEvent',
    );
    expect(debugMonitoringCopy.notifications).toContain(
      '本 Debug Web 不自动轮询',
    );
    expect(debugMonitoringCopy.notifications).toContain(
      '原生 Push 与客户端后台定位尚未实现',
    );
  });
  it('keeps credentials private and identifies the manual panel versus independent server flows', () => {
    expect(debugMonitoringCopy.flight).toContain('不显示凭证');
    expect(debugMonitoringCopy.flight).toContain('服务端航班监控');
    expect(debugMonitoringCopy.risk).toContain('手动测试触发');
    expect(debugMonitoringCopy.risk).toContain('服务端监控与 Provider 流程');
    for (const copy of [debugMonitoringCopy.flight, debugMonitoringCopy.risk])
      expect(copy).toContain('本 Debug Web 不自动轮询');
  });
  it('renders this responsibility copy in the notification, flight and risk panels', async () => {
    const source = await readFile(
      new URL('../src/main.ts', import.meta.url),
      'utf8',
    );
    for (const field of ['notifications', 'flight', 'risk'])
      expect(source).toContain(`esc(debugMonitoringCopy.${field})`);
    expect(source).not.toContain('后台实时监控、Push 尚未实现');
  });
});
